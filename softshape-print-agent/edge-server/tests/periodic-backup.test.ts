// ─────────────────────────────────────────────────────────────────────────────
// periodic-backup.test.ts — the in-day database copy is rare, skipped when idle,
// and capped
// ─────────────────────────────────────────────────────────────────────────────
// One copy every 30 minutes (the data-loss window), none when nothing was saved
// since the last one, and only the newest 15 kept.
// Run: cd edge-server && bun test tests/periodic-backup.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, beforeAll, afterAll } from "bun:test";
import { setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIN = 60 * 1000;
const dir = mkdtempSync(join(tmpdir(), "softshape-backup-"));
process.env.EDGE_DB_PATH = join(dir, "edge.db");

let db: Database;
let runPeriodicBackup: (db: Database) => void;
let MAX_PERIODIC_BACKUPS: number;

const backups = () => readdirSync(join(dir, "backups")).filter((f) => f.startsWith("edge-periodic-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Saving something also marks the file as written "now" on the test's moved clock.
const save = (n: number) => {
  db.exec(`INSERT INTO t (v) VALUES (${n})`);
  const stamp = new Date(Date.now());
  for (const f of [process.env.EDGE_DB_PATH!, `${process.env.EDGE_DB_PATH}-wal`]) { try { utimesSync(f, stamp, stamp); } catch { /* no wal yet */ } }
};

beforeAll(async () => {
  db = new Database(process.env.EDGE_DB_PATH!);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v INTEGER)");
  save(1);
  ({ runPeriodicBackup, MAX_PERIODIC_BACKUPS } = await import("../backup.ts"));
});

afterAll(() => {
  setSystemTime();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the first check makes a copy", () => {
  runPeriodicBackup(db);
  expect(backups()).toHaveLength(1);
});

test("a check 10 minutes later makes no new copy", () => {
  setSystemTime(new Date(Date.now() + 10 * MIN));
  runPeriodicBackup(db);
  expect(backups()).toHaveLength(1);
});

test("over 30 minutes later but nothing was saved: still no new copy", () => {
  setSystemTime(new Date(Date.now() + 40 * MIN));
  runPeriodicBackup(db);
  expect(backups()).toHaveLength(1);
});

test("over 30 minutes later and something was saved: a new copy", async () => {
  await sleep(30);
  save(2);
  setSystemTime(new Date(Date.now() + 40 * MIN));
  runPeriodicBackup(db);
  expect(backups()).toHaveLength(2);
});

test("old copies beyond the cap are deleted", async () => {
  for (let i = 1; i <= 20; i++) writeFileSync(join(dir, "backups", `edge-periodic-${1000 + i}.db`), "x");
  await sleep(30);
  save(3);
  setSystemTime(new Date(Date.now() + 40 * MIN));
  runPeriodicBackup(db);
  expect(backups()).toHaveLength(MAX_PERIODIC_BACKUPS);
});
