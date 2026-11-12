// ─────────────────────────────────────────────────────────────────────────────
// error-report.test.ts — the PC keeps its errors and uploads them to the cloud
// ─────────────────────────────────────────────────────────────────────────────
// Errors, crashes and refused KOTs are saved in a small table, repeats are counted
// not stored twice, secrets never leave the PC, and what was uploaded is cleared.
// Run: cd edge-server && bun test tests/error-report.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import "./_logdir.ts";
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { setDb } from "../db.ts";
import {
  reportEdgeError, pendingErrorReports, flushEdgeErrorReports, resetErrorReportThrottle, safeContext,
} from "../errorReport.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  setDb(db);
  resetErrorReportThrottle();
});

afterEach(() => setDb(null));

test("an error is saved with its details", () => {
  reportEdgeError("log:printer", "Printer offline", { printer: "Kitchen" });

  const [row] = pendingErrorReports();
  expect(row).toMatchObject({ kind: "log:printer", severity: "error", message: "Printer offline", count: 1 });
  expect(JSON.parse(row.context!)).toEqual({ printer: "Kitchen" });
});

test("the same error repeating is counted, not stored again", () => {
  for (let i = 0; i < 5; i++) reportEdgeError("log:sync", "Cloud unreachable");

  const rows = pendingErrorReports();
  expect(rows).toHaveLength(1);
  expect(rows[0].count).toBe(5);
});

test("tokens, PINs and printer bytes never go into a report", () => {
  const json = safeContext({ token: "abc", pin: "1234", Authorization: "Bearer x", escposData: "zzz", tableId: "t5" });

  expect(JSON.parse(json!)).toEqual({ tableId: "t5" });
});

test("a refused KOT is kept as info, not as an error", () => {
  reportEdgeError("kot_refused", "KOT refused: table was billed", { tableId: "t5" }, "info");

  expect(pendingErrorReports()[0].severity).toBe("info");
});

test("uploaded reports are marked sent and not uploaded again", async () => {
  reportEdgeError("log:edge", "Something failed");
  const uploads: number[] = [];

  const sent = await flushEdgeErrorReports(async (rows) => { uploads.push(rows.length); return true; });
  resetErrorReportThrottle();
  const again = await flushEdgeErrorReports(async (rows) => { uploads.push(rows.length); return true; });

  expect(sent).toBe(1);
  expect(again).toBe(0);
  expect(uploads).toEqual([1]);
  expect(pendingErrorReports()).toHaveLength(0);
});

test("when the cloud cannot be reached the reports are kept for the next try", async () => {
  reportEdgeError("log:edge", "Something failed");

  expect(await flushEdgeErrorReports(async () => false)).toBe(0);
  expect(pendingErrorReports()).toHaveLength(1);
});

test("uploads are not attempted more than once every 30 seconds", async () => {
  reportEdgeError("log:edge", "A");
  await flushEdgeErrorReports(async () => false, 1_000_000);
  reportEdgeError("log:edge", "B");

  expect(await flushEdgeErrorReports(async () => true, 1_000_000 + 10_000)).toBe(0);
  expect(await flushEdgeErrorReports(async () => true, 1_000_000 + 40_000)).toBe(2);
});

test("only the newest 500 are kept when the cloud is unreachable for a long time", () => {
  // Digits are treated as "the same error", so make the messages differ by letters.
  const word = (n: number) => n.toString(26).replace(/[0-9]/g, (d) => "qrstuvwxyz"[Number(d)]);
  for (let i = 0; i < 520; i++) reportEdgeError("log:edge", `Distinct error ${word(i)}`);

  expect(pendingErrorReports(1000)).toHaveLength(500);
});

test("reporting never throws, even with no database", () => {
  setDb(null);
  expect(() => reportEdgeError("log:edge", "No database")).not.toThrow();
});

// ── plain console.error calls (backup, recovery, sync worker, sockets, orders) ──

import { installErrorReporting } from "../errorReport.ts";
import { printerLog } from "../contract/logger.ts";

test("a plain console.error is reported once, and an error-level log line is not reported twice", () => {
  const realError = console.error;
  console.error = () => {}; // keep the test output clean; the hook wraps this
  try {
    installErrorReporting();
    console.error("[Backup] Failed:", new Error("disk full"));
    printerLog.error("Print service failed", { printerName: "Kitchen" });
  } finally {
    console.error = realError;
  }

  expect(pendingErrorReports().map((r) => r.kind).sort()).toEqual(["console", "log:printer"]);
});

test("errors that differ only by ids or counts are counted as one", () => {
  reportEdgeError("console", "Order 12 failed for table 7");
  reportEdgeError("console", "Order 98 failed for table 3");

  const rows = pendingErrorReports();
  expect(rows).toHaveLength(1);
  expect(rows[0].count).toBe(2);
});
