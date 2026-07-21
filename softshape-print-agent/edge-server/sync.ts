// ─────────────────────────────────────────────────────────────────────────────
// sync.ts — Edge → Cloud sync worker
// ─────────────────────────────────────────────────────────────────────────────
// Background worker that pushes locally created/modified records to the cloud.
// Reads from the `sync_queue` table and batches them to `POST /api/edge/sync`.
//
// Design:
//   - Runs every 10 seconds (configurable via EDGE_SYNC_INTERVAL_MS)
//   - Batches up to 50 records per push
//   - Exponential backoff on failure (max 5 attempts, then dead-letter)
//   - Pushes: orders, order_items, kots, kot_items, table status updates
//   - Cloud responds with { accepted: [...], rejected: [...] }
//   - Accepted records are marked synced=1
//   - Rejected records get error logged, attempts incremented
//
// The cloud receiver endpoint (Part 7) will:
//   - Upsert orders/kots into PostgreSQL
//   - Update table status
//   - Emit socket events for real-time dashboard updates
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, insertSyncAudit } from "./db.ts";
import { getBackendUrl, getSessionToken, getRestaurantId, isSessionValid, getDeviceId, saveSession, loadSession } from "./auth.ts";
import { cloudFetch } from "./cloudFetch.ts";

const SYNC_INTERVAL_MS = parseInt(process.env.EDGE_SYNC_INTERVAL_MS || "10000", 10);
const MAX_BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 10_000;   // 10 seconds
const BACKOFF_MAX_MS = 5 * 60_000; // 5 minutes cap
const SYNC_SCHEMA_VERSION = 1;

let syncRunning = false;
let lastSyncAt = 0;
let consecutiveFailures = 0;
let lastSyncResult: { ok: boolean; pushed: number; accepted: number; rejected: number; error?: string } | null = null;

function getBackoffDelay(): number {
  if (consecutiveFailures === 0) return SYNC_INTERVAL_MS;
  const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, consecutiveFailures - 1), BACKOFF_MAX_MS);
  return delay;
}

// ─── Collect a batch of pending sync records ─────────────────────────────────

interface SyncQueueRow {
  id: number;
  table_name: string;
  record_id: string;
  operation: string;
  created_at: number;
  attempts: number;
  last_error: string | null;
}

interface SyncPayloadItem {
  queueId: number;
  tableName: string;
  recordId: string;
  operation: string;
  data: any;
}

function collectBatch(): SyncQueueRow[] {
  const db = getDb();
  // Get pending records, prioritizing by entity dependency order first,
  // then oldest first within each priority group.
  return db.query(`
    SELECT * FROM sync_queue
    WHERE synced = 0
    ORDER BY
      CASE table_name
        WHEN 'order' THEN 0
        WHEN 'order_item' THEN 1
        WHEN 'kot' THEN 1
        WHEN 'kot_item' THEN 2
        WHEN 'table' THEN 3
        WHEN 'transaction' THEN 4
        WHEN 'walkin_transaction' THEN 4
        ELSE 10
      END,
      created_at ASC, id ASC
    LIMIT ?
  `).all(MAX_BATCH_SIZE) as SyncQueueRow[];
}

// ─── Load the full record data for a sync queue entry ────────────────────────

function loadRecordData(tableName: string, recordId: string): any | null {
  const db = getDb();

  switch (tableName) {
    case "order": {
      const order = db.query("SELECT * FROM order_record WHERE id = ?").get(recordId) as any;
      if (!order) return null;
      const items = db.query("SELECT * FROM order_item WHERE order_id = ?").all(recordId) as any[];
      return {
        ...order,
        cloud_synced: undefined, // don't send this back
        items: items.map((i) => ({
          ...i,
          cloud_synced: undefined,
        })),
      };
    }

    case "order_item": {
      const item = db.query("SELECT * FROM order_item WHERE id = ?").get(recordId) as any;
      if (!item) return null;
      return { ...item, cloud_synced: undefined };
    }

    case "kot": {
      const kot = db.query("SELECT * FROM kot WHERE id = ?").get(recordId) as any;
      if (!kot) return null;
      const items = db.query("SELECT * FROM kot_item WHERE kot_id = ?").all(recordId) as any[];
      return {
        ...kot,
        cloud_synced: undefined,
        items: items.map((i) => ({ ...i, cloud_synced: undefined })),
      };
    }

    case "kot_item": {
      const item = db.query("SELECT * FROM kot_item WHERE id = ?").get(recordId) as any;
      if (!item) return null;
      return { ...item, cloud_synced: undefined };
    }

    case "table": {
      const table = db.query("SELECT * FROM \"table\" WHERE id = ?").get(recordId) as any;
      if (!table) return null;
      return {
        id: table.id,
        number: table.number,
        capacity: table.capacity,
        sectionId: table.section_id,
        status: table.status,
        workflowStatus: table.workflow_status,
        captainId: table.captain_id,
        guests: table.guests,
        sessionStartedAt: table.session_started_at,
        currentBill: Number(table.current_bill),
        kotHistory: typeof table.kot_history === "string" ? JSON.parse(table.kot_history) : [],
        discount: table.discount ? Number(table.discount) : null,
        sectionTag: table.section_tag,
        updatedAt: table.updated_at,
      };
    }

    case "outlet": {
      const o = db.query("SELECT * FROM outlet WHERE id = ?").get(recordId) as any;
      if (!o) return null;
      return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        restaurantCode: o.restaurant_code,
        restaurantType: o.restaurant_type,
        address: o.address,
        phone: o.phone,
        email: o.email,
        gstin: o.gstin,
        logoUrl: o.logo_url,
        receiptHeader: o.receipt_header,
        receiptSubHeader: o.receipt_sub_header,
        themePrimary: o.theme_primary,
        themeSecondary: o.theme_secondary,
        printerConfig: o.printer_config,
        barUnitMl: o.bar_unit_ml,
        fullBottleMl: o.full_bottle_ml,
        halfBottleMl: o.half_bottle_ml,
        fssai: o.fssai,
        pricesIncludeGst: !!o.prices_include_gst,
        gstCategory: o.gst_category,
        gstRate: o.gst_rate,
        gstRegistered: !!o.gst_registered,
        serviceChargePercent: o.service_charge_percent || 0,
        enabledModules: o.enabled_modules,
      };
    }

    case "venue": {
      const v = db.query("SELECT * FROM venue WHERE id = ?").get(recordId) as any;
      if (!v) return null;
      return {
        id: v.id,
        restaurantId: v.restaurant_id,
        name: v.name,
        venueType: v.venue_type,
        isActive: !!v.is_active,
        sortOrder: v.sort_order,
      };
    }

    case "floor": {
      const f = db.query("SELECT * FROM floor WHERE id = ?").get(recordId) as any;
      if (!f) return null;
      return {
        id: f.id,
        venueId: f.venue_id,
        restaurantId: f.restaurant_id,
        name: f.name,
        sortOrder: f.sort_order,
      };
    }

    case "section": {
      const s = db.query("SELECT * FROM section WHERE id = ?").get(recordId) as any;
      if (!s) return null;
      return {
        id: s.id,
        name: s.name,
        restaurantId: s.restaurant_id,
        floorId: s.floor_id,
        sortOrder: s.sort_order,
        isActive: !!s.is_active,
      };
    }

    case "category": {
      const c = db.query("SELECT * FROM category WHERE id = ?").get(recordId) as any;
      if (!c) return null;
      return {
        id: c.id,
        name: c.name,
        restaurantId: c.restaurant_id,
        sortOrder: c.sort_order,
        isActive: !!c.is_active,
        printerTarget: c.printer_target,
      };
    }

    case "menu_item": {
      const m = db.query("SELECT * FROM menu_item WHERE id = ?").get(recordId) as any;
      if (!m) return null;
      const variants = db.query("SELECT * FROM menu_item_variant WHERE menu_item_id = ?").all(recordId) as any[];
      return {
        id: m.id,
        name: m.name,
        description: m.description,
        imageUrl: m.image_url,
        isVeg: !!m.is_veg,
        isAvailable: !!m.is_available,
        sortOrder: m.sort_order,
        categoryId: m.category_id,
        restaurantId: m.restaurant_id,
        basePrice: m.base_price,
        unit: m.unit,
        isDeleted: !!m.is_deleted,
        deletedAt: m.deleted_at,
        printerTarget: m.printer_target,
        printerName: m.printer_name,
        menuType: m.menu_type,
        gstEnabled: !!m.gst_enabled,
        isSpecial: !!m.is_special,
        specialChannel: m.special_channel,
        specialActive: !!m.special_active,
        specialExpiresAt: m.special_expires_at,
        variants: variants.map(v => ({
          id: v.id,
          name: v.name,
          price: v.price,
          isDefault: !!v.is_default,
          menuItemId: v.menu_item_id,
          isAvailable: !!v.is_available,
          restaurantId: v.restaurant_id,
        })),
      };
    }

    case "menu_item_variant": {
      const v = db.query("SELECT * FROM menu_item_variant WHERE id = ?").get(recordId) as any;
      if (!v) return null;
      return {
        id: v.id,
        name: v.name,
        price: v.price,
        isDefault: !!v.is_default,
        menuItemId: v.menu_item_id,
        isAvailable: !!v.is_available,
        restaurantId: v.restaurant_id,
      };
    }

    case "users": {
      const u = db.query("SELECT * FROM users WHERE id = ?").get(recordId) as any;
      if (!u) return null;
      return {
        id: u.id,
        name: u.name,
        pin: u.pin,
        role: u.role,
        outletId: u.outlet_id,
        isActive: !!u.is_active,
        permissions: u.permissions,
      };
    }

    case "transaction": {
      // Payment confirmations are stored in edge_config with key `payment:${transactionId}`
      // Settle records use `settle:${localTxnId}` — check both prefixes
      const row = db.query("SELECT value FROM edge_config WHERE key IN (?, ?)").get(`payment:${recordId}`, `settle:${recordId}`) as any;
      if (!row || !row.value) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    }

    case "walkin_transaction": {
      // Walk-in transactions are stored in edge_config with key `walkin_txn:${localId}`
      const row = db.query("SELECT value FROM edge_config WHERE key = ?").get(`walkin_txn:${recordId}`) as any;
      if (!row || !row.value) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    }

    default:
      return null;
  }
}

// ─── Mark records as synced or update attempts ───────────────────────────────

function markSynced(queueIds: number[]): void {
  if (queueIds.length === 0) return;
  const db = getDb();
  const placeholders = queueIds.map(() => "?").join(",");

  // Before deleting, set cloud_synced = 1 on the source records so
  // getOrderSyncStatus can confirm sync even after queue rows are cleaned up.
  const rows = db.query(`SELECT table_name, record_id FROM sync_queue WHERE id IN (${placeholders})`).all(...queueIds) as any[];
  for (const row of rows) {
    if (row.table_name === "order") {
      db.query("UPDATE order_record SET cloud_synced = 1 WHERE id = ?").run(row.record_id);
    } else if (row.table_name === "order_item") {
      db.query("UPDATE order_item SET cloud_synced = 1 WHERE id = ?").run(row.record_id);
    } else if (row.table_name === "kot") {
      db.query("UPDATE kot SET cloud_synced = 1 WHERE id = ?").run(row.record_id);
    } else if (row.table_name === "kot_item") {
      db.query("UPDATE kot_item SET cloud_synced = 1 WHERE id = ?").run(row.record_id);
    }
  }

  // Delete instead of marking synced=1 — keeps the table small so
  // collectBatch() stays fast and INSERTs don't slow down over a shift.
  db.query(`DELETE FROM sync_queue WHERE id IN (${placeholders})`).run(...queueIds);
}

function incrementAttempts(queueIds: number[], error: string): void {
  if (queueIds.length === 0) return;
  const db = getDb();
  const placeholders = queueIds.map(() => "?").join(",");
  db.query(`UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE id IN (${placeholders})`)
    .run(error, ...queueIds);
}

// ─── Dead-letter exhausted records (attempts >= MAX_ATTEMPTS) ────────────────

function deadLetterExhausted(): void {
  const db = getDb();
  db.query(`UPDATE sync_queue SET last_error = COALESCE(last_error, 'Max attempts reached') WHERE synced = 0 AND attempts >= ? AND last_error NOT LIKE 'DEAD_LETTER%'`)
    .run(MAX_ATTEMPTS);
  // Mark them with DEAD_LETTER prefix so they don't get retried
  db.query(`UPDATE sync_queue SET last_error = 'DEAD_LETTER: ' || COALESCE(last_error, 'exhausted') WHERE synced = 0 AND attempts >= ? AND last_error NOT LIKE 'DEAD_LETTER%'`)
    .run(MAX_ATTEMPTS);
}

// ─── Main sync push ──────────────────────────────────────────────────────────

let _cloudRegistrationAttempted = false;

async function ensureCloudSession(): Promise<boolean> {
  const session = loadSession();
  if (!session) return false;

  // If the token is a real JWT (not a local onboarding token), we're fine
  if (!session.sessionToken.startsWith("local-onboard-")) return true;

  // Already tried and failed — don't retry every cycle, just on startup
  if (_cloudRegistrationAttempted) return false;
  _cloudRegistrationAttempted = true;

  const backendUrl = getBackendUrl();
  const restaurantId = getRestaurantId();
  if (!backendUrl || !restaurantId) return false;

  // Load outlet + owner data from local SQLite to send to the cloud
  const db = getDb();
  const outlet = db.query("SELECT * FROM outlet WHERE id = ?").get(restaurantId) as any;
  if (!outlet) {
    console.warn("[Sync] No outlet found in local DB for cloud registration");
    return false;
  }

  const owner = db.query("SELECT name, pin FROM users WHERE outlet_id = ? AND role = 'OWNER' LIMIT 1").get(restaurantId) as any;

  console.log("[Sync] Local onboarding token detected — attempting cloud registration...");
  try {
    const res = await fetch(`${backendUrl}/api/edge/register-offline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        restaurantId,
        deviceId: getDeviceId(),
        restaurantName: outlet.name,
        restaurantType: outlet.restaurant_type,
        restaurantCode: outlet.restaurant_code,
        slug: outlet.slug,
        owner: owner ? { name: owner.name, pin: owner.pin } : undefined,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.warn(`[Sync] Cloud registration failed: HTTP ${res.status} — ${errBody.error || ''}`);
      _cloudRegistrationAttempted = false; // allow retry next cycle
      return false;
    }

    const data = await res.json() as { sessionToken: string; restaurantName: string; restaurantCode: string };
    console.log(`[Sync] Cloud registration successful — got real JWT for ${data.restaurantName}`);

    // Update the stored session with the real JWT
    saveSession({
      ...session,
      sessionToken: data.sessionToken,
      restaurantName: data.restaurantName,
      restaurantCode: data.restaurantCode,
    });

    return true;
  } catch (err) {
    console.warn("[Sync] Cloud registration error:", err);
    _cloudRegistrationAttempted = false; // allow retry next cycle
    return false;
  }
}

export async function pushSyncBatch(): Promise<{ ok: boolean; pushed: number; accepted: number; rejected: number; error?: string }> {
  const backendUrl = getBackendUrl();
  const restaurantId = getRestaurantId();

  if (!backendUrl || !restaurantId) {
    return { ok: false, pushed: 0, accepted: 0, rejected: 0, error: "No valid session" };
  }

  // If we have a local onboarding token, try to exchange it for a real JWT first
  if (!(await ensureCloudSession())) {
    return { ok: false, pushed: 0, accepted: 0, rejected: 0, error: "No valid cloud session" };
  }

  const token = getSessionToken();

  const batch = collectBatch();
  if (batch.length === 0) {
    lastSyncAt = Date.now();
    lastSyncResult = { ok: true, pushed: 0, accepted: 0, rejected: 0 };
    return lastSyncResult;
  }

  // Build payload with full record data
  const payload: SyncPayloadItem[] = [];
  for (const row of batch) {
    const data = loadRecordData(row.table_name, row.record_id);
    if (data) {
      payload.push({
        queueId: row.id,
        tableName: row.table_name,
        recordId: row.record_id,
        operation: row.operation,
        data,
      });
    } else {
      // Record was deleted locally — mark as synced (nothing to push)
      markSynced([row.id]);
    }
  }

  if (payload.length === 0) {
    lastSyncAt = Date.now();
    lastSyncResult = { ok: true, pushed: 0, accepted: 0, rejected: 0 };
    return lastSyncResult;
  }

  try {
    const res = await cloudFetch(`${backendUrl}/api/edge/sync`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        restaurantId,
        deviceId: getDeviceId(),
        schemaVersion: SYNC_SCHEMA_VERSION,
        pushedAt: new Date().toISOString(),
        batch: payload,
      }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const errorMsg = errBody.error || `HTTP ${res.status}`;
      // All records in batch failed — increment attempts
      incrementAttempts(batch.map((b) => b.id), errorMsg);
      lastSyncAt = Date.now();
      lastSyncResult = { ok: false, pushed: payload.length, accepted: 0, rejected: payload.length, error: errorMsg };
      console.error(`[Sync] Push failed: ${errorMsg}`);
      return lastSyncResult;
    }

    const result = await res.json() as {
      accepted: number[];
      rejected: Array<{ queueId: number; error: string; outcome?: string }>;
    };

    // Mark accepted records as synced (dequeued)
    markSynced(result.accepted);

    // Build lookup from queueId → payload item for audit logging
    const payloadMap = new Map(payload.map((p) => [p.queueId, p]));

    // Handle rejected records based on their outcome:
    // - "error": transient failure — increment attempts for retry
    // - "rejected"/"conflict": permanent — write audit row, then dequeue
    //   (the cloud has seen this record and decided not to apply it)
    // - missing outcome: treat as error for backward compatibility
    const retryIds: number[] = [];
    const dequeueIds: number[] = [];
    if (result.rejected && result.rejected.length > 0) {
      for (const rej of result.rejected) {
        if (rej.outcome === "rejected" || rej.outcome === "conflict") {
          dequeueIds.push(rej.queueId);
          // Persist audit record before dequeuing
          const item = payloadMap.get(rej.queueId);
          if (item) {
            insertSyncAudit(rej.queueId, item.tableName, item.recordId, item.operation, rej.outcome, rej.error);
          }
          console.warn(`[Sync] ${rej.outcome}: queueId=${rej.queueId} — ${rej.error}`);
        } else {
          retryIds.push(rej.queueId);
          incrementAttempts([rej.queueId], rej.error);
        }
      }
      if (dequeueIds.length > 0) {
        markSynced(dequeueIds);
      }
    }

    // Also mark any queue IDs that were in our payload but not in accepted/rejected
    // (cloud might have silently dropped them)
    const respondedIds = new Set([
      ...result.accepted,
      ...(result.rejected || []).map((r) => r.queueId),
    ]);
    const orphanIds = payload.filter((p) => !respondedIds.has(p.queueId)).map((p) => p.queueId);
    if (orphanIds.length > 0) {
      incrementAttempts(orphanIds, "No response from cloud");
    }

    lastSyncAt = Date.now();
    lastSyncResult = {
      ok: true,
      pushed: payload.length,
      accepted: result.accepted.length + dequeueIds.length,
      rejected: retryIds.length + orphanIds.length,
    };

    if (result.accepted.length > 0 || dequeueIds.length > 0) {
      console.log(`[Sync] Pushed ${payload.length} records — ${result.accepted.length} accepted, ${dequeueIds.length} dequeued (rejected/conflict), ${retryIds.length + orphanIds.length} retrying`);
    }

    return lastSyncResult;
  } catch (err: any) {
    const errorMsg = err.message || "Network error during sync push";
    incrementAttempts(batch.map((b) => b.id), errorMsg);
    lastSyncAt = Date.now();
    lastSyncResult = { ok: false, pushed: payload.length, accepted: 0, rejected: payload.length, error: errorMsg };
    console.error(`[Sync] Push error: ${errorMsg}`);
    return lastSyncResult;
  }
}

// ─── Sync worker loop (with exponential backoff) ─────────────────────────────

let syncTimer: ReturnType<typeof setTimeout> | null = null;

async function runSyncCycle(): Promise<void> {
  if (!isSessionValid()) {
    scheduleNextCycle(SYNC_INTERVAL_MS);
    return;
  }
  if (syncRunning) {
    scheduleNextCycle(SYNC_INTERVAL_MS);
    return;
  }

  syncRunning = true;
  try {
    const result = await pushSyncBatch();
    deadLetterExhausted();

    // Checkpoint WAL to keep the -wal file small and reads fast.
    // Without this, the WAL grows throughout a shift and every query
    // has to scan both the main DB and the WAL, causing progressive slowdown.
    try {
      getDb().query("PRAGMA wal_checkpoint(TRUNCATE)").run();
    } catch {
      // Non-fatal — checkpoint can fail if another connection is busy
    }

    if (result.ok) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      console.warn(`[Sync] Push failed (${consecutiveFailures} consecutive) — backing off for ${getBackoffDelay()}ms`);
    }
  } catch (err) {
    consecutiveFailures++;
    console.error("[Sync] Worker cycle error:", err);
  } finally {
    syncRunning = false;
  }

  scheduleNextCycle(getBackoffDelay());
}

function scheduleNextCycle(delay: number): void {
  syncTimer = setTimeout(async () => {
    await runSyncCycle();
  }, delay);
}

export function startSyncWorker(): void {
  if (syncTimer) return;

  const initialDelay = consecutiveFailures > 0 ? getBackoffDelay() : 5_000;
  console.log(`[Sync] Worker started — initial delay: ${initialDelay}ms, base interval: ${SYNC_INTERVAL_MS}ms`);
  scheduleNextCycle(initialDelay);
}

export function stopSyncWorker(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
    console.log("[Sync] Worker stopped");
  }
}

// ─── Sync status (for /api/edge/status endpoint) ─────────────────────────────

export function getSyncStatus(): {
  workerRunning: boolean;
  lastSyncAt: number | null;
  lastSyncResult: typeof lastSyncResult;
  pendingCount: number;
  deadLetterCount: number;
  consecutiveFailures: number;
  nextSyncInMs: number;
} {
  const db = getDb();
  const pendingCount = (db.query("SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0").get() as any)?.c || 0;
  const deadLetterCount = (db.query("SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0 AND attempts >= ?").get(MAX_ATTEMPTS) as any)?.c || 0;

  return {
    workerRunning: syncTimer !== null,
    lastSyncAt: lastSyncAt || null,
    lastSyncResult,
    pendingCount,
    deadLetterCount,
    consecutiveFailures,
    nextSyncInMs: getBackoffDelay(),
  };
}

// ─── Manual sync trigger (for /api/edge/sync/push endpoint) ──────────────────

export async function manualSyncPush(): Promise<{ ok: boolean; pushed: number; accepted: number; rejected: number; error?: string }> {
  return pushSyncBatch();
}

// ─── Retry dead-lettered records (for /api/edge/sync/retry endpoint) ─────────

export function retryDeadLetters(): { reset: number } {
  const db = getDb();
  const result = db.query("UPDATE sync_queue SET attempts = 0, last_error = NULL WHERE synced = 0 AND attempts >= ?").run(MAX_ATTEMPTS);
  return { reset: result.changes || 0 };
}

// ─── List dead-lettered records with full details (for recovery UI) ──────────

export function getDeadLetterRecords(): Array<{
  id: number;
  tableName: string;
  recordId: string;
  operation: string;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  payload: unknown;
}> {
  const db = getDb();
  const rows = db.query(
    `SELECT id, table_name, record_id, operation, attempts, last_error, created_at
     FROM sync_queue
     WHERE synced = 0 AND attempts >= ?
     ORDER BY created_at ASC`
  ).all(MAX_ATTEMPTS) as any[];

  return rows.map((row) => {
    const payload = loadRecordData(row.table_name, row.record_id);
    return {
      id: row.id,
      tableName: row.table_name,
      recordId: row.record_id,
      operation: row.operation,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      payload,
    };
  });
}

// ─── Discard a single dead-letter record (with audit trail) ──────────────────

export function discardDeadLetter(queueId: number): { success: boolean } {
  const db = getDb();
  const result = db.query("UPDATE sync_queue SET synced = 1, last_error = 'DISCARDED_BY_USER' WHERE id = ? AND synced = 0 AND attempts >= ?").run(queueId, MAX_ATTEMPTS);
  return { success: (result.changes || 0) > 0 };
}

// ─── Retry a single dead-letter record ───────────────────────────────────────

export function retrySingleDeadLetter(queueId: number): { success: boolean } {
  const db = getDb();
  const result = db.query("UPDATE sync_queue SET attempts = 0, last_error = NULL WHERE id = ? AND synced = 0 AND attempts >= ?").run(queueId, MAX_ATTEMPTS);
  return { success: (result.changes || 0) > 0 };
}
