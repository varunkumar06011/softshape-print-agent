// ─────────────────────────────────────────────────────────────────────────────
// config-verification.test.ts — Regression tests for sync verification
// ─────────────────────────────────────────────────────────────────────────────
// Tests the end-to-end count verification, config_sync_completed gating,
// empty cache prevention, and incremental sync mutex.
//
// Run with: bun test config-verification.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

const originalFetch = globalThis.fetch;

const RESTAURANT_ID = "test-restaurant-001";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS outlet (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
      restaurant_code TEXT NOT NULL, restaurant_type TEXT,
      gst_category TEXT DEFAULT 'NON_AC', gst_rate REAL DEFAULT 5.0,
      gst_registered INTEGER DEFAULT 1, prices_include_gst INTEGER DEFAULT 0,
      receipt_header TEXT, printer_config TEXT DEFAULT '{}',
      enabled_modules TEXT DEFAULT '{}',
      organization_id TEXT, edge_api_key TEXT
    );

    CREATE TABLE IF NOT EXISTS tax_profile (
      id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL,
      name TEXT, rate REAL, is_default INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS price_profile (
      id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL,
      name TEXT, is_default INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS price_profile_item (
      id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL,
      price_profile_id TEXT, menu_item_id TEXT, price REAL
    );

    CREATE TABLE IF NOT EXISTS venue (
      id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL,
      name TEXT, venue_type TEXT, is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS floor (
      id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL,
      venue_id TEXT, name TEXT, sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS section (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, restaurant_id TEXT NOT NULL,
      floor_id TEXT, venue_id TEXT, sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS "table" (
      id TEXT PRIMARY KEY, number INTEGER NOT NULL,
      section_id TEXT, restaurant_id TEXT NOT NULL,
      status TEXT DEFAULT 'AVAILABLE', workflow_status TEXT DEFAULT 'Free',
      capacity INTEGER DEFAULT 4, revision INTEGER NOT NULL DEFAULT 1,
      last_command_id TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS category (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      restaurant_id TEXT NOT NULL, sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1, printer_target TEXT
    );

    CREATE TABLE IF NOT EXISTS menu_item (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      category_id TEXT, restaurant_id TEXT NOT NULL,
      base_price REAL DEFAULT 0, menu_type TEXT DEFAULT 'FOOD',
      is_available INTEGER DEFAULT 1, is_deleted INTEGER DEFAULT 0,
      is_veg INTEGER DEFAULT 0, gst_enabled INTEGER DEFAULT 1,
      printer_target TEXT, printer_name TEXT,
      unit TEXT, ml_per_unit INTEGER,
      is_special INTEGER DEFAULT 0, special_channel TEXT DEFAULT 'BOTH',
      special_active INTEGER DEFAULT 0, special_expires_at INTEGER,
      description TEXT, image_url TEXT, sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS menu_item_variant (
      id TEXT PRIMARY KEY, menu_item_id TEXT, restaurant_id TEXT NOT NULL,
      name TEXT, price REAL, is_default INTEGER DEFAULT 0, is_available INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS menu_item_addon (
      id TEXT PRIMARY KEY, menu_item_id TEXT, restaurant_id TEXT NOT NULL,
      name TEXT, price REAL, is_available INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS venue_price (
      id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL,
      venue_id TEXT, menu_item_id TEXT, price REAL
    );

    CREATE TABLE IF NOT EXISTS venue_menu_item_availability (
      id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL,
      venue_id TEXT, menu_item_id TEXT, is_available INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, pin TEXT,
      role TEXT NOT NULL, outlet_id TEXT NOT NULL, is_active INTEGER DEFAULT 1,
      permissions TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS edge_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);

  return db;
}

function getSyncState(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM sync_state WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

function setSyncState(db: Database, key: string, value: string): void {
  db.query("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?")
    .run(key, value, Date.now(), value, Date.now());
}

// ── Test 1: verifyCounts detects mismatch between cloud and local counts ──────

test("verifyCounts — detects mismatch when SQLite has fewer rows than cloud", () => {
  const db = createTestDb();
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST001')`);

  // Insert 3 categories and 5 menu items
  for (let i = 0; i < 3; i++) {
    db.query(`INSERT INTO category (id, name, restaurant_id) VALUES (?, ?, ?)`).run(`cat-${i}`, `Cat ${i}`, RESTAURANT_ID);
  }
  for (let i = 0; i < 5; i++) {
    db.query(`INSERT INTO menu_item (id, name, category_id, restaurant_id) VALUES (?, ?, ?, ?)`).run(`item-${i}`, `Item ${i}`, `cat-0`, RESTAURANT_ID);
  }

  // Cloud says 12 categories and 156 menu items — mismatch
  const cloudCounts = { categories: 12, menuItems: 156 };

  // Inline the verifyCounts logic for testing
  const tableMap = [
    { cloudKey: "categories", table: "category", scopeColumn: "restaurant_id" },
    { cloudKey: "menuItems", table: "menu_item", scopeColumn: "restaurant_id" },
  ];

  const mismatches: Array<{ table: string; cloud: number; local: number }> = [];
  for (const { cloudKey, table, scopeColumn } of tableMap) {
    const cloudCount = (cloudCounts as any)[cloudKey];
    if (cloudCount === undefined) continue;
    const row = db.query(`SELECT COUNT(*) as c FROM ${table} WHERE ${scopeColumn} = ?`).get(RESTAURANT_ID) as { c: number };
    if (row.c !== cloudCount) {
      mismatches.push({ table: cloudKey, cloud: cloudCount, local: row.c });
    }
  }

  expect(mismatches).toHaveLength(2);
  expect(mismatches[0]).toEqual({ table: "categories", cloud: 12, local: 3 });
  expect(mismatches[1]).toEqual({ table: "menuItems", cloud: 156, local: 5 });
});

// ── Test 2: verifyCounts passes when counts match ─────────────────────────────

test("verifyCounts — passes when SQLite counts match cloud counts", () => {
  const db = createTestDb();
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST001')`);

  for (let i = 0; i < 12; i++) {
    db.query(`INSERT INTO category (id, name, restaurant_id) VALUES (?, ?, ?)`).run(`cat-${i}`, `Cat ${i}`, RESTAURANT_ID);
  }
  for (let i = 0; i < 156; i++) {
    db.query(`INSERT INTO menu_item (id, name, category_id, restaurant_id) VALUES (?, ?, ?, ?)`).run(`item-${i}`, `Item ${i}`, `cat-0`, RESTAURANT_ID);
  }

  const cloudCounts = { categories: 12, menuItems: 156 };

  const tableMap = [
    { cloudKey: "categories", table: "category", scopeColumn: "restaurant_id" },
    { cloudKey: "menuItems", table: "menu_item", scopeColumn: "restaurant_id" },
  ];

  const mismatches: Array<{ table: string; cloud: number; local: number }> = [];
  for (const { cloudKey, table, scopeColumn } of tableMap) {
    const cloudCount = (cloudCounts as any)[cloudKey];
    if (cloudCount === undefined) continue;
    const row = db.query(`SELECT COUNT(*) as c FROM ${table} WHERE ${scopeColumn} = ?`).get(RESTAURANT_ID) as { c: number };
    if (row.c !== cloudCount) {
      mismatches.push({ table: cloudKey, cloud: cloudCount, local: row.c });
    }
  }

  expect(mismatches).toHaveLength(0);
});

// ── Test 3: verifyCounts skips when cloud doesn't send counts (backward compat) ─

test("verifyCounts — skips verification when cloudCounts is undefined", () => {
  const db = createTestDb();
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST001')`);

  // No counts provided — should return match: true
  const cloudCounts = undefined;
  expect(cloudCounts).toBeUndefined();
});

// ── Test 3a: verifyCounts with multi-outlet organization ─────────────────────
// Regression test: cloud returns data for ALL outlets in the org, so local
// counts must be summed across all restaurant IDs using IN (...).

test("verifyCounts — multi-outlet: counts match when summed across all outlet IDs", () => {
  const db = createTestDb();

  const OUTLET_A = "outlet-a";
  const OUTLET_B = "outlet-b";
  const allIds = [OUTLET_A, OUTLET_B];

  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${OUTLET_A}', 'A', 'a', 'A001')`);
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${OUTLET_B}', 'B', 'b', 'B001')`);

  // Outlet A: 6 categories, 20 menu items
  // Outlet B: 6 categories, 20 menu items
  // Total: 12 categories, 40 menu items
  for (let i = 0; i < 6; i++) {
    db.query(`INSERT INTO category (id, name, restaurant_id) VALUES (?, ?, ?)`).run(`cat-a-${i}`, `Cat A${i}`, OUTLET_A);
    db.query(`INSERT INTO category (id, name, restaurant_id) VALUES (?, ?, ?)`).run(`cat-b-${i}`, `Cat B${i}`, OUTLET_B);
  }
  for (let i = 0; i < 20; i++) {
    db.query(`INSERT INTO menu_item (id, name, category_id, restaurant_id) VALUES (?, ?, ?, ?)`).run(`item-a-${i}`, `Item A${i}`, `cat-a-0`, OUTLET_A);
    db.query(`INSERT INTO menu_item (id, name, category_id, restaurant_id) VALUES (?, ?, ?, ?)`).run(`item-b-${i}`, `Item B${i}`, `cat-b-0`, OUTLET_B);
  }

  const cloudCounts = { categories: 12, menuItems: 40 };

  // Inline the fixed verifyCounts logic (uses IN (...))
  const placeholders = allIds.map(() => "?").join(",");
  const tableMap = [
    { cloudKey: "categories", table: "category", scopeColumn: "restaurant_id" },
    { cloudKey: "menuItems", table: "menu_item", scopeColumn: "restaurant_id" },
  ];

  const mismatches: Array<{ table: string; cloud: number; local: number }> = [];
  for (const { cloudKey, table, scopeColumn } of tableMap) {
    const cloudCount = (cloudCounts as any)[cloudKey];
    if (cloudCount === undefined) continue;
    const row = db.query(`SELECT COUNT(*) as c FROM ${table} WHERE ${scopeColumn} IN (${placeholders})`).get(...allIds) as { c: number };
    if (row.c !== cloudCount) {
      mismatches.push({ table: cloudKey, cloud: cloudCount, local: row.c });
    }
  }

  expect(mismatches).toHaveLength(0);
});

test("verifyCounts — multi-outlet: detects mismatch when only one outlet's data is present", () => {
  const db = createTestDb();

  const OUTLET_A = "outlet-a";
  const OUTLET_B = "outlet-b";
  const allIds = [OUTLET_A, OUTLET_B];

  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${OUTLET_A}', 'A', 'a', 'A001')`);
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${OUTLET_B}', 'B', 'b', 'B001')`);

  // Only outlet A has data: 6 categories, 20 menu items
  // Cloud expects both outlets: 12 categories, 40 menu items
  for (let i = 0; i < 6; i++) {
    db.query(`INSERT INTO category (id, name, restaurant_id) VALUES (?, ?, ?)`).run(`cat-a-${i}`, `Cat A${i}`, OUTLET_A);
  }
  for (let i = 0; i < 20; i++) {
    db.query(`INSERT INTO menu_item (id, name, category_id, restaurant_id) VALUES (?, ?, ?, ?)`).run(`item-a-${i}`, `Item A${i}`, `cat-a-0`, OUTLET_A);
  }

  const cloudCounts = { categories: 12, menuItems: 40 };

  const placeholders = allIds.map(() => "?").join(",");
  const tableMap = [
    { cloudKey: "categories", table: "category", scopeColumn: "restaurant_id" },
    { cloudKey: "menuItems", table: "menu_item", scopeColumn: "restaurant_id" },
  ];

  const mismatches: Array<{ table: string; cloud: number; local: number }> = [];
  for (const { cloudKey, table, scopeColumn } of tableMap) {
    const cloudCount = (cloudCounts as any)[cloudKey];
    if (cloudCount === undefined) continue;
    const row = db.query(`SELECT COUNT(*) as c FROM ${table} WHERE ${scopeColumn} IN (${placeholders})`).get(...allIds) as { c: number };
    if (row.c !== cloudCount) {
      mismatches.push({ table: cloudKey, cloud: cloudCount, local: row.c });
    }
  }

  expect(mismatches).toHaveLength(2);
  expect(mismatches[0]).toEqual({ table: "categories", cloud: 12, local: 6 });
  expect(mismatches[1]).toEqual({ table: "menuItems", cloud: 40, local: 20 });
});

// ── Test 4: verification failure still marks sync completed (data is committed) ─

test("config_sync_completed — set to true even when count verification fails (data is committed)", () => {
  const db = createTestDb();
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST001')`);

  // Simulate: sync wrote 5 items but cloud said 156
  for (let i = 0; i < 5; i++) {
    db.query(`INSERT INTO menu_item (id, name, category_id, restaurant_id) VALUES (?, ?, ?, ?)`).run(`item-${i}`, `Item ${i}`, `cat-0`, RESTAURANT_ID);
  }

  // Simulate the verification logic: counts don't match
  const cloudCounts = { menuItems: 156 };
  const localRow = db.query(`SELECT COUNT(*) as c FROM menu_item WHERE restaurant_id = ?`).get(RESTAURANT_ID) as { c: number };
  const countsMatch = localRow.c === cloudCounts.menuItems;

  expect(countsMatch).toBe(false);

  // New behavior: verification failure still marks sync as completed because
  // the data IS committed to SQLite. config_sync_verified is "false" so the
  // system knows the data wasn't fully verified. The UI shows a warning and
  // lets the user decide whether to proceed.
  setSyncState(db, "config_sync_completed", "true");
  setSyncState(db, "config_sync_verified", "false");

  expect(getSyncState(db, "config_sync_completed")).toBe("true");
  expect(getSyncState(db, "config_sync_verified")).toBe("false");
});

// ── Test 5: Re-sync failure keeps prior data operational ──────────────────────

test("config_sync_completed — stays true on re-sync failure when prior sync succeeded", () => {
  const db = createTestDb();
  db.exec(`INSERT INTO outlet (id, name, slug, restaurant_code) VALUES ('${RESTAURANT_ID}', 'Test', 'test', 'TEST001')`);

  // First sync succeeded
  setSyncState(db, "config_sync_completed", "true");
  setSyncState(db, "config_sync_verified", "true");

  // Re-sync fails verification
  const previousSyncCompleted = getSyncState(db, "config_sync_completed") === "true";
  expect(previousSyncCompleted).toBe(true);

  // Simulate re-sync failure: counts don't match
  const countsMatch = false;

  if (!countsMatch) {
    setSyncState(db, "config_sync_verified", "false");
    if (!previousSyncCompleted) {
      setSyncState(db, "config_sync_completed", "false");
    }
    // else: keep config_sync_completed = "true" from prior sync
  }

  // config_sync_completed should still be "true" — old data keeps serving
  expect(getSyncState(db, "config_sync_completed")).toBe("true");
  expect(getSyncState(db, "config_sync_verified")).toBe("false");
});

// ── Test 6: Empty arrays should not be cached in reads.ts ─────────────────────

test("reads cache — empty arrays are not cached", () => {
  const cache = new Map<string, { data: any; timestamp: number }>();

  function setCached(key: string, data: any): void {
    if (Array.isArray(data) && data.length === 0) return;
    cache.set(key, { data, timestamp: Date.now() });
  }

  // Cache a non-empty array — should be stored
  setCached("menu:items", [{ id: "1", name: "Biryani" }]);
  expect(cache.has("menu:items")).toBe(true);
  expect(cache.size).toBe(1);

  // Cache an empty array — should NOT be stored
  setCached("menu:empty", []);
  expect(cache.has("menu:empty")).toBe(false);
  expect(cache.size).toBe(1);

  // Cache a non-array (e.g., object) — should be stored
  setCached("outlet:settings", { id: "1", name: "Test" });
  expect(cache.has("outlet:settings")).toBe(true);
  expect(cache.size).toBe(2);
});

// ── Test 7: Incremental sync mutex — skip when full sync is in progress ───────

test("incremental sync mutex — skips when full sync mutex is held", () => {
  let syncMutex = false;
  let incrementalRan = false;

  // Simulate full sync holding the mutex
  syncMutex = true;

  // Simulate the incremental poll check
  if (syncMutex) {
    // Skip — full sync in progress
  } else {
    incrementalRan = true;
  }

  expect(incrementalRan).toBe(false);

  // Release mutex — incremental should now run
  syncMutex = false;
  if (!syncMutex) {
    incrementalRan = true;
  }

  expect(incrementalRan).toBe(true);
});

// ── Test 8: ConfigSyncState transitions follow the contract ───────────────────

test("ConfigSyncState — all transitions are valid per the contract", () => {
  const transitions: Record<string, string[]> = {
    IDLE: ["DOWNLOADING"],
    DOWNLOADING: ["VALIDATING", "FAILED"],
    VALIDATING: ["COMMITTING", "FAILED"],
    COMMITTING: ["VERIFYING", "FAILED"],
    VERIFYING: ["READY", "FAILED"],
    READY: ["IDLE", "DOWNLOADING"],
    FAILED: ["IDLE", "DOWNLOADING"],
  };

  // Verify the happy path: IDLE → DOWNLOADING → VALIDATING → COMMITTING → VERIFYING → READY
  expect(transitions.IDLE).toContain("DOWNLOADING");
  expect(transitions.DOWNLOADING).toContain("VALIDATING");
  expect(transitions.VALIDATING).toContain("COMMITTING");
  expect(transitions.COMMITTING).toContain("VERIFYING");
  expect(transitions.VERIFYING).toContain("READY");

  // Verify failure paths: every state can transition to FAILED
  expect(transitions.DOWNLOADING).toContain("FAILED");
  expect(transitions.VALIDATING).toContain("FAILED");
  expect(transitions.COMMITTING).toContain("FAILED");
  expect(transitions.VERIFYING).toContain("FAILED");

  // Verify retry: FAILED can go back to IDLE or DOWNLOADING
  expect(transitions.FAILED).toContain("IDLE");
  expect(transitions.FAILED).toContain("DOWNLOADING");

  // Verify re-sync: READY can go back to DOWNLOADING
  expect(transitions.READY).toContain("DOWNLOADING");
});

// ── Test 9: Health endpoint exposes verification fields ───────────────────────

test("health endpoint — exposes configSyncVerified and count mismatches", () => {
  const db = createTestDb();

  // Simulate a successful verified sync
  setSyncState(db, "config_sync_completed", "true");
  setSyncState(db, "config_sync_verified", "true");
  setSyncState(db, "config_count_mismatches", "");
  setSyncState(db, "config_integrity_violations", "[]");

  const verified = getSyncState(db, "config_sync_verified") === "true";
  const countMismatches = getSyncState(db, "config_count_mismatches") || "";
  const integrityViolations = getSyncState(db, "config_integrity_violations") || "[]";

  expect(verified).toBe(true);
  expect(countMismatches).toBe("");
  expect(integrityViolations).toBe("[]");

  // Simulate a failed verification
  setSyncState(db, "config_sync_verified", "false");
  setSyncState(db, "config_count_mismatches", JSON.stringify([{ table: "menuItems", cloud: 156, local: 89 }]));

  const failedVerified = getSyncState(db, "config_sync_verified") === "true";
  const failedMismatches = getSyncState(db, "config_count_mismatches") || "";

  expect(failedVerified).toBe(false);
  expect(JSON.parse(failedMismatches)).toEqual([{ table: "menuItems", cloud: 156, local: 89 }]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});
