// ─────────────────────────────────────────────────────────────────────────────
// venue-price.test.ts — a price edited on the PC reaches new orders at once
// ─────────────────────────────────────────────────────────────────────────────
// Orders read a venue's price profile first. A price edited at the counter must
// be written there as well as to venue_price, or new orders keep the old price
// until the cloud round-trip (and not at all while offline).
// Run: cd edge-server && bun test tests/venue-price.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { setDb } from "../db.ts";
import { upsertVenuePrices } from "../menuService.ts";
import { buildVenuePriceMap, effectiveItemPrice } from "../pricing.ts";

const RID = "price-restaurant";
let db: Database;

const profilePrice = (profile: string, item: string) =>
  (db.query("SELECT price FROM price_profile_item WHERE price_profile_id = ? AND menu_item_id = ?").get(profile, item) as any)?.price;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE venue (id TEXT PRIMARY KEY, price_profile_id TEXT, is_deleted INTEGER DEFAULT 0);
    CREATE TABLE venue_price (id TEXT PRIMARY KEY, venue_id TEXT, menu_item_id TEXT, price REAL, is_active INTEGER, restaurant_id TEXT,
      pending_push INTEGER, UNIQUE(venue_id, menu_item_id));
    CREATE TABLE price_profile_item (id TEXT PRIMARY KEY, price_profile_id TEXT NOT NULL, menu_item_id TEXT NOT NULL, price REAL NOT NULL,
      restaurant_id TEXT NOT NULL, UNIQUE(price_profile_id, menu_item_id));
  `);
  setDb(db);
  db.query("INSERT INTO venue (id, price_profile_id) VALUES ('v-ac', 'pp-ac'), ('v-plain', NULL), ('v-shared-1', 'pp-shared'), ('v-shared-2', 'pp-shared')").run();
  db.query("INSERT INTO price_profile_item (id, price_profile_id, menu_item_id, price, restaurant_id) VALUES ('cloud-id-1', 'pp-ac', 'item-1', 250, ?)").run(RID);
});

afterEach(() => setDb(null));

test("editing a price updates the venue's price profile that orders read", () => {
  upsertVenuePrices(RID, "item-1", { "v-ac": 300 });

  expect(profilePrice("pp-ac", "item-1")).toBe(300);
  expect((db.query("SELECT price FROM venue_price WHERE venue_id = 'v-ac'").get() as any).price).toBe(300);
  // The row the cloud created keeps its own id (no duplicate row).
  expect((db.query("SELECT COUNT(*) AS n FROM price_profile_item").get() as any).n).toBe(1);
});

test("a venue without a price profile only gets the venue price", () => {
  upsertVenuePrices(RID, "item-1", { "v-plain": 180 });

  expect((db.query("SELECT price FROM venue_price WHERE venue_id = 'v-plain'").get() as any).price).toBe(180);
  expect((db.query("SELECT COUNT(*) AS n FROM price_profile_item").get() as any).n).toBe(1);
});

test("a zero or invalid price never overwrites the profile price", () => {
  upsertVenuePrices(RID, "item-1", { "v-ac": 0 });

  expect(profilePrice("pp-ac", "item-1")).toBe(250);
});

test("a price list shared by two venues is not touched, so one venue's edit cannot overwrite the other's", () => {
  db.query("INSERT INTO price_profile_item (id, price_profile_id, menu_item_id, price, restaurant_id) VALUES ('s1', 'pp-shared', 'item-1', 250, ?)").run(RID);

  // The edit form sends both venues: the first changed, the second unchanged.
  upsertVenuePrices(RID, "item-1", { "v-shared-1": 300, "v-shared-2": 250 });

  expect(profilePrice("pp-shared", "item-1")).toBe(250);
  // Only the changed venue gets its own price; the unchanged one keeps using the list.
  const venuePrices = db.query("SELECT venue_id, price FROM venue_price ORDER BY venue_id").all() as any[];
  expect(venuePrices).toEqual([{ venue_id: "v-shared-1", price: 300 }]);
  // Both venues now show and bill what was set.
  expect(buildVenuePriceMap("v-shared-1").get("item-1")).toBe(300);
  expect(buildVenuePriceMap("v-shared-2").get("item-1")).toBe(250);
});

test("an edited price is marked to be sent; an unchanged one is not", () => {
  upsertVenuePrices(RID, "item-1", { "v-ac": 300 });
  expect((db.query("SELECT pending_push FROM venue_price WHERE venue_id = 'v-ac'").get() as any).pending_push).toBeGreaterThan(0);

  // Clear as the cloud would confirm, then re-save the same price.
  db.query("UPDATE venue_price SET pending_push = NULL").run();
  upsertVenuePrices(RID, "item-1", { "v-ac": 300 });
  expect((db.query("SELECT pending_push FROM venue_price WHERE venue_id = 'v-ac'").get() as any).pending_push).toBeNull();
});

test("the price shown on the menu is the price billed, whatever was edited", () => {
  // Cloud list says 250; PC edit says 320 → both screen and bill use 320.
  upsertVenuePrices(RID, "item-1", { "v-ac": 320 });
  const map = buildVenuePriceMap("v-ac");
  expect(effectiveItemPrice(map.get("item-1"), 200, 150)).toBe(320);
  // No venue price → base price, then default portion price.
  expect(effectiveItemPrice(undefined, 200, 150)).toBe(200);
  expect(effectiveItemPrice(undefined, 0, 150)).toBe(150);
  // 0 venue price = not sold there; billing falls back to base as a safety net.
  expect(effectiveItemPrice(0, 200, null)).toBe(200);
});
