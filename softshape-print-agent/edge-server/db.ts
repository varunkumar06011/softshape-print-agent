// ─────────────────────────────────────────────────────────────────────────────
// db.ts — Local SQLite database for SoftShape Edge Server
// ─────────────────────────────────────────────────────────────────────────────
// Uses Bun's built-in SQLite (bun:sqlite) — zero native dependencies.
// Mirrors the cloud PostgreSQL hot-path tables needed for offline order creation,
// KOT printing, and table management.
//
// All writes go through here. Reads for the captain app also come from here
// when the edge server is active.
// ─────────────────────────────────────────────────────────────────────────────

import { Database } from "bun:sqlite";
import { openDatabaseWithRecovery, getDbPath, type RecoveryResult } from "./recovery.ts";
import { existsSync, renameSync } from "node:fs";

// ── IST date helper ──────────────────────────────────────────────────────────
// The cloud backend uses Asia/Kolkata (IST, UTC+5:30) for daily counter dates.
// The edge server must use the same timezone so that edge-assigned KOT/bill
// numbers map to the same counter date on the cloud during sync. Using UTC
// (toISOString().slice(0,10)) caused a 5.5-hour mismatch around midnight where
// edge and cloud counters were on different dates.
export function getKolkataDateString(date = new Date()): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

const CURRENT_SCHEMA_VERSION = 2;

let db: Database | null = null;
let recoveryStatus: RecoveryResult = { recovered: false, corruptPath: null, message: "" };

export function getDb(): Database {
  if (db) return db;

  const result = openDatabaseWithRecovery();
  db = result.db;
  recoveryStatus = result.recovery;

  // Schema-version check: a stale on-disk schema (from an older app version
  // or a previous broken attempt) is treated like corruption — back up + rebuild
  // — so CREATE TABLE IF NOT EXISTS doesn't silently reuse a mismatched schema.
  const versionRow = db.query("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const onDiskVersion = Number(versionRow?.user_version || 0);

  // Detect pre-versioning DBs: user_version=0 but tables already exist (from
  // an older app version that didn't stamp user_version). These have the old
  // schema (e.g. organization_id NOT NULL) and must be rebuilt.
  const hasPreVersioningTables = onDiskVersion === 0 &&
    !!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='outlet'").get();

  if ((onDiskVersion !== 0 && onDiskVersion !== CURRENT_SCHEMA_VERSION) || hasPreVersioningTables) {
    console.warn(`[DB] Schema version mismatch: on-disk=${onDiskVersion}, expected=${CURRENT_SCHEMA_VERSION}${hasPreVersioningTables ? ' (pre-versioning DB detected)' : ''}. Rebuilding fresh DB.`);
    const dbPath = getDbPath();
    db.close();
    db = null;

    const backupPath = `${dbPath}.stale-schema-${Date.now()}`;
    try {
      if (existsSync(dbPath)) renameSync(dbPath, backupPath);
    } catch (err) {
      console.error("[DB] Could not back up stale-schema DB:", err);
    }

    const fresh = new Database(dbPath, { create: true });
    fresh.exec("PRAGMA journal_mode = WAL;");
    fresh.exec("PRAGMA foreign_keys = ON;");
    fresh.exec("PRAGMA busy_timeout = 5000;");
    db = fresh;

    recoveryStatus = {
      recovered: true,
      corruptPath: backupPath,
      message: "Local database schema was outdated and has been reset. " +
        "Menu and settings will be re-downloaded from the cloud when connected.",
    };
    console.warn(`[DB] ${recoveryStatus.message}`);
  }

  initSchema(db);
  runMigrations(db);

  if (onDiskVersion !== CURRENT_SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  }

  return db;
}

export function getRecoveryStatus(): RecoveryResult {
  return recoveryStatus;
}

function initSchema(database: Database) {
  database.exec(`
    -- Outlet (restaurant settings, branding, tax config)
    CREATE TABLE IF NOT EXISTS outlet (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      slug                TEXT NOT NULL,
      restaurant_code     TEXT NOT NULL,
      restaurant_type     TEXT,
      address             TEXT,
      phone               TEXT,
      email               TEXT,
      gstin               TEXT,
      logo_url            TEXT,
      receipt_header      TEXT,
      receipt_sub_header  TEXT,
      theme_primary       TEXT,
      theme_secondary     TEXT,
      printer_config      TEXT,  -- JSON
      bar_unit_ml         INTEGER DEFAULT 30,
      full_bottle_ml      INTEGER DEFAULT 750,
      half_bottle_ml      INTEGER DEFAULT 375,
      fssai               TEXT,
      prices_include_gst  INTEGER DEFAULT 0,
      gst_category        TEXT DEFAULT 'NON_AC',
      gst_rate            REAL,
      gst_registered      INTEGER DEFAULT 1,
      service_charge_percent INTEGER DEFAULT 0,
      enabled_modules     TEXT,  -- JSON
      shared_kitchen_outlet_id TEXT,
      organization_id     TEXT,
      is_active           INTEGER DEFAULT 1,
      synced_at           INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Tax Profiles
    CREATE TABLE IF NOT EXISTS tax_profile (
      id                    TEXT PRIMARY KEY,
      restaurant_id         TEXT NOT NULL,
      name                  TEXT NOT NULL,
      gst_category          TEXT DEFAULT 'NON_AC',
      gst_rate              REAL,
      gst_registered        INTEGER DEFAULT 1,
      service_charge_percent INTEGER DEFAULT 0,
      is_default            INTEGER DEFAULT 0,
      synced_at             INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_tax_profile_restaurant ON tax_profile(restaurant_id);

    -- Price Profiles
    CREATE TABLE IF NOT EXISTS price_profile (
      id              TEXT PRIMARY KEY,
      restaurant_id   TEXT NOT NULL,
      name            TEXT NOT NULL,
      is_default      INTEGER DEFAULT 0,
      synced_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_price_profile_restaurant ON price_profile(restaurant_id);

    -- Price Profile Items (per-menu-item price overrides)
    CREATE TABLE IF NOT EXISTS price_profile_item (
      id                TEXT PRIMARY KEY,
      price_profile_id  TEXT NOT NULL,
      menu_item_id      TEXT NOT NULL,
      price             REAL NOT NULL,
      restaurant_id     TEXT NOT NULL,
      UNIQUE(price_profile_id, menu_item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ppi_profile ON price_profile_item(price_profile_id);
    CREATE INDEX IF NOT EXISTS idx_ppi_menu_item ON price_profile_item(menu_item_id);
    CREATE INDEX IF NOT EXISTS idx_ppi_restaurant ON price_profile_item(restaurant_id);

    -- Venues
    CREATE TABLE IF NOT EXISTS venue (
      id                TEXT PRIMARY KEY,
      restaurant_id     TEXT NOT NULL,
      name              TEXT NOT NULL,
      venue_type        TEXT DEFAULT 'DINE_IN',
      sort_order        INTEGER DEFAULT 0,
      is_active         INTEGER DEFAULT 1,
      is_deleted        INTEGER DEFAULT 0,
      price_profile_id  TEXT,
      tax_profile_id    TEXT,
      kot_printer_name  TEXT,
      bill_printer_name TEXT,
      kot_enabled       INTEGER DEFAULT 1,
      synced_at         INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_venue_restaurant ON venue(restaurant_id);

    -- Floors
    CREATE TABLE IF NOT EXISTS floor (
      id              TEXT PRIMARY KEY,
      venue_id        TEXT NOT NULL,
      restaurant_id   TEXT NOT NULL,
      name            TEXT NOT NULL,
      sort_order      INTEGER DEFAULT 0,
      is_active       INTEGER DEFAULT 1,
      synced_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_floor_venue ON floor(venue_id);
    CREATE INDEX IF NOT EXISTS idx_floor_restaurant ON floor(restaurant_id);

    -- Sections
    CREATE TABLE IF NOT EXISTS section (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      restaurant_id   TEXT NOT NULL,
      floor_id        TEXT,
      venue_id        TEXT,
      sort_order      INTEGER DEFAULT 0,
      is_active       INTEGER DEFAULT 1,
      synced_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_section_restaurant ON section(restaurant_id);
    CREATE INDEX IF NOT EXISTS idx_section_venue ON section(venue_id);
    CREATE INDEX IF NOT EXISTS idx_section_floor ON section(floor_id);

    -- Tables
    CREATE TABLE IF NOT EXISTS "table" (
      id                TEXT PRIMARY KEY,
      number            INTEGER NOT NULL,
      capacity          INTEGER DEFAULT 4,
      status            TEXT DEFAULT 'AVAILABLE',
      section_id        TEXT NOT NULL,
      restaurant_id     TEXT NOT NULL,
      workflow_status   TEXT,
      captain_id        TEXT,
      guests            INTEGER DEFAULT 0,
      session_started_at INTEGER,  -- epoch ms
      current_bill      REAL DEFAULT 0,
      kot_history       TEXT DEFAULT '[]',  -- JSON
      discount          REAL,
      section_tag       TEXT,
      last_waiter_call_at INTEGER,  -- epoch ms
      updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_table_restaurant_status ON "table"(restaurant_id, status);
    CREATE INDEX IF NOT EXISTS idx_table_section ON "table"(section_id);

    -- Categories
    CREATE TABLE IF NOT EXISTS category (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      sort_order      INTEGER DEFAULT 0,
      is_active       INTEGER DEFAULT 1,
      restaurant_id   TEXT NOT NULL,
      printer_target  TEXT,
      synced_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_category_restaurant ON category(restaurant_id);

    -- Menu Items
    CREATE TABLE IF NOT EXISTS menu_item (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      description     TEXT,
      image_url       TEXT,
      is_veg          INTEGER DEFAULT 1,
      is_available    INTEGER DEFAULT 1,
      sort_order      INTEGER DEFAULT 0,
      category_id     TEXT NOT NULL,
      restaurant_id   TEXT NOT NULL,
      base_price      REAL DEFAULT 0,
      unit            TEXT,
      is_deleted      INTEGER DEFAULT 0,
      deleted_at      INTEGER,
      printer_target  TEXT,
      printer_name    TEXT,
      menu_type       TEXT DEFAULT 'FOOD',
      gst_enabled     INTEGER DEFAULT 1,
      is_special      INTEGER DEFAULT 0,
      special_channel TEXT DEFAULT 'BOTH',
      special_active  INTEGER DEFAULT 1,
      special_expires_at INTEGER,
      synced_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_menu_item_category ON menu_item(category_id);
    CREATE INDEX IF NOT EXISTS idx_menu_item_restaurant ON menu_item(restaurant_id);
    CREATE INDEX IF NOT EXISTS idx_menu_item_available ON menu_item(restaurant_id, is_available, is_deleted);

    -- Menu Item Variants
    CREATE TABLE IF NOT EXISTS menu_item_variant (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      price           REAL NOT NULL,
      is_default      INTEGER DEFAULT 0,
      menu_item_id    TEXT NOT NULL,
      is_available    INTEGER DEFAULT 1,
      restaurant_id   TEXT NOT NULL,
      synced_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_variant_menu_item ON menu_item_variant(menu_item_id);
    CREATE INDEX IF NOT EXISTS idx_variant_restaurant ON menu_item_variant(restaurant_id);

    -- Menu Item Addons
    CREATE TABLE IF NOT EXISTS menu_item_addon (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      price           REAL NOT NULL,
      is_available    INTEGER DEFAULT 1,
      menu_item_id    TEXT NOT NULL,
      restaurant_id   TEXT NOT NULL,
      synced_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_addon_menu_item ON menu_item_addon(menu_item_id);
    CREATE INDEX IF NOT EXISTS idx_addon_restaurant ON menu_item_addon(restaurant_id);

    -- Venue Prices (per-venue menu item price overrides)
    CREATE TABLE IF NOT EXISTS venue_price (
      id              TEXT PRIMARY KEY,
      venue_id        TEXT NOT NULL,
      menu_item_id    TEXT NOT NULL,
      price           REAL NOT NULL,
      is_active       INTEGER DEFAULT 1,
      restaurant_id   TEXT NOT NULL,
      UNIQUE(venue_id, menu_item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_venue_price_venue ON venue_price(venue_id);
    CREATE INDEX IF NOT EXISTS idx_venue_price_menu_item ON venue_price(menu_item_id);

    -- Venue Menu Item Availability
    CREATE TABLE IF NOT EXISTS venue_menu_item_availability (
      id              TEXT PRIMARY KEY,
      venue_id        TEXT NOT NULL,
      menu_item_id    TEXT NOT NULL,
      restaurant_id   TEXT NOT NULL,
      is_available    INTEGER DEFAULT 1,
      UNIQUE(venue_id, menu_item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_vmaa_venue ON venue_menu_item_availability(venue_id);

    -- Orders
    CREATE TABLE IF NOT EXISTS order_record (
      id                  TEXT PRIMARY KEY,
      table_id            TEXT NOT NULL,
      restaurant_id       TEXT NOT NULL,
      status              TEXT DEFAULT 'PENDING',
      total_amount        REAL DEFAULT 0,
      billing_requested   INTEGER DEFAULT 0,
      billing_requested_at INTEGER,
      created_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      is_deleted          INTEGER DEFAULT 0,
      deleted_at          INTEGER,
      bill_number         TEXT,
      paid_at             INTEGER,
      last_request_id     TEXT,
      inventory_deducted  INTEGER DEFAULT 0,
      captain_id          TEXT,
      platform            TEXT DEFAULT 'DINE_IN',
      created_by_user_id  TEXT,
      cloud_synced        INTEGER DEFAULT 0,  -- 0 = not yet pushed to cloud, 1 = synced
      UNIQUE(last_request_id)  -- idempotency: one order per requestId
    );
    CREATE INDEX IF NOT EXISTS idx_order_restaurant_status ON order_record(restaurant_id, status);
    CREATE INDEX IF NOT EXISTS idx_order_table_status ON order_record(table_id, status);
    CREATE INDEX IF NOT EXISTS idx_order_cloud_synced ON order_record(cloud_synced) WHERE cloud_synced = 0;

    -- Order Items
    CREATE TABLE IF NOT EXISTS order_item (
      id                  TEXT PRIMARY KEY,
      order_id            TEXT NOT NULL,
      menu_item_id        TEXT NOT NULL,
      name                TEXT NOT NULL,
      price               REAL NOT NULL,
      quantity            INTEGER NOT NULL,
      notes               TEXT,
      added_by_cashier    INTEGER DEFAULT 0,
      original_quantity   INTEGER,
      cancelled_quantity  INTEGER DEFAULT 0,
      edited_quantity     INTEGER DEFAULT 0,
      removed_from_bill   INTEGER DEFAULT 0,
      removed_by          TEXT,
      removed_at          INTEGER,
      menu_type           TEXT DEFAULT 'FOOD',
      cloud_synced        INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_order_item_order ON order_item(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_item_menu_item ON order_item(menu_item_id);
    CREATE INDEX IF NOT EXISTS idx_order_item_synced ON order_item(cloud_synced) WHERE cloud_synced = 0;

    -- KOTs (Kitchen Order Tickets)
    CREATE TABLE IF NOT EXISTS kot (
      id              TEXT PRIMARY KEY,
      restaurant_id   TEXT NOT NULL,
      table_id        TEXT NOT NULL,
      order_id        TEXT NOT NULL,
      kot_number      INTEGER NOT NULL,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      cloud_synced    INTEGER DEFAULT 0,
      UNIQUE(restaurant_id, kot_number)
    );
    CREATE INDEX IF NOT EXISTS idx_kot_restaurant_table ON kot(restaurant_id, table_id);
    CREATE INDEX IF NOT EXISTS idx_kot_restaurant_order ON kot(restaurant_id, order_id);
    CREATE INDEX IF NOT EXISTS idx_kot_synced ON kot(cloud_synced) WHERE cloud_synced = 0;

    -- KOT Items
    CREATE TABLE IF NOT EXISTS kot_item (
      id              TEXT PRIMARY KEY,
      kot_id          TEXT NOT NULL,
      order_item_id   TEXT NOT NULL,
      menu_item_id    TEXT NOT NULL,
      name            TEXT NOT NULL,
      quantity        INTEGER NOT NULL,
      price           REAL NOT NULL,
      notes           TEXT,
      status          TEXT DEFAULT 'SENT',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      cloud_synced    INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_kot_item_kot ON kot_item(kot_id);
    CREATE INDEX IF NOT EXISTS idx_kot_item_order_item ON kot_item(order_item_id);
    CREATE INDEX IF NOT EXISTS idx_kot_item_synced ON kot_item(cloud_synced) WHERE cloud_synced = 0;

    -- Daily Counter (KOT/bill/txn counts per day)
    CREATE TABLE IF NOT EXISTS daily_counter (
      id              TEXT PRIMARY KEY,
      restaurant_id   TEXT NOT NULL,
      counter_date    TEXT NOT NULL,
      kot_count       INTEGER DEFAULT 0,
      bill_count      INTEGER DEFAULT 0,
      txn_count       INTEGER DEFAULT 0,
      UNIQUE(restaurant_id, counter_date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_counter_restaurant_date ON daily_counter(restaurant_id, counter_date);

    -- Sync Queue (edge to cloud push queue)
    CREATE TABLE IF NOT EXISTS sync_queue (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name      TEXT NOT NULL,       -- 'order', 'order_item', 'kot', 'kot_item', 'table'
      record_id       TEXT NOT NULL,       -- the local row ID
      operation       TEXT NOT NULL,       -- 'insert', 'update'
      created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      attempts        INTEGER DEFAULT 0,
      last_error      TEXT,
      synced          INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sync_queue_pending ON sync_queue(synced) WHERE synced = 0;

    -- Sync State (cloud to edge pull tracking)
    CREATE TABLE IF NOT EXISTS sync_state (
      key             TEXT PRIMARY KEY,
      value           TEXT NOT NULL,
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    -- Edge Config (local settings, printer mapping, session)
    CREATE TABLE IF NOT EXISTS edge_config (
      key             TEXT PRIMARY KEY,
      value           TEXT NOT NULL,
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    -- Users (staff accounts for offline PIN verification)
    CREATE TABLE IF NOT EXISTS users (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      pin             TEXT,              -- bcrypt hash (same as cloud)
      role            TEXT NOT NULL,     -- 'OWNER', 'ADMIN', 'CASHIER', 'CAPTAIN', 'MANAGER'
      is_active       INTEGER DEFAULT 1,
      outlet_id       TEXT NOT NULL,
      permissions      TEXT,             -- JSON
      synced_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_users_outlet ON users(outlet_id);
    CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active) WHERE is_active = 1;
  `);
}

// ── Lightweight column migrations for existing DBs ───────────────────────────
// CREATE TABLE IF NOT EXISTS won't add new columns to existing tables.
// This runs idempotent ALTER TABLE statements guarded by column-existence checks.
function runMigrations(database: Database) {
  const hasColumn = (table: string, col: string): boolean => {
    const cols = database.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return cols.some(c => c.name === col);
  };

  // section.is_active — added for onboarding INSERT compatibility
  if (!hasColumn("section", "is_active")) {
    database.exec(`ALTER TABLE section ADD COLUMN is_active INTEGER DEFAULT 1`);
  }

  // outlet.organization_id NOT NULL → nullable
  // Pre-v17.1.0 DBs created organization_id as TEXT NOT NULL. The schema-version
  // check in getDb() should rebuild these, but on Windows the rebuild can fail
  // silently (renameSync fails if WAL/SHM files are locked by another process).
  // This migration recreates the outlet table with nullable organization_id as
  // a safety net. SQLite has no ALTER COLUMN, so we recreate via temp table.
  const outletCols = database.query("PRAGMA table_info(outlet)").all() as { name: string; notnull: number }[];
  const orgCol = outletCols.find(c => c.name === "organization_id");
  if (orgCol && orgCol.notnull === 1) {
    console.warn("[DB] outlet.organization_id is NOT NULL — recreating table with nullable column");
    database.exec(`
      CREATE TABLE IF NOT EXISTS outlet_migrate_tmp (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        slug                TEXT NOT NULL,
        restaurant_code     TEXT NOT NULL,
        restaurant_type     TEXT,
        address             TEXT,
        phone               TEXT,
        email               TEXT,
        gstin               TEXT,
        logo_url            TEXT,
        receipt_header      TEXT,
        receipt_sub_header  TEXT,
        theme_primary       TEXT,
        theme_secondary     TEXT,
        printer_config      TEXT,
        bar_unit_ml         INTEGER DEFAULT 30,
        full_bottle_ml      INTEGER DEFAULT 750,
        half_bottle_ml      INTEGER DEFAULT 375,
        fssai               TEXT,
        prices_include_gst  INTEGER DEFAULT 0,
        gst_category        TEXT DEFAULT 'NON_AC',
        gst_rate            REAL,
        gst_registered      INTEGER DEFAULT 1,
        service_charge_percent INTEGER DEFAULT 0,
        enabled_modules     TEXT,
        shared_kitchen_outlet_id TEXT,
        organization_id     TEXT,
        is_active           INTEGER DEFAULT 1,
        synced_at           INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    // Copy existing data using explicit column list. Use COALESCE for columns
    // that might not exist in the old schema.
    const oldColNames = new Set(outletCols.map(c => c.name));
    const allCols = [
      "id", "name", "slug", "restaurant_code", "restaurant_type", "address",
      "phone", "email", "gstin", "logo_url", "receipt_header", "receipt_sub_header",
      "theme_primary", "theme_secondary", "printer_config", "bar_unit_ml",
      "full_bottle_ml", "half_bottle_ml", "fssai", "prices_include_gst",
      "gst_category", "gst_rate", "gst_registered", "service_charge_percent",
      "enabled_modules", "shared_kitchen_outlet_id", "organization_id",
      "is_active", "synced_at"
    ];
    const selectCols = allCols.map(col =>
      oldColNames.has(col) ? col : "NULL"
    ).join(", ");
    database.exec(`INSERT INTO outlet_migrate_tmp (${allCols.join(", ")}) SELECT ${selectCols} FROM outlet;`);
    database.exec(`DROP TABLE outlet;`);
    database.exec(`ALTER TABLE outlet_migrate_tmp RENAME TO outlet;`);
    console.warn("[DB] outlet table recreated with nullable organization_id");
  }
}

// ── Prepared statement helpers ───────────────────────────────────────────────

export function getConfig(key: string): string | null {
  const db = getDb();
  const row = db.query("SELECT value FROM edge_config WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setConfig(key: string, value: string): void {
  const db = getDb();
  db.query("INSERT INTO edge_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?")
    .run(key, value, Date.now(), value, Date.now());
}

export function getSyncState(key: string): string | null {
  const db = getDb();
  const row = db.query("SELECT value FROM sync_state WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setSyncState(key: string, value: string): void {
  const db = getDb();
  db.query("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?")
    .run(key, value, Date.now(), value, Date.now());
}

// ── Enqueue sync record for edge → cloud push ────────────────────────────────

export function enqueueSync(tableName: string, recordId: string, operation: string): void {
  const db = getDb();
  db.query("INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)")
    .run(tableName, recordId, operation, Date.now());
}

// ── Get next KOT number (local counter, atomic) ──────────────────────────────

export function getNextKotNumber(restaurantId: string): number {
  const db = getDb();
  const today = getKolkataDateString();

  // Upsert daily counter
  db.query("INSERT INTO daily_counter (id, restaurant_id, counter_date, kot_count) VALUES (?, ?, ?, 0) ON CONFLICT(restaurant_id, counter_date) DO NOTHING")
    .run(crypto.randomUUID(), restaurantId, today);

  // Atomically increment kot_count and return the new value
  const row = db.query("UPDATE daily_counter SET kot_count = kot_count + 1 WHERE restaurant_id = ? AND counter_date = ? RETURNING kot_count")
    .get(restaurantId, today) as { kot_count: number };

  return row.kot_count;
}

// ── Close database (for graceful shutdown) ────────────────────────────────────

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ── Test-only: inject an in-memory database for unit tests ───────────────────
// ESM exports are readonly, so tests cannot monkey-patch getDb directly.
// Call setDb(testDb) before importing modules that call getDb(), and
// closeDb() after each test to reset state.
export function setDb(testDb: Database | null): void {
  if (db && db !== testDb) {
    try { db.close(); } catch {}
  }
  db = testDb;
}
