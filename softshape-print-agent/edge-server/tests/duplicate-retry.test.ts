// ─────────────────────────────────────────────────────────────────────────────
// duplicate-retry.test.ts — a retried captain KOT never prints food twice
// ─────────────────────────────────────────────────────────────────────────────
// A captain KOT fails on weak WiFi, the captain walks to the cashier who
// punches the same food, then the phone retries. The billing PC must reject
// that retry (nothing written, nothing printed) — but must still let through a
// retry whose items were only ordered *before* the first attempt.
// Uses the real orderService.ts guard against an in-memory SQLite DB.
// Run: cd edge-server && bun test tests/duplicate-retry.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { setDb } from "../db.ts";
import { createOrder, updateOrderItems, findRetryConflicts } from "../orderService.ts";

const RID = "dup-restaurant";
const TABLE = "table-5";
const ORDER = "order-5";
const MIN = 60_000;

let db: Database;
let kotSeq = 0;

const biryani = { menuItemId: "menu-biryani", name: "Chicken Biryani", price: 300, quantity: 1 };
const naan = { menuItemId: "menu-naan", name: "Butter Naan", price: 60, quantity: 2 };

/** A KOT already on the table, punched at `at` by `captainId` (null = cashier). */
function addKot(at: number, items: { menuItemId: string; name: string; quantity: number }[], captainId: string | null = null) {
  const kotId = `kot-${++kotSeq}`;
  db.query("INSERT INTO kot (id, restaurant_id, table_id, order_id, kot_number, captain_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(kotId, RID, TABLE, ORDER, kotSeq, captainId, at);
  for (const i of items) {
    db.query("INSERT INTO kot_item (id, kot_id, order_item_id, menu_item_id, name, quantity, price, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 'SENT', ?)")
      .run(`${kotId}-${i.menuItemId}`, kotId, `oi-${kotId}`, i.menuItemId, i.name, i.quantity, at);
  }
}

function kotCount() {
  return (db.query("SELECT COUNT(*) AS n FROM kot").get() as any).n;
}

beforeEach(() => {
  kotSeq = 0;
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE "table" (id TEXT PRIMARY KEY, number INTEGER, section_id TEXT, restaurant_id TEXT, status TEXT, workflow_status TEXT,
      captain_id TEXT, guests INTEGER DEFAULT 0, session_started_at INTEGER, current_bill REAL DEFAULT 0, kot_history TEXT DEFAULT '[]',
      discount REAL, section_tag TEXT, revision INTEGER DEFAULT 1, last_command_id TEXT, updated_at INTEGER DEFAULT 0);
    CREATE TABLE section (id TEXT PRIMARY KEY, name TEXT, venue_id TEXT, floor_id TEXT);
    CREATE TABLE venue (id TEXT PRIMARY KEY, name TEXT, venue_type TEXT, kot_enabled INTEGER, kot_printer_name TEXT,
      bill_printer_name TEXT, price_profile_id TEXT, tax_profile_id TEXT);
    CREATE TABLE order_record (id TEXT PRIMARY KEY, table_id TEXT, restaurant_id TEXT, status TEXT, total_amount REAL DEFAULT 0,
      is_deleted INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0, revision INTEGER DEFAULT 1, last_command_id TEXT, last_request_id TEXT);
    CREATE TABLE kot (id TEXT PRIMARY KEY, restaurant_id TEXT, table_id TEXT, order_id TEXT, kot_number INTEGER, counter_date TEXT DEFAULT '',
      captain_id TEXT, created_at INTEGER, cloud_synced INTEGER DEFAULT 0);
    CREATE TABLE kot_item (id TEXT PRIMARY KEY, kot_id TEXT, order_item_id TEXT, menu_item_id TEXT, name TEXT, quantity INTEGER,
      price REAL, notes TEXT, status TEXT DEFAULT 'SENT', created_at INTEGER, cloud_synced INTEGER DEFAULT 0);
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT, outlet_id TEXT);
    CREATE TABLE command_log (id INTEGER PRIMARY KEY AUTOINCREMENT, restaurant_id TEXT NOT NULL, request_id TEXT NOT NULL,
      command_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, device_id TEXT, command_ts INTEGER NOT NULL,
      expected_revision INTEGER, resulting_revision INTEGER, status TEXT NOT NULL, response_json TEXT, error_message TEXT,
      applied_at INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX idx_command_log_dedup ON command_log(restaurant_id, request_id, command_type);
  `);
  setDb(db);
  db.query(`INSERT INTO "table" (id, number, section_id, restaurant_id, status, workflow_status) VALUES (?, 5, 'sec-1', ?, 'OCCUPIED', 'Occupied')`).run(TABLE, RID);
  db.query("INSERT INTO section (id, name, venue_id) VALUES ('sec-1', 'Main Hall', 'venue-1')").run();
  db.query("INSERT INTO venue (id, name, venue_type) VALUES ('venue-1', 'Family Restaurant', 'RESTAURANT')").run();
  db.query("INSERT INTO users (id, name, role, outlet_id) VALUES ('cap-ravi', 'Ravi', 'CAPTAIN', ?)").run(RID);
});

afterEach(() => {
  setDb(null);
});

const retryCreate = (firstAttemptAt: number, extra: Record<string, unknown> = {}) =>
  createOrder(RID, { tableId: TABLE, items: [biryani, naan], requestId: "kot-req-1", firstAttemptAt, sentAt: Date.now(), ...extra });

const retryUpdate = (firstAttemptAt: number, extra: Record<string, unknown> = {}) =>
  updateOrderItems(RID, { orderId: ORDER, tableId: TABLE, items: [biryani, naan], requestId: "kot-req-1", firstAttemptAt, sentAt: Date.now(), ...extra });

function openOrder() {
  db.query("INSERT INTO order_record (id, table_id, restaurant_id, status) VALUES (?, ?, ?, 'PREPARING')").run(ORDER, TABLE, RID);
}

test("cashier opened the table and punched the same food → the captain's retry is rejected, nothing written", async () => {
  const firstAttemptAt = Date.now() - 2 * MIN;
  openOrder();
  addKot(Date.now() - MIN, [{ ...biryani }]);

  const result = await retryCreate(firstAttemptAt);

  expect(result).toMatchObject({ success: false, statusCode: 409, code: "POSSIBLE_DUPLICATE" });
  expect(result.conflicts).toEqual([expect.objectContaining({ name: "Chicken Biryani", quantity: 1, addedBy: "Cashier" })]);
  expect(kotCount()).toBe(1);
});

test("an item ordered BEFORE the first attempt does not block the retry (no lost orders)", () => {
  // Table 5 had a Biryani at 7:30; the captain's KOT for one more Biryani failed at 7:40.
  const firstAttemptAt = Date.now() - 2 * MIN;
  addKot(firstAttemptAt - 10 * MIN, [{ ...biryani }]);

  expect(findRetryConflicts(RID, TABLE, [biryani, naan], { firstAttemptAt, sentAt: Date.now() })).toEqual([]);
});

test("adding items to an open order: same food added since the first attempt → rejected, with who added it", async () => {
  const firstAttemptAt = Date.now() - 2 * MIN;
  openOrder();
  addKot(firstAttemptAt - 10 * MIN, [{ ...biryani }]);
  addKot(Date.now() - 30_000, [{ ...naan }], "cap-ravi");

  const result = await retryUpdate(firstAttemptAt);

  expect(result.code).toBe("POSSIBLE_DUPLICATE");
  expect(result.conflicts).toEqual([expect.objectContaining({ name: "Butter Naan", addedBy: "Ravi" })]);
  expect(kotCount()).toBe(2);
});

test("'Send anyway' skips the check", () => {
  const firstAttemptAt = Date.now() - 2 * MIN;
  addKot(Date.now() - MIN, [{ ...biryani }]);

  expect(findRetryConflicts(RID, TABLE, [biryani], { firstAttemptAt, sentAt: Date.now(), allowDuplicate: true })).toEqual([]);
});

test("different food added since the first attempt does not block the retry", () => {
  const firstAttemptAt = Date.now() - 2 * MIN;
  addKot(Date.now() - MIN, [{ menuItemId: "menu-lassi", name: "Lassi", quantity: 1 }]);

  expect(findRetryConflicts(RID, TABLE, [biryani, naan], { firstAttemptAt, sentAt: Date.now() })).toEqual([]);
});

test("cancelled items added since the first attempt do not count", () => {
  const firstAttemptAt = Date.now() - 2 * MIN;
  addKot(Date.now() - MIN, [{ ...biryani }]);
  db.query("UPDATE kot_item SET status = 'CANCELLED'").run();

  expect(findRetryConflicts(RID, TABLE, [biryani], { firstAttemptAt, sentAt: Date.now() })).toEqual([]);
});

test("the phone's clock being 10 minutes behind the PC is corrected", () => {
  const phoneSkew = -10 * MIN; // phone clock = PC clock − 10 min
  const pcFirstAttempt = Date.now() - 2 * MIN;
  addKot(Date.now() - MIN, [{ ...biryani }]); // cashier, after the first attempt (PC time)
  addKot(pcFirstAttempt - 5 * MIN, [{ ...naan }]); // before the first attempt (PC time)

  const conflicts = findRetryConflicts(RID, TABLE, [biryani, naan], {
    firstAttemptAt: pcFirstAttempt + phoneSkew,
    sentAt: Date.now() + phoneSkew,
  });

  expect(conflicts.map((c) => c.name)).toEqual(["Chicken Biryani"]);
});

test("a retry of a KOT that already went through returns the earlier result instead of printing again", async () => {
  openOrder();
  const earlier = { success: true, orderId: ORDER, kotNumber: 7 };
  db.query(`INSERT INTO command_log (restaurant_id, request_id, command_type, entity_type, entity_id, command_ts, status, response_json)
    VALUES (?, 'kot-req-1', 'createOrder', 'table', ?, ?, 'applied', ?)`).run(RID, TABLE, Date.now(), JSON.stringify(earlier));
  addKot(Date.now() - MIN, [{ ...biryani }]); // the captain's own KOT from that first attempt

  // The phone now thinks the table has an order and retries as an add-on.
  const result = await retryUpdate(Date.now() - 2 * MIN);

  expect(result).toMatchObject(earlier);
  expect(kotCount()).toBe(1);
});

test("a first send (no firstAttemptAt) is not checked", () => {
  addKot(Date.now() - MIN, [{ ...biryani }]);

  expect(findRetryConflicts(RID, TABLE, [biryani], {})).toEqual([]);
});
