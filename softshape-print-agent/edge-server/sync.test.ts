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
      platform TEXT DEFAULT 'DINE_IN',
      is_deleted INTEGER DEFAULT 0,
      cloud_synced_version INTEGER DEFAULT 0,
      sync_attempt_count INTEGER DEFAULT 0,
      last_sync_attempt_at INTEGER,
      last_sync_error TEXT
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

  it('should prioritize transactions ahead of exhausted KOT rows', () => {
    enqueueSync(db, 'kot', 'kot-1', 'insert');
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    db.query(`UPDATE sync_queue SET attempts = 6, last_error = 'DEAD_LETTER: previous failure' WHERE table_name = 'transaction'`).run();
    db.query(`UPDATE sync_queue SET created_at = 1 WHERE table_name = 'kot'`).run();

    const first = db.query(`
      SELECT table_name FROM sync_queue
      WHERE synced = 0
      ORDER BY
        CASE
          WHEN table_name IN ('transaction', 'walkin_transaction') THEN 0
          WHEN attempts >= ? THEN 1
          ELSE 2
        END,
        created_at ASC, id ASC
      LIMIT 1
    `).get(5) as any;

    expect(first.table_name).toBe('transaction');
  });

  it('should preserve a pending row while an older push is in flight', () => {
    enqueueSync(db, 'transaction', 'txn-1', 'insert');
    const firstRow = db.query(
      `SELECT id FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1' AND synced = 0`,
    ).get() as any;
    db.query(`UPDATE sync_queue SET last_error = 'IN_FLIGHT' WHERE id = ?`).run(firstRow.id);

    enqueueSync(db, 'transaction', 'txn-1', 'update');

    const rows = db.query(
      `SELECT id, operation, last_error FROM sync_queue WHERE table_name = 'transaction' AND record_id = 'txn-1' AND synced = 0 ORDER BY id`,
    ).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(firstRow.id);
    expect(rows[0].last_error).toBe('IN_FLIGHT');
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

// ═══════════════════════════════════════════════════════════════════════════════
// v2 revision-based sync tests
// ═══════════════════════════════════════════════════════════════════════════════

import { getDb, setDb, closeDb, markUnsynced, nextOrderRevision, nextExpenditureRevision, nextTransactionRevision, migrateSyncQueueToRevisions, reclaimStalePrintingJobs } from "./db.ts";
import { dispatchPendingPrintJobs, listTransactionsEdge } from "./orderService.ts";

describe('transaction listing', () => {
  beforeEach(() => {
    const db = createTestDb();
    db.exec(`
      CREATE TABLE "table" (id TEXT PRIMARY KEY, number INTEGER, section_tag TEXT, section_id TEXT);
      CREATE TABLE section (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE order_item (order_id TEXT, name TEXT, quantity INTEGER, cancelled_quantity INTEGER DEFAULT 0, price REAL, menu_type TEXT, removed_from_bill INTEGER DEFAULT 0);
      CREATE INDEX idx_order_item_order ON order_item(order_id);
    `);
    const insertOrder = db.query("INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, paid_at, bill_number) VALUES (?, 'table-1', 'rest-1', 'SETTLED', ?, ?, ?)");
    const insertPayment = db.query("INSERT INTO edge_config (key, value, updated_at) VALUES (?, ?, ?)");
    const insertItem = db.query("INSERT INTO order_item (order_id, name, quantity, price) VALUES (?, 'Item', 1, ?)");
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) {
        const orderId = `order-${i}`;
        insertOrder.run(orderId, i + 1, Date.now() - i, `B-${i}`);
        insertPayment.run(`settle:txn-${i}`, JSON.stringify({ orderId, grandTotal: i + 1, paymentMethod: 'CASH' }), Date.now());
        insertItem.run(orderId, i + 1);
      }
    })();
    setDb(db);
  });

  afterEach(() => closeDb());

  it('loads large transaction history without per-order payment scans', async () => {
    const transactions = await listTransactionsEdge('rest-1', { limit: 2000 });
    expect(transactions).toHaveLength(2000);
    expect(transactions[0].items).toHaveLength(1);
    expect(transactions[0].method).toBe('CASH');
  });
});

describe('print job recovery', () => {
  beforeEach(() => {
    const db = createTestDb();
    db.exec(`CREATE TABLE print_job (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      failed_at INTEGER,
      last_error TEXT,
      acked_via TEXT,
      printed_at INTEGER,
      updated_at INTEGER NOT NULL,
      next_attempt_at INTEGER,
      lease_until INTEGER,
      printer_name TEXT,
      escpos_data TEXT
    )`);
    setDb(db);
  });

  afterEach(() => closeDb());

  it('moves exhausted retrying jobs to dead_letter', () => {
    getDb().query("INSERT INTO print_job (event_id, job_type, status, attempts, updated_at) VALUES (?, 'BILL', 'retrying', 10, ?)").run('job-1', Date.now());
    expect(() => reclaimStalePrintingJobs()).not.toThrow();
    const job = getDb().query("SELECT status, failed_at, updated_at FROM print_job WHERE event_id = 'job-1'").get() as any;
    expect(job.status).toBe('dead_letter');
    expect(job.failed_at).toBeGreaterThan(0);
    expect(job.updated_at).toBeGreaterThan(0);
  });

  it('does not automatically dispatch queued KOT jobs', async () => {
    getDb().query("INSERT INTO print_job (event_id, job_type, status, attempts, updated_at, escpos_data) VALUES (?, 'KOT', 'queued', 0, ?, '[]')").run('kot-1', Date.now());
    const result = await dispatchPendingPrintJobs();
    const job = getDb().query("SELECT status, last_error FROM print_job WHERE event_id = 'kot-1'").get() as any;
    expect(result.dispatched).toBe(0);
    expect(result.remaining).toBe(0);
    expect(job.status).toBe('failed');
    expect(job.last_error).toContain('explicit retry');
  });
});

describe('v2 revision-based sync helpers', () => {
  beforeEach(() => {
    const db = createTestDb();
    db.query(`
      CREATE TABLE IF NOT EXISTS order_record (
        id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL,
        restaurant_id TEXT NOT NULL,
        status TEXT DEFAULT 'PREPARING',
        total_amount REAL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        paid_at INTEGER,
        bill_number TEXT,
        cloud_synced INTEGER DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        is_extra_table INTEGER DEFAULT 0,
        platform TEXT DEFAULT 'DINE_IN',
        is_deleted INTEGER DEFAULT 0,
        cloud_synced_version INTEGER DEFAULT 0,
        sync_attempt_count INTEGER DEFAULT 0,
        last_sync_attempt_at INTEGER,
        last_sync_error TEXT,
        last_request_id TEXT
      )
    `).run();
    db.query(`
      CREATE TABLE IF NOT EXISTS order_item (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        menu_item_id TEXT,
        name TEXT,
        price REAL DEFAULT 0,
        quantity REAL DEFAULT 1,
        notes TEXT,
        menu_type TEXT DEFAULT 'FOOD',
        cancelled_quantity REAL DEFAULT 0,
        removed_from_bill INTEGER DEFAULT 0,
        pour_from_inventory_item_id TEXT
      )
    `).run();
    db.query(`
      CREATE TABLE IF NOT EXISTS kot (
        id TEXT PRIMARY KEY,
        restaurant_id TEXT,
        table_id TEXT,
        order_id TEXT,
        kot_number INTEGER,
        counter_date TEXT,
        captain_id TEXT,
        created_at INTEGER,
        device_id TEXT
      )
    `).run();
    db.query(`
      CREATE TABLE IF NOT EXISTS kot_item (
        id TEXT PRIMARY KEY,
        kot_id TEXT,
        order_item_id TEXT,
        menu_item_id TEXT,
        name TEXT,
        quantity REAL DEFAULT 1,
        price REAL DEFAULT 0,
        notes TEXT,
        status TEXT DEFAULT 'SENT'
      )
    `).run();
    db.query(`
      CREATE TABLE IF NOT EXISTS transaction_record (
        id TEXT PRIMARY KEY,
        order_id TEXT,
        restaurant_id TEXT,
        kind TEXT,
        payload TEXT,
        sync_version INTEGER DEFAULT 1,
        cloud_synced_version INTEGER DEFAULT 0,
        sync_attempt_count INTEGER DEFAULT 0,
        last_sync_attempt_at INTEGER,
        last_sync_error TEXT,
        created_at INTEGER
      )
    `).run();
    db.query(`
      CREATE TABLE IF NOT EXISTS expenditure (
        id TEXT PRIMARY KEY,
        restaurant_id TEXT,
        amount REAL,
        paid_to_type TEXT,
        created_at INTEGER,
        sync_version INTEGER DEFAULT 1,
        cloud_synced_version INTEGER DEFAULT 0,
        sync_attempt_count INTEGER DEFAULT 0,
        last_sync_attempt_at INTEGER,
        last_sync_error TEXT
      )
    `).run();
    db.query(`
      CREATE TABLE IF NOT EXISTS edge_config (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER
      )
    `).run();
    setDb(db);
  });

  afterEach(() => {
    closeDb();
  });

  it('markUnsynced("order") bumps order revision', () => {
    const db = getDb();
    db.query("INSERT INTO order_record (id, table_id, restaurant_id, status, revision, cloud_synced_version) VALUES (?, ?, ?, 'PREPARING', 1, 0)").run('o-1', 't-1', 'r-1');
    markUnsynced('order', 'o-1');
    const row = db.query("SELECT revision, cloud_synced_version FROM order_record WHERE id = ?").get('o-1') as any;
    expect(row.revision).toBe(2);
    expect(row.cloud_synced_version).toBe(0);
  });

  it('markUnsynced("transaction") bumps sync_version', () => {
    const db = getDb();
    db.query("INSERT INTO transaction_record (id, order_id, restaurant_id, kind, sync_version, cloud_synced_version) VALUES (?, ?, ?, 'settle', 1, 0)").run('txn-1', 'o-1', 'r-1');
    markUnsynced('transaction', 'txn-1');
    const row = db.query("SELECT sync_version, cloud_synced_version FROM transaction_record WHERE id = ?").get('txn-1') as any;
    expect(row.sync_version).toBe(2);
    expect(row.cloud_synced_version).toBe(0);
  });

  it('markUnsynced("expenditure") bumps sync_version', () => {
    const db = getDb();
    db.query("INSERT INTO expenditure (id, restaurant_id, amount, sync_version, cloud_synced_version) VALUES (?, ?, ?, ?, ?)").run('e-1', 'r-1', 100, 1, 0);
    markUnsynced('expenditure', 'e-1');
    const row = db.query("SELECT sync_version, cloud_synced_version FROM expenditure WHERE id = ?").get('e-1') as any;
    expect(row.sync_version).toBe(2);
    expect(row.cloud_synced_version).toBe(0);
  });

  it('nextExpenditureRevision returns current + 1', () => {
    const db = getDb();
    db.query("INSERT INTO expenditure (id, restaurant_id, amount, sync_version) VALUES (?, ?, ?, ?)").run('e-1', 'r-1', 100, 5);
    expect(nextExpenditureRevision('e-1')).toBe(6);
  });

  it('nextTransactionRevision returns current + 1', () => {
    const db = getDb();
    db.query("INSERT INTO transaction_record (id, restaurant_id, kind, sync_version) VALUES (?, ?, ?, ?)").run('txn-1', 'r-1', 'settle', 3);
    expect(nextTransactionRevision('txn-1')).toBe(4);
  });
});

describe('v2 sync migration (sync_queue → revision-based)', () => {
  beforeEach(() => {
    const db = createTestDb();
    db.query(`
      CREATE TABLE IF NOT EXISTS order_record (
        id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL,
        restaurant_id TEXT NOT NULL,
        status TEXT DEFAULT 'PREPARING',
        total_amount REAL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        is_deleted INTEGER DEFAULT 0,
        cloud_synced INTEGER DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        cloud_synced_version INTEGER DEFAULT 0
      )
    `).run();
    db.query(`
      CREATE TABLE IF NOT EXISTS transaction_record (
        id TEXT PRIMARY KEY,
        order_id TEXT,
        restaurant_id TEXT,
        kind TEXT,
        sync_version INTEGER DEFAULT 1,
        cloud_synced_version INTEGER DEFAULT 0
      )
    `).run();
    db.query(`
      CREATE TABLE IF NOT EXISTS expenditure (
        id TEXT PRIMARY KEY,
        restaurant_id TEXT,
        amount REAL,
        sync_version INTEGER DEFAULT 1,
        cloud_synced_version INTEGER DEFAULT 0
      )
    `).run();
    db.query(`
      CREATE TABLE IF NOT EXISTS edge_config (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER
      )
    `).run();
    setDb(db);
  });

  afterEach(() => {
    closeDb();
  });

  it('keeps revision=1 pending order truly pending (not marked as synced)', () => {
    const db = getDb();
    db.query("INSERT INTO order_record (id, table_id, restaurant_id, revision, cloud_synced_version) VALUES (?, ?, ?, 1, 0)").run('o-1', 't-1', 'r-1');
    db.query("INSERT INTO sync_queue (table_name, record_id, operation, synced, created_at) VALUES ('order', 'o-1', 'insert', 0, ?)").run(Date.now());

    migrateSyncQueueToRevisions();

    const row = db.query("SELECT revision, cloud_synced_version FROM order_record WHERE id = ?").get('o-1') as any;
    expect(row.cloud_synced_version).toBe(0); // pending: 1 > 0
    expect(row.revision).toBe(1);
  });

  it('migrates pending sync_queue orders into revision-based pending state', () => {
    const db = getDb();
    db.query("INSERT INTO order_record (id, table_id, restaurant_id, revision, cloud_synced_version) VALUES (?, ?, ?, 5, 0)").run('o-1', 't-1', 'r-1');
    db.query("INSERT INTO sync_queue (table_name, record_id, operation, synced, created_at) VALUES ('order', 'o-1', 'insert', 0, ?)").run(Date.now());

    const result = migrateSyncQueueToRevisions();
    expect(result.migrated).toBe(true);
    expect(result.pendingConverted).toBeGreaterThan(0);

    const row = db.query("SELECT revision, cloud_synced_version FROM order_record WHERE id = ?").get('o-1') as any;
    expect(row.cloud_synced_version).toBe(row.revision - 1);
    expect(row.cloud_synced_version).toBeLessThan(row.revision);
  });

  it('does not run twice (idempotent)', () => {
    const db = getDb();
    db.query("INSERT INTO order_record (id, table_id, restaurant_id, revision, cloud_synced_version) VALUES (?, ?, ?, 1, 0)").run('o-1', 't-1', 'r-1');
    db.query("INSERT INTO sync_queue (table_name, record_id, operation, synced, created_at) VALUES ('order', 'o-1', 'insert', 0, ?)").run(Date.now());

    const first = migrateSyncQueueToRevisions();
    const second = migrateSyncQueueToRevisions();
    expect(first.migrated).toBe(true);
    expect(second.migrated).toBe(false);
  });
});
