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
      created_at INTEGER NOT NULL
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

// Helper: simulate enqueueSync
function enqueueSync(db: Database, tableName: string, recordId: string, operation: string): void {
  db.query(`DELETE FROM sync_queue WHERE table_name = ? AND record_id = ? AND synced = 0`)
    .run(tableName, recordId);
  db.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`)
    .run(tableName, recordId, operation, Date.now());
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

    // Should still have only 1 pending entry (dedup removes old one, inserts new)
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

  it('should reset dead-lettered records (attempts >= MAX_ATTEMPTS)', () => {
    const MAX_ATTEMPTS = 5;

    // Insert a dead-lettered record
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    db.query(
      `UPDATE sync_queue SET attempts = ?, last_error = 'DEAD_LETTER: expired token' WHERE table_name = 'transaction' AND record_id = 'txn-1'`,
    ).run(MAX_ATTEMPTS);

    // Verify it's dead-lettered
    const before = db.query(
      `SELECT attempts, last_error FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`,
    ).get() as any;
    expect(before.attempts).toBe(MAX_ATTEMPTS);
    expect(before.last_error).toContain('DEAD_LETTER');

    // Reset (same SQL as refreshCloudSession uses)
    db.query(
      `UPDATE sync_queue SET attempts = 0, last_error = NULL WHERE synced = 0 AND attempts >= ?`,
    ).run(MAX_ATTEMPTS);

    // Verify reset
    const after = db.query(
      `SELECT attempts, last_error FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`,
    ).get() as any;
    expect(after.attempts).toBe(0);
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
      `UPDATE sync_queue SET attempts = 0, last_error = NULL WHERE synced = 0 AND attempts >= ?`,
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
      `UPDATE sync_queue SET attempts = 0, last_error = NULL WHERE synced = 0 AND attempts >= ?`,
    ).run(MAX_ATTEMPTS);

    // Should NOT be reset (attempts < MAX_ATTEMPTS)
    const row = db.query(
      `SELECT attempts FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1'`,
    ).get() as any;
    expect(row.attempts).toBe(3);
  });
});
