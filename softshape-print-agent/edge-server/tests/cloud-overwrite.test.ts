// ─────────────────────────────────────────────────────────────────────────────
// cloud-overwrite.test.ts — a cloud change never erases an unsent PC edit
// ─────────────────────────────────────────────────────────────────────────────
// The restaurant edits menu/prices/settings on the PC. If that edit has not
// reached the cloud yet, the cloud's older copy of the same record must not
// overwrite it. Once the edit is sent (or its push is stuck for good), cloud
// changes apply again.
// Run: cd edge-server && bun test tests/cloud-overwrite.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { setDb } from "../db.ts";
import { applyChangesBatch } from "../config.ts";

let db: Database;

const category = (name: string) => ({ table: "category", operation: "upsert", row: { id: "cat-1", name, sortOrder: 1, isActive: true, restaurantId: "r1" } });
const nameNow = () => (db.query("SELECT name FROM category WHERE id = 'cat-1'").get() as any).name;
const queue = (table: string, id: string, synced = 0, attempts = 0) =>
  db.query("INSERT INTO sync_queue (table_name, record_id, operation, synced, attempts) VALUES (?, ?, 'update', ?, ?)").run(table, id, synced, attempts);

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE category (id TEXT PRIMARY KEY, name TEXT, sort_order INTEGER, is_active INTEGER, restaurant_id TEXT,
      printer_target TEXT, report_category TEXT, synced_at INTEGER);
    CREATE TABLE price_profile_item (id TEXT PRIMARY KEY, price_profile_id TEXT NOT NULL, menu_item_id TEXT NOT NULL, price REAL NOT NULL,
      restaurant_id TEXT NOT NULL, UNIQUE(price_profile_id, menu_item_id));
    CREATE TABLE sync_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, record_id TEXT NOT NULL, operation TEXT NOT NULL,
      created_at INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, last_error TEXT, synced INTEGER DEFAULT 0);
  `);
  setDb(db);
  db.query("INSERT INTO category (id, name, sort_order, is_active, restaurant_id) VALUES ('cat-1', 'Starters (edited on PC)', 1, 1, 'r1')").run();
});

afterEach(() => setDb(null));

test("cloud change is skipped while the PC's edit is still waiting to be sent", () => {
  queue("category", "cat-1");

  const applied = applyChangesBatch([category("Starters (old cloud copy)")]);

  expect(applied).toBe(0);
  expect(nameNow()).toBe("Starters (edited on PC)");
});

test("cloud change applies once the PC's edit has been sent", () => {
  queue("category", "cat-1", 1);

  const applied = applyChangesBatch([category("Starters (admin edit)")]);

  expect(applied).toBe(1);
  expect(nameNow()).toBe("Starters (admin edit)");
});

test("a push that is stuck for good no longer blocks the cloud's version", () => {
  queue("category", "cat-1", 0, 50);

  expect(applyChangesBatch([category("Starters (admin edit)")])).toBe(1);
});

test("a price-profile row for an item the PC just edited is also kept", () => {
  db.query("INSERT INTO price_profile_item (id, price_profile_id, menu_item_id, price, restaurant_id) VALUES ('p1', 'pp-1', 'item-1', 300, 'r1')").run();
  queue("menu_item", "item-1");

  const applied = applyChangesBatch([{ table: "price_profile_item", operation: "upsert", row: { id: "p1", priceProfileId: "pp-1", menuItemId: "item-1", price: 250, restaurantId: "r1" } }]);

  expect(applied).toBe(0);
  expect((db.query("SELECT price FROM price_profile_item WHERE id = 'p1'").get() as any).price).toBe(300);
});

test("changes for records the PC did not touch still apply", () => {
  queue("category", "some-other-category");

  expect(applyChangesBatch([category("Starters (admin edit)")])).toBe(1);
});

// ── The cloud refused a PC edit because its own copy was newer ───────────────

import { rewindConfigCursor } from "../config.ts";
import { getSyncState, setSyncState } from "../db.ts";

test("cloud had the newer copy → the download position moves back so the PC fetches it", () => {
  db.exec("CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)");
  setSyncState("last_incremental_sync", "2026-10-21T10:00:00.000Z");

  rewindConfigCursor("2026-10-21T09:30:00.000Z");

  expect(getSyncState("last_incremental_sync")).toBe("2026-10-21T09:29:58.000Z");
});

test("a cloud copy older than the download position changes nothing", () => {
  db.exec("CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)");
  setSyncState("last_incremental_sync", "2026-10-21T10:00:00.000Z");

  rewindConfigCursor("2026-10-21T10:30:00.000Z");

  expect(getSyncState("last_incremental_sync")).toBe("2026-10-21T10:00:00.000Z");
});
