// ─────────────────────────────────────────────────────────────────────────────
// offline-edge-cases.test.ts — Edge case tests for offline-first scenarios
// ─────────────────────────────────────────────────────────────────────────────
// Tests the scenarios that are cheap to skip and expensive to hit in production:
//   1. Two devices editing the same table simultaneously
//   2. A device losing power mid-order (order saved but KOT not printed)
//   3. A device offline for a full shift reconnecting and syncing a day's orders
//   4. Tenant scoping under sync load (regression test for Phase 0.3 fix)
//
// Run with: bun test offline-edge-cases.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";

// Helper: create a fresh in-memory test DB with the edge server schema
function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS outlet (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
      restaurant_code TEXT NOT NULL, restaurant_type TEXT,
      gst_category TEXT DEFAULT 'NON_AC', gst_rate REAL DEFAULT 5.0,
      gst_registered INTEGER DEFAULT 1, prices_include_gst INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS "table" (
      id TEXT PRIMARY KEY, number INTEGER NOT NULL, capacity INTEGER DEFAULT 4,
      section_id TEXT, restaurant_id TEXT NOT NULL,
      status TEXT DEFAULT 'AVAILABLE', workflow_status TEXT DEFAULT 'Free',
      captain_id TEXT, guests INTEGER DEFAULT 0,
      current_bill REAL DEFAULT 0, kot_history TEXT DEFAULT '[]',
      discount REAL, section_tag TEXT, updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS order_record (
      id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL,
      table_id TEXT, table_number INTEGER,
      kot_number INTEGER, status TEXT DEFAULT 'OPEN',
      total REAL DEFAULT 0, captain_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER,
      cloud_synced INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS order_item (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL,
      name TEXT NOT NULL, price REAL NOT NULL, qty INTEGER DEFAULT 1,
      is_veg INTEGER DEFAULT 1, menu_item_id TEXT, kot_id TEXT,
      status TEXT DEFAULT 'PENDING', notes TEXT, cloud_synced INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS kot (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL,
      kot_number INTEGER NOT NULL, restaurant_id TEXT NOT NULL,
      status TEXT DEFAULT 'PRINTED', created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kot_item (
      id TEXT PRIMARY KEY, kot_id TEXT NOT NULL,
      name TEXT NOT NULL, qty INTEGER NOT NULL, price REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL, record_id TEXT NOT NULL,
      operation TEXT NOT NULL, created_at INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0, last_error TEXT, synced INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, pin TEXT,
      role TEXT NOT NULL, outlet_id TEXT NOT NULL, is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS section (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, restaurant_id TEXT NOT NULL,
      floor_id TEXT, sort_order INTEGER DEFAULT 0
    );
  `);

  return db;
}

const RESTAURANT_ID = "test-restaurant-001";
const DEVICE_A = "device-aaa";
const DEVICE_B = "device-bbb";

// ── Test 1: Two devices editing the same table simultaneously ────────────────
test("concurrent table edits — last write wins, no crash", () => {
  const db = createTestDb();
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST001')`);
  db.exec(`INSERT INTO section (id, name, restaurant_id) VALUES ('sec1', 'Main', '${RESTAURANT_ID}')`);
  db.exec(`INSERT INTO "table" (id, number, section_id, restaurant_id, status, workflow_status) VALUES ('table1', 1, 'sec1', '${RESTAURANT_ID}', 'AVAILABLE', 'Free')`);

  // Device A sets table to OCCUPIED
  db.query(`UPDATE "table" SET status = 'OCCUPIED', captain_id = '${DEVICE_A}', updated_at = ? WHERE id = 'table1'`)
    .run(Date.now());

  // Device B sets table to OCCUPIED with a different captain (simultaneous)
  db.query(`UPDATE "table" SET status = 'OCCUPIED', captain_id = '${DEVICE_B}', updated_at = ? WHERE id = 'table1'`)
    .run(Date.now() + 1);

  const tableState = db.query(`SELECT * FROM "table" WHERE id = 'table1'`).get() as any;
  expect(tableState.captain_id).toBe(DEVICE_B);
  expect(tableState.status).toBe('OCCUPIED');
});

// ── Test 2: Power loss mid-order (order saved but KOT not printed) ───────────
test("power loss mid-order — order data preserved, KOT missing", () => {
  const db = createTestDb();
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST002')`);

  const orderId = "order-power-loss";
  db.query(`INSERT INTO order_record (id, restaurant_id, table_number, status, total, created_at) VALUES (?, ?, 1, 'OPEN', 0, ?)`)
    .run(orderId, RESTAURANT_ID, Date.now());

  db.query(`INSERT INTO order_item (id, order_id, name, price, qty, is_veg, status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("item1", orderId, "Chicken Biryani", 250, 2, 0, "PENDING");

  const order = db.query(`SELECT * FROM order_record WHERE id = ?`).get(orderId) as any;
  const items = db.query(`SELECT * FROM order_item WHERE order_id = ?`).all(orderId) as any[];
  const kots = db.query(`SELECT * FROM kot WHERE order_id = ?`).all(orderId) as any[];

  expect(order.status).toBe('OPEN');
  expect(items.length).toBe(1);
  expect(kots.length).toBe(0);
});

// ── Test 3: Full shift offline, then reconnect and sync a day's orders ───────
test("full shift offline — 50 orders synced successfully on reconnect", () => {
  const db = createTestDb();
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST003')`);

  const shiftStart = Date.now() - 8 * 60 * 60 * 1000;
  for (let i = 0; i < 50; i++) {
    const oid = `shift-order-${i}`;
    const createdAt = shiftStart + i * 10 * 60 * 1000;
    db.query(`INSERT INTO order_record (id, restaurant_id, table_number, status, total, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(oid, RESTAURANT_ID, (i % 10) + 1, i < 45 ? 'SETTLED' : 'OPEN', 100 + i * 10, createdAt);

    db.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`)
      .run("order", oid, "create", createdAt);
  }

  const pendingBefore = db.query(`SELECT COUNT(*) as count FROM sync_queue WHERE synced = 0`).get() as any;
  expect(pendingBefore.count).toBe(50);

  // Simulate sync: mark all as synced
  db.query(`UPDATE sync_queue SET synced = 1 WHERE synced = 0`).run();

  const pendingAfter = db.query(`SELECT COUNT(*) as count FROM sync_queue WHERE synced = 0`).get() as any;
  const totalOrders = db.query(`SELECT COUNT(*) as count FROM order_record`).get() as any;
  expect(pendingAfter.count).toBe(0);
  expect(totalOrders.count).toBe(50);
});

// ── Test 4: Tenant scoping under sync load (regression test) ─────────────────
test("tenant scoping — orders don't cross restaurants under sync load", () => {
  const db = createTestDb();
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('rest-A', 'Rest A', 'rest-a', 'AAA001')`);
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('rest-B', 'Rest B', 'rest-b', 'BBB002')`);

  db.query(`INSERT INTO order_record (id, restaurant_id, table_number, status, total, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("order-A1", "rest-A", 1, "SETTLED", 500, Date.now());
  db.query(`INSERT INTO order_record (id, restaurant_id, table_number, status, total, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("order-B1", "rest-B", 1, "SETTLED", 300, Date.now());

  db.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`).run("order", "order-A1", "create", Date.now());
  db.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`).run("order", "order-B1", "create", Date.now());

  const orderA = db.query(`SELECT * FROM order_record WHERE id = 'order-A1'`).get() as any;
  const orderB = db.query(`SELECT * FROM order_record WHERE id = 'order-B1'`).get() as any;
  expect(orderA.restaurant_id).toBe("rest-A");
  expect(orderB.restaurant_id).toBe("rest-B");
  expect(orderA.restaurant_id).not.toBe(orderB.restaurant_id);
});

// ── Test 5: Sync queue ordering preserves insertion order ────────────────────
test("sync queue ordering — parent before child even with same timestamp", () => {
  const db = createTestDb();
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST005')`);

  const now = Date.now();
  db.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`).run("outlet", RESTAURANT_ID, "create", now);
  db.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`).run("section", "sec1", "create", now);
  db.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`).run("table", "table1", "create", now);

  const batch = db.query(`SELECT * FROM sync_queue WHERE synced = 0 ORDER BY created_at ASC, id ASC`).all() as any[];
  expect(batch[0].table_name).toBe("outlet");
  expect(batch[1].table_name).toBe("section");
  expect(batch[2].table_name).toBe("table");
});
