// ─────────────────────────────────────────────────────────────────────────────
// offline-edge-cases.test.ts — Edge case tests for offline-first scenarios
// ─────────────────────────────────────────────────────────────────────────────
// Tests the scenarios that are cheap to skip and expensive to hit in production:
//   1. Two devices editing the same table simultaneously
//   2. A device losing power mid-order (order saved but KOT not printed)
//   3. A device offline for a full shift reconnecting and syncing a day's orders
//   4. Tenant scoping under sync load (regression test for Phase 0.3 fix)
//   5. Sync queue ordering preserves insertion order
//   6. Real sync push via pushSyncBatch with mocked fetch
//   7. Two-device sync conflict detection (cloud rejects stale edge data)
//
// Run with: bun test offline-edge-cases.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, mock, beforeEach } from "bun:test";
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

    CREATE TABLE IF NOT EXISTS edge_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0
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

// ── Test 3: Full shift offline, then reconnect and sync via real pushSyncBatch ─
// This test exercises the actual sync push path: collectBatch → loadRecordData →
// fetch(POST /api/edge/sync) → markSynced. The previous version just flipped
// synced=1 manually, proving nothing about the sync code itself.
let testDb: Database;

beforeEach(() => {
  testDb = createTestDb();
});

test("full shift offline — 50 orders synced via real pushSyncBatch with mocked fetch", async () => {
  testDb.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST003')`);

  // Seed session config so auth.ts functions return valid values
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_token', 'test-jwt-token', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('restaurant_id', '${RESTAURANT_ID}', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('backend_url', 'http://mock-backend', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_expires_at', '${Date.now() + 3600000}', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('device_id', '${DEVICE_A}', ?)`).run(Date.now());

  const shiftStart = Date.now() - 8 * 60 * 60 * 1000;
  for (let i = 0; i < 50; i++) {
    const oid = `shift-order-${i}`;
    const createdAt = shiftStart + i * 10 * 60 * 1000;
    testDb.query(`INSERT INTO order_record (id, restaurant_id, table_number, status, total, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(oid, RESTAURANT_ID, (i % 10) + 1, i < 45 ? 'SETTLED' : 'OPEN', 100 + i * 10, createdAt);

    testDb.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`)
      .run("order", oid, "create", createdAt);
  }

  const pendingBefore = testDb.query(`SELECT COUNT(*) as count FROM sync_queue WHERE synced = 0`).get() as any;
  expect(pendingBefore.count).toBe(50);

  // Mock fetch to simulate the cloud backend accepting all records
  const fetchMock = mock(async (url: string, opts: any) => {
    const body = JSON.parse(opts.body);
    const accepted = body.batch.map((b: any) => b.queueId);
    return new Response(JSON.stringify({ accepted, rejected: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchMock as any;

  // Dynamically import sync.ts so it picks up our mocked fetch and test DB
  const { pushSyncBatch } = await import("../sync.ts");
  const { getDb } = await import("../db.ts");

  // Override getDb to return our in-memory test DB
  (getDb as any).mock?.mockReturnValue?.(testDb);
  // If not a mock, monkey-patch the module
  const dbModule = await import("../db.ts");
  const originalGetDb = dbModule.getDb;
  // @ts-ignore — override for test
  dbModule.getDb = () => testDb;

  const result = await pushSyncBatch();

  // Restore
  // @ts-ignore
  dbModule.getDb = originalGetDb;

  expect(result.ok).toBe(true);
  expect(result.pushed).toBe(50);
  expect(result.accepted).toBe(50);
  expect(result.rejected).toBe(0);

  // Verify fetch was called with the right URL and payload
  expect(fetchMock).toHaveBeenCalled();
  const callArgs = fetchMock.mock.calls[0];
  expect(callArgs[0]).toContain("/api/edge/sync");

  // Verify sync_queue records are actually marked synced in the DB
  const pendingAfter = testDb.query(`SELECT COUNT(*) as count FROM sync_queue WHERE synced = 0`).get() as any;
  expect(pendingAfter.count).toBe(0);

  const syncedCount = testDb.query(`SELECT COUNT(*) as count FROM sync_queue WHERE synced = 1`).get() as any;
  expect(syncedCount.count).toBe(50);
});

// ── Test 4: Tenant scoping under sync load (regression test) ─────────────────
// This test verifies that the sync payload correctly associates each record
// with its restaurant_id, and that the sync batch doesn't mix up records
// from different restaurants. It exercises loadRecordData + the batch payload
// construction, not just raw SQL inserts.
test("tenant scoping — sync batch payload preserves restaurant_id per record", async () => {
  testDb.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('rest-A', 'Rest A', 'rest-a', 'AAA001')`);
  testDb.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('rest-B', 'Rest B', 'rest-b', 'BBB002')`);

  testDb.query(`INSERT INTO order_record (id, restaurant_id, table_number, status, total, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("order-A1", "rest-A", 1, "SETTLED", 500, Date.now());
  testDb.query(`INSERT INTO order_record (id, restaurant_id, table_number, status, total, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("order-B1", "rest-B", 1, "SETTLED", 300, Date.now());

  testDb.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`).run("order", "order-A1", "create", Date.now());
  testDb.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`).run("order", "order-B1", "create", Date.now());

  // Intercept the fetch call to inspect the payload
  let capturedPayload: any = null;
  const fetchMock = mock(async (url: string, opts: any) => {
    capturedPayload = JSON.parse(opts.body);
    const accepted = capturedPayload.batch.map((b: any) => b.queueId);
    return new Response(JSON.stringify({ accepted, rejected: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchMock as any;

  // Use rest-A as the session restaurant (simulating a hub serving one outlet)
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_token', 'test-jwt-token', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('restaurant_id', 'rest-A', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('backend_url', 'http://mock-backend', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_expires_at', '${Date.now() + 3600000}', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('device_id', '${DEVICE_A}', ?)`).run(Date.now());

  const { pushSyncBatch } = await import("../sync.ts");
  const dbModule = await import("../db.ts");
  const originalGetDb = dbModule.getDb;
  // @ts-ignore
  dbModule.getDb = () => testDb;

  await pushSyncBatch();

  // @ts-ignore
  dbModule.getDb = originalGetDb;

  // Verify the payload contains both records with correct restaurant_ids
  expect(capturedPayload).not.toBeNull();
  expect(capturedPayload.batch).toHaveLength(2);

  const orderAItem = capturedPayload.batch.find((b: any) => b.recordId === "order-A1");
  const orderBItem = capturedPayload.batch.find((b: any) => b.recordId === "order-B1");
  expect(orderAItem).toBeDefined();
  expect(orderBItem).toBeDefined();
  expect(orderAItem.data.restaurant_id).toBe("rest-A");
  expect(orderBItem.data.restaurant_id).toBe("rest-B");
  expect(orderAItem.data.restaurant_id).not.toBe(orderBItem.data.restaurant_id);
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

// ── Test 6: Two-device sync conflict — cloud rejects stale edge data ─────────
// Simulates: Device A creates an order offline. Cloud receives an update from
// Device B that changes the order status. When Device A syncs, the cloud's
// updatedAt is newer than Device A's — this should be flagged as a conflict.
//
// We can't run the real cloud endpoint in this test, but we CAN verify that
// the sync push correctly sends the edge's updatedAt timestamp so the cloud
// can detect the conflict. We also simulate the cloud's rejection response
// and verify the edge handles it correctly (increments attempts, doesn't mark
// as synced).
test("two-device sync conflict — cloud rejects stale edge data, edge retries", async () => {
  testDb.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST006')`);

  const orderId = "conflict-order-001";
  const edgeUpdatedAt = Date.now() - 60_000; // Edge's data is 1 minute stale
  const cloudUpdatedAt = Date.now(); // Cloud has a newer version

  testDb.query(`INSERT INTO order_record (id, restaurant_id, table_number, status, total, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(orderId, RESTAURANT_ID, 5, "SETTLED", 500, Date.now() - 120_000, edgeUpdatedAt);
  testDb.query(`INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`)
    .run("order", orderId, "create", Date.now());

  // Seed session
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_token', 'test-jwt-token', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('restaurant_id', '${RESTAURANT_ID}', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('backend_url', 'http://mock-backend', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_expires_at', '${Date.now() + 3600000}', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('device_id', '${DEVICE_A}', ?)`).run(Date.now());

  // Mock fetch to simulate cloud detecting a conflict and rejecting the record
  let capturedBatch: any = null;
  const fetchMock = mock(async (url: string, opts: any) => {
    const body = JSON.parse(opts.body);
    capturedBatch = body.batch;
    // Cloud rejects because it has a newer updatedAt (conflict)
    return new Response(JSON.stringify({
      accepted: [],
      rejected: [{ queueId: body.batch[0].queueId, error: "Conflict: cloud has newer version" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchMock as any;

  const { pushSyncBatch } = await import("../sync.ts");
  const dbModule = await import("../db.ts");
  const originalGetDb = dbModule.getDb;
  // @ts-ignore
  dbModule.getDb = () => testDb;

  const result = await pushSyncBatch();

  // @ts-ignore
  dbModule.getDb = originalGetDb;

  // The push should succeed at the HTTP level but all records rejected
  expect(result.ok).toBe(true);
  expect(result.pushed).toBe(1);
  expect(result.accepted).toBe(0);
  expect(result.rejected).toBe(1);

  // Verify the edge sent its updatedAt in the payload so cloud could detect conflict
  expect(capturedBatch).toHaveLength(1);
  expect(capturedBatch[0].data.updated_at).toBe(edgeUpdatedAt);

  // Verify the record is NOT marked as synced (it was rejected)
  const queueRow = testDb.query(`SELECT * FROM sync_queue WHERE record_id = ?`).get(orderId) as any;
  expect(queueRow.synced).toBe(0);
  expect(queueRow.attempts).toBe(1);
  expect(queueRow.last_error).toContain("Conflict");
});
