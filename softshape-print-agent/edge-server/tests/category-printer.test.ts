// Category printer rules (cashier Edit Menu):
//  - setting a category printer overrides every per-item printer in that category
//  - an item printer set afterwards wins over the category again
// Run: cd edge-server && bun test tests/category-printer.test.ts
import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { setDb } from "../db.ts";
import { setCategoryPrinterEdge, updateMenuItemEdge, listCategoriesWithPrinters } from "../menuService.ts";

const RID = "cat-printer-restaurant";
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE edge_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    CREATE TABLE category (id TEXT PRIMARY KEY, name TEXT, restaurant_id TEXT, sort_order INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, printer_target TEXT);
    CREATE TABLE menu_item (id TEXT PRIMARY KEY, name TEXT, restaurant_id TEXT, category_id TEXT, printer_target TEXT, printer_name TEXT,
      base_price REAL DEFAULT 0, is_deleted INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0, synced_at INTEGER);
    CREATE TABLE sync_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, operation TEXT, created_at INTEGER,
      attempts INTEGER DEFAULT 0, last_error TEXT, synced INTEGER DEFAULT 0);
  `);
  for (const [k, v] of [["session_token", "t"], ["restaurant_id", RID], ["backend_url", "http://x"]])
    db.query("INSERT INTO edge_config VALUES (?, ?, 0)").run(k, v);
  db.query("INSERT INTO category (id, name, restaurant_id, printer_target) VALUES ('c1','Drinks',?, NULL), ('c2','Starters',?, 'KITCHEN')").run(RID, RID);
  const item = db.query("INSERT INTO menu_item (id, name, restaurant_id, category_id, printer_target) VALUES (?, ?, ?, ?, ?)");
  item.run("coke", "Coke", RID, "c1", "KITCHEN");   // own override
  item.run("fanta", "Fanta", RID, "c1", null);      // follows category
  item.run("soup", "Soup", RID, "c2", "BAR");       // other category, own override
  setDb(db);
});

const itemPrinter = (id: string) => (db.query("SELECT printer_target FROM menu_item WHERE id = ?").get(id) as any).printer_target;
const catPrinter = (id: string) => (db.query("SELECT printer_target FROM category WHERE id = ?").get(id) as any).printer_target;

test("category printer replaces per-item printers in that category only", () => {
  const r = setCategoryPrinterEdge("c1", "BAR");
  expect(r.success).toBe(true);
  expect(catPrinter("c1")).toBe("BAR");
  expect(itemPrinter("coke")).toBeNull();
  expect(itemPrinter("fanta")).toBeNull();
  expect(itemPrinter("soup")).toBe("BAR");      // untouched
  expect(catPrinter("c2")).toBe("KITCHEN");     // untouched
});

test("an item printer set afterwards wins; the rest keep following the category", () => {
  setCategoryPrinterEdge("c1", "BAR");
  expect(updateMenuItemEdge("coke", { printerTarget: "KITCHEN" }).success).toBe(true);
  expect(itemPrinter("coke")).toBe("KITCHEN");
  expect(itemPrinter("fanta")).toBeNull();
  expect(catPrinter("c1")).toBe("BAR");
});

test("changing the category printer again overrides the item printer", () => {
  setCategoryPrinterEdge("c1", "BAR");
  updateMenuItemEdge("coke", { printerTarget: "KITCHEN" });
  setCategoryPrinterEdge("c1", "COUNTER");
  expect(catPrinter("c1")).toBe("COUNTER");
  expect(itemPrinter("coke")).toBeNull();
});

test("clearing the category printer (empty) also clears item overrides", () => {
  setCategoryPrinterEdge("c1", "");
  expect(catPrinter("c1")).toBeNull();
  expect(itemPrinter("coke")).toBeNull();
});

test("queues sync for the category and every item whose printer was cleared", () => {
  setCategoryPrinterEdge("c1", "BAR");
  const q = db.query("SELECT table_name, record_id FROM sync_queue WHERE synced = 0").all() as any[];
  expect(q).toContainEqual({ table_name: "category", record_id: "c1" });
  expect(q).toContainEqual({ table_name: "menu_item", record_id: "coke" });
  expect(q.find(x => x.record_id === "soup")).toBeUndefined();
});

test("unknown category returns 404; list shows printers", () => {
  expect(setCategoryPrinterEdge("nope", "BAR")).toMatchObject({ success: false, statusCode: 404 });
  expect(listCategoriesWithPrinters()).toEqual([
    { id: "c1", name: "Drinks", printerTarget: null },
    { id: "c2", name: "Starters", printerTarget: "KITCHEN" },
  ]);
});
