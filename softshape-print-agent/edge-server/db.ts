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
import { existsSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getBackendUrl, getSessionToken, getRestaurantId, isSessionValid, getDeviceId } from "./auth.ts";
import { cloudFetch, getServerTimeOffsetMs } from "./cloudFetch.ts";

// ── IST date helper ──────────────────────────────────────────────────────────
// The cloud backend uses Asia/Kolkata (IST, UTC+5:30) for daily counter dates.
// The edge server must use the same timezone so that edge-assigned KOT/bill
// numbers map to the same counter date on the cloud during sync. Using UTC
// (toISOString().slice(0,10)) caused a 5.5-hour mismatch around midnight where
// edge and cloud counters were on different dates.
//
// Clock skew correction: if the cloud server's Date header indicates the local
// clock is wrong, we apply the offset so the date string matches server time.
// This prevents KOT numbers from resetting at the wrong time.
export function getKolkataDateString(date = new Date()): string {
  const offset = getServerTimeOffsetMs();
  const corrected = offset !== 0 ? new Date(date.getTime() + offset) : date;
  return corrected.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

const CURRENT_SCHEMA_VERSION = 6;

// Schema versions that can be migrated in place (via runMigrations) without
// wiping the database. Any version not in this set triggers the existing
// backup + rebuild path. v2 → v3 adds revision columns and the command_log
// table via idempotent ALTER TABLE / CREATE TABLE IF NOT EXISTS, so it is
// safe to apply to a live production DB without data loss. v4 → v5 adds the
// transaction_record table (CREATE TABLE IF NOT EXISTS) — also idempotent.
// v5 → v6 recreates the kot table with a date-scoped unique constraint
// (UNIQUE(restaurant_id, kot_number, counter_date)) and backfills
// counter_date from created_at so KOT numbers can restart at 1 daily.
const SAFE_INPLACE_MIGRATION_FROM = new Set<number>([2, 3, 4, 5]);

let db: Database | null = null;
let recoveryStatus: RecoveryResult = { recovered: false, corruptPath: null, message: "" };

// ── Sync-before-migrate ──────────────────────────────────────────────────────
// Before a schema-version rebuild wipes the DB, attempt to push unsynced orders
// to the cloud. Fire-and-forget — the old DB is preserved as a backup file.

async function attemptSyncBeforeMigrate(database: Database): Promise<void> {
  if (!isSessionValid()) return;

  const backendUrl = getBackendUrl();
  const restaurantId = getRestaurantId();
  const token = getSessionToken();
  if (!backendUrl || !restaurantId || !token) return;

  let unsyncedOrders: any[] = [];
  try {
    unsyncedOrders = database.query("SELECT * FROM order_record WHERE cloud_synced = 0").all() as any[];
  } catch {
    return;
  }

  if (unsyncedOrders.length === 0) return;

  console.log(`[DB] Salvage sync: attempting to push ${unsyncedOrders.length} unsynced orders before schema rebuild...`);

  const payload: any[] = [];
  for (const order of unsyncedOrders) {
    try {
      const items = database.query("SELECT * FROM order_item WHERE order_id = ?").all(order.id) as any[];
      payload.push({
        tableName: "order",
        recordId: order.id,
        operation: "create",
        data: {
          ...order,
          cloud_synced: undefined,
          items: items.map(i => ({ ...i, cloud_synced: undefined })),
        },
      });
    } catch { /* skip unreadable */ }
  }

  if (payload.length === 0) return;

  try {
    const res = await cloudFetch(`${backendUrl}/api/edge/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ restaurantId, deviceId: getDeviceId(), batch: payload }),
      timeout: 15_000,
    });
    if (res.ok) {
      const result = await res.json() as { accepted: number[] };
      console.log(`[DB] Salvage sync: ${result.accepted.length} orders pushed to cloud`);
    }
  } catch (err) {
    console.warn("[DB] Salvage sync failed (non-blocking):", err);
  }
}

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

  const canMigrateInPlace = onDiskVersion !== 0 && SAFE_INPLACE_MIGRATION_FROM.has(onDiskVersion) && !hasPreVersioningTables;
  if ((onDiskVersion !== 0 && onDiskVersion !== CURRENT_SCHEMA_VERSION && !canMigrateInPlace) || hasPreVersioningTables) {
    console.warn(`[DB] Schema version mismatch: on-disk=${onDiskVersion}, expected=${CURRENT_SCHEMA_VERSION}${hasPreVersioningTables ? ' (pre-versioning DB detected)' : ''}. Rebuilding fresh DB.`);

    // ── Backup before rebuild (VACUUM INTO) ──────────────────────────────────
    try {
      const backupDir = join(dirname(getDbPath()), "backups");
      mkdirSync(backupDir, { recursive: true });
      const backupFile = join(backupDir, `edge-pre-migrate-${Date.now()}.db`);
      db.query(`VACUUM INTO '${backupFile}'`).run();
      console.log(`[DB] Pre-migration backup created: ${backupFile}`);
    } catch (backupErr) {
      console.warn("[DB] Pre-migration backup failed (non-fatal):", backupErr);
    }

    // ── Salvage sync: push unsynced orders to cloud before wiping ────────────
    attemptSyncBeforeMigrate(db).catch(e => {
      console.warn("[DB] Salvage sync error (non-blocking):", e);
    });

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
    fresh.exec("PRAGMA auto_vacuum = INCREMENTAL;");
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
  } else if (canMigrateInPlace && onDiskVersion !== CURRENT_SCHEMA_VERSION) {
    console.log(`[DB] In-place migration: on-disk=${onDiskVersion} → target=${CURRENT_SCHEMA_VERSION}. Running migrations without rebuild.`);
  }

  initSchema(db);
  runMigrations(db);

  // Enable incremental auto_vacuum so daily maintenance can reclaim free pages
  // from deleted rows without a full VACUUM lock. For existing DBs where
  // auto_vacuum is off (0), set it to INCREMENTAL (2) and run a one-time VACUUM.
  try {
    const av = db.query("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | undefined;
    if (Number(av?.auto_vacuum || 0) !== 2) {
      console.log("[DB] Enabling incremental auto_vacuum (one-time VACUUM)...");
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      db.exec("VACUUM");
      console.log("[DB] Incremental auto_vacuum enabled");
    }
  } catch (err) {
    console.warn("[DB] Could not enable incremental auto_vacuum:", err);
  }

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
      revision         INTEGER NOT NULL DEFAULT 1,  -- monotonic per-table aggregate revision
      last_command_id  TEXT,                       -- most recent command_log request_id applied
      updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_table_restaurant_status ON "table"(restaurant_id, status);
    CREATE INDEX IF NOT EXISTS idx_table_section ON "table"(section_id);
    CREATE INDEX IF NOT EXISTS idx_table_revision ON "table"(revision);

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
      revision            INTEGER NOT NULL DEFAULT 1,  -- monotonic per-order aggregate revision
      last_command_id     TEXT,                       -- most recent command_log request_id applied
      is_extra_table      INTEGER DEFAULT 0,           -- 0 = parent/main table order, 1 = extra table order
      UNIQUE(last_request_id)  -- idempotency: one order per requestId
    );
    CREATE INDEX IF NOT EXISTS idx_order_restaurant_status ON order_record(restaurant_id, status);
    CREATE INDEX IF NOT EXISTS idx_order_table_status ON order_record(table_id, status);
    CREATE INDEX IF NOT EXISTS idx_order_cloud_synced ON order_record(cloud_synced) WHERE cloud_synced = 0;
    CREATE INDEX IF NOT EXISTS idx_order_revision ON order_record(revision);

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
    -- counter_date scopes kot_number uniqueness per IST business day so that
    -- KOT numbers can restart at 1 each morning without colliding with
    -- previous days' KOTs.
    CREATE TABLE IF NOT EXISTS kot (
      id              TEXT PRIMARY KEY,
      restaurant_id   TEXT NOT NULL,
      table_id        TEXT NOT NULL,
      order_id        TEXT NOT NULL,
      kot_number      INTEGER NOT NULL,
      counter_date    TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      cloud_synced    INTEGER DEFAULT 0,
      UNIQUE(restaurant_id, kot_number, counter_date)
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

    -- Sync Audit (permanent rejections and conflicts from cloud sync)
    -- When the cloud permanently rejects or flags a conflict on a sync item,
    -- the edge stores an audit row here before dequeuing it from sync_queue.
    -- This ensures operators can review why items were not applied.
    CREATE TABLE IF NOT EXISTS sync_audit (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id        INTEGER NOT NULL,       -- original sync_queue.id
      table_name      TEXT NOT NULL,
      record_id       TEXT NOT NULL,
      operation       TEXT NOT NULL,
      outcome         TEXT NOT NULL,          -- 'rejected' or 'conflict'
      message         TEXT,                   -- cloud's error message
      audited_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_audit_outcome ON sync_audit(outcome);

    -- Sync Metrics (per-cycle metrics for observability and alerting)
    -- One row per sync push cycle. Used to track success rate, latency,
    -- and detect degradation trends. Pruned to last 7 days automatically.
    CREATE TABLE IF NOT EXISTS sync_metrics (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_at        INTEGER NOT NULL,          -- timestamp of cycle start
      pushed          INTEGER NOT NULL DEFAULT 0,
      accepted        INTEGER NOT NULL DEFAULT 0,
      rejected        INTEGER NOT NULL DEFAULT 0,
      dead_lettered   INTEGER NOT NULL DEFAULT 0,
      latency_ms      INTEGER NOT NULL DEFAULT 0,
      ok              INTEGER NOT NULL DEFAULT 0, -- 1=success, 0=failure
      error           TEXT,
      pending_after   INTEGER NOT NULL DEFAULT 0,
      dead_letter_after INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sync_metrics_cycle_at ON sync_metrics(cycle_at);

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

    -- Print Jobs (durable, idempotent print queue for KOT/bill printing)
    -- One row per physical print job. The edge server creates these inside
    -- the same transaction as the order/KOT write so they survive crashes.
    -- The cashier Tauri frontend (or cloud relay) acknowledges each job.
    -- Per-printer serialization is enforced by the dispatch loop reading
    -- ORDER BY id ASC within a single-printer batch.
    CREATE TABLE IF NOT EXISTS print_job (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id        TEXT NOT NULL UNIQUE,   -- idempotency key shared with captain
      restaurant_id   TEXT NOT NULL,
      order_id        TEXT NOT NULL,
      kot_id          TEXT,
      kot_number      INTEGER,
      table_id        TEXT,
      printer_name    TEXT,                   -- resolved printer (null = auto)
      job_type        TEXT NOT NULL,           -- 'KOT', 'BAR_KOT', 'CANCEL_KOT', 'BILL', etc.
      escpos_data     TEXT NOT NULL,           -- JSON array of {type,format,data}
      item_summary    TEXT,                    -- JSON: [{name,qty}] for audit UI
      captain_name    TEXT,
      status          TEXT NOT NULL DEFAULT 'queued',  -- queued|printing|printed|failed|retrying|dead_letter|cancelled
      attempts        INTEGER DEFAULT 0,
      max_attempts    INTEGER DEFAULT 3,
      last_error      TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      queued_at       INTEGER,
      printing_at     INTEGER,
      printed_at      INTEGER,
      failed_at       INTEGER,
      acked_via       TEXT,                    -- 'http' | 'cloud_relay' | 'local'
      next_attempt_at INTEGER,                 -- exponential backoff scheduling
      lease_until     INTEGER,                 -- claim lease expiry for stale recovery
      copy_number     INTEGER DEFAULT 0,       -- reprint copy counter
      payload_version INTEGER DEFAULT 1        -- ESC/POS payload schema version
    );
    CREATE INDEX IF NOT EXISTS idx_print_job_status ON print_job(status) WHERE status IN ('queued', 'retrying');
    CREATE INDEX IF NOT EXISTS idx_print_job_printer_status ON print_job(printer_name, status);
    CREATE INDEX IF NOT EXISTS idx_print_job_order ON print_job(order_id);

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

    -- Command Log (durable idempotency + audit for every edge business command)
    -- One row per applied/rejected command. Replay of the same (restaurant_id,
    -- request_id, command_type) returns the original response without reapplying
    -- side effects. Retention is bounded by operational cleanup, not deletion.
    CREATE TABLE IF NOT EXISTS command_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id     TEXT NOT NULL,
      request_id        TEXT NOT NULL,
      command_type      TEXT NOT NULL,          -- 'createOrder','updateOrderItems','cancelKotItem','settleOrder', etc.
      entity_type       TEXT NOT NULL,          -- 'table' | 'order' | 'transaction'
      entity_id         TEXT NOT NULL,
      device_id         TEXT,
      command_ts        INTEGER NOT NULL,       -- client-supplied command timestamp
      expected_revision INTEGER,                -- caller's view of current revision (optimistic)
      resulting_revision INTEGER,               -- revision after apply (null if rejected)
      status            TEXT NOT NULL,          -- 'applied' | 'rejected' | 'failed'
      response_json     TEXT,                   -- JSON of original response/result metadata
      error_message     TEXT,
      applied_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_command_log_dedup ON command_log(restaurant_id, request_id, command_type);
    CREATE INDEX IF NOT EXISTS idx_command_log_entity ON command_log(entity_type, entity_id, applied_at);
    CREATE INDEX IF NOT EXISTS idx_command_log_status ON command_log(status) WHERE status IN ('rejected','failed');

    -- Expenditures (cash payments for staff/maintenance/other)
    CREATE TABLE IF NOT EXISTS expenditure (
      id                TEXT PRIMARY KEY,
      restaurant_id     TEXT NOT NULL,
      amount            REAL NOT NULL,
      paid_to_type      TEXT,
      paid_to_name      TEXT,
      category          TEXT,
      narration         TEXT,
      approver          TEXT,
      created_by        TEXT,
      expenditure_no    INTEGER,
      date              TEXT NOT NULL,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      voided            INTEGER DEFAULT 0,
      cloud_synced      INTEGER DEFAULT 0,
      employee_id       TEXT,                 -- FK to employee.id (STAFF type)
      ledger_category_id TEXT,                -- FK to ledger_category.id (OTHER type)
      entry_type        TEXT DEFAULT 'EXPENSE' -- ASSET | LIABILITY | GROCERY | EXPENSE | LIABILITY_PAYMENT
    );
    CREATE INDEX IF NOT EXISTS idx_expenditure_date ON expenditure(date);
    CREATE INDEX IF NOT EXISTS idx_expenditure_synced ON expenditure(cloud_synced) WHERE cloud_synced = 0;
    -- idx_expenditure_employee and idx_expenditure_ledger are created in
    -- runMigrations (after ALTER TABLE adds the columns for v5 DBs). Creating
    -- them here crashes on v5 databases where employee_id/ledger_category_id
    -- don't exist yet, because initSchema runs BEFORE runMigrations.

    -- Employees (staff without login accounts — created from expenditure module)
    -- Mirrors the cloud Employee table. Locally-created employees (cloud_synced=0)
    -- are pushed to cloud via the sync worker; cloud-created employees are pulled
    -- via the config sync and have cloud_synced=1.
    CREATE TABLE IF NOT EXISTS employee (
      id              TEXT PRIMARY KEY,
      restaurant_id   TEXT NOT NULL,
      name            TEXT NOT NULL,
      role            TEXT,              -- null = no role assigned (admin assigns later)
      is_active       INTEGER DEFAULT 1,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      cloud_synced    INTEGER DEFAULT 0,
      synced_at       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_employee_outlet ON employee(restaurant_id);
    CREATE INDEX IF NOT EXISTS idx_employee_active ON employee(is_active) WHERE is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_employee_synced ON employee(cloud_synced) WHERE cloud_synced = 0;

    -- Ledger Categories (expense/asset/liability categories — user-creatable)
    -- Mirrors the cloud LedgerCategory table. Locally-created categories
    -- (cloud_synced=0) are pushed to cloud via the sync worker; cloud-created
    -- categories are pulled via the config sync and have cloud_synced=1.
    CREATE TABLE IF NOT EXISTS ledger_category (
      id              TEXT PRIMARY KEY,
      restaurant_id   TEXT NOT NULL,
      name            TEXT NOT NULL,
      entry_type      TEXT NOT NULL DEFAULT 'EXPENSE',
      is_active       INTEGER DEFAULT 1,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      cloud_synced    INTEGER DEFAULT 0,
      synced_at       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_category_outlet ON ledger_category(restaurant_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_category_active ON ledger_category(is_active) WHERE is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_ledger_category_synced ON ledger_category(cloud_synced) WHERE cloud_synced = 0;

    -- Transaction Record (durable local copy of every settlement + walk-in txn)
    -- Stores the full payment payload that the sync worker needs to create the
    -- cloud Transaction row. This is the durable source of truth for sync;
    -- edge_config (settle:<id> / walkin_txn:<id>) is kept only for backward
    -- compatibility and reprint lookups. If a row is missing here, the sync
    -- worker cannot reconstruct the transaction and the reconciliation worker
    -- will re-enqueue it from the parent order_record.
    CREATE TABLE IF NOT EXISTS transaction_record (
      id              TEXT PRIMARY KEY,           -- localTxnId (settle) or localId (walk-in)
      restaurant_id   TEXT NOT NULL,
      order_id        TEXT,                        -- null for walk-in transactions
      kind            TEXT NOT NULL,               -- 'settle' | 'walkin'
      payload         TEXT NOT NULL,               -- full JSON payment payload
      cloud_synced    INTEGER DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      synced_at       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_txn_record_restaurant ON transaction_record(restaurant_id);
    CREATE INDEX IF NOT EXISTS idx_txn_record_order ON transaction_record(order_id);
    CREATE INDEX IF NOT EXISTS idx_txn_record_synced ON transaction_record(cloud_synced) WHERE cloud_synced = 0;
  `);
}

// ── Lightweight column migrations for existing DBs ───────────────────────────
// CREATE TABLE IF NOT EXISTS won't add new columns to existing tables.
// This runs idempotent ALTER TABLE statements guarded by column-existence checks.
function runMigrations(database: Database) {
  const hasColumn = (table: string, col: string): boolean => {
    const cols = database.query(`PRAGMA table_info("${table}")`).all() as { name: string }[];
    return cols.some(c => c.name === col);
  };

  // section.is_active — added for onboarding INSERT compatibility
  if (!hasColumn("section", "is_active")) {
    database.exec(`ALTER TABLE section ADD COLUMN is_active INTEGER DEFAULT 1`);
  }

  // venue.kot_enabled — added for KOT printing gate. If missing, SELECT v.kot_enabled
  // would throw "no such column" and crash createOrder/updateOrderItems.
  if (!hasColumn("venue", "kot_enabled")) {
    database.exec(`ALTER TABLE venue ADD COLUMN kot_enabled INTEGER DEFAULT 1`);
  }

  // order_record.is_extra_table — added for extra table isolation
  if (!hasColumn("order_record", "is_extra_table")) {
    database.exec(`ALTER TABLE order_record ADD COLUMN is_extra_table INTEGER DEFAULT 0`);
  }

  // print_job: add durable queue columns for existing DBs
  if (!hasColumn("print_job", "next_attempt_at")) {
    database.exec(`ALTER TABLE print_job ADD COLUMN next_attempt_at INTEGER`);
  }
  if (!hasColumn("print_job", "lease_until")) {
    database.exec(`ALTER TABLE print_job ADD COLUMN lease_until INTEGER`);
  }
  if (!hasColumn("print_job", "copy_number")) {
    database.exec(`ALTER TABLE print_job ADD COLUMN copy_number INTEGER DEFAULT 0`);
  }
  if (!hasColumn("print_job", "payload_version")) {
    database.exec(`ALTER TABLE print_job ADD COLUMN payload_version INTEGER DEFAULT 1`);
  }

  // ── v4: Print queue state machine columns ────────────────────────────────
  if (!hasColumn("print_job", "max_attempts")) {
    database.exec(`ALTER TABLE print_job ADD COLUMN max_attempts INTEGER DEFAULT 3`);
  }
  if (!hasColumn("print_job", "queued_at")) {
    database.exec(`ALTER TABLE print_job ADD COLUMN queued_at INTEGER`);
  }
  if (!hasColumn("print_job", "printing_at")) {
    database.exec(`ALTER TABLE print_job ADD COLUMN printing_at INTEGER`);
  }
  if (!hasColumn("print_job", "failed_at")) {
    database.exec(`ALTER TABLE print_job ADD COLUMN failed_at INTEGER`);
  }
  // Migrate old status values to new state machine names
  database.exec(`UPDATE print_job SET status = 'queued' WHERE status = 'accepted'`);
  database.exec(`UPDATE print_job SET status = 'retrying' WHERE status = 'needs_retry'`);
  // Backfill queued_at from created_at for existing queued/retrying jobs
  database.exec(`UPDATE print_job SET queued_at = created_at WHERE queued_at IS NULL AND status IN ('queued', 'retrying')`);

  // ── v3: revision columns + last_command_id on table and order_record ──────
  // Monotonic aggregate revisions guard against stale-command overwrites. Existing
  // rows backfill to revision=1; subsequent mutations increment within their
  // transaction. last_command_id tracks the most recent command_log entry applied.
  if (!hasColumn("table", "revision")) {
    database.exec(`ALTER TABLE "table" ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`);
  }
  if (!hasColumn("table", "last_command_id")) {
    database.exec(`ALTER TABLE "table" ADD COLUMN last_command_id TEXT`);
  }
  if (!hasColumn("order_record", "revision")) {
    database.exec(`ALTER TABLE order_record ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`);
  }
  if (!hasColumn("order_record", "last_command_id")) {
    database.exec(`ALTER TABLE order_record ADD COLUMN last_command_id TEXT`);
  }
  // Indexes for revision lookups (idempotent; CREATE INDEX IF NOT EXISTS)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_table_revision ON "table"(revision)`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_order_revision ON order_record(revision)`);

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

  // ── v6: kot table — add counter_date + date-scoped uniqueness ──────────────
  // Recreate the kot table so the unique constraint becomes
  // UNIQUE(restaurant_id, kot_number, counter_date) instead of
  // UNIQUE(restaurant_id, kot_number). This allows KOT numbers to restart at 1
  // each IST day without colliding with previous days' KOTs.
  // counter_date is backfilled from created_at (epoch ms) using IST offset
  // (UTC+5:30 = +19800 seconds).
  if (!hasColumn("kot", "counter_date")) {
    database.exec(`
      CREATE TABLE kot_migrate_tmp (
        id              TEXT PRIMARY KEY,
        restaurant_id   TEXT NOT NULL,
        table_id        TEXT NOT NULL,
        order_id        TEXT NOT NULL,
        kot_number      INTEGER NOT NULL,
        counter_date    TEXT NOT NULL DEFAULT '',
        created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        cloud_synced    INTEGER DEFAULT 0,
        UNIQUE(restaurant_id, kot_number, counter_date)
      );
    `);
    database.exec(`
      INSERT INTO kot_migrate_tmp (id, restaurant_id, table_id, order_id, kot_number, counter_date, created_at, cloud_synced)
      SELECT id, restaurant_id, table_id, order_id, kot_number,
             date((created_at / 1000) + 19800, 'unixepoch') AS counter_date,
             created_at, cloud_synced
      FROM kot;
    `);
    database.exec(`DROP TABLE kot;`);
    database.exec(`ALTER TABLE kot_migrate_tmp RENAME TO kot;`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_kot_restaurant_table ON kot(restaurant_id, table_id)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_kot_restaurant_order ON kot(restaurant_id, order_id)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_kot_synced ON kot(cloud_synced) WHERE cloud_synced = 0`);
    console.warn("[DB] kot table recreated with counter_date column and date-scoped uniqueness");
  }

  // ── v7: expenditure FK columns — employee_id, ledger_category_id, entry_type ──
  // Added so edge-synced expenditures carry the same linkage as cloud-created
  // ones (payroll for STAFF, ledger category for OTHER). Backward compatible:
  // existing rows default to NULL employee_id/ledger_category_id and 'EXPENSE'.
  if (!hasColumn("expenditure", "employee_id")) {
    database.exec(`ALTER TABLE expenditure ADD COLUMN employee_id TEXT`);
  }
  if (!hasColumn("expenditure", "ledger_category_id")) {
    database.exec(`ALTER TABLE expenditure ADD COLUMN ledger_category_id TEXT`);
  }
  if (!hasColumn("expenditure", "entry_type")) {
    database.exec(`ALTER TABLE expenditure ADD COLUMN entry_type TEXT DEFAULT 'EXPENSE'`);
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_expenditure_employee ON expenditure(employee_id) WHERE employee_id IS NOT NULL`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_expenditure_ledger ON expenditure(ledger_category_id) WHERE ledger_category_id IS NOT NULL`);
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
  // Dedup without deleting the existing row. A sync push may already have
  // selected that row; preserving its queue ID keeps the acknowledgment and
  // retry state valid if a new local update arrives while the request is in
  // flight. The source row is always re-read when the batch is built.
  const now = Date.now();
  const updated = db.query(
    "UPDATE sync_queue SET operation = ?, created_at = ?, attempts = 0, last_error = NULL WHERE table_name = ? AND record_id = ? AND synced = 0 AND COALESCE(last_error, '') != 'IN_FLIGHT'",
  ).run(operation, now, tableName, recordId);
  if ((updated.changes || 0) === 0) {
    db.query("INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)")
      .run(tableName, recordId, operation, now);
  }
}

// ── Transaction Record: durable local copy of settlement/walk-in payloads ────
// The sync worker reads from here first (falling back to edge_config for rows
// written by older app versions). This decouples sync durability from the
// generic edge_config key/value store, which can be cleaned/migrated without
// losing the ability to reconstruct cloud Transaction rows.

export function upsertTransactionRecord(
  id: string,
  restaurantId: string,
  orderId: string | null,
  kind: "settle" | "walkin",
  payload: any,
): void {
  const db = getDb();
  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
  const now = Date.now();
  db.query(
    "INSERT INTO transaction_record (id, restaurant_id, order_id, kind, payload, cloud_synced, created_at) VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET payload = ?, restaurant_id = ?, order_id = ?, cloud_synced = 0",
  ).run(id, restaurantId, orderId, kind, payloadStr, now, payloadStr, restaurantId, orderId);
}

export function getTransactionRecord(id: string): any | null {
  const db = getDb();
  const row = db.query("SELECT payload FROM transaction_record WHERE id = ?").get(id) as { payload: string } | null;
  if (!row || !row.payload) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

export function markTransactionRecordSynced(id: string): void {
  const db = getDb();
  db.query("UPDATE transaction_record SET cloud_synced = 1, synced_at = ? WHERE id = ?").run(Date.now(), id);
}

// ── Command log: durable idempotency + audit for edge business commands ──────

export interface CommandLogEntry {
  id: number;
  restaurant_id: string;
  request_id: string;
  command_type: string;
  entity_type: string;
  entity_id: string;
  device_id: string | null;
  command_ts: number;
  expected_revision: number | null;
  resulting_revision: number | null;
  status: string;
  response_json: string | null;
  error_message: string | null;
  applied_at: number;
}

export function lookupCommand(
  restaurantId: string,
  requestId: string,
  commandType: string,
): CommandLogEntry | null {
  const db = getDb();
  const row = db.query(
    `SELECT * FROM command_log WHERE restaurant_id = ? AND request_id = ? AND command_type = ?`,
  ).get(restaurantId, requestId, commandType) as CommandLogEntry | null;
  return row ?? null;
}

export function recordCommand(entry: {
  restaurant_id: string;
  request_id: string;
  command_type: string;
  entity_type: string;
  entity_id: string;
  device_id?: string | null;
  command_ts: number;
  expected_revision?: number | null;
  resulting_revision?: number | null;
  status: "applied" | "rejected" | "failed";
  response_json?: string | null;
  error_message?: string | null;
}): void {
  const db = getDb();
  db.query(
    `INSERT INTO command_log
      (restaurant_id, request_id, command_type, entity_type, entity_id, device_id,
       command_ts, expected_revision, resulting_revision, status, response_json, error_message, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(restaurant_id, request_id, command_type) DO UPDATE SET
       entity_type = excluded.entity_type,
       entity_id = excluded.entity_id,
       device_id = excluded.device_id,
       command_ts = excluded.command_ts,
       expected_revision = excluded.expected_revision,
       resulting_revision = excluded.resulting_revision,
       status = excluded.status,
       response_json = excluded.response_json,
       error_message = excluded.error_message,
       applied_at = excluded.applied_at`,
  ).run(
    entry.restaurant_id,
    entry.request_id,
    entry.command_type,
    entry.entity_type,
    entry.entity_id,
    entry.device_id ?? null,
    entry.command_ts,
    entry.expected_revision ?? null,
    entry.resulting_revision ?? null,
    entry.status,
    entry.response_json ?? null,
    entry.error_message ?? null,
    Date.now(),
  );
}

// Returns the next monotonic revision for an entity, for use inside a transaction.
// Reads the current revision and returns current+1; the caller must UPDATE the
// row with the new value within the same transaction.
export function nextTableRevision(tableId: string): number {
  const db = getDb();
  const row = db.query('SELECT revision FROM "table" WHERE id = ?').get(tableId) as { revision?: number } | null;
  return (row?.revision ?? 0) + 1;
}

export function nextOrderRevision(orderId: string): number {
  const db = getDb();
  const row = db.query("SELECT revision FROM order_record WHERE id = ?").get(orderId) as { revision?: number } | null;
  return (row?.revision ?? 0) + 1;
}

// ── Sync audit: persist permanent rejections/conflicts before dequeuing ──────

export function insertSyncAudit(
  queueId: number,
  tableName: string,
  recordId: string,
  operation: string,
  outcome: string,
  message: string,
): void {
  const db = getDb();
  db.query(
    `INSERT INTO sync_audit (queue_id, table_name, record_id, operation, outcome, message, audited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(queueId, tableName, recordId, operation, outcome, message, Date.now());
}

export function getSyncAuditRecords(limit = 100): Array<{
  id: number; queue_id: number; table_name: string; record_id: string;
  operation: string; outcome: string; message: string | null; audited_at: number;
}> {
  const db = getDb();
  return db.query(
    `SELECT id, queue_id, table_name, record_id, operation, outcome, message, audited_at
     FROM sync_audit ORDER BY audited_at DESC LIMIT ?`,
  ).all(limit) as any[];
}

// ─── Sync Metrics (Gap 8: observability + alerting) ──────────────────────────

export function recordSyncMetric(metric: {
  cycleAt: number;
  pushed: number;
  accepted: number;
  rejected: number;
  deadLettered: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
  pendingAfter: number;
  deadLetterAfter: number;
}): void {
  const db = getDb();
  db.query(
    `INSERT INTO sync_metrics
      (cycle_at, pushed, accepted, rejected, dead_lettered, latency_ms, ok, error, pending_after, dead_letter_after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    metric.cycleAt,
    metric.pushed,
    metric.accepted,
    metric.rejected,
    metric.deadLettered,
    metric.latencyMs,
    metric.ok ? 1 : 0,
    metric.error || null,
    metric.pendingAfter,
    metric.deadLetterAfter,
  );

  // Prune metrics older than 7 days to keep the table small
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  db.query("DELETE FROM sync_metrics WHERE cycle_at < ?").run(cutoff);
}

export function getSyncMetrics(limit = 100): Array<{
  id: number; cycle_at: number; pushed: number; accepted: number; rejected: number;
  dead_lettered: number; latency_ms: number; ok: number; error: string | null;
  pending_after: number; dead_letter_after: number;
}> {
  const db = getDb();
  return db.query(
    `SELECT id, cycle_at, pushed, accepted, rejected, dead_lettered, latency_ms, ok, error, pending_after, dead_letter_after
     FROM sync_metrics ORDER BY cycle_at DESC LIMIT ?`,
  ).all(limit) as any[];
}

export function getSyncAlerts(): Array<{
  type: string;
  severity: string;
  message: string;
  since: number;
  count: number;
}> {
  const db = getDb();
  const alerts: Array<{ type: string; severity: string; message: string; since: number; count: number }> = [];
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  // Alert 1: Dead-lettered records accumulating for > 1 hour
  const deadLetterStuck = db.query(
    `SELECT COUNT(*) as c, MIN(created_at) as oldest
     FROM sync_queue
     WHERE synced = 0 AND attempts >= 5 AND created_at < ?`,
  ).get(oneHourAgo) as any;
  if (deadLetterStuck?.c > 0) {
    alerts.push({
      type: "dead_letter_stuck",
      severity: "critical",
      message: `${deadLetterStuck.c} dead-lettered sync record(s) stuck for over 1 hour — manual intervention needed`,
      since: deadLetterStuck.oldest,
      count: deadLetterStuck.c,
    });
  }

  // Alert 2: High failure rate in last 10 cycles (> 50%)
  const recentMetrics = db.query(
    `SELECT ok FROM sync_metrics ORDER BY cycle_at DESC LIMIT 10`,
  ).all() as any[];
  if (recentMetrics.length >= 5) {
    const failures = recentMetrics.filter((m) => m.ok === 0).length;
    const failureRate = failures / recentMetrics.length;
    if (failureRate > 0.5) {
      alerts.push({
        type: "high_failure_rate",
        severity: "warning",
        message: `${failures}/${recentMetrics.length} recent sync cycles failed (${Math.round(failureRate * 100)}% failure rate)`,
        since: now,
        count: failures,
      });
    }
  }

  // Alert 3: Pending queue growing (pending > 50 for > 30 min)
  const pendingGrowth = db.query(
    `SELECT pending_after, cycle_at FROM sync_metrics
     WHERE cycle_at > ? ORDER BY cycle_at DESC LIMIT 10`,
  ).get(now - 30 * 60 * 1000) as any;
  const recentPending = db.query(
    `SELECT pending_after FROM sync_metrics ORDER BY cycle_at DESC LIMIT 1`,
  ).get() as any;
  if (recentPending?.pending_after > 50) {
    alerts.push({
      type: "pending_queue_growing",
      severity: "warning",
      message: `${recentPending.pending_after} records pending sync — queue may be stuck`,
      since: now,
      count: recentPending.pending_after,
    });
  }

  return alerts;
}

export function getOrderSyncStatus(orderId: string): { synced: boolean; pending: number; deadLettered: number } {
  const db = getDb();

  // ── Order-related sync rows (order, order_item, kot, kot_item) ──────────────
  // NOTE: only the 'order' row actually matches record_id = orderId; order_item,
  // kot, and kot_item rows store their own IDs in record_id, so they won't match
  // here. This is a known limitation — the order row is the one that matters for
  // confirming the order itself reached the cloud.
  const orderRows = db.query(
    `SELECT synced, attempts FROM sync_queue WHERE table_name IN ('order', 'order_item', 'kot', 'kot_item') AND record_id = ?`,
  ).all(orderId) as any[];

  // ── Transaction sync rows linked to this order ──────────────────────────────
  // Transactions are enqueued under their localTxnId (not the orderId), so we
  // look them up via the transaction_record table which has an order_id column.
  // Without this check, the frontend considers the settlement synced as soon as
  // the order row is confirmed — even if the payment/transaction is still
  // pending, failing, or dead-lettered in the sync queue. That causes the
  // frontend to drop its tracking record prematurely, and if the transaction
  // subsequently fails permanently, the payment never reaches the cloud admin
  // panel.
  const txnRows = db.query(
    `SELECT sq.synced, sq.attempts
     FROM sync_queue sq
     JOIN transaction_record tr ON sq.record_id = tr.id
     WHERE sq.table_name IN ('transaction', 'walkin_transaction')
       AND tr.order_id = ?`,
  ).all(orderId) as any[];

  const allRows = [...orderRows, ...txnRows];

  if (allRows.length === 0) {
    // No sync_queue rows — check if the order exists at all.
    // If it doesn't exist, the order was never created (wrong ID or not yet processed).
    // If it exists with no pending sync entries, it was either already synced and
    // cleaned up, or sync hasn't been queued yet. Check cloud_synced to distinguish.
    const order = db.query("SELECT cloud_synced FROM order_record WHERE id = ?").get(orderId) as any;
    if (!order) {
      return { synced: false, pending: 0, deadLettered: 0 };
    }
    // Order exists — if cloud_synced is 1, the order was confirmed synced.
    // But also verify any transaction_record for this order is synced, otherwise
    // the settlement payment hasn't reached the cloud yet.
    if (order.cloud_synced === 1) {
      const txnSynced = db.query(
        `SELECT 1 FROM transaction_record WHERE order_id = ? AND cloud_synced = 0 LIMIT 1`,
      ).get(orderId) as any;
      if (txnSynced) {
        // Order is synced but a transaction is still pending — don't report synced.
        return { synced: false, pending: 1, deadLettered: 0 };
      }
      return { synced: true, pending: 0, deadLettered: 0 };
    }
    return { synced: false, pending: 1, deadLettered: 0 };
  }

  let pending = 0;
  let deadLettered = 0;
  for (const row of allRows) {
    if (row.synced === 1) continue;
    if (row.attempts >= 5) deadLettered++;
    else pending++;
  }
  return { synced: pending === 0 && deadLettered === 0, pending, deadLettered };
}

// ── Get next KOT number (local counter, atomic) ──────────────────────────────

export function getNextKotNumber(restaurantId: string): number {
  const db = getDb();
  const today = getKolkataDateString();

  // Upsert daily counter — a new row is created each IST day, so the counter
  // naturally resets to 0 and the first KOT of the day becomes #1.
  // The kot table uses UNIQUE(restaurant_id, kot_number, counter_date) so
  // today's #1 cannot collide with a previous day's #1.
  db.query("INSERT INTO daily_counter (id, restaurant_id, counter_date, kot_count) VALUES (?, ?, ?, 0) ON CONFLICT(restaurant_id, counter_date) DO NOTHING")
    .run(crypto.randomUUID(), restaurantId, today);

  // Atomically increment kot_count and return the new value
  const row = db.query("UPDATE daily_counter SET kot_count = kot_count + 1 WHERE restaurant_id = ? AND counter_date = ? RETURNING kot_count")
    .get(restaurantId, today) as { kot_count: number };

  return row.kot_count;
}

// ── Print job helpers (durable, idempotent print queue) ──────────────────────

export function createPrintJob(job: {
  eventId: string;
  restaurantId: string;
  orderId: string;
  kotId?: string | null;
  kotNumber?: number | null;
  tableId?: string | null;
  printerName: string | null;
  jobType: string;
  escposData: any[];
  itemSummary?: any[];
  captainName?: string | null;
}): number | null {
  const db = getDb();
  const now = Date.now();
  try {
    db.query(`INSERT INTO print_job
      (event_id, restaurant_id, order_id, kot_id, kot_number, table_id, printer_name, job_type, escpos_data, item_summary, captain_name, status, created_at, updated_at, queued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING`)
      .run(
        job.eventId, job.restaurantId, job.orderId, job.kotId || null, job.kotNumber || null,
        job.tableId || null, job.printerName, job.jobType,
        JSON.stringify(job.escposData), JSON.stringify(job.itemSummary || []),
        job.captainName || null, now, now, now,
      );
    const row = db.query("SELECT id FROM print_job WHERE event_id = ?").get(job.eventId) as { id: number } | undefined;
    return row?.id ?? null;
  } catch (err) {
    console.warn("[DB] createPrintJob failed:", err);
    return null;
  }
}

export function updatePrintJobStatus(
  eventId: string,
  status: "printing" | "printed" | "failed" | "retrying" | "dead_letter" | "cancelled",
  error?: string | null,
  ackedVia?: string | null,
): void {
  const db = getDb();
  const now = Date.now();
  const printedAt = status === "printed" ? now : null;
  const failedAt = status === "failed" || status === "dead_letter" ? now : null;
  // Compute next_attempt_at for retryable statuses using exponential backoff
  let nextAttemptAt: number | null = null;
  if (status === "retrying") {
    // Get current attempt count to compute backoff
    const row = db.query("SELECT attempts FROM print_job WHERE event_id = ?").get(eventId) as { attempts: number } | undefined;
    const attempts = row?.attempts ?? 0;
    const backoffMs = Math.min(1000 * Math.pow(2, attempts), 60_000); // cap at 60s
    nextAttemptAt = now + backoffMs;
  }
  db.query(`UPDATE print_job SET status = ?, last_error = ?, acked_via = COALESCE(?, acked_via), printed_at = COALESCE(?, printed_at), failed_at = COALESCE(?, failed_at), updated_at = ?, attempts = attempts + 1, next_attempt_at = COALESCE(?, next_attempt_at), lease_until = NULL WHERE event_id = ?`)
    .run(status, error || null, ackedVia || null, printedAt, failedAt, now, nextAttemptAt, eventId);
}

const PRINT_JOB_LEASE_MS = 30_000;
const PRINT_JOB_MAX_ATTEMPTS = 10;

export function claimPrintJob(eventId: string): boolean {
  const db = getDb();
  const now = Date.now();
  const leaseUntil = now + PRINT_JOB_LEASE_MS;
  const result = db.query(
    `UPDATE print_job SET status = 'printing', printing_at = ?, updated_at = ?, lease_until = ? WHERE event_id = ? AND status IN ('queued', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
  ).run(now, now, leaseUntil, eventId, now);
  return result.changes > 0;
}

export function reclaimStalePrintingJobs(): number {
  const db = getDb();
  const now = Date.now();
  // Reclaim jobs whose lease has expired — either by lease_until or by the old
  // updated_at heuristic (for jobs created before the lease_until column existed)
  const cutoff = now - PRINT_JOB_LEASE_MS;
  const result = db.query(
    `UPDATE print_job SET status = 'queued', updated_at = ?, lease_until = NULL
     WHERE status = 'printing'
     AND (lease_until IS NOT NULL AND lease_until < ? OR lease_until IS NULL AND updated_at < ?)`,
  ).run(now, now, cutoff);

  // Transition jobs that exceeded max attempts to dead_letter
  const deadLetterResult = db.query(
    `UPDATE print_job SET status = 'dead_letter', failed_at = ?, updated_at = ?
     WHERE status = 'retrying' AND attempts >= ?`,
  ).run(now, PRINT_JOB_MAX_ATTEMPTS);
  if (deadLetterResult.changes > 0) {
    console.warn(`[PrintQueue] ${deadLetterResult.changes} job(s) moved to dead_letter after ${PRINT_JOB_MAX_ATTEMPTS} attempts`);
  }

  return result.changes;
}

export function getPendingPrintJobs(limit = 50): any[] {
  const db = getDb();
  const now = Date.now();
  // Only pick jobs that are ready for dispatch (next_attempt_at is null or in the past)
  return db.query(
    `SELECT * FROM print_job
     WHERE status IN ('queued', 'retrying')
     AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY
     CASE job_type
       WHEN 'BILL' THEN 0
       WHEN 'FINAL_BILL' THEN 0
       WHEN 'KOT' THEN 1
       WHEN 'BAR_KOT' THEN 1
       WHEN 'CANCEL_KOT' THEN 2
       ELSE 3
     END,
     id ASC LIMIT ?`
  ).all(now, limit) as any[];
}

export function getPrintJobByEventId(eventId: string): any | null {
  const db = getDb();
  const row = db.query("SELECT * FROM print_job WHERE event_id = ?").get(eventId) as any | undefined;
  return row ?? null;
}

export function getPrintJobsByOrder(orderId: string): any[] {
  const db = getDb();
  return db.query("SELECT * FROM print_job WHERE order_id = ? ORDER BY id ASC").all(orderId) as any[];
}

// ── Cancel a print job (prevent further dispatch attempts) ───────────────────
export function cancelPrintJob(eventId: string): boolean {
  const db = getDb();
  const now = Date.now();
  const result = db.query(
    `UPDATE print_job SET status = 'cancelled', updated_at = ?, lease_until = NULL WHERE event_id = ? AND status IN ('queued', 'retrying', 'dead_letter')`,
  ).run(now, eventId);
  return result.changes > 0;
}

// ── Reprint: create a new print job with a new event_id, copying ESC/POS data ─
export function reprintPrintJob(originalEventId: string, newEventId?: string): { eventId: string; id: number | null } | null {
  const db = getDb();
  const original = db.query("SELECT * FROM print_job WHERE event_id = ?").get(originalEventId) as any | undefined;
  if (!original) return null;

  // Count existing reprints for this original event to generate a copy number
  const copyRow = db.query(
    "SELECT COUNT(*) as c FROM print_job WHERE event_id LIKE ? OR event_id = ?"
  ).get(`${originalEventId}-reprint-%`, originalEventId) as { c: number };
  const copyNumber = (copyRow?.c ?? 0) + 1;

  const eventId = newEventId || `${originalEventId}-reprint-${copyNumber}`;
  const now = Date.now();

  try {
    db.query(`INSERT INTO print_job
      (event_id, restaurant_id, order_id, kot_id, kot_number, table_id, printer_name, job_type, escpos_data, item_summary, captain_name, status, copy_number, payload_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`)
      .run(
        eventId, original.restaurant_id, original.order_id, original.kot_id, original.kot_number,
        original.table_id, original.printer_name, original.job_type,
        original.escpos_data, original.item_summary, original.captain_name,
        copyNumber, original.payload_version || 1, now, now,
      );
    const row = db.query("SELECT id FROM print_job WHERE event_id = ?").get(eventId) as { id: number } | undefined;
    return { eventId, id: row?.id ?? null };
  } catch (err) {
    console.warn("[DB] reprintPrintJob failed:", err);
    return null;
  }
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
