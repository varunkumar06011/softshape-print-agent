import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─────────────────────────────────────────────────────────────────────────────
// Tests for edge server transaction delete propagation and sync queue logic
//
// These tests use a temporary SQLite DB to verify:
//   1. The txn_deleted marker correctly filters orders from listTransactionsEdge
//   2. The settle:* key removal works when a transaction delete is applied
//   3. The sync_queue enqueue/dedup logic works for re-enqueued transactions
//   4. The backfill script logic correctly identifies missing sync_queue entries
// ─────────────────────────────────────────────────────────────────────────────

// Helper: create a fresh test DB with the minimal schema needed
function createTestDb(): Database {
  const dbPath = join(tmpdir(), `edge-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbPath);

  // Create minimal tables
  db.query(`
    CREATE TABLE IF NOT EXISTS order_record (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      status TEXT DEFAULT 'PENDING',
      total_amount REAL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      paid_at INTEGER,
      bill_number TEXT,
      cloud_synced INTEGER DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      is_extra_table INTEGER DEFAULT 0,
      platform TEXT DEFAULT 'DINE_IN'
    )
  `).run();

  db.query(`
    CREATE TABLE IF NOT EXISTS edge_config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    )
  `).run();

  db.query(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      synced INTEGER DEFAULT 0,
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      state TEXT DEFAULT 'pending'
    )
  `).run();

  db.query(`
    CREATE TABLE IF NOT EXISTS sync_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id INTEGER,
      table_name TEXT,
      record_id TEXT,
      operation TEXT,
      outcome TEXT,
      message TEXT,
      audited_at INTEGER
    )
  `).run();

  db.query(`
    CREATE TABLE IF NOT EXISTS transaction_record (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      kind TEXT DEFAULT 'settle',
      payload TEXT,
      cloud_synced INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `).run();

  return db;
}

// Helper: insert a settled order + settle record
function insertSettledOrder(
  db: Database,
  orderId: string,
  restaurantId: string,
  localTxnId: string,
  grandTotal: number = 100,
): void {
  const now = Date.now();
  db.query(
    `INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, paid_at) VALUES (?, ?, ?, 'SETTLED', ?, ?)`,
  ).run(orderId, 'table-1', restaurantId, grandTotal, now);

  const settleData = JSON.stringify({
    orderId,
    restaurantId,
    paymentMethod: 'CASH',
    grandTotal,
    localTxnId,
    settledAt: now,
  });
  db.query(
    `INSERT INTO edge_config (key, value, updated_at) VALUES (?, ?, ?)`,
  ).run(`settle:${localTxnId}`, settleData, now);
}

// Helper: simulate the applyChange transaction delete logic from config.ts
function applyTransactionDelete(db: Database, orderId: string): boolean {
  try {
    db.query(
      `DELETE FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = ?`,
    ).run(orderId);
    db.query(
      `INSERT INTO edge_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`,
    ).run(`txn_deleted:${orderId}`, String(Date.now()), Date.now(), String(Date.now()), Date.now());
    return true;
  } catch {
    return false;
  }
}

// Helper: simulate the listTransactionsEdge filter
function listSettledOrders(db: Database, restaurantId: string): any[] {
  return db.query(
    `SELECT o.id, o.paid_at, o.bill_number
     FROM order_record o
     WHERE o.restaurant_id = ? AND o.status = 'SETTLED'
     AND NOT EXISTS (SELECT 1 FROM edge_config WHERE key = 'txn_deleted:' || o.id)`,
  ).all(restaurantId) as any[];
}

// Helper: simulate enqueueSync, preserving an in-flight row so a newer
// local update cannot be removed by the older request's acknowledgment.
function enqueueSync(db: Database, tableName: string, recordId: string, operation: string): void {
  const now = Date.now();
  const updated = db.query(
    `UPDATE sync_queue
     SET operation = ?, created_at = ?, attempts = 0, last_error = NULL
     WHERE table_name = ? AND record_id = ? AND synced = 0
       AND COALESCE(last_error, '') != 'IN_FLIGHT'`,
  ).run(operation, now, tableName, recordId);
  if ((updated.changes || 0) === 0) {
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`)
      .run(tableName, recordId, operation, now);
  }
}

describe('Transaction delete propagation (cloud → edge)', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('should list settled orders before delete', () => {
    insertSettledOrder(db, 'order-1', 'rest-1', 'txn-1', 250);
    insertSettledOrder(db, 'order-2', 'rest-1', 'txn-2', 350);

    const orders = listSettledOrders(db, 'rest-1');
    expect(orders).toHaveLength(2);
  });

  it('should exclude order from list after txn_deleted marker is set', () => {
    insertSettledOrder(db, 'order-1', 'rest-1', 'txn-1', 250);
    insertSettledOrder(db, 'order-2', 'rest-1', 'txn-2', 350);

    // Delete transaction for order-1
    const result = applyTransactionDelete(db, 'order-1');
    expect(result).toBe(true);

    const orders = listSettledOrders(db, 'rest-1');
    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe('order-2');
  });

  it('should remove settle:* key when transaction is deleted', () => {
    insertSettledOrder(db, 'order-1', 'rest-1', 'txn-1', 250);

    // Verify settle record exists
    const settleRow = db.query(
      `SELECT value FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = 'order-1'`,
    ).get() as any;
    expect(settleRow).not.toBeNull();

    // Delete
    applyTransactionDelete(db, 'order-1');

    // Verify settle record is gone
    const settleRowAfter = db.query(
      `SELECT value FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = 'order-1'`,
    ).get() as any;
    expect(settleRowAfter).toBeNull();

    // Verify txn_deleted marker exists
    const markerRow = db.query(
      `SELECT value FROM edge_config WHERE key = 'txn_deleted:order-1'`,
    ).get() as any;
    expect(markerRow).not.toBeNull();
  });

  it('should not affect other orders when one transaction is deleted', () => {
    insertSettledOrder(db, 'order-1', 'rest-1', 'txn-1', 250);
    insertSettledOrder(db, 'order-2', 'rest-1', 'txn-2', 350);
    insertSettledOrder(db, 'order-3', 'rest-1', 'txn-3', 450);

    applyTransactionDelete(db, 'order-2');

    const orders = listSettledOrders(db, 'rest-1');
    expect(orders).toHaveLength(2);
    const ids = orders.map((o) => o.id);
    expect(ids).toContain('order-1');
    expect(ids).toContain('order-3');
    expect(ids).not.toContain('order-2');
  });

  it('should handle delete for non-existent order gracefully', () => {
    insertSettledOrder(db, 'order-1', 'rest-1', 'txn-1', 250);

    // Delete a non-existent order — should not throw
    const result = applyTransactionDelete(db, 'nonexistent-order');
    expect(result).toBe(true);

    // Original order should still be there
    const orders = listSettledOrders(db, 'rest-1');
    expect(orders).toHaveLength(1);
  });
});

describe('Sync queue backfill logic', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('should identify orders missing from sync_queue', () => {
    insertSettledOrder(db, 'order-1', 'rest-1', 'txn-1', 250);
    insertSettledOrder(db, 'order-2', 'rest-1', 'txn-2', 350);

    // Only enqueue order-1's transaction
    enqueueSync(db, 'transaction', 'txn-1', 'insert');

    // Check which orders have pending sync_queue entries
    for (const localTxnId of ['txn-1', 'txn-2']) {
      const row = db.query(
        `SELECT id, synced FROM sync_queue WHERE table_name = 'transaction' AND record_id = ? ORDER BY id DESC LIMIT 1`,
      ).get(localTxnId) as any;

      if (localTxnId === 'txn-1') {
        expect(row).not.toBeNull();
        expect(row.synced).toBe(0);
      } else {
        expect(row).toBeNull();
      }
    }
  });

  it('should re-enqueue a transaction that was dequeued as rejected', () => {
    insertSettledOrder(db, 'order-1', 'rest-1', 'txn-1', 250);

    // Simulate: was enqueued, synced (dequeued), and audited as rejected
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    const queueRow = db.query(
      `SELECT id FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`,
    ).get() as any;
    db.query(`UPDATE sync_queue SET synced = 1 WHERE id = ?`).run(queueRow.id);
    db.query(
      `INSERT INTO sync_audit (queue_id, table_name, record_id, operation, outcome, message, audited_at) VALUES (?, 'transaction', 'txn-1', 'insert', 'rejected', 'test', ?)`,
    ).run(queueRow.id, Date.now());

    // Backfill: check if rejected, re-enqueue
    const existingRow = db.query(
      `SELECT id, synced FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1' ORDER BY id DESC LIMIT 1`,
    ).get() as any;

    expect(existingRow.synced).toBe(1);

    const auditRow = db.query(
      `SELECT outcome FROM sync_audit WHERE queue_id = ? AND table_name = 'transaction' ORDER BY audited_at DESC LIMIT 1`,
    ).get(existingRow.id) as any;

    expect(auditRow.outcome).toBe('rejected');

    // Re-enqueue
    enqueueSync(db, 'transaction', 'txn-1', 'insert');

    const newRow = db.query(
      `SELECT id, synced FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1' AND synced = 0`,
    ).get() as any;

    expect(newRow).not.toBeNull();
    expect(newRow.synced).toBe(0);
  });

  it('should prioritize healthy records ahead of dead-lettered ones (2-tier priority)', () => {
    enqueueSync(db, 'kot', 'kot-1', 'insert');
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    db.query(`UPDATE sync_queue SET created_at = 1 WHERE table_name = 'kot'`).run();

    // Both are healthy (state = 'pending', attempts < MAX_ATTEMPTS) — same tier.
    // KOT has earlier created_at so it comes first by FIFO.
    const first = db.query(`
      SELECT table_name FROM sync_queue
      WHERE synced = 0 AND state = 'pending'
      ORDER BY
        CASE WHEN attempts >= ? THEN 2 ELSE 1 END,
        created_at ASC, id ASC
      LIMIT 1
    `).get(5) as any;

    expect(first.table_name).toBe('kot');
  });

  it('should NOT prioritize dead-lettered transactions over orders (starvation fix)', () => {
    enqueueSync(db, 'order', 'order-1', 'insert');
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    // Dead-letter the transaction (state = 'dead_letter')
    db.query(`UPDATE sync_queue SET attempts = 6, state = 'dead_letter', last_error = 'previous failure' WHERE table_name = 'transaction'`).run();
    db.query(`UPDATE sync_queue SET created_at = 1 WHERE table_name = 'order'`).run();

    // A dead-lettered transaction is priority 2, order is priority 1 — order wins.
    // Also, dead-letter state is excluded by the state = 'pending' filter.
    const first = db.query(`
      SELECT table_name FROM sync_queue
      WHERE synced = 0 AND state = 'pending'
      ORDER BY
        CASE WHEN attempts >= ? THEN 2 ELSE 1 END,
        created_at ASC, id ASC
      LIMIT 1
    `).get(5) as any;

    expect(first.table_name).toBe('order');
  });

  it('should NOT prioritize dead-lettered KOTs over orders (KOT has required FK to order)', () => {
    enqueueSync(db, 'order', 'order-1', 'insert');
    enqueueSync(db, 'kot', 'kot-1', 'insert');
    // Dead-letter the KOT (state = 'dead_letter') — it's failing because
    // the order hasn't synced yet (Kot.orderId is a required FK in cloud schema).
    db.query(`UPDATE sync_queue SET attempts = 6, state = 'dead_letter', last_error = 'order not found' WHERE table_name = 'kot'`).run();
    db.query(`UPDATE sync_queue SET created_at = 1 WHERE table_name = 'order'`).run();

    // A dead-lettered KOT is excluded by state = 'pending' filter.
    const first = db.query(`
      SELECT table_name FROM sync_queue
      WHERE synced = 0 AND state = 'pending'
      ORDER BY
        CASE WHEN attempts >= ? THEN 2 ELSE 1 END,
        created_at ASC, id ASC
      LIMIT 1
    `).get(5) as any;

    expect(first.table_name).toBe('order');
  });

  it('should preserve a pending row while an older push is in flight', () => {
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    const firstRow = db.query(
      `SELECT id FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1' AND synced = 0`,
    ).get() as any;
    db.query(`UPDATE sync_queue SET state = 'in_flight', last_error = 'IN_FLIGHT' WHERE id = ?`).run(firstRow.id);

    enqueueSync(db, 'transaction', 'txn-1', 'update');

    const rows = db.query(
      `SELECT id, operation, last_error, state FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1' AND synced = 0 ORDER BY id`,
    ).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(firstRow.id);
    expect(rows[0].last_error).toBe('IN_FLIGHT');
    expect(rows[0].state).toBe('in_flight');
    expect(rows[1].operation).toBe('update');
  });

  it('should skip orders that already have pending sync_queue entries', () => {
    insertSettledOrder(db, 'order-1', 'rest-1', 'txn-1', 250);
    enqueueSync(db, 'transaction', 'txn-1', 'insert');

    // Check — should find a pending entry
    const row = db.query(
      `SELECT id, synced FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1' AND synced = 0`,
    ).get() as any;

    expect(row).not.toBeNull();
    expect(row.synced).toBe(0);

    // Should NOT re-enqueue (dedup logic)
    enqueueSync(db, 'transaction', 'txn-1', 'insert');

    // Should still have only 1 pending entry (the existing row is updated)
    const rows = db.query(
      `SELECT id FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1' AND synced = 0`,
    ).all() as any[];

    expect(rows).toHaveLength(1);
  });

  it('should skip orders with no settle record', () => {
    // Insert a settled order but NO settle:* key
    db.query(
      `INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, paid_at) VALUES ('order-x', 'table-1', 'rest-1', 'SETTLED', 100, ?)`,
    ).run(Date.now());

    // No settle record exists
    const settleRow = db.query(
      `SELECT value FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = 'order-x'`,
    ).get() as any;

    expect(settleRow).toBeNull();
  });

  it('should skip orders with txn_deleted marker (already deleted)', () => {
    insertSettledOrder(db, 'order-1', 'rest-1', 'txn-1', 250);

    // Mark as deleted
    applyTransactionDelete(db, 'order-1');

    // Backfill query should exclude this order
    const orders = db.query(
      `SELECT id FROM order_record WHERE status = 'SETTLED' AND NOT EXISTS (SELECT 1 FROM edge_config WHERE key = 'txn_deleted:' || order_record.id)`,
    ).all() as any[];

    expect(orders).toHaveLength(0);
  });
});

describe('Dead-letter reset logic', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('should reset dead-lettered records (state = dead_letter)', () => {
    const MAX_ATTEMPTS = 5;

    // Insert a dead-lettered record
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    db.query(
      `UPDATE sync_queue SET attempts = ?, state = 'dead_letter', last_error = 'expired token' WHERE table_name = 'transaction' AND record_id = 'txn-1'`,
    ).run(MAX_ATTEMPTS);

    // Verify it's dead-lettered
    const before = db.query(
      `SELECT attempts, state, last_error FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`,
    ).get() as any;
    expect(before.attempts).toBe(MAX_ATTEMPTS);
    expect(before.state).toBe('dead_letter');

    // Reset (same SQL as refreshCloudSession uses — now with state column)
    db.query(
      `UPDATE sync_queue SET attempts = 0, last_error = NULL, state = 'pending' WHERE synced = 0 AND attempts >= ?`,
    ).run(MAX_ATTEMPTS);

    // Verify reset
    const after = db.query(
      `SELECT attempts, state, last_error FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`,
    ).get() as any;
    expect(after.attempts).toBe(0);
    expect(after.state).toBe('pending');
    expect(after.last_error).toBeNull();
  });

  it('should not reset records that are already synced', () => {
    const MAX_ATTEMPTS = 5;

    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    db.query(
      `UPDATE sync_queue SET attempts = ?, synced = 1 WHERE table_name = 'transaction' AND record_id = 'txn-1'`,
    ).run(MAX_ATTEMPTS);

    // Reset
    db.query(
      `UPDATE sync_queue SET attempts = 0, last_error = NULL, state = 'pending' WHERE synced = 0 AND attempts >= ?`,
    ).run(MAX_ATTEMPTS);

    // Should NOT be reset (synced = 1)
    const row = db.query(
      `SELECT attempts, synced FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`,
    ).get() as any;
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.synced).toBe(1);
  });

  it('should not reset records with attempts < MAX_ATTEMPTS', () => {
    const MAX_ATTEMPTS = 5;

    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    db.query(
      `UPDATE sync_queue SET attempts = 3 WHERE table_name = 'transaction' AND record_id = 'txn-1'`,
    ).run();

    // Reset
    db.query(
      `UPDATE sync_queue SET attempts = 0, last_error = NULL, state = 'pending' WHERE synced = 0 AND attempts >= ?`,
    ).run(MAX_ATTEMPTS);

    // Should NOT be reset (attempts < MAX_ATTEMPTS)
    const row = db.query(
      `SELECT attempts FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`,
    ).get() as any;
    expect(row.attempts).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.5 tests: dependency filter, waiting_dependency, state transitions,
// invariant checker, dual-signal gate
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5;
const MAX_BATCH_SIZE = 100;

// The collectBatch SQL from sync.ts (kept in sync with the production query)
const COLLECT_BATCH_SQL = `
  SELECT * FROM sync_queue
  WHERE synced = 0
    AND state = 'pending'
    AND NOT (
      table_name IN ('transaction', 'walkin_transaction')
      AND EXISTS (
        SELECT 1 FROM transaction_record tr
        WHERE tr.id = sync_queue.record_id
          AND tr.order_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM sync_queue sq2
            WHERE sq2.table_name = 'order'
              AND sq2.record_id = tr.order_id
              AND sq2.synced = 0
              AND sq2.state IN ('pending', 'in_flight', 'waiting_dependency', 'dead_letter')
          )
          AND NOT EXISTS (
            SELECT 1 FROM order_record o
            WHERE o.id = tr.order_id
              AND o.cloud_synced = 1
          )
      )
    )
  ORDER BY
    CASE WHEN attempts >= ? THEN 2 ELSE 1 END,
    created_at ASC, id ASC
  LIMIT ?
`;

describe('Dependency filter: orders before transactions', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('should filter out transactions whose order still has a pending queue row', () => {
    // Order enqueued at t=200, transaction enqueued at t=100 (earlier!)
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at, state) VALUES ('order', 'order-1', 'insert', 200, 'pending')`).run();
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at, state) VALUES ('transaction', 'txn-1', 'insert', 100, 'pending')`).run();
    db.query(`INSERT INTO transaction_record (id, order_id, kind) VALUES ('txn-1', 'order-1', 'settle')`).run();

    const batch = db.query(COLLECT_BATCH_SQL).all(MAX_ATTEMPTS, MAX_BATCH_SIZE) as any[];
    const tableNames = batch.map(r => r.table_name);

    // Order is in the batch, transaction is NOT (filtered out)
    expect(tableNames).toContain('order');
    expect(tableNames).not.toContain('transaction');
  });

  it('should allow transactions after their order queue row is deleted', () => {
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at, state) VALUES ('order', 'order-1', 'insert', 200, 'pending')`).run();
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at, state) VALUES ('transaction', 'txn-1', 'insert', 100, 'pending')`).run();
    db.query(`INSERT INTO transaction_record (id, order_id, kind) VALUES ('txn-1', 'order-1', 'settle')`).run();

    // Delete the order's queue row (simulate order synced)
    db.query(`DELETE FROM sync_queue WHERE table_name = 'order' AND record_id = 'order-1'`).run();

    const batch = db.query(COLLECT_BATCH_SQL).all(MAX_ATTEMPTS, MAX_BATCH_SIZE) as any[];
    const tableNames = batch.map(r => r.table_name);

    // Now the transaction IS in the batch
    expect(tableNames).toContain('transaction');
  });

  it('should NOT block walk-in transactions (order_id IS NULL)', () => {
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at, state) VALUES ('walkin_transaction', 'walkin-1', 'insert', 100, 'pending')`).run();
    db.query(`INSERT INTO transaction_record (id, order_id, kind) VALUES ('walkin-1', NULL, 'walkin')`).run();

    const batch = db.query(COLLECT_BATCH_SQL).all(MAX_ATTEMPTS, MAX_BATCH_SIZE) as any[];
    const tableNames = batch.map(r => r.table_name);

    expect(tableNames).toContain('walkin_transaction');
  });
});

describe('Dual-signal dependency gate', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('should block transaction when order has queue row AND cloud_synced=0', () => {
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state) VALUES ('order', 'order-1', 'insert', 'pending')`).run();
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state) VALUES ('transaction', 'txn-1', 'insert', 'pending')`).run();
    db.query(`INSERT INTO transaction_record (id, order_id) VALUES ('txn-1', 'order-1')`).run();
    db.query(`INSERT INTO order_record (id, table_id, restaurant_id, cloud_synced) VALUES ('order-1', 't1', 'r1', 0)`).run();

    const batch = db.query(COLLECT_BATCH_SQL).all(MAX_ATTEMPTS, MAX_BATCH_SIZE) as any[];
    expect(batch.map(r => r.table_name)).not.toContain('transaction');
  });

  it('should allow transaction when order has queue row BUT cloud_synced=1 (crash after cloud_synced update)', () => {
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state) VALUES ('order', 'order-1', 'insert', 'pending')`).run();
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state) VALUES ('transaction', 'txn-1', 'insert', 'pending')`).run();
    db.query(`INSERT INTO transaction_record (id, order_id) VALUES ('txn-1', 'order-1')`).run();
    db.query(`INSERT INTO order_record (id, table_id, restaurant_id, cloud_synced) VALUES ('order-1', 't1', 'r1', 1)`).run();

    const batch = db.query(COLLECT_BATCH_SQL).all(MAX_ATTEMPTS, MAX_BATCH_SIZE) as any[];
    expect(batch.map(r => r.table_name)).toContain('transaction');
  });

  it('should allow transaction when order has NO queue row AND cloud_synced=0 (queue row lost)', () => {
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state) VALUES ('transaction', 'txn-1', 'insert', 'pending')`).run();
    db.query(`INSERT INTO transaction_record (id, order_id) VALUES ('txn-1', 'order-1')`).run();
    db.query(`INSERT INTO order_record (id, table_id, restaurant_id, cloud_synced) VALUES ('order-1', 't1', 'r1', 0)`).run();

    const batch = db.query(COLLECT_BATCH_SQL).all(MAX_ATTEMPTS, MAX_BATCH_SIZE) as any[];
    expect(batch.map(r => r.table_name)).toContain('transaction');
  });

  it('should allow transaction when order has NO queue row AND cloud_synced=1 (both signals say synced)', () => {
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state) VALUES ('transaction', 'txn-1', 'insert', 'pending')`).run();
    db.query(`INSERT INTO transaction_record (id, order_id) VALUES ('txn-1', 'order-1')`).run();
    db.query(`INSERT INTO order_record (id, table_id, restaurant_id, cloud_synced) VALUES ('order-1', 't1', 'r1', 1)`).run();

    const batch = db.query(COLLECT_BATCH_SQL).all(MAX_ATTEMPTS, MAX_BATCH_SIZE) as any[];
    expect(batch.map(r => r.table_name)).toContain('transaction');
  });
});

describe('waiting_dependency state', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('should NOT increment attempts when setting waiting_dependency', () => {
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    const row = db.query(`SELECT id FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`).get() as any;

    // Simulate cloud returning waiting_dependency
    db.query(`UPDATE sync_queue SET state = 'waiting_dependency', last_error = ? WHERE id = ?`)
      .run('Order not found', row.id);

    const after = db.query(`SELECT attempts, state FROM sync_queue WHERE id = ?`).get(row.id) as any;
    expect(after.attempts).toBe(0);
    expect(after.state).toBe('waiting_dependency');
  });

  it('should flip waiting_dependency back to pending when order syncs (markSynced)', () => {
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state) VALUES ('order', 'order-1', 'insert', 'pending')`).run();
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state) VALUES ('transaction', 'txn-1', 'insert', 'waiting_dependency')`).run();
    db.query(`INSERT INTO transaction_record (id, order_id) VALUES ('txn-1', 'order-1')`).run();
    db.query(`INSERT INTO order_record (id, table_id, restaurant_id, cloud_synced) VALUES ('order-1', 't1', 'r1', 0)`).run();

    const orderRow = db.query(`SELECT id FROM sync_queue WHERE table_name = 'order' AND record_id = 'order-1'`).get() as any;

    // Simulate markSynced for the order — atomic transaction
    db.transaction(() => {
      db.query(`UPDATE order_record SET cloud_synced = 1 WHERE id = 'order-1'`).run();
      db.query(`UPDATE sync_queue SET state = 'pending', last_error = NULL WHERE state = 'waiting_dependency' AND table_name IN ('transaction', 'walkin_transaction') AND EXISTS (SELECT 1 FROM transaction_record tr WHERE tr.id = sync_queue.record_id AND tr.order_id = 'order-1')`).run();
      db.query(`DELETE FROM sync_queue WHERE id = ?`).run(orderRow.id);
    })();

    // Order queue row deleted
    const orderQueue = db.query(`SELECT id FROM sync_queue WHERE table_name = 'order' AND record_id = 'order-1'`).get() as any;
    expect(orderQueue).toBeNull();

    // Transaction flipped to pending
    const txn = db.query(`SELECT state FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`).get() as any;
    expect(txn.state).toBe('pending');
  });

  it('should exclude waiting_dependency from collectBatch', () => {
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state) VALUES ('transaction', 'txn-1', 'insert', 'waiting_dependency')`).run();

    const batch = db.query(COLLECT_BATCH_SQL).all(MAX_ATTEMPTS, MAX_BATCH_SIZE) as any[];
    expect(batch).toHaveLength(0);
  });
});

describe('Retry classification', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('should increment attempts and reset state to pending for network errors', () => {
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    const row = db.query(`SELECT id FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`).get() as any;
    db.query(`UPDATE sync_queue SET state = 'in_flight' WHERE id = ?`).run(row.id);

    // Simulate incrementAttempts (network error path)
    db.query(`UPDATE sync_queue SET attempts = attempts + 1, last_error = ?, state = 'pending' WHERE id = ?`)
      .run('Network timeout', row.id);

    const after = db.query(`SELECT attempts, state, last_error FROM sync_queue WHERE id = ?`).get(row.id) as any;
    expect(after.attempts).toBe(1);
    expect(after.state).toBe('pending');
    expect(after.last_error).toBe('Network timeout');
  });

  it('should NOT increment attempts for waiting_dependency', () => {
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    const row = db.query(`SELECT id FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`).get() as any;

    // waiting_dependency path: set state, don't touch attempts
    db.query(`UPDATE sync_queue SET state = 'waiting_dependency', last_error = ? WHERE id = ?`)
      .run('Order not found', row.id);

    const after = db.query(`SELECT attempts, state FROM sync_queue WHERE id = ?`).get(row.id) as any;
    expect(after.attempts).toBe(0);
    expect(after.state).toBe('waiting_dependency');
  });

  it('should dequeue permanent rejections (audit + delete)', () => {
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    const row = db.query(`SELECT id FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`).get() as any;

    // Simulate audit insert
    db.query(`INSERT INTO sync_audit (queue_id, table_name, record_id, operation, outcome, message, audited_at) VALUES (?, 'transaction', 'txn-1', 'insert', 'permanent', 'day closed', ?)`)
      .run(row.id, Date.now());

    // Simulate markSynced (dequeue)
    db.query(`DELETE FROM sync_queue WHERE id = ?`).run(row.id);

    const after = db.query(`SELECT id FROM sync_queue WHERE id = ?`).get(row.id) as any;
    expect(after).toBeNull();

    const audit = db.query(`SELECT outcome FROM sync_audit WHERE queue_id = ?`).get(row.id) as any;
    expect(audit.outcome).toBe('permanent');
  });

  it('should dequeue duplicate rejections (audit + delete)', () => {
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    const row = db.query(`SELECT id FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`).get() as any;

    db.query(`INSERT INTO sync_audit (queue_id, table_name, record_id, operation, outcome, message, audited_at) VALUES (?, 'transaction', 'txn-1', 'insert', 'duplicate', 'already exists', ?)`)
      .run(row.id, Date.now());
    db.query(`DELETE FROM sync_queue WHERE id = ?`).run(row.id);

    const after = db.query(`SELECT id FROM sync_queue WHERE id = ?`).get(row.id) as any;
    expect(after).toBeNull();
  });
});

describe('Queue starvation: dead-lettered records do not block healthy ones', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('should return healthy order but not dead-lettered transaction', () => {
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state, attempts) VALUES ('order', 'order-1', 'insert', 'pending', 0)`).run();
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state, attempts, last_error) VALUES ('transaction', 'txn-1', 'insert', 'dead_letter', 5, 'max attempts')`).run();

    const batch = db.query(COLLECT_BATCH_SQL).all(MAX_ATTEMPTS, MAX_BATCH_SIZE) as any[];
    expect(batch).toHaveLength(1);
    expect(batch[0].table_name).toBe('order');
  });
});

describe('State transitions', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('pending → in_flight → pending (claimBatch then incrementAttempts)', () => {
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    const row = db.query(`SELECT id FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`).get() as any;

    // claimBatch
    db.query(`UPDATE sync_queue SET state = 'in_flight', last_error = 'IN_FLIGHT' WHERE id = ?`).run(row.id);
    let after = db.query(`SELECT state FROM sync_queue WHERE id = ?`).get(row.id) as any;
    expect(after.state).toBe('in_flight');

    // incrementAttempts (failure)
    db.query(`UPDATE sync_queue SET attempts = attempts + 1, last_error = ?, state = 'pending' WHERE id = ?`).run('error', row.id);
    after = db.query(`SELECT state, attempts FROM sync_queue WHERE id = ?`).get(row.id) as any;
    expect(after.state).toBe('pending');
    expect(after.attempts).toBe(1);
  });

  it('pending → in_flight → deleted (claimBatch then markSynced)', () => {
    enqueueSync(db, 'order', 'order-1', 'insert');
    const row = db.query(`SELECT id FROM sync_queue WHERE table_name = 'order' AND record_id = 'order-1'`).get() as any;

    db.query(`UPDATE sync_queue SET state = 'in_flight', last_error = 'IN_FLIGHT' WHERE id = ?`).run(row.id);
    db.query(`DELETE FROM sync_queue WHERE id = ?`).run(row.id);

    const after = db.query(`SELECT id FROM sync_queue WHERE id = ?`).get(row.id) as any;
    expect(after).toBeNull();
  });

  it('pending → waiting_dependency → pending (order syncs)', () => {
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    const row = db.query(`SELECT id FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`).get() as any;

    // Enter waiting_dependency
    db.query(`UPDATE sync_queue SET state = 'waiting_dependency', last_error = ? WHERE id = ?`).run('Order not found', row.id);
    let after = db.query(`SELECT state FROM sync_queue WHERE id = ?`).get(row.id) as any;
    expect(after.state).toBe('waiting_dependency');

    // Order syncs → flip back to pending
    db.query(`UPDATE sync_queue SET state = 'pending', last_error = NULL WHERE id = ?`).run(row.id);
    after = db.query(`SELECT state, last_error FROM sync_queue WHERE id = ?`).get(row.id) as any;
    expect(after.state).toBe('pending');
    expect(after.last_error).toBeNull();
  });

  it('pending → dead_letter → pending (reconciliation reset)', () => {
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    const row = db.query(`SELECT id FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`).get() as any;

    // Dead-letter
    db.query(`UPDATE sync_queue SET state = 'dead_letter', attempts = 5, last_error = 'max attempts' WHERE id = ?`).run(row.id);
    let after = db.query(`SELECT state FROM sync_queue WHERE id = ?`).get(row.id) as any;
    expect(after.state).toBe('dead_letter');

    // Reconciliation reset
    db.query(`UPDATE sync_queue SET attempts = 0, last_error = NULL, state = 'pending' WHERE id = ?`).run(row.id);
    after = db.query(`SELECT state, attempts, last_error FROM sync_queue WHERE id = ?`).get(row.id) as any;
    expect(after.state).toBe('pending');
    expect(after.attempts).toBe(0);
    expect(after.last_error).toBeNull();
  });
});

describe('Queue invariant checker', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // The invariant checker SQL from sync.ts checkQueueInvariants()
  function checkInvariant1(db: Database): any[] {
    return db.query(`
      SELECT sq.id as queue_id, sq.table_name, sq.record_id, tr.order_id, o.cloud_synced
      FROM sync_queue sq
      JOIN transaction_record tr ON tr.id = sq.record_id
      LEFT JOIN order_record o ON o.id = tr.order_id
      WHERE sq.state = 'waiting_dependency'
        AND tr.order_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM sync_queue sq2
          WHERE sq2.table_name = 'order'
            AND sq2.record_id = tr.order_id
            AND sq2.synced = 0
        )
        AND (o.cloud_synced IS NULL OR o.cloud_synced = 0)
    `).all() as any[];
  }

  function checkInvariant2(db: Database): any[] {
    return db.query(`
      SELECT sq.id as queue_id, sq.table_name, sq.record_id, sq.state
      FROM sync_queue sq
      JOIN order_record o ON o.id = sq.record_id
      WHERE sq.table_name = 'order'
        AND sq.synced = 0
        AND o.cloud_synced = 1
    `).all() as any[];
  }

  function checkInvariant3(db: Database): any[] {
    return db.query(`
      SELECT sq.id as queue_id, sq.table_name, sq.record_id, tr.order_id
      FROM sync_queue sq
      JOIN transaction_record tr ON tr.id = sq.record_id
      JOIN order_record o ON o.id = tr.order_id
      WHERE sq.state = 'waiting_dependency'
        AND o.cloud_synced = 1
    `).all() as any[];
  }

  it('Invariant 1: should detect orphaned waiting_dependency (order queue row missing, cloud_synced=0)', () => {
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state) VALUES ('transaction', 'txn-1', 'insert', 'waiting_dependency')`).run();
    db.query(`INSERT INTO transaction_record (id, order_id) VALUES ('txn-1', 'order-1')`).run();
    db.query(`INSERT INTO order_record (id, table_id, restaurant_id, cloud_synced) VALUES ('order-1', 't1', 'r1', 0)`).run();
    // No order queue row exists — orphaned wait

    const violations = checkInvariant1(db);
    expect(violations).toHaveLength(1);
    expect(violations[0].order_id).toBe('order-1');
    expect(violations[0].cloud_synced).toBe(0);
  });

  it('Invariant 2: should detect stale queue row (cloud_synced=1 but queue row exists)', () => {
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state) VALUES ('order', 'order-1', 'insert', 'pending')`).run();
    db.query(`INSERT INTO order_record (id, table_id, restaurant_id, cloud_synced) VALUES ('order-1', 't1', 'r1', 1)`).run();

    const violations = checkInvariant2(db);
    expect(violations).toHaveLength(1);
    expect(violations[0].record_id).toBe('order-1');
  });

  it('Invariant 3 (first cycle): should flag stale wait but NOT repair yet', () => {
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state) VALUES ('transaction', 'txn-1', 'insert', 'waiting_dependency')`).run();
    db.query(`INSERT INTO transaction_record (id, order_id) VALUES ('txn-1', 'order-1')`).run();
    db.query(`INSERT INTO order_record (id, table_id, restaurant_id, cloud_synced) VALUES ('order-1', 't1', 'r1', 1)`).run();

    const staleWaits = checkInvariant3(db);
    expect(staleWaits).toHaveLength(1);

    // First cycle: flag with STALE_WAIT_CONFIRMED prefix
    db.query(`UPDATE sync_queue SET last_error = 'STALE_WAIT_CONFIRMED: order cloud_synced=1, will auto-repair next cycle' WHERE id = ?`).run(staleWaits[0].queue_id);

    // Verify state is still waiting_dependency (not repaired yet)
    const row = db.query(`SELECT state, last_error FROM sync_queue WHERE id = ?`).get(staleWaits[0].queue_id) as any;
    expect(row.state).toBe('waiting_dependency');
    expect(row.last_error).toContain('STALE_WAIT_CONFIRMED');
  });

  it('Invariant 3 (second cycle): should auto-repair after confirmation', () => {
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state, last_error) VALUES ('transaction', 'txn-1', 'insert', 'waiting_dependency', 'STALE_WAIT_CONFIRMED: pending')`).run();
    db.query(`INSERT INTO transaction_record (id, order_id) VALUES ('txn-1', 'order-1')`).run();
    db.query(`INSERT INTO order_record (id, table_id, restaurant_id, cloud_synced) VALUES ('order-1', 't1', 'r1', 1)`).run();

    const staleWaits = checkInvariant3(db);
    expect(staleWaits).toHaveLength(1);

    // Second cycle: condition persists → repair
    db.query(`UPDATE sync_queue SET state = 'pending', last_error = NULL WHERE id = ?`).run(staleWaits[0].queue_id);

    const row = db.query(`SELECT state, last_error FROM sync_queue WHERE id = ?`).get(staleWaits[0].queue_id) as any;
    expect(row.state).toBe('pending');
    expect(row.last_error).toBeNull();
  });

  it('Invariant 3 (transient): should NOT repair if condition disappears', () => {
    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, state, last_error) VALUES ('transaction', 'txn-1', 'insert', 'waiting_dependency', 'STALE_WAIT_CONFIRMED: pending')`).run();
    db.query(`INSERT INTO transaction_record (id, order_id) VALUES ('txn-1', 'order-1')`).run();
    db.query(`INSERT INTO order_record (id, table_id, restaurant_id, cloud_synced) VALUES ('order-1', 't1', 'r1', 1)`).run();

    // Condition disappears: order cloud_synced reverts to 0 (transient state)
    db.query(`UPDATE order_record SET cloud_synced = 0 WHERE id = 'order-1'`).run();

    const staleWaits = checkInvariant3(db);
    expect(staleWaits).toHaveLength(0); // No violation — condition gone
  });

  it('No violations: clean queue should return empty arrays', () => {
    expect(checkInvariant1(db)).toHaveLength(0);
    expect(checkInvariant2(db)).toHaveLength(0);
    expect(checkInvariant3(db)).toHaveLength(0);
  });
});

describe('100 offline settlements converge', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('should sync all orders first, then all transactions (dependency filter guarantees ordering)', () => {
    const COUNT = 100;
    const now = Date.now();

    // Bulk insert using a transaction for speed
    db.transaction(() => {
      for (let i = 0; i < COUNT; i++) {
        const orderId = `order-${i}`;
        const txnId = `txn-${i}`;
        db.query(`INSERT INTO order_record (id, table_id, restaurant_id, status, cloud_synced) VALUES (?, 't1', 'r1', 'SETTLED', 0)`).run(orderId);
        db.query(`INSERT INTO transaction_record (id, order_id, kind) VALUES (?, ?, 'settle')`).run(txnId, orderId);
        // Transaction enqueued with earlier created_at to prove filter works regardless of timestamps
        db.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at, state) VALUES ('transaction', ?, 'insert', ?, 'pending')`).run(txnId, now - 100 + i);
        db.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at, state) VALUES ('order', ?, 'insert', ?, 'pending')`).run(orderId, now + i);
      }
    })();

    let ordersSynced = 0;
    let txnsSynced = 0;
    let txnsWhileOrdersPending = 0;
    const syncRound = (): { orders: number; txns: number } => {
      const batch = db.query(COLLECT_BATCH_SQL).all(MAX_ATTEMPTS, MAX_BATCH_SIZE) as any[];
      let orders = 0, txns = 0;
      for (const row of batch) {
        if (row.table_name === 'order') {
          db.query(`UPDATE order_record SET cloud_synced = 1 WHERE id = ?`).run(row.record_id);
          db.query(`DELETE FROM sync_queue WHERE id = ?`).run(row.id);
          orders++;
        } else if (row.table_name === 'transaction') {
          db.query(`DELETE FROM sync_queue WHERE id = ?`).run(row.id);
          txns++;
        }
      }
      return { orders, txns };
    };

    // Sync rounds — orders should come first, transactions after
    while (true) {
      const { orders, txns } = syncRound();
      if (orders === 0 && txns === 0) break;
      // While orders are still pending, transactions should be filtered out
      const pendingOrders = (db.query(`SELECT COUNT(*) as c FROM sync_queue WHERE table_name = 'order' AND synced = 0`).get() as any).c;
      if (pendingOrders > 0) {
        txnsWhileOrdersPending += txns;
      }
      ordersSynced += orders;
      txnsSynced += txns;
    }

    // All orders synced first (transactions filtered out until orders done)
    expect(txnsWhileOrdersPending).toBe(0);
    expect(ordersSynced).toBe(COUNT);
    expect(txnsSynced).toBe(COUNT);

    // Queue should be empty
    const remaining = db.query(`SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0`).get() as any;
    expect(remaining.c).toBe(0);

    // All orders cloud_synced
    const syncedOrders = db.query(`SELECT COUNT(*) as c FROM order_record WHERE cloud_synced = 1`).get() as any;
    expect(syncedOrders.c).toBe(COUNT);
  });
});
