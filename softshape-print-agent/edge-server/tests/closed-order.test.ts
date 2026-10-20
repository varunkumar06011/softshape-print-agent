// ─────────────────────────────────────────────────────────────────────────────
// closed-order.test.ts — a paid or cancelled order is final
// ─────────────────────────────────────────────────────────────────────────────
// A captain's phone loses WiFi while the cashier settles the table; when it
// reconnects it sends a KOT for the old order. The kitchen would print it but
// it could never be billed. Likewise a stale cashier screen must not change the
// amount of a bill that is already paid. The billing PC refuses both with
// ORDER_CLOSED and writes nothing.
// Run: cd edge-server && bun test tests/closed-order.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { setDb } from "../db.ts";
import { updateOrderItems, cancelKotItem, cancelKotItems, isOrderClosed } from "../orderService.ts";

const RID = "closed-restaurant";
const TABLE = "table-5";
const ORDER = "order-5";

let db: Database;

const biryani = { menuItemId: "menu-biryani", name: "Chicken Biryani", price: 300, quantity: 1 };

function openOrder(status: string, isDeleted = 0) {
  db.query("INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, is_deleted) VALUES (?, ?, ?, ?, 900, ?)").run(ORDER, TABLE, RID, status, isDeleted);
  db.query("INSERT INTO order_item (id, order_id, menu_item_id, name, price, quantity) VALUES ('oi-1', ?, 'menu-biryani', 'Chicken Biryani', 300, 3)").run(ORDER);
  db.query("INSERT INTO kot_item (id, kot_id, order_item_id, menu_item_id, name, quantity, price, status) VALUES ('ki-1', 'kot-1', 'oi-1', 'menu-biryani', 'Chicken Biryani', 3, 300, 'PENDING')").run();
}

const add = () => updateOrderItems(RID, { orderId: ORDER, tableId: TABLE, items: [biryani], requestId: "late-kot" });
const cancelOne = () => cancelKotItem({ orderId: ORDER, restaurantId: RID, orderItemId: "oi-1", cancelQuantity: 1, cancelledBy: "Cashier", requestId: "late-cancel" });

const state = () => ({
  kots: (db.query("SELECT COUNT(*) AS n FROM kot").get() as any).n,
  qty: (db.query("SELECT quantity FROM order_item WHERE id = 'oi-1'").get() as any).quantity,
  total: (db.query("SELECT total_amount FROM order_record WHERE id = ?").get(ORDER) as any).total_amount,
});

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE "table" (id TEXT PRIMARY KEY, number INTEGER, section_id TEXT, restaurant_id TEXT, status TEXT, workflow_status TEXT,
      captain_id TEXT, guests INTEGER DEFAULT 0, session_started_at INTEGER, current_bill REAL DEFAULT 0, kot_history TEXT DEFAULT '[]',
      discount REAL, section_tag TEXT, revision INTEGER DEFAULT 1, last_command_id TEXT, updated_at INTEGER DEFAULT 0);
    CREATE TABLE order_record (id TEXT PRIMARY KEY, table_id TEXT, restaurant_id TEXT, status TEXT, total_amount REAL DEFAULT 0,
      is_deleted INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0, revision INTEGER DEFAULT 1, last_command_id TEXT, last_request_id TEXT);
    CREATE TABLE order_item (id TEXT PRIMARY KEY, order_id TEXT, menu_item_id TEXT, name TEXT, price REAL, quantity INTEGER,
      menu_type TEXT, cancelled_quantity INTEGER DEFAULT 0, removed_from_bill INTEGER DEFAULT 0);
    CREATE TABLE kot (id TEXT PRIMARY KEY, restaurant_id TEXT, table_id TEXT, order_id TEXT, kot_number INTEGER, counter_date TEXT DEFAULT '',
      captain_id TEXT, created_at INTEGER, cloud_synced INTEGER DEFAULT 0);
    CREATE TABLE kot_item (id TEXT PRIMARY KEY, kot_id TEXT, order_item_id TEXT, menu_item_id TEXT, name TEXT, quantity INTEGER,
      price REAL, notes TEXT, status TEXT DEFAULT 'SENT', created_at INTEGER, cloud_synced INTEGER DEFAULT 0);
    CREATE TABLE outlet (id TEXT PRIMARY KEY, name TEXT, printer_config TEXT, enabled_modules TEXT);
    CREATE TABLE section (id TEXT PRIMARY KEY, name TEXT, venue_id TEXT, floor_id TEXT);
    CREATE TABLE venue (id TEXT PRIMARY KEY, name TEXT, venue_type TEXT, kot_enabled INTEGER, kot_printer_name TEXT,
      bill_printer_name TEXT, price_profile_id TEXT, tax_profile_id TEXT);
    CREATE TABLE command_log (id INTEGER PRIMARY KEY AUTOINCREMENT, restaurant_id TEXT NOT NULL, request_id TEXT NOT NULL,
      command_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, device_id TEXT, command_ts INTEGER NOT NULL,
      expected_revision INTEGER, resulting_revision INTEGER, status TEXT NOT NULL, response_json TEXT, error_message TEXT,
      applied_at INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX idx_command_log_dedup ON command_log(restaurant_id, request_id, command_type);
  `);
  setDb(db);
  db.query(`INSERT INTO "table" (id, number, section_id, restaurant_id, status, workflow_status) VALUES (?, 5, 'sec-1', ?, 'AVAILABLE', 'Free')`).run(TABLE, RID);
  db.query("INSERT INTO section (id, name, venue_id) VALUES ('sec-1', 'Main Hall', 'venue-1')").run();
  db.query("INSERT INTO venue (id, name, venue_type) VALUES ('venue-1', 'Family Restaurant', 'RESTAURANT')").run();
});

afterEach(() => {
  setDb(null);
});

test("adding items to a paid order is refused, nothing is written or printed", async () => {
  openOrder("PAID");
  const before = state();

  const result = await add();

  expect(result).toMatchObject({ success: false, statusCode: 409, code: "ORDER_CLOSED", error: "This table was already billed and paid" });
  expect(state()).toEqual(before);
});

test("adding items to a settled order is refused the same way", async () => {
  openOrder("SETTLED");
  expect(await add()).toMatchObject({ success: false, code: "ORDER_CLOSED" });
});

test("adding items to a cancelled order says it was cancelled", async () => {
  openOrder("CANCELLED");
  expect(await add()).toMatchObject({ success: false, code: "ORDER_CLOSED", error: "This order was already cancelled" });
});

test("a deleted order is closed whatever its status says", async () => {
  openOrder("PREPARING", 1);
  expect(await add()).toMatchObject({ success: false, code: "ORDER_CLOSED" });
});

test("cancelling an item on a paid order is refused and the bill does not change", async () => {
  openOrder("SETTLED");
  const before = state();

  const result = await cancelOne();

  expect(result).toMatchObject({ success: false, code: "ORDER_CLOSED" });
  expect(state()).toEqual(before);
});

test("a cancel batch on a paid order cancels nothing", async () => {
  openOrder("PAID");
  const before = state();

  const result = await cancelKotItems({ orderId: ORDER, restaurantId: RID, items: [{ orderItemId: "oi-1", cancelQuantity: 2 }], cancelledBy: "Cashier", requestId: "late-batch" });

  expect(result).toMatchObject({ success: false, status: 409 });
  expect(state()).toEqual(before);
});

test("an open order is not affected: cancelling still works", async () => {
  openOrder("PREPARING");

  const result = await cancelOne();

  expect(result.success).toBe(true);
  expect(state().qty).toBe(2);
});

test("open statuses are not closed", () => {
  for (const status of ["PENDING", "CONFIRMED", "PREPARING", "READY", "BILLING_REQUESTED"]) {
    expect(isOrderClosed({ status, is_deleted: 0 })).toBe(false);
  }
  expect(isOrderClosed(null)).toBe(false);
});
