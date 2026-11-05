// Settled orders arriving via sync must carry paid_at, or they vanish from every date-based report.
// Run: cd edge-server && bun test tests/synced-order-paid-at.test.ts
import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { upsertOrderFromSync } from "../socketSync.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE order_record (id TEXT PRIMARY KEY, table_id TEXT, restaurant_id TEXT, status TEXT, total_amount REAL, captain_id TEXT,
      platform TEXT, created_by_user_id TEXT, last_request_id TEXT, created_at INTEGER, updated_at INTEGER, cloud_synced INTEGER,
      is_extra_table INTEGER, bill_number TEXT, billing_requested INTEGER, revision INTEGER, cloud_synced_version INTEGER, paid_at INTEGER);
    CREATE TABLE order_item (id TEXT PRIMARY KEY, order_id TEXT, quantity INTEGER, cancelled_quantity INTEGER, removed_from_bill INTEGER, notes TEXT, cloud_synced INTEGER);
  `);
});
const paidAt = (id: string) => (db.query("SELECT paid_at FROM order_record WHERE id = ?").get(id) as any).paid_at;
const row = (extra: any) => ({ id: "o1", table_id: "t1", restaurant_id: "r1", status: "SETTLED", total_amount: 100, updated_at: 5000, revision: 2, ...extra });

test("new SETTLED order keeps the sent paid_at (ISO string)", () => {
  upsertOrderFromSync(db, row({ paidAt: "2026-11-01T10:00:00.000Z" }));
  expect(paidAt("o1")).toBe(Date.parse("2026-11-01T10:00:00.000Z"));
});

test("new SETTLED order with no paid_at falls back to updated_at", () => {
  upsertOrderFromSync(db, row({}));
  expect(paidAt("o1")).toBe(5000);
});

test("non-settled order gets no paid_at", () => {
  upsertOrderFromSync(db, row({ status: "PREPARING" }));
  expect(paidAt("o1")).toBeNull();
});

test("order settled via update gets paid_at filled in when missing", () => {
  upsertOrderFromSync(db, row({ status: "PREPARING", updated_at: 1000, revision: 1 }));
  expect(paidAt("o1")).toBeNull();
  upsertOrderFromSync(db, row({ updated_at: 3000, revision: 2 }));
  expect(paidAt("o1")).toBe(3000);
});

test("a later sync never overwrites an existing paid_at with updated_at", () => {
  upsertOrderFromSync(db, row({ paid_at: 2222, updated_at: 3000, revision: 2 }));
  upsertOrderFromSync(db, row({ updated_at: 9000, revision: 3 })); // no paid_at sent
  expect(paidAt("o1")).toBe(2222);
});

test("an explicit paid_at from the source is applied on update", () => {
  upsertOrderFromSync(db, row({ paid_at: 2222, updated_at: 3000, revision: 2 }));
  upsertOrderFromSync(db, row({ paid_at: 4444, updated_at: 9000, revision: 3 }));
  expect(paidAt("o1")).toBe(4444);
});
