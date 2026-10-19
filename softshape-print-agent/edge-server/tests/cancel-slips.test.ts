// ─────────────────────────────────────────────────────────────────────────────
// cancel-slips.test.ts — one cancel slip per cancel action (cashier cancel dialog)
// ─────────────────────────────────────────────────────────────────────────────
// "Biryani x6" is stored as one order line per KOT. Cancelling the 6 must print
// ONE slip "6 BIRYANI CANCELLED" (not one slip per line), cancelling 2 of 6 must
// leave exactly 4 and print one slip for 2, and food / bar items go to their own
// printers. The slip is read back from the durable print_job queue (no print
// service runs in tests).
// Run: cd edge-server && bun test tests/cancel-slips.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { setDb } from "../db.ts";
import { cancelKotItems } from "../orderService.ts";

const RID = "slip-restaurant";
const ORDER = "order-1";
const TABLE = "table-1";

let db: Database;

function addItem(id: string, menuItemId: string, name: string, price: number, quantity: number, menuType = "FOOD") {
  db.query("INSERT INTO order_item (id, order_id, menu_item_id, name, price, quantity, menu_type) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, ORDER, menuItemId, name, price, quantity, menuType);
  db.query("INSERT INTO kot_item (id, kot_id, order_item_id, menu_item_id, name, quantity, price, status) VALUES (?, 'kot-1', ?, ?, ?, ?, ?, 'PENDING')")
    .run(`ki-${id}`, id, menuItemId, name, quantity, price);
}

function line(id: string) {
  return db.query("SELECT quantity, cancelled_quantity, removed_from_bill FROM order_item WHERE id = ?").get(id) as any;
}

function orderTotal() {
  return (db.query("SELECT total_amount FROM order_record WHERE id = ?").get(ORDER) as any).total_amount;
}

/** Cancel slips queued so far: { printer, text } — text is the printed ticket. */
function slips() {
  const rows = db.query("SELECT printer_name, escpos_data FROM print_job WHERE job_type = 'CANCEL_KOT' ORDER BY id").all() as any[];
  return rows.map((r) => ({
    printer: r.printer_name as string | null,
    text: (JSON.parse(r.escpos_data) as { data: string }[]).map((b) => b.data).join("").replace(/[\x00-\x09\x0b-\x1f]/g, ""),
  }));
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
    CREATE TABLE outlet (id TEXT PRIMARY KEY, name TEXT, printer_config TEXT, enabled_modules TEXT, receipt_header TEXT);
    CREATE TABLE section (id TEXT PRIMARY KEY, name TEXT, venue_id TEXT, floor_id TEXT);
    CREATE TABLE venue (id TEXT PRIMARY KEY, name TEXT, venue_type TEXT, kot_enabled INTEGER, kot_printer_name TEXT,
      bill_printer_name TEXT, price_profile_id TEXT, tax_profile_id TEXT);
    CREATE TABLE category (id TEXT PRIMARY KEY, printer_target TEXT);
    CREATE TABLE menu_item (id TEXT PRIMARY KEY, category_id TEXT, printer_name TEXT, printer_target TEXT);
    CREATE TABLE command_log (id INTEGER PRIMARY KEY AUTOINCREMENT, restaurant_id TEXT NOT NULL, request_id TEXT NOT NULL,
      command_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, device_id TEXT, command_ts INTEGER NOT NULL,
      expected_revision INTEGER, resulting_revision INTEGER, status TEXT NOT NULL, response_json TEXT, error_message TEXT,
      applied_at INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX idx_command_log_dedup ON command_log(restaurant_id, request_id, command_type);
    CREATE TABLE print_job (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, restaurant_id TEXT NOT NULL,
      order_id TEXT NOT NULL, kot_id TEXT, kot_number INTEGER, table_id TEXT, printer_name TEXT, job_type TEXT NOT NULL,
      escpos_data TEXT NOT NULL, item_summary TEXT, captain_name TEXT, status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3, last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, queued_at INTEGER, printing_at INTEGER,
      printed_at INTEGER, failed_at INTEGER);
  `);
  setDb(db);
  db.query("INSERT INTO outlet (id, name, printer_config, enabled_modules, receipt_header) VALUES (?, 'Vgrand Family Restaurant', '{}', '{}', 'VGRAND')").run(RID);
  db.query("INSERT INTO section (id, name, venue_id) VALUES ('sec-1', 'Main Hall', 'venue-1')").run();
  db.query("INSERT INTO venue (id, name, venue_type) VALUES ('venue-1', 'Family Restaurant', 'RESTAURANT')").run();
  db.query(`INSERT INTO "table" (id, number, section_id, restaurant_id, status, workflow_status, current_bill) VALUES (?, 3, 'sec-1', ?, 'OCCUPIED', 'Occupied', 0)`).run(TABLE, RID);
  db.query("INSERT INTO category (id, printer_target) VALUES ('cat-food', NULL), ('cat-bar', NULL)").run();
  db.query("INSERT INTO menu_item (id, category_id, printer_name) VALUES ('m-biryani', 'cat-food', 'KitchenPrinter'), ('m-naan', 'cat-food', 'KitchenPrinter'), ('m-beer', 'cat-bar', 'BarPrinter')").run();
});

afterEach(() => {
  setDb(null);
});

const cancel = (items: { orderItemId: string; cancelQuantity: number }[], requestId = "req-1") =>
  cancelKotItems({ orderId: ORDER, restaurantId: RID, items, cancelledBy: "Cashier", tableNumber: undefined, requestId });

function openOrder(total: number) {
  db.query("INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount) VALUES (?, ?, ?, 'PREPARING', ?)").run(ORDER, TABLE, RID, total);
}

test("6 biryani on one line, cancel all 6 → gone for good, ONE slip saying 6", async () => {
  openOrder(1800);
  addItem("b1", "m-biryani", "Biryani", 300, 6);

  const result = await cancel([{ orderItemId: "b1", cancelQuantity: 6 }]);

  expect(result.success).toBe(true);
  expect(line("b1")).toMatchObject({ quantity: 0, cancelled_quantity: 6, removed_from_bill: 1 });
  expect(orderTotal()).toBe(0);
  const printed = slips();
  expect(printed).toHaveLength(1);
  expect(printed[0].text).toContain("6    BIRYANI  CANCELLED");
});

test("6 biryani, cancel 2 → exactly 4 left, ONE slip saying 2", async () => {
  openOrder(1800);
  addItem("b1", "m-biryani", "Biryani", 300, 6);

  await cancel([{ orderItemId: "b1", cancelQuantity: 2 }]);

  expect(line("b1")).toMatchObject({ quantity: 4, cancelled_quantity: 2, removed_from_bill: 0 });
  expect(orderTotal()).toBe(1200);
  const printed = slips();
  expect(printed).toHaveLength(1);
  expect(printed[0].text).toContain("2    BIRYANI  CANCELLED");
});

test("6 biryani spread over three KOT lines (2+3+1) → cancel all 6 prints ONE slip with 6, not three slips", async () => {
  openOrder(1800);
  addItem("b1", "m-biryani", "Biryani", 300, 2);
  addItem("b2", "m-biryani", "Biryani", 300, 3);
  addItem("b3", "m-biryani", "Biryani", 300, 1);

  const result = await cancel([
    { orderItemId: "b1", cancelQuantity: 2 },
    { orderItemId: "b2", cancelQuantity: 3 },
    { orderItemId: "b3", cancelQuantity: 1 },
  ]);

  expect(result.success).toBe(true);
  for (const id of ["b1", "b2", "b3"]) expect(line(id).removed_from_bill).toBe(1);
  expect(orderTotal()).toBe(0);
  const printed = slips();
  expect(printed).toHaveLength(1);
  expect(printed[0].text).toContain("6    BIRYANI  CANCELLED");
});

test("cancel 2 of 6 spread over lines (3+3): 4 left in total, ONE slip saying 2", async () => {
  openOrder(1800);
  addItem("b1", "m-biryani", "Biryani", 300, 3);
  addItem("b2", "m-biryani", "Biryani", 300, 3);

  await cancel([{ orderItemId: "b1", cancelQuantity: 2 }]);

  expect(line("b1").quantity + line("b2").quantity).toBe(4);
  expect(orderTotal()).toBe(1200);
  const printed = slips();
  expect(printed).toHaveLength(1);
  expect(printed[0].text).toContain("2    BIRYANI  CANCELLED");
});

test("different dishes for the same printer share ONE slip; bar items get their own printer's slip", async () => {
  openOrder(1000);
  addItem("b1", "m-biryani", "Biryani", 300, 1);
  addItem("n1", "m-naan", "Naan", 100, 2);
  addItem("beer", "m-beer", "Beer", 200, 1, "LIQUOR");

  await cancel([
    { orderItemId: "b1", cancelQuantity: 1 },
    { orderItemId: "n1", cancelQuantity: 2 },
    { orderItemId: "beer", cancelQuantity: 1 },
  ]);

  const printed = slips();
  expect(printed).toHaveLength(2);
  const kitchen = printed.find((p) => p.printer === "KitchenPrinter")!;
  const bar = printed.find((p) => p.printer === "BarPrinter")!;
  expect(kitchen.text).toContain("1    BIRYANI  CANCELLED");
  expect(kitchen.text).toContain("2    NAAN  CANCELLED");
  expect(kitchen.text).not.toContain("BEER");
  expect(bar.text).toContain("1    BEER  CANCELLED");
});

test("retrying the same cancel never prints a second slip or cancels twice", async () => {
  openOrder(1800);
  addItem("b1", "m-biryani", "Biryani", 300, 3);
  addItem("b2", "m-biryani", "Biryani", 300, 3);
  const items = [{ orderItemId: "b1", cancelQuantity: 3 }, { orderItemId: "b2", cancelQuantity: 1 }];

  await cancel(items);
  const retry = await cancel(items);

  expect(retry.success).toBe(true);
  expect(line("b2")).toMatchObject({ quantity: 2, cancelled_quantity: 1 });
  expect(orderTotal()).toBe(600);
  expect(slips()).toHaveLength(1);
});
