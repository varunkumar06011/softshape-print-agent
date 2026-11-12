// ─────────────────────────────────────────────────────────────────────────────
// stale-table.test.ts — a captain's old screen never opens an order on a table
// that was billed after the phone last looked at it
// ─────────────────────────────────────────────────────────────────────────────
// The phone sends the time it last saw the table (tableSeenAt). If an order on
// that table was settled or cancelled after that moment, the KOT is refused with
// ORDER_CLOSED and nothing is written or printed.
// Run: cd edge-server && bun test tests/stale-table.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { setDb } from "../db.ts";
import { createOrder } from "../orderService.ts";

const RID = "stale-restaurant";
const TABLE = "table-5";
const MIN = 60_000;

let db: Database;

const biryani = { menuItemId: "menu-biryani", name: "Chicken Biryani", price: 300, quantity: 1 };

function closedOrder(status: string, paidAt: number | null, updatedAt = paidAt ?? 0) {
  db.query("INSERT INTO order_record (id, table_id, restaurant_id, status, paid_at, updated_at) VALUES ('old-order', ?, ?, ?, ?, ?)")
    .run(TABLE, RID, status, paidAt, updatedAt);
}

const send = (extra: Record<string, unknown>) =>
  createOrder(RID, { tableId: TABLE, items: [biryani], requestId: "kot-1", sentAt: Date.now(), ...extra });

const kotCount = () => (db.query("SELECT COUNT(*) AS n FROM kot").get() as any).n;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE "table" (id TEXT PRIMARY KEY, number INTEGER, section_id TEXT, restaurant_id TEXT, status TEXT, workflow_status TEXT,
      captain_id TEXT, guests INTEGER DEFAULT 0, session_started_at INTEGER, current_bill REAL DEFAULT 0, kot_history TEXT DEFAULT '[]',
      discount REAL, section_tag TEXT, revision INTEGER DEFAULT 1, last_command_id TEXT, updated_at INTEGER DEFAULT 0);
    CREATE TABLE order_record (id TEXT PRIMARY KEY, table_id TEXT, restaurant_id TEXT, status TEXT, total_amount REAL DEFAULT 0,
      is_deleted INTEGER DEFAULT 0, paid_at INTEGER, updated_at INTEGER DEFAULT 0, revision INTEGER DEFAULT 1, last_command_id TEXT, last_request_id TEXT);
    CREATE TABLE outlet (id TEXT PRIMARY KEY, name TEXT, printer_config TEXT, enabled_modules TEXT);
    CREATE TABLE section (id TEXT PRIMARY KEY, name TEXT, venue_id TEXT, floor_id TEXT);
    CREATE TABLE venue (id TEXT PRIMARY KEY, name TEXT, venue_type TEXT, kot_enabled INTEGER, kot_printer_name TEXT,
      bill_printer_name TEXT, price_profile_id TEXT, tax_profile_id TEXT);
    CREATE TABLE kot (id TEXT PRIMARY KEY, restaurant_id TEXT, table_id TEXT, order_id TEXT, kot_number INTEGER, counter_date TEXT DEFAULT '',
      captain_id TEXT, created_at INTEGER, cloud_synced INTEGER DEFAULT 0);
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

test("table settled after the captain last saw it → refused, nothing written", async () => {
  closedOrder("SETTLED", Date.now() - MIN);

  const result = await send({ tableSeenAt: Date.now() - 10 * MIN });

  expect(result).toMatchObject({ success: false, statusCode: 409, code: "ORDER_CLOSED" });
  expect(kotCount()).toBe(0);
  expect((db.query("SELECT COUNT(*) AS n FROM order_record WHERE id != 'old-order'").get() as any).n).toBe(0);
});

test("order cancelled (e.g. table moved) after the captain last saw it → refused", async () => {
  closedOrder("CANCELLED", null, Date.now() - MIN);

  const result = await send({ tableSeenAt: Date.now() - 10 * MIN });

  expect(result).toMatchObject({ success: false, statusCode: 409, code: "ORDER_CLOSED" });
});

test("table billed BEFORE the captain opened it (new guests) is not blocked by the stale check", async () => {
  closedOrder("SETTLED", Date.now() - 30 * MIN);

  const result = await send({ tableSeenAt: Date.now() - 5 * MIN });

  expect(result.code).not.toBe("ORDER_CLOSED");
});

test("phone clock running 10 minutes slow does not make a fresh screen look stale", async () => {
  closedOrder("SETTLED", Date.now() - 5 * MIN);
  const skew = 10 * MIN;

  // The phone saw the table 1 minute ago by its own (slow) clock, i.e. after the bill.
  const result = await send({ tableSeenAt: Date.now() - skew - MIN, sentAt: Date.now() - skew });

  expect(result.code).not.toBe("ORDER_CLOSED");
});

test("old captain apps that send no tableSeenAt behave exactly as before", async () => {
  closedOrder("SETTLED", Date.now() - MIN);

  const result = await send({});

  expect(result.code).not.toBe("ORDER_CLOSED");
});

test("a refused stale-table KOT is recorded for the cloud (info), so it can be traced remotely", async () => {
  const { pendingErrorReports } = await import("../errorReport.ts");
  closedOrder("SETTLED", Date.now() - MIN);

  await send({ tableSeenAt: Date.now() - 10 * MIN });

  expect(pendingErrorReports()).toEqual([
    expect.objectContaining({ kind: "kot_refused", severity: "info" }),
  ]);
});
