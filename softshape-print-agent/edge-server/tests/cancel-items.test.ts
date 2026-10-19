// ─────────────────────────────────────────────────────────────────────────────
// cancel-items.test.ts — cashier cancel dialog (POST /api/edge/order/cancel-items)
// ─────────────────────────────────────────────────────────────────────────────
// Uses the real orderService.ts cancelKotItems/cancelKotItem against an
// in-memory SQLite DB. No outlet row is seeded, so no cancel slip is printed.
// Run: cd edge-server && bun test tests/cancel-items.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { setDb } from "../db.ts";
import { cancelKotItem, cancelKotItems } from "../orderService.ts";

const RID = "cancel-restaurant";
const ORDER = "order-1";
const TABLE = "table-1";

let db: Database;

function addItem(id: string, name: string, price: number, quantity: number) {
  db.query("INSERT INTO order_item (id, order_id, menu_item_id, name, price, quantity) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, ORDER, `menu-${name}`, name, price, quantity);
  db.query("INSERT INTO kot_item (id, kot_id, order_item_id, menu_item_id, name, quantity, price, status) VALUES (?, 'kot-1', ?, ?, ?, ?, ?, 'PENDING')")
    .run(`ki-${id}`, id, `menu-${name}`, name, quantity, price);
}

function item(id: string) {
  return db.query("SELECT quantity, cancelled_quantity, removed_from_bill FROM order_item WHERE id = ?").get(id) as any;
}

function orderTotal() {
  return (db.query("SELECT total_amount FROM order_record WHERE id = ?").get(ORDER) as any).total_amount;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE "table" (id TEXT PRIMARY KEY, number INTEGER, section_id TEXT, restaurant_id TEXT, status TEXT, workflow_status TEXT,
      captain_id TEXT, guests INTEGER DEFAULT 0, session_started_at INTEGER, current_bill REAL DEFAULT 0, kot_history TEXT DEFAULT '[]',
      discount REAL, section_tag TEXT, revision INTEGER DEFAULT 1, last_command_id TEXT, updated_at INTEGER DEFAULT 0);
    CREATE TABLE order_record (id TEXT PRIMARY KEY, table_id TEXT, restaurant_id TEXT, status TEXT, total_amount REAL DEFAULT 0,
      is_deleted INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0, revision INTEGER DEFAULT 1, last_command_id TEXT);
    CREATE TABLE order_item (id TEXT PRIMARY KEY, order_id TEXT, menu_item_id TEXT, name TEXT, price REAL, quantity INTEGER,
      menu_type TEXT, cancelled_quantity INTEGER DEFAULT 0, removed_from_bill INTEGER DEFAULT 0);
    CREATE TABLE kot_item (id TEXT PRIMARY KEY, kot_id TEXT, order_item_id TEXT, menu_item_id TEXT, name TEXT, quantity INTEGER, price REAL, status TEXT);
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
  db.query(`INSERT INTO "table" (id, number, restaurant_id, status, workflow_status, current_bill) VALUES (?, 1, ?, 'OCCUPIED', 'Occupied', 900)`).run(TABLE, RID);
  db.query("INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount) VALUES (?, ?, ?, 'PREPARING', 900)").run(ORDER, TABLE, RID);
  // The same dish sent in two KOTs is two order lines — the cashier shows them as "Biryani ×2".
  addItem("biryani-a", "Biryani", 300, 1);
  addItem("biryani-b", "Biryani", 300, 1);
  addItem("naan", "Naan", 100, 3);
});

afterEach(() => {
  setDb(null);
});

const batch = (items: { orderItemId: string; cancelQuantity?: number }[], requestId = "req-1") =>
  cancelKotItems({ orderId: ORDER, restaurantId: RID, items, cancelledBy: "Cashier", requestId });

test("cancelling several lines in one request cancels every line, not just the first", async () => {
  const result = await batch([{ orderItemId: "biryani-a", cancelQuantity: 1 }, { orderItemId: "biryani-b", cancelQuantity: 1 }]);

  expect(result.success).toBe(true);
  expect(item("biryani-a")).toMatchObject({ quantity: 0, removed_from_bill: 1 });
  expect(item("biryani-b")).toMatchObject({ quantity: 0, removed_from_bill: 1 });
  expect(orderTotal()).toBe(300);
  const kotStatuses = db.query("SELECT status FROM kot_item WHERE order_item_id IN ('biryani-a','biryani-b')").all() as any[];
  expect(kotStatuses.every((k) => k.status === "CANCELLED")).toBe(true);
});

test("retrying the same request does not cancel anything twice", async () => {
  const items = [{ orderItemId: "biryani-a", cancelQuantity: 1 }, { orderItemId: "naan", cancelQuantity: 1 }];
  await batch(items);
  const retry = await batch(items);

  expect(retry.success).toBe(true);
  expect(item("naan")).toMatchObject({ quantity: 2, cancelled_quantity: 1 });
  expect(item("biryani-b")).toMatchObject({ quantity: 1, removed_from_bill: 0 });
  expect(orderTotal()).toBe(500);
});

test("a second partial cancel on the same line only removes what was asked", async () => {
  await batch([{ orderItemId: "naan", cancelQuantity: 1 }], "req-1");
  await batch([{ orderItemId: "naan", cancelQuantity: 1 }], "req-2");

  expect(item("naan")).toMatchObject({ quantity: 1, cancelled_quantity: 2, removed_from_bill: 0 });
  expect(orderTotal()).toBe(700);

  // The last one left can still be cancelled.
  const last = await batch([{ orderItemId: "naan", cancelQuantity: 1 }], "req-3");
  expect(last.success).toBe(true);
  expect(item("naan")).toMatchObject({ quantity: 0, cancelled_quantity: 3, removed_from_bill: 1 });
});

test("cancelling more than is left is rejected and nothing changes", async () => {
  await batch([{ orderItemId: "naan", cancelQuantity: 2 }], "req-1");
  const tooMany = await batch([{ orderItemId: "biryani-a", cancelQuantity: 1 }, { orderItemId: "naan", cancelQuantity: 2 }], "req-2");

  expect(tooMany).toMatchObject({ success: false, status: 400 });
  expect(item("biryani-a")).toMatchObject({ quantity: 1, removed_from_bill: 0 });
  expect(item("naan")).toMatchObject({ quantity: 1 });
});

test("an already-cancelled line cannot be cancelled again", async () => {
  await cancelKotItem({ orderId: ORDER, restaurantId: RID, orderItemId: "biryani-a", cancelledBy: "Captain", requestId: "c-1" });
  const again = await cancelKotItem({ orderId: ORDER, restaurantId: RID, orderItemId: "biryani-a", cancelQuantity: 1, cancelledBy: "Captain", requestId: "c-2" });

  expect(again.success).toBe(false);
  expect(orderTotal()).toBe(600);
});
