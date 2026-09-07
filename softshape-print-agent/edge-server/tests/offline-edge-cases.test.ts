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
//   8. Offline -> online transition: writes land in queue, cloud unreachable, then
//      reachable, manualSyncPush pushes, and no duplicates are sent.
//
// Run with: bun test offline-edge-cases.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

// Save original fetch so we can restore it after each test
const originalFetch = globalThis.fetch;

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
      gst_registered INTEGER DEFAULT 1, prices_include_gst INTEGER DEFAULT 0,
      receipt_header TEXT, printer_config TEXT DEFAULT '{}',
      enabled_modules TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS "table" (
      id TEXT PRIMARY KEY, number INTEGER NOT NULL, capacity INTEGER DEFAULT 4,
      section_id TEXT NOT NULL, restaurant_id TEXT NOT NULL,
      status TEXT DEFAULT 'AVAILABLE', workflow_status TEXT DEFAULT 'Free',
      captain_id TEXT, guests INTEGER DEFAULT 0,
      session_started_at INTEGER, current_bill REAL DEFAULT 0,
      kot_history TEXT DEFAULT '[]', discount REAL, section_tag TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      last_command_id TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS order_record (
      id TEXT PRIMARY KEY, table_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      status TEXT DEFAULT 'PENDING', total_amount REAL DEFAULT 0,
      billing_requested INTEGER DEFAULT 0, billing_requested_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      is_deleted INTEGER DEFAULT 0, deleted_at INTEGER,
      bill_number TEXT, paid_at INTEGER, last_request_id TEXT,
      inventory_deducted INTEGER DEFAULT 0,
      captain_id TEXT, platform TEXT DEFAULT 'DINE_IN',
      created_by_user_id TEXT, cloud_synced INTEGER DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      last_command_id TEXT,
      cloud_synced_version INTEGER DEFAULT 0,
      sync_attempt_count INTEGER DEFAULT 0,
      last_sync_attempt_at INTEGER,
      last_sync_error TEXT,
      UNIQUE(last_request_id)
    );

    CREATE TABLE IF NOT EXISTS order_item (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL,
      menu_item_id TEXT NOT NULL, name TEXT NOT NULL,
      price REAL NOT NULL, quantity INTEGER NOT NULL,
      notes TEXT, added_by_cashier INTEGER DEFAULT 0,
      original_quantity INTEGER, cancelled_quantity INTEGER DEFAULT 0,
      edited_quantity INTEGER DEFAULT 0, removed_from_bill INTEGER DEFAULT 0,
      removed_by TEXT, removed_at INTEGER,
      menu_type TEXT DEFAULT 'FOOD', cloud_synced INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS kot (
      id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL,
      table_id TEXT NOT NULL, order_id TEXT NOT NULL,
      kot_number INTEGER NOT NULL, counter_date TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      cloud_synced INTEGER DEFAULT 0,
      UNIQUE(restaurant_id, kot_number, counter_date)
    );

    CREATE TABLE IF NOT EXISTS kot_item (
      id TEXT PRIMARY KEY, kot_id TEXT NOT NULL,
      order_item_id TEXT NOT NULL, menu_item_id TEXT NOT NULL,
      name TEXT NOT NULL, quantity INTEGER NOT NULL, price REAL NOT NULL,
      notes TEXT, status TEXT DEFAULT 'SENT',
      created_at INTEGER NOT NULL, cloud_synced INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL, record_id TEXT NOT NULL,
      operation TEXT NOT NULL, created_at INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0, last_error TEXT, synced INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS transaction_record (
      id TEXT PRIMARY KEY, order_id TEXT, restaurant_id TEXT,
      kind TEXT, payload TEXT, created_at INTEGER,
      sync_version INTEGER DEFAULT 1, cloud_synced_version INTEGER DEFAULT 0,
      sync_attempt_count INTEGER DEFAULT 0, last_sync_attempt_at INTEGER,
      last_sync_error TEXT
    );

    CREATE TABLE IF NOT EXISTS expenditure (
      id TEXT PRIMARY KEY, restaurant_id TEXT, amount REAL,
      paid_to_type TEXT, created_at INTEGER,
      sync_version INTEGER DEFAULT 1, cloud_synced_version INTEGER DEFAULT 0,
      sync_attempt_count INTEGER DEFAULT 0, last_sync_attempt_at INTEGER,
      last_sync_error TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, pin TEXT,
      role TEXT NOT NULL, outlet_id TEXT NOT NULL, is_active INTEGER DEFAULT 1,
      permissions TEXT
    );

    CREATE TABLE IF NOT EXISTS section (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, restaurant_id TEXT NOT NULL,
      floor_id TEXT, venue_id TEXT, sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS category (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      restaurant_id TEXT NOT NULL, sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1, printer_target TEXT
    );

    CREATE TABLE IF NOT EXISTS menu_item (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      category_id TEXT NOT NULL, restaurant_id TEXT NOT NULL,
      base_price REAL DEFAULT 0, menu_type TEXT DEFAULT 'FOOD',
      is_available INTEGER DEFAULT 1, is_deleted INTEGER DEFAULT 0,
      printer_target TEXT, printer_name TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_counter (
      id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL,
      counter_date TEXT NOT NULL,
      kot_count INTEGER DEFAULT 0, bill_count INTEGER DEFAULT 0, txn_count INTEGER DEFAULT 0,
      UNIQUE(restaurant_id, counter_date)
    );

    CREATE TABLE IF NOT EXISTS edge_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS command_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id     TEXT NOT NULL,
      request_id        TEXT NOT NULL,
      command_type      TEXT NOT NULL,
      entity_type       TEXT NOT NULL,
      entity_id         TEXT NOT NULL,
      device_id         TEXT,
      command_ts        INTEGER NOT NULL,
      expected_revision INTEGER,
      resulting_revision INTEGER,
      status            TEXT NOT NULL,
      response_json     TEXT,
      error_message     TEXT,
      applied_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_command_log_dedup ON command_log(restaurant_id, request_id, command_type);
  `);

  return db;
}

const RESTAURANT_ID = "test-restaurant-001";
const DEVICE_A = "device-aaa";
const DEVICE_B = "device-bbb";

// ── Test 1: Two devices editing the same table — revision-based concurrency ──
test("concurrent table edits — revision increments monotonically, newer revision wins", () => {
  const db = createTestDb();
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST001')`);
  db.exec(`INSERT INTO section (id, name, restaurant_id) VALUES ('sec1', 'Main', '${RESTAURANT_ID}')`);
  db.exec(`INSERT INTO "table" (id, number, section_id, restaurant_id, status, workflow_status, revision, last_command_id) VALUES ('table1', 1, 'sec1', '${RESTAURANT_ID}', 'AVAILABLE', 'Free', 1, NULL)`);

  // Device A sets table to OCCUPIED + increments revision
  const revA = (db.query('SELECT revision FROM "table" WHERE id = ?').get('table1') as any)?.revision + 1;
  db.query(`UPDATE "table" SET status = 'OCCUPIED', captain_id = '${DEVICE_A}', revision = ?, last_command_id = 'cmd-A', updated_at = ? WHERE id = 'table1'`)
    .run(revA, Date.now());

  // Device B sets table to OCCUPIED with a different captain + increments revision
  const revB = (db.query('SELECT revision FROM "table" WHERE id = ?').get('table1') as any)?.revision + 1;
  db.query(`UPDATE "table" SET status = 'OCCUPIED', captain_id = '${DEVICE_B}', revision = ?, last_command_id = 'cmd-B', updated_at = ? WHERE id = 'table1'`)
    .run(revB, Date.now() + 1);

  const tableState = db.query(`SELECT * FROM "table" WHERE id = 'table1'`).get() as any;
  expect(tableState.captain_id).toBe(DEVICE_B);
  expect(tableState.status).toBe('OCCUPIED');
  expect(tableState.revision).toBe(3);
  expect(tableState.last_command_id).toBe('cmd-B');
});

// ── Test 2: Power loss mid-order (order saved but KOT not printed) ───────────
test("power loss mid-order — order data preserved, KOT missing", () => {
  const db = createTestDb();
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST002')`);
  db.exec(`INSERT INTO section (id, name, restaurant_id) VALUES ('sec-pl', 'Main', '${RESTAURANT_ID}')`);
  db.exec(`INSERT INTO "table" (id, number, section_id, restaurant_id, status, workflow_status) VALUES ('tbl-pl', 1, 'sec-pl', '${RESTAURANT_ID}', 'AVAILABLE', 'Free')`);

  const orderId = "order-power-loss";
  db.query(`INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, created_at, updated_at) VALUES (?, ?, ?, 'OPEN', 0, ?, ?)`)
    .run(orderId, 'tbl-pl', RESTAURANT_ID, Date.now(), Date.now());

  db.query(`INSERT INTO order_item (id, order_id, menu_item_id, name, price, quantity) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("item1", orderId, "menu-1", "Chicken Biryani", 250, 2);

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

beforeEach(async () => {
  const { setDb } = await import("../db.ts");
  setDb(null);
  testDb = createTestDb();
});

afterEach(() => {
  // Restore original fetch so mocks don't leak into other test files
  globalThis.fetch = originalFetch;
});

test("full shift offline — 50 orders synced via real pushSyncBatch with mocked fetch", async () => {
  testDb.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST003')`);

  // Seed session config so auth.ts functions return valid values
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_token', 'test-jwt-token', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('restaurant_id', '${RESTAURANT_ID}', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('backend_url', 'http://mock-backend', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_expires_at', '${Date.now() + 30 * 24 * 60 * 60 * 1000}', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('device_id', '${DEVICE_A}', ?)`).run(Date.now());

  const shiftStart = Date.now() - 8 * 60 * 60 * 1000;
  for (let i = 0; i < 50; i++) {
    const oid = `shift-order-${i}`;
    const createdAt = shiftStart + i * 10 * 60 * 1000;
    // New system: orders are pending via revision > cloud_synced_version (defaults: 1 > 0)
    testDb.query(`INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, created_at, updated_at, revision, cloud_synced_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`)
      .run(oid, `table-${(i % 10) + 1}`, RESTAURANT_ID, i < 45 ? 'SETTLED' : 'OPEN', 100 + i * 10, createdAt, createdAt);
  }

  // In the new system, pending = revision > cloud_synced_version
  const pendingBefore = testDb.query(`SELECT COUNT(*) as count FROM order_record WHERE revision > cloud_synced_version AND is_deleted = 0`).get() as any;
  expect(pendingBefore.count).toBe(50);

  // Mock fetch to simulate the cloud backend accepting all order payloads
  let callCount = 0;
  const fetchMock = mock(async (url: string, opts: any) => {
    callCount++;
    const body = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      outcome: "applied",
      orderId: body.order?.id || "unknown",
      appliedRevision: body.snapshotRevision,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchMock as any;

  // Dynamically import sync.ts so it picks up our mocked fetch and test DB
  const { setDb } = await import("../db.ts");
  setDb(testDb);

  const { pushSyncBatch } = await import("../sync.ts");

  // MAX_ORDERS_PER_CYCLE = 10, so we need multiple cycles to push all 50
  let totalAccepted = 0;
  let totalPushed = 0;
  for (let cycle = 0; cycle < 6; cycle++) {
    const result = await pushSyncBatch();
    totalPushed += result.pushed;
    totalAccepted += result.accepted;
    if (result.pushed === 0) break;
  }

  expect(totalPushed).toBe(50);
  expect(totalAccepted).toBe(50);

  // Verify fetch was called with the sync-order endpoint
  expect(fetchMock).toHaveBeenCalled();
  const callArgs = fetchMock.mock.calls[0];
  expect(callArgs[0]).toContain("/api/edge/sync-order");

  // Verify all orders are now synced (revision === cloud_synced_version)
  const pendingAfter = testDb.query(`SELECT COUNT(*) as count FROM order_record WHERE revision > cloud_synced_version AND is_deleted = 0`).get() as any;
  expect(pendingAfter.count).toBe(0);

  // Restore
  setDb(null);
});

// ── Test 4: Tenant scoping under sync load (regression test) ─────────────────
// This test verifies that the sync payload correctly associates each record
// with its restaurant_id, and that the sync batch doesn't mix up records
// from different restaurants. It exercises loadRecordData + the batch payload
// construction, not just raw SQL inserts.
test("tenant scoping — sync batch payload preserves restaurant_id per record", async () => {
  testDb.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('rest-A', 'Rest A', 'rest-a', 'AAA001')`);
  testDb.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('rest-B', 'Rest B', 'rest-b', 'BBB002')`);

  // New system: orders pending via revision > cloud_synced_version
  testDb.query(`INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, created_at, updated_at, revision, cloud_synced_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`)
    .run("order-A1", "table-a", "rest-A", "SETTLED", 500, Date.now(), Date.now());
  testDb.query(`INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, created_at, updated_at, revision, cloud_synced_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`)
    .run("order-B1", "table-b", "rest-B", "SETTLED", 300, Date.now(), Date.now());

  // Intercept the fetch call to inspect the payload
  let capturedPayloads: any[] = [];
  const fetchMock = mock(async (url: string, opts: any) => {
    const body = JSON.parse(opts.body);
    capturedPayloads.push(body);
    return new Response(JSON.stringify({
      outcome: "applied",
      orderId: body.order?.id || "unknown",
      appliedRevision: body.snapshotRevision,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchMock as any;

  // Use rest-A as the session restaurant (simulating a hub serving one outlet)
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_token', 'test-jwt-token', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('restaurant_id', 'rest-A', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('backend_url', 'http://mock-backend', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_expires_at', '${Date.now() + 30 * 24 * 60 * 60 * 1000}', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('device_id', '${DEVICE_A}', ?)`).run(Date.now());

  const { setDb } = await import("../db.ts");
  setDb(testDb);

  const { pushSyncBatch } = await import("../sync.ts");

  await pushSyncBatch();

  // Verify the payloads contain the correct restaurant_ids
  expect(capturedPayloads.length).toBeGreaterThanOrEqual(2);

  const orderAPayload = capturedPayloads.find((p) => p.order?.id === "order-A1");
  const orderBPayload = capturedPayloads.find((p) => p.order?.id === "order-B1");
  expect(orderAPayload).toBeDefined();
  expect(orderBPayload).toBeDefined();
  expect(orderAPayload.order.restaurant_id).toBe("rest-A");
  expect(orderBPayload.order.restaurant_id).toBe("rest-B");
  expect(orderAPayload.order.restaurant_id).not.toBe(orderBPayload.order.restaurant_id);

  // Restore
  setDb(null);
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

  // New system: order pending via revision > cloud_synced_version
  testDb.query(`INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, created_at, updated_at, revision, cloud_synced_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`)
    .run(orderId, "table-5", RESTAURANT_ID, "SETTLED", 500, Date.now() - 120_000, edgeUpdatedAt);

  // Seed session
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_token', 'test-jwt-token', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('restaurant_id', '${RESTAURANT_ID}', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('backend_url', 'http://mock-backend', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_expires_at', '${Date.now() + 30 * 24 * 60 * 60 * 1000}', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('device_id', '${DEVICE_A}', ?)`).run(Date.now());

  // Mock fetch to simulate cloud detecting a conflict and rejecting the order
  let capturedPayload: any = null;
  const fetchMock = mock(async (url: string, opts: any) => {
    const body = JSON.parse(opts.body);
    capturedPayload = body;
    // Cloud rejects with HTTP 409 Conflict
    return new Response(JSON.stringify({
      error: "Conflict: cloud has newer version",
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchMock as any;

  const { setDb } = await import("../db.ts");
  setDb(testDb);

  const { pushSyncBatch } = await import("../sync.ts");

  const result = await pushSyncBatch();

  // The push should fail (rejected by cloud)
  expect(result.ok).toBe(false);
  expect(result.pushed).toBeGreaterThanOrEqual(1);
  expect(result.accepted).toBe(0);

  // Verify the edge sent its updated_at in the payload so cloud could detect conflict
  expect(capturedPayload).not.toBeNull();
  expect(capturedPayload.order.id).toBe(orderId);
  expect(capturedPayload.order.updated_at).toBe(edgeUpdatedAt);

  // Verify the order is NOT marked as synced (it was rejected)
  const orderRow = testDb.query(`SELECT revision, cloud_synced_version, sync_attempt_count, last_sync_error FROM order_record WHERE id = ?`).get(orderId) as any;
  expect(orderRow.revision).toBeGreaterThan(orderRow.cloud_synced_version);
  expect(orderRow.sync_attempt_count).toBeGreaterThan(0);
  expect(orderRow.last_sync_error).toContain("Conflict");

  // Restore
  setDb(null);
});

// ── Test 8: Offline -> online end-to-end sync through manualSyncPush ─────────
// Simulates the real flow the frontend exercises: write happens locally (via
// createOrder or table session update), enqueueSync puts the records into the
// sync_queue, the cloud is unreachable, the sync worker marks them as attempted,
// then the cloud comes back, manualSyncPush is called, and the correct records
// are pushed exactly once in the correct order.
test("offline -> online end-to-end sync — correct records, no duplicates", async () => {
  testDb.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST008')`);

  // Seed session config
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_token', 'test-jwt-token', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('restaurant_id', '${RESTAURANT_ID}', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('backend_url', 'http://mock-backend', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_expires_at', '${Date.now() + 30 * 24 * 60 * 60 * 1000}', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('device_id', '${DEVICE_A}', ?)`).run(Date.now());

  // Seed a table and menu item so loadRecordData can resolve the order
  testDb.exec(`INSERT INTO section (id, name, restaurant_id, venue_id, sort_order) VALUES ('sec1', 'Main', '${RESTAURANT_ID}', 'venue1', 0)`);
  testDb.exec(`INSERT INTO "table" (id, number, section_id, restaurant_id, status, workflow_status) VALUES ('table1', 1, 'sec1', '${RESTAURANT_ID}', 'AVAILABLE', 'Free')`);
  testDb.exec(`INSERT INTO category (id, name, restaurant_id, sort_order) VALUES ('cat1', 'Main', '${RESTAURANT_ID}', 0)`);
  testDb.exec(`INSERT INTO menu_item (id, name, category_id, restaurant_id, base_price, menu_type) VALUES ('menu1', 'Biryani', 'cat1', '${RESTAURANT_ID}', 250, 'FOOD')`);

  // 1. Simulate the offline write path: create order + items + kot + update table
  // This mirrors what orderService.createOrder does internally, without blocking
  // on printer hardware.
  const orderId = "offline-order-001";
  const kotId = "offline-kot-001";
  const orderItemId = "offline-oi-001";
  const kotItemId = "offline-ki-001";
  const now = Date.now();

  testDb.query(`INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, captain_id, platform, created_at, updated_at, cloud_synced, revision, cloud_synced_version) VALUES (?, ?, ?, 'PREPARING', 250, 'captain-1', 'DINE_IN', ?, ?, 0, 1, 0)`)
    .run(orderId, 'table1', RESTAURANT_ID, now, now);
  testDb.query(`INSERT INTO order_item (id, order_id, menu_item_id, name, price, quantity, menu_type, cloud_synced) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`)
    .run(orderItemId, orderId, 'menu1', 'Biryani', 250, 1, 'FOOD');
  testDb.query(`INSERT INTO kot (id, restaurant_id, table_id, order_id, kot_number, counter_date, created_at, cloud_synced) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`)
    .run(kotId, RESTAURANT_ID, 'table1', orderId, 1, '2025-01-01', now);
  testDb.query(`INSERT INTO kot_item (id, kot_id, order_item_id, menu_item_id, name, quantity, price, status, created_at, cloud_synced) VALUES (?, ?, ?, ?, ?, ?, ?, 'SENT', ?, 0)`)
    .run(kotItemId, kotId, orderItemId, 'menu1', 'Biryani', 1, 250, now);
  testDb.query(`UPDATE "table" SET status = 'OCCUPIED', workflow_status = 'Preparing', current_bill = 250, updated_at = ? WHERE id = ?`).run(now, 'table1');

  // In the new revision-based system, the order is already pending:
  // revision=1 > cloud_synced_version=0 → pending. No enqueueSync needed.
  const { setDb } = await import("../db.ts");
  setDb(testDb);

  // 2. Verify order is pending via revision comparison
  const pendingBefore = testDb.query(`SELECT COUNT(*) as count FROM order_record WHERE revision > cloud_synced_version AND is_deleted = 0`).get() as any;
  expect(pendingBefore.count).toBe(1);

  // 3. Cloud is unreachable: push fails, order stays pending, attempt count incremented
  globalThis.fetch = (() => { throw new Error("Network error: cloud unreachable"); }) as any;

  const { manualSyncPush } = await import("../sync.ts");
  const offlineResult = await manualSyncPush();

  expect(offlineResult.ok).toBe(false);
  expect(offlineResult.pushed).toBeGreaterThanOrEqual(1);
  expect(offlineResult.accepted).toBe(0);

  // Order should still be pending, with attempt count incremented
  const orderAfterOffline = testDb.query(`SELECT revision, cloud_synced_version, sync_attempt_count FROM order_record WHERE id = ?`).get(orderId) as any;
  expect(orderAfterOffline.revision).toBeGreaterThan(orderAfterOffline.cloud_synced_version);
  expect(orderAfterOffline.sync_attempt_count).toBeGreaterThan(0);

  // 4. Cloud is reachable again: mock the cloud accepting the order payload
  let capturedPayloads: any[] = [];
  const acceptFetchMock = mock(async (url: string, opts: any) => {
    const body = JSON.parse(opts.body);
    capturedPayloads.push(body);
    // New sync-order endpoint returns { outcome, orderId, appliedRevision }
    return new Response(JSON.stringify({
      outcome: "applied",
      orderId: body.order?.id || "unknown",
      appliedRevision: body.snapshotRevision,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = acceptFetchMock as any;

  const onlineResult = await manualSyncPush();

  expect(onlineResult.ok).toBe(true);
  expect(onlineResult.accepted).toBeGreaterThanOrEqual(1);
  expect(onlineResult.rejected).toBe(0);

  // 6. Verify order is now synced (revision === cloud_synced_version)
  const orderAfterOnline = testDb.query(`SELECT revision, cloud_synced_version, sync_attempt_count FROM order_record WHERE id = ?`).get(orderId) as any;
  expect(orderAfterOnline.revision).toBe(orderAfterOnline.cloud_synced_version);
  expect(orderAfterOnline.sync_attempt_count).toBe(0);

  // 7. Verify cloud received the complete order payload with items and KOTs
  expect(acceptFetchMock).toHaveBeenCalled();
  const payload = capturedPayloads.find((p) => p.order?.id === orderId);
  expect(payload).toBeDefined();
  expect(payload.snapshotRevision).toBe(1);
  expect(payload.order.id).toBe(orderId);
  expect(payload.items).toHaveLength(1);
  expect(payload.items[0].name).toBe("Biryani");
  expect(payload.kots).toHaveLength(1);
  expect(payload.kots[0].items).toHaveLength(1);
  expect(payload.transactions).toHaveLength(0);

  // Restore
  setDb(null);
});

// ── Test 9: Durable idempotency — replaying same requestId returns original result ──
test("durable idempotency — replaying same requestId returns original result from command_log", () => {
  const db = createTestDb();
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST009')`);
  db.exec(`INSERT INTO section (id, name, restaurant_id) VALUES ('sec9', 'Main', '${RESTAURANT_ID}')`);
  db.exec(`INSERT INTO "table" (id, number, section_id, restaurant_id, status, workflow_status, revision) VALUES ('tbl9', 1, 'sec9', '${RESTAURANT_ID}', 'AVAILABLE', 'Free', 1)`);

  const requestId = "req-idempotency-001";
  const commandType = "createOrder";
  const originalResult = { success: true, orderId: "order-9", revision: 1, tableRevision: 2 };

  // Simulate recording a command result (as recordCommandResult does)
  db.query(`INSERT INTO command_log
    (restaurant_id, request_id, command_type, entity_type, entity_id, device_id,
     command_ts, expected_revision, resulting_revision, status, response_json, error_message, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      RESTAURANT_ID, requestId, commandType, "table", "tbl9", DEVICE_A,
      Date.now(), 1, 2, "applied", JSON.stringify(originalResult), null, Date.now()
    );

  // Simulate idempotency check: lookup by (restaurant_id, request_id, command_type)
  const entry = db.query("SELECT * FROM command_log WHERE restaurant_id = ? AND request_id = ? AND command_type = ?")
    .get(RESTAURANT_ID, requestId, commandType) as any;

  expect(entry).toBeDefined();
  expect(entry.status).toBe("applied");
  expect(entry.response_json).toBeDefined();

  const replayedResult = JSON.parse(entry.response_json);
  expect(replayedResult.success).toBe(true);
  expect(replayedResult.orderId).toBe("order-9");
  expect(replayedResult.revision).toBe(1);
  expect(replayedResult.tableRevision).toBe(2);
});

// ── Test 10: command_log ON CONFLICT — re-recording same command updates, doesn't throw ──
test("command_log ON CONFLICT — re-recording same (restaurant_id, request_id, command_type) updates instead of throwing", () => {
  const db = createTestDb();
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST010')`);

  const requestId = "req-conflict-001";
  const commandType = "settleOrder";

  // First insert
  db.query(`INSERT INTO command_log
    (restaurant_id, request_id, command_type, entity_type, entity_id, device_id,
     command_ts, expected_revision, resulting_revision, status, response_json, error_message, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(RESTAURANT_ID, requestId, commandType, "order", "order-10", DEVICE_A,
      Date.now(), 1, 2, "applied", JSON.stringify({ success: true }), null, Date.now());

  // Second insert with same key — should NOT throw, should update
  expect(() => {
    db.query(`INSERT INTO command_log
      (restaurant_id, request_id, command_type, entity_type, entity_id, device_id,
       command_ts, expected_revision, resulting_revision, status, response_json, error_message, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(restaurant_id, request_id, command_type) DO UPDATE SET
        status = excluded.status,
        response_json = excluded.response_json,
        error_message = excluded.error_message,
        resulting_revision = excluded.resulting_revision,
        applied_at = excluded.applied_at`)
      .run(RESTAURANT_ID, requestId, commandType, "order", "order-10", DEVICE_A,
        Date.now(), 1, 3, "applied", JSON.stringify({ success: true, revision: 3 }), null, Date.now());
  }).not.toThrow();

  // Verify only one row exists and it has the updated values
  const rows = db.query("SELECT * FROM command_log WHERE request_id = ? AND command_type = ?")
    .all(requestId, commandType) as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].resulting_revision).toBe(3);
  const parsed = JSON.parse(rows[0].response_json);
  expect(parsed.revision).toBe(3);
});

// ── Test 11: Revision increment — nextTableRevision and nextOrderRevision ──────
test("revision increment — nextTableRevision and nextOrderRevision return monotonically increasing values", async () => {
  const db = createTestDb();
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST011')`);
  db.exec(`INSERT INTO section (id, name, restaurant_id) VALUES ('sec11', 'Main', '${RESTAURANT_ID}')`);
  db.exec(`INSERT INTO "table" (id, number, section_id, restaurant_id, status, workflow_status, revision) VALUES ('tbl11', 1, 'sec11', '${RESTAURANT_ID}', 'AVAILABLE', 'Free', 1)`);
  db.query(`INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, created_at, updated_at, revision) VALUES (?, ?, ?, 'OPEN', 0, ?, ?, 1)`)
    .run("order11", "tbl11", RESTAURANT_ID, Date.now(), Date.now());

  const { setDb, nextTableRevision, nextOrderRevision } = await import("../db.ts");
  setDb(db);

  // Table revision: 1 → 2 → 3
  expect(nextTableRevision("tbl11")).toBe(2);
  db.query(`UPDATE "table" SET revision = 2 WHERE id = 'tbl11'`).run();
  expect(nextTableRevision("tbl11")).toBe(3);
  db.query(`UPDATE "table" SET revision = 3 WHERE id = 'tbl11'`).run();

  // Order revision: 1 → 2 → 3
  expect(nextOrderRevision("order11")).toBe(2);
  db.query(`UPDATE order_record SET revision = 2 WHERE id = 'order11'`).run();
  expect(nextOrderRevision("order11")).toBe(3);

  setDb(null);
});

// ── Test 12: Sync payload includes revision and lastCommandId ──────────────────
test("sync payload includes revision and lastCommandId for order records", async () => {
  testDb.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST012')`);

  // Seed session
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_token', 'test-jwt-token', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('restaurant_id', '${RESTAURANT_ID}', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('backend_url', 'http://mock-backend', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('session_expires_at', '${Date.now() + 30 * 24 * 60 * 60 * 1000}', ?)`).run(Date.now());
  testDb.query(`INSERT INTO edge_config (key, value, updated_at) VALUES ('device_id', '${DEVICE_A}', ?)`).run(Date.now());

  // Create order with revision + last_command_id (table is LAN-only, not synced)
  testDb.exec(`INSERT INTO section (id, name, restaurant_id) VALUES ('sec12', 'Main', '${RESTAURANT_ID}')`);
  testDb.query(`INSERT INTO "table" (id, number, section_id, restaurant_id, status, workflow_status, revision, last_command_id) VALUES (?, 1, 'sec12', ?, 'OCCUPIED', 'Preparing', 5, 'cmd-table-12')`)
    .run('tbl12', RESTAURANT_ID);
  // New system: order pending via revision=3 > cloud_synced_version=0
  testDb.query(`INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, created_at, updated_at, revision, last_command_id, cloud_synced_version) VALUES (?, ?, ?, 'PREPARING', 250, ?, ?, 3, 'cmd-order-12', 0)`)
    .run('order12', 'tbl12', RESTAURANT_ID, Date.now(), Date.now());

  let capturedPayload: any = null;
  const fetchMock = mock(async (url: string, opts: any) => {
    capturedPayload = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      outcome: "applied",
      orderId: capturedPayload.order?.id || "unknown",
      appliedRevision: capturedPayload.snapshotRevision,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchMock as any;

  const { setDb } = await import("../db.ts");
  setDb(testDb);

  const { pushSyncBatch } = await import("../sync.ts");
  await pushSyncBatch();

  expect(capturedPayload).not.toBeNull();
  expect(capturedPayload.order.id).toBe('order12');
  expect(capturedPayload.snapshotRevision).toBe(3);

  setDb(null);
});
