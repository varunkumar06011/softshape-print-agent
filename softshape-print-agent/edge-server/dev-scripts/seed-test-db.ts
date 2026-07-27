// Seed the edge server's local SQLite DB with test data for E2E testing.
// This mimics what cloud onboarding + config sync would do, without needing
// a real cloud backend or setup token.
//
// Usage: bun run dev-scripts/seed-test-db.ts
//
// After running, restart the edge server so it picks up the new session.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import bcrypt from "bcryptjs";

const DB_PATH = process.env.EDGE_DB_PATH || join(homedir(), ".softshape", "edge.db");

if (!existsSync(DB_PATH)) {
  console.error(`[seed] DB not found at ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

const RESTAURANT_ID = "test-restaurant-001";
const RESTAURANT_NAME = "Test Restaurant";
const RESTAURANT_SLUG = "test-restaurant";
const RESTAURANT_CODE = "TEST01";
const EDGE_API_KEY = "test-edge-api-key-1234567890abcdef";

// ── 1. Create schema if not exists (minimal subset) ──────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS outlet (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
    restaurant_code TEXT, restaurant_type TEXT DEFAULT 'DINE_IN',
    address TEXT, phone TEXT, email TEXT, gstin TEXT, logo_url TEXT,
    receipt_header TEXT, receipt_sub_header TEXT,
    theme_primary TEXT, theme_secondary TEXT,
    printer_config TEXT, bar_unit_ml INTEGER DEFAULT 30,
    full_bottle_ml INTEGER DEFAULT 750, half_bottle_ml INTEGER DEFAULT 375,
    fssai TEXT, prices_include_gst INTEGER DEFAULT 0,
    gst_category TEXT DEFAULT 'NON_AC', gst_rate REAL,
    gst_registered INTEGER DEFAULT 1, service_charge_percent INTEGER DEFAULT 0,
    enabled_modules TEXT, shared_kitchen_outlet_id TEXT,
    organization_id TEXT, is_active INTEGER DEFAULT 1,
    synced_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, pin TEXT,
    role TEXT NOT NULL, outlet_id TEXT NOT NULL,
    is_active INTEGER DEFAULT 1, permissions TEXT,
    synced_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS edge_config (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS category (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1, restaurant_id TEXT NOT NULL,
    printer_target TEXT, synced_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS menu_item (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
    price REAL DEFAULT 0, is_available INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0, category_id TEXT NOT NULL,
    restaurant_id TEXT NOT NULL, base_price REAL DEFAULT 0,
    unit TEXT, is_deleted INTEGER DEFAULT 0,
    synced_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS venue (
    id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL, name TEXT NOT NULL,
    venue_type TEXT DEFAULT 'DINE_IN', sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1, kot_enabled INTEGER DEFAULT 1,
    synced_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS section (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, restaurant_id TEXT NOT NULL,
    floor_id TEXT, venue_id TEXT, sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1, synced_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS "table" (
    id TEXT PRIMARY KEY, number INTEGER NOT NULL, capacity INTEGER DEFAULT 4,
    status TEXT DEFAULT 'AVAILABLE', section_id TEXT NOT NULL,
    restaurant_id TEXT NOT NULL, workflow_status TEXT,
    captain_id TEXT, guests INTEGER DEFAULT 0,
    revision INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1,
    last_command_id TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// ── 2. Insert outlet ──────────────────────────────────────────────────────────
db.query(`INSERT INTO outlet (id, name, slug, restaurant_code, restaurant_type, is_active, prices_include_gst, gst_category, gst_registered, service_charge_percent, enabled_modules, synced_at)
  VALUES (?, ?, ?, ?, 'DINE_IN', 1, 0, 'NON_AC', 1, 0, '["KOT","BILLING","TABLES"]', unixepoch())
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, slug=excluded.slug, restaurant_code=excluded.restaurant_code, enabled_modules=excluded.enabled_modules, synced_at=unixepoch()
`).run(RESTAURANT_ID, RESTAURANT_NAME, RESTAURANT_SLUG, RESTAURANT_CODE);

// ── 3. Insert edge_config (session) ───────────────────────────────────────────
const sessionToken = "test-session-token-" + Date.now();
const backendUrl = "https://api.softshape.in";
const now = Date.now();
const expiresAt = now + 365 * 24 * 60 * 60 * 1000; // 1 year

const configEntries: [string, string][] = [
  ["session_token", sessionToken],
  ["restaurant_id", RESTAURANT_ID],
  ["restaurant_name", RESTAURANT_NAME],
  ["restaurant_code", RESTAURANT_CODE],
  ["backend_url", backendUrl],
  ["session_expires_at", String(expiresAt)],
  ["edge_api_key", EDGE_API_KEY],
  ["device_id", "test-device-001"],
];

for (const [key, value] of configEntries) {
  db.query(`INSERT INTO edge_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, value, now);
}

// Mark config sync as completed so isLocalReady() returns true
db.query(`INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
`).run("config_sync_completed", "true", now);

// ── 4. Insert test users (captain + cashier) ──────────────────────────────────
const captainPin = bcrypt.hashSync("1234", 10);
const cashierPin = bcrypt.hashSync("5678", 10);

db.query(`INSERT INTO users (id, name, pin, role, outlet_id, is_active, synced_at)
  VALUES (?, ?, ?, 'CAPTAIN', ?, 1, unixepoch())
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, pin=excluded.pin, is_active=1, synced_at=unixepoch()
`).run("test-captain-001", "Test Captain", captainPin, RESTAURANT_ID);

db.query(`INSERT INTO users (id, name, pin, role, outlet_id, is_active, synced_at)
  VALUES (?, ?, ?, 'CASHIER', ?, 1, unixepoch())
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, pin=excluded.pin, is_active=1, synced_at=unixepoch()
`).run("test-cashier-001", "Test Cashier", cashierPin, RESTAURANT_ID);

// ── 5. Insert minimal menu data ───────────────────────────────────────────────
db.query(`INSERT INTO category (id, name, sort_order, is_active, restaurant_id, printer_target, synced_at)
  VALUES (?, 'Main Course', 0, 1, ?, 'KOT', unixepoch())
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, synced_at=unixepoch()
`).run("test-cat-001", RESTAURANT_ID);

db.query(`INSERT INTO menu_item (id, name, is_available, category_id, restaurant_id, base_price, sort_order, is_deleted, synced_at)
  VALUES (?, 'Test Item 1', 1, ?, ?, 150, 0, 0, unixepoch())
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_price=excluded.base_price, is_available=1, is_deleted=0, synced_at=unixepoch()
`).run("test-item-001", "test-cat-001", RESTAURANT_ID);

db.query(`INSERT INTO menu_item (id, name, is_available, category_id, restaurant_id, base_price, sort_order, is_deleted, synced_at)
  VALUES (?, 'Test Item 2', 1, ?, ?, 200, 0, 0, unixepoch())
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_price=excluded.base_price, is_available=1, is_deleted=0, synced_at=unixepoch()
`).run("test-item-002", "test-cat-001", RESTAURANT_ID);

// ── 6. Insert venue + section + table ─────────────────────────────────────────
db.query(`INSERT INTO venue (id, restaurant_id, name, venue_type, sort_order, is_active, kot_enabled, synced_at)
  VALUES (?, ?, 'Main Hall', 'DINE_IN', 0, 1, 1, unixepoch())
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, synced_at=unixepoch()
`).run("test-venue-001", RESTAURANT_ID);

db.query(`INSERT INTO section (id, name, restaurant_id, venue_id, sort_order, is_active, synced_at)
  VALUES (?, 'Section A', ?, ?, 0, 1, unixepoch())
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, synced_at=unixepoch()
`).run("test-section-001", RESTAURANT_ID, "test-venue-001");

db.query(`INSERT INTO "table" (id, number, capacity, status, section_id, restaurant_id, revision, updated_at)
  VALUES (?, 1, 4, 'AVAILABLE', ?, ?, 1, unixepoch())
  ON CONFLICT(id) DO UPDATE SET number=excluded.number, status='AVAILABLE', updated_at=unixepoch()
`).run("test-table-001", "test-section-001", RESTAURANT_ID);

db.query(`INSERT INTO "table" (id, number, capacity, status, section_id, restaurant_id, revision, updated_at)
  VALUES (?, 2, 4, 'AVAILABLE', ?, ?, 1, unixepoch())
  ON CONFLICT(id) DO UPDATE SET number=excluded.number, status='AVAILABLE', updated_at=unixepoch()
`).run("test-table-002", "test-section-001", RESTAURANT_ID);

// ── Summary ───────────────────────────────────────────────────────────────────
const userCount = db.query("SELECT COUNT(*) as c FROM users WHERE is_active = 1").get() as { c: number };
const itemCount = db.query("SELECT COUNT(*) as c FROM menu_item WHERE is_deleted = 0").get() as { c: number };
const tableCount = db.query('SELECT COUNT(*) as c FROM "table"').get() as { c: number };

console.log("[seed] ✅ Edge DB seeded successfully");
console.log(`[seed]    Restaurant: ${RESTAURANT_NAME} (${RESTAURANT_CODE})`);
console.log(`[seed]    Users: ${userCount.c} (captain PIN: 1234, cashier PIN: 5678)`);
console.log(`[seed]    Menu items: ${itemCount.c}`);
console.log(`[seed]    Tables: ${tableCount.c}`);
console.log(`[seed]    Edge API key: ${EDGE_API_KEY}`);
console.log("[seed] Restart the edge server to pick up the new session.");

db.close();
