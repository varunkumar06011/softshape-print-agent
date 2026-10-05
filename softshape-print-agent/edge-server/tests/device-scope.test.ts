// ─────────────────────────────────────────────────────────────────────────────
// device-scope.test.ts — multi-PC restaurant support (venue binding, bill
// prefix, captain hub flag)
// ─────────────────────────────────────────────────────────────────────────────
// Uses the real deviceScope.ts + reads.ts against an in-memory SQLite DB.
// Run: cd edge-server && bun test tests/device-scope.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { setDb } from "../db.ts";
import { saveSession, clearSession } from "../auth.ts";
import { getSections, getTablesForRestaurant, getTablesFlat, getVenues, invalidateReadCache } from "../reads.ts";
import { getDeviceScope, updateDeviceScope, getBoundVenueId, getBillPrefix, isCaptainHub, resolveWalkinVenue } from "../deviceScope.ts";

const RID = "scope-restaurant";
const DINE = "venue-dine";
const CURRY = "venue-curry";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE edge_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE venue (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL, name TEXT, venue_type TEXT, sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1, is_deleted INTEGER DEFAULT 0, price_profile_id TEXT, tax_profile_id TEXT,
      kot_printer_name TEXT, bill_printer_name TEXT, kot_enabled INTEGER DEFAULT 1);
    CREATE TABLE floor (id TEXT PRIMARY KEY, venue_id TEXT, restaurant_id TEXT, name TEXT, sort_order INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1);
    CREATE TABLE section (id TEXT PRIMARY KEY, name TEXT, restaurant_id TEXT, floor_id TEXT, venue_id TEXT, sort_order INTEGER DEFAULT 0, is_default INTEGER DEFAULT 0);
    CREATE TABLE "table" (id TEXT PRIMARY KEY, number INTEGER, capacity INTEGER DEFAULT 4, status TEXT DEFAULT 'AVAILABLE', section_id TEXT,
      restaurant_id TEXT, workflow_status TEXT, captain_id TEXT, guests INTEGER DEFAULT 0, session_started_at INTEGER, current_bill REAL DEFAULT 0,
      kot_history TEXT DEFAULT '[]', discount REAL, section_tag TEXT, last_waiter_call_at INTEGER, revision INTEGER DEFAULT 1, last_command_id TEXT,
      bill_printer_name TEXT, kot_printer_name TEXT, updated_at INTEGER DEFAULT 0);
    CREATE TABLE order_record (id TEXT PRIMARY KEY, table_id TEXT, restaurant_id TEXT, status TEXT, is_deleted INTEGER DEFAULT 0,
      is_extra_table INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0, total_amount REAL DEFAULT 0,
      captain_id TEXT, platform TEXT, revision INTEGER DEFAULT 1, last_command_id TEXT);
    CREATE TABLE order_item (id TEXT PRIMARY KEY, order_id TEXT, menu_item_id TEXT, name TEXT, price REAL, quantity INTEGER, notes TEXT,
      menu_type TEXT, cancelled_quantity INTEGER DEFAULT 0, removed_from_bill INTEGER DEFAULT 0);
    CREATE TABLE menu_item (id TEXT PRIMARY KEY, gst_enabled INTEGER, menu_type TEXT);
    CREATE TABLE kot (id TEXT PRIMARY KEY, restaurant_id TEXT, table_id TEXT, order_id TEXT, kot_number INTEGER, created_at INTEGER);
    CREATE TABLE kot_item (id TEXT PRIMARY KEY, kot_id TEXT, order_item_id TEXT, menu_item_id TEXT, name TEXT, quantity INTEGER, price REAL, notes TEXT, status TEXT);
  `);
  setDb(db);
  clearSession();
  const set = (k: string, v: string) => db.query("INSERT INTO edge_config (key, value, updated_at) VALUES (?, ?, 0)").run(k, v);
  set("session_token", "t");
  set("restaurant_id", RID);
  set("backend_url", "http://localhost:9");

  const venue = db.query("INSERT INTO venue (id, restaurant_id, name, venue_type, bill_printer_name) VALUES (?, ?, ?, ?, ?)");
  venue.run(DINE, RID, "Dine In", "DINE_IN", "DineBill");
  venue.run(CURRY, RID, "Curry Point", "TAKEAWAY", "CurryBill");
  db.query("INSERT INTO section (id, name, restaurant_id, venue_id) VALUES (?, ?, ?, ?)").run("sec-dine", "Hall", RID, DINE);
  db.query("INSERT INTO section (id, name, restaurant_id, venue_id) VALUES (?, ?, ?, ?)").run("sec-curry", "Counter", RID, CURRY);
  db.query(`INSERT INTO "table" (id, number, section_id, restaurant_id) VALUES (?, ?, ?, ?)`).run("t-dine-1", 1, "sec-dine", RID);
  db.query(`INSERT INTO "table" (id, number, section_id, restaurant_id) VALUES (?, ?, ?, ?)`).run("t-curry-1", 1, "sec-curry", RID);
  invalidateReadCache();
});

afterEach(() => {
  clearSession();
  invalidateReadCache();
  setDb(null);
});

test("unbound PC keeps legacy behaviour: all venues, no prefix, captain hub on", () => {
  expect(getDeviceScope()).toEqual({ boundVenueId: null, billPrefix: "", captainHub: true });
  expect(getSections().map((s) => s.id).sort()).toEqual(["sec-curry", "sec-dine"]);
  expect(getVenues()).toHaveLength(2);
  expect(getTablesFlat()).toHaveLength(2);
});

test("bound PC only exposes its own venue in sections, tables and venues", () => {
  const r = updateDeviceScope(RID, { boundVenueId: CURRY, billPrefix: "C-", captainHub: false });
  expect(r.ok).toBe(true);
  invalidateReadCache();

  expect(getBoundVenueId()).toBe(CURRY);
  expect(getBillPrefix()).toBe("C-");
  expect(isCaptainHub()).toBe(false);

  expect(getSections().map((s) => s.id)).toEqual(["sec-curry"]);
  expect(getVenues().map((v) => v.id)).toEqual([CURRY]);
  expect(getTablesFlat().map((t) => t.id)).toEqual(["t-curry-1"]);
  expect(getTablesForRestaurant().map((s) => s.id)).toEqual(["sec-curry"]);
});

test("changing the binding is reflected even without a manual cache flush", () => {
  updateDeviceScope(RID, { boundVenueId: DINE });
  expect(getSections().map((s) => s.id)).toEqual(["sec-dine"]);
  updateDeviceScope(RID, { boundVenueId: CURRY });
  // cache key includes the bound venue, so the stale dine-in list is not served
  expect(getSections().map((s) => s.id)).toEqual(["sec-curry"]);
  updateDeviceScope(RID, { boundVenueId: null });
  expect(getSections()).toHaveLength(2);
});

test("rejects unknown venues and bad prefixes without changing anything", () => {
  expect(updateDeviceScope(RID, { boundVenueId: "nope" }).ok).toBe(false);
  expect(updateDeviceScope(RID, { boundVenueId: "other", billPrefix: "ok" }).ok).toBe(false);
  expect(updateDeviceScope(RID, { billPrefix: "TOO-LONG-PREFIX" }).ok).toBe(false);
  expect(updateDeviceScope(RID, { billPrefix: "a b" }).ok).toBe(false);
  expect(getDeviceScope()).toEqual({ boundVenueId: null, billPrefix: "", captainHub: true });
});

test("a venue that was deleted in the cloud falls back to showing all venues", () => {
  updateDeviceScope(RID, { boundVenueId: CURRY });
  db.query("UPDATE venue SET is_deleted = 1 WHERE id = ?").run(CURRY);
  invalidateReadCache();
  expect(getBoundVenueId()).toBeNull();
  // Legacy all-venues view (same as an unbound PC) instead of an empty screen
  expect(getSections().map((s) => s.id).sort()).toEqual(["sec-curry", "sec-dine"]);
});

test("walk-in bill resolves the venue from the section tag, else the bound venue", () => {
  expect(resolveWalkinVenue(RID, `venue-${CURRY}`)?.bill_printer_name).toBe("CurryBill");
  // Placeholder tag that matches no venue and no binding -> legacy path (null)
  expect(resolveWalkinVenue(RID, "venue-restaurant-parcel")).toBeNull();
  expect(resolveWalkinVenue(RID, null)).toBeNull();
  // Bound PC: placeholder tag falls back to the bound venue's printer
  updateDeviceScope(RID, { boundVenueId: CURRY });
  expect(resolveWalkinVenue(RID, "venue-restaurant-parcel")?.bill_printer_name).toBe("CurryBill");
  expect(resolveWalkinVenue(RID, undefined)?.id).toBe(CURRY);
});
