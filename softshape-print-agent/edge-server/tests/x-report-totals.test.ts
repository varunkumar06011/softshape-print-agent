// X report totals: every settled bill Past Transactions shows must be counted.
// Run: cd edge-server && bun test tests/x-report-totals.test.ts
import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { computeXReportSales } from "../xReportTotals.ts";

const RID = "r1";
const START = 1_000_000, END = 2_000_000, IN = 1_500_000;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE order_record (id TEXT PRIMARY KEY, restaurant_id TEXT, status TEXT, total_amount REAL DEFAULT 0, paid_at INTEGER);
    CREATE TABLE edge_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    CREATE TABLE transaction_record (id TEXT PRIMARY KEY, order_id TEXT, kind TEXT, payload TEXT, created_at INTEGER DEFAULT 0);
  `);
});

const order = (id: string, total = 0, paidAt: number | null = IN, status = "SETTLED") =>
  db.query("INSERT INTO order_record VALUES (?, ?, ?, ?, ?)").run(id, RID, status, total, paidAt);
const settle = (id: string, pd: any) =>
  db.query("INSERT INTO edge_config VALUES (?, ?, 0)").run(`settle:${id}`, JSON.stringify({ orderId: id, ...pd }));
const sales = () => computeXReportSales(db, RID, START, END);

test("counts a bill by its payment method", () => {
  order("a"); settle("a", { grandTotal: 500, paymentMethod: "CASH" });
  order("b"); settle("b", { grandTotal: 300, paymentMethod: "CARD", tipAmount: 20 });
  order("c"); settle("c", { grandTotal: 200, paymentMethod: "UPI", upiAmount: 200 });
  expect(sales()).toEqual({ totalSales: 1000, cashAmount: 500, cardAmount: 300, upiAmount: 200, otherAmount: 0, tipsAmount: 20 });
});

test("MIXED uses the recorded split; remainder goes to other", () => {
  order("m"); settle("m", { grandTotal: 1000, paymentMethod: "MIXED", cashAmount: 400, cardAmount: 300, upiAmount: 200 });
  const r = sales();
  expect(r).toMatchObject({ totalSales: 1000, cashAmount: 400, cardAmount: 300, upiAmount: 200, otherAmount: 100 });
});

test("bill with no settle record falls back to transaction_record", () => {
  order("t", 999);
  db.query("INSERT INTO transaction_record (id, order_id, kind, payload) VALUES ('x','t','settle',?)").run(JSON.stringify({ grandTotal: 450, paymentMethod: "CARD" }));
  expect(sales()).toMatchObject({ totalSales: 450, cardAmount: 450 });
});

test("bill with no payment data at all still counts its order total (as other)", () => {
  order("n", 275);
  expect(sales()).toMatchObject({ totalSales: 275, otherAmount: 275 });
});

test("settle record without grandTotal falls back to order total", () => {
  order("g", 320); settle("g", { paymentMethod: "CASH" });
  expect(sales().totalSales).toBe(320);
});

test("complimentary bill (grandTotal 0) counts as 0, not the pre-discount total", () => {
  order("z", 800); settle("z", { grandTotal: 0, paymentMethod: "CASH" });
  expect(sales().totalSales).toBe(0);
});

test("excludes deleted transactions, other days, unsettled and other restaurants", () => {
  order("del"); settle("del", { grandTotal: 100 });
  db.query("INSERT INTO edge_config VALUES ('txn_deleted:del','1',0)").run();
  order("old", 0, START - 1); settle("old", { grandTotal: 100 });
  order("open", 0, IN, "PREPARING"); settle("open", { grandTotal: 100 });
  db.query("INSERT INTO order_record VALUES ('other','r2','SETTLED',0,?)").run(IN);
  order("ok"); settle("ok", { grandTotal: 50, paymentMethod: "CASH" });
  expect(sales().totalSales).toBe(50);
});

test("walk-in sales are included; duplicates of a counted order are not", () => {
  order("o1"); settle("o1", { grandTotal: 100, paymentMethod: "CASH" });
  const walk = (id: string, extra: any) => db.query("INSERT INTO edge_config VALUES (?, ?, 0)")
    .run(`walkin_txn:${id}`, JSON.stringify({ restaurantId: RID, createdAt: IN, grandTotal: 60, method: "UPI", ...extra }));
  walk("w1", {});
  walk("w2", { orderId: "o1" });          // already counted via its order
  walk("w3", { createdAt: START - 5 });   // other day
  walk("w4", { restaurantId: "r2" });     // other restaurant
  expect(sales()).toMatchObject({ totalSales: 160, cashAmount: 100, upiAmount: 60 });
});
