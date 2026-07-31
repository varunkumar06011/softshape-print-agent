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

import { getDb, insertSyncAudit, recordSyncMetric, getSyncAlerts, getTransactionRecord, markTransactionRecordSynced } from "./db.ts";
import { getBackendUrl, getSessionToken, getRestaurantId, isSessionValid, getDeviceId, saveSession, loadSession } from "./auth.ts";
import { cloudFetch } from "./cloudFetch.ts";
import { pullIncrementalChanges } from "./config.ts";
import { startSocketSync } from "./socketSync.ts";

const SYNC_INTERVAL_MS = parseInt(process.env.EDGE_SYNC_INTERVAL_MS || "10000", 10);
const CONFIG_PULL_INTERVAL_MS = parseInt(process.env.EDGE_CONFIG_PULL_INTERVAL_MS || "60000", 10);
const MAX_BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 10_000;   // 10 seconds
const BACKOFF_MAX_MS = 5 * 60_000; // 5 minutes cap
const SYNC_SCHEMA_VERSION = 2;

let syncRunning = false;
let lastSyncAt = 0;
let lastConfigPullAt = 0;
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
  // Simple FIFO — oldest first. Records that have failed (attempts >= MAX_ATTEMPTS)
  // are pushed to the end of the queue so they don't block other records,
  // but they stay in the queue and keep retrying.
  //
  // DEAD_LETTER rows (last_error LIKE 'DEAD_LETTER:%') are excluded from the
  // normal sync cycle. They are surfaced in the recovery UI and only retried
  // via the explicit retryDeadLetters() endpoint or the reconciliation worker
  // (which resets their attempts). Without this exclusion the worker keeps
  // re-selecting permanently broken records every cycle, wasting bandwidth
  // and making the pending count climb without progress.
  return db.query(`
    SELECT * FROM sync_queue
    WHERE synced = 0
      AND (last_error IS NULL OR last_error NOT LIKE 'DEAD_LETTER:%')
    ORDER BY
      CASE WHEN attempts >= ? THEN 1 ELSE 0 END,
      created_at ASC, id ASC
    LIMIT ?
  `).all(MAX_ATTEMPTS, MAX_BATCH_SIZE) as SyncQueueRow[];
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
        revision: order.revision ?? 1,
        lastCommandId: order.last_command_id ?? null,
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
        revision: table.revision ?? 1,
        lastCommandId: table.last_command_id ?? null,
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
      // Durable source: transaction_record table (preferred).
      // Fallback: edge_config keys `payment:${transactionId}` / `settle:${localTxnId}`
      // (kept for rows written by older app versions before transaction_record).
      const durable = getTransactionRecord(recordId);
      if (durable) return durable;
      const row = db.query("SELECT value FROM edge_config WHERE key IN (?, ?)").get(`payment:${recordId}`, `settle:${recordId}`) as any;
      if (!row || !row.value) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    }

    case "walkin_transaction": {
      // Durable source: transaction_record table (preferred).
      // Fallback: edge_config key `walkin_txn:${localId}`.
      const durable = getTransactionRecord(recordId);
      if (durable) return durable;
      const row = db.query("SELECT value FROM edge_config WHERE key = ?").get(`walkin_txn:${recordId}`) as any;
      if (!row || !row.value) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    }

    case "expenditure": {
      const row = db.query("SELECT * FROM expenditure WHERE id = ?").get(recordId) as any;
      if (!row) return null;
      return {
        id: row.id,
        restaurantId: row.restaurant_id,
        amount: row.amount,
        paidToType: row.paid_to_type,
        paidToName: row.paid_to_name,
        category: row.category,
        narration: row.narration,
        approver: row.approver,
        createdBy: row.created_by,
        expenditureNo: row.expenditure_no,
        date: row.date,
        voided: !!row.voided,
      };
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
    } else if (row.table_name === "transaction" || row.table_name === "walkin_transaction") {
      // Mark the durable transaction_record as synced so the reconciliation
      // worker knows it reached the cloud and doesn't re-enqueue it.
      markTransactionRecordSynced(row.record_id);
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
let _lastRefreshAttemptAt = 0;
const REFRESH_COOLDOWN_MS = 60_000; // don't retry refresh more than once per minute

// ─── Refresh an expired (or near-expiry) agent JWT ────────────────────────────
// Calls POST /api/edge/refresh-session with the current (possibly expired)
// token in the Authorization header. The cloud verifies the signature
// (ignoring expiry) and issues a fresh 30-day token.
// Returns true if the session was refreshed.
async function refreshCloudSession(): Promise<boolean> {
  const session = loadSession();
  if (!session || !session.sessionToken) return false;

  // Local onboarding tokens can't be refreshed — they need register-offline
  if (session.sessionToken.startsWith("local-onboard-")) return false;

  const now = Date.now();
  if (now - _lastRefreshAttemptAt < REFRESH_COOLDOWN_MS) return false;
  _lastRefreshAttemptAt = now;

  const backendUrl = getBackendUrl();
  if (!backendUrl) return false;

  console.log("[Sync] Attempting cloud session refresh...");
  try {
    const res = await cloudFetch(`${backendUrl}/api/edge/refresh-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.sessionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ deviceId: getDeviceId() }),
      connectTimeout: 15_000,
      bodyTimeout: 30_000,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.warn(`[Sync] Session refresh failed: HTTP ${res.status} — ${errBody.error || ""}`);
      return false;
    }

    const data = await res.json() as {
      sessionToken: string;
      restaurantName?: string;
      restaurantCode?: string;
      expiresAt?: number;
    };

    saveSession({
      ...session,
      sessionToken: data.sessionToken,
      restaurantName: data.restaurantName || session.restaurantName,
      restaurantCode: data.restaurantCode || session.restaurantCode,
      expiresAt: data.expiresAt || (Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    console.log("[Sync] Session refreshed successfully — new JWT saved");

    // Start socket sync if it wasn't running (e.g. edge booted with expired session)
    try {
      startSocketSync();
    } catch (err: any) {
      console.warn("[Sync] Socket sync start failed after refresh:", err.message || err);
    }

    // Reset dead-lettered records — they failed due to expired token, not data issues.
    // With a fresh JWT they should succeed on the next sync cycle.
    try {
      const db = getDb();
      const resetResult = db.query("UPDATE sync_queue SET attempts = 0, last_error = NULL WHERE synced = 0 AND attempts >= ?").run(MAX_ATTEMPTS);
      if (resetResult.changes && resetResult.changes > 0) {
        console.log(`[Sync] Reset ${resetResult.changes} dead-lettered records after session refresh`);
      }
    } catch (err: any) {
      console.warn("[Sync] Dead-letter reset failed after refresh:", err.message || err);
    }

    return true;
  } catch (err: any) {
    console.warn("[Sync] Session refresh error:", err.message || err);
    return false;
  }
}

// Check if a JWT will expire within the given threshold (default 24h).
// Returns true for tokens that are already expired OR will expire soon.
function isJwtExpiringSoon(expiresAt: number, thresholdMs: number = 24 * 60 * 60 * 1000): boolean {
  if (!expiresAt) return false; // no expiry set — assume valid
  return Date.now() + thresholdMs > expiresAt;
}

async function ensureCloudSession(): Promise<boolean> {
  const session = loadSession();
  if (!session) return false;

  // If the token is a real JWT (not a local onboarding token), check expiry.
  // If it's expired or expiring within 24h, proactively refresh it.
  if (!session.sessionToken.startsWith("local-onboard-")) {
    if (isJwtExpiringSoon(session.expiresAt)) {
      const refreshed = await refreshCloudSession();
      if (!refreshed) {
        // Refresh failed — if the session is actually expired, we can't push.
        // If it's just near-expiry (still valid), proceed with the current token.
        if (!isSessionValid()) return false;
      }
    }
    return true;
  }

  // Already tried and failed — don't retry every cycle, just on startup
  if (_cloudRegistrationAttempted) return false;
  _cloudRegistrationAttempted = true;

  // DEPRECATED: Offline onboarding (register-offline) has been retired.
  // Restaurants must register via the 13-step web wizard, then link the
  // desktop app via /edge-setup (which uses the authenticated /api/edge/register).
  // If a local-onboard token is detected, the user needs to re-link via /edge-setup.
  console.warn("[Sync] Local onboarding token detected — offline registration is deprecated. Please re-link this device via the web onboarding wizard and /edge-setup.");
  return false;

  // ── DEPRECATED register-offline call (preserved for reference) ──────────
  // const backendUrl = getBackendUrl();
  // const restaurantId = getRestaurantId();
  // if (!backendUrl || !restaurantId) return false;
  //
  // // Load outlet + owner data from local SQLite to send to the cloud
  // const db = getDb();
  // const outlet = db.query("SELECT * FROM outlet WHERE id = ?").get(restaurantId) as any;
  // if (!outlet) {
  //   console.warn("[Sync] No outlet found in local DB for cloud registration");
  //   return false;
  // }
  //
  // const owner = db.query("SELECT name, pin FROM users WHERE outlet_id = ? AND role = 'OWNER' LIMIT 1").get(restaurantId) as any;
  //
  // console.log("[Sync] Local onboarding token detected — attempting cloud registration...");
  // try {
  //   const res = await fetch(`${backendUrl}/api/edge/register-offline`, {
  //     method: "POST",
  //     headers: { "Content-Type": "application/json" },
  //     body: JSON.stringify({
  //       restaurantId,
  //       deviceId: getDeviceId(),
  //       restaurantName: outlet.name,
  //       restaurantType: outlet.restaurant_type,
  //       restaurantCode: outlet.restaurant_code,
  //       slug: outlet.slug,
  //       owner: owner ? { name: owner.name, pin: owner.pin } : undefined,
  //     }),
  //     signal: AbortSignal.timeout(10000),
  //   });
  //
  //   if (!res.ok) {
  //     const errBody = await res.json().catch(() => ({}));
  //     console.warn(`[Sync] Cloud registration failed: HTTP ${res.status} — ${errBody.error || ''}`);
  //     _cloudRegistrationAttempted = false; // allow retry next cycle
  //     return false;
  //   }
  //
  //   const data = await res.json() as { sessionToken: string; restaurantName: string; restaurantCode: string };
  //   console.log(`[Sync] Cloud registration successful — got real JWT for ${data.restaurantName}`);
  //
  //   // Update the stored session with the real JWT
  //   saveSession({
  //     ...session,
  //     sessionToken: data.sessionToken,
  //     restaurantName: data.restaurantName,
  //     restaurantCode: data.restaurantCode,
  //   });
  //
  //   return true;
  // } catch (err) {
  //   console.warn("[Sync] Cloud registration error:", err);
  //   _cloudRegistrationAttempted = false; // allow retry next cycle
  //   return false;
  // }
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
    } else if (row.table_name === "transaction" || row.table_name === "walkin_transaction") {
      // Payment data missing from edge_config — do NOT silently drop.
      // Increment attempts so it goes to the end of the queue and surfaces
      // in the dead-letter recovery UI for manual investigation.
      console.warn(`[Sync] ${row.table_name} ${row.record_id} has no data in edge_config — keeping in queue (queueId=${row.id})`);
      incrementAttempts([row.id], "Payment data missing from edge_config");
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

  // Build lookup from queueId → payload item for audit logging
  // (defined here so it's in scope for both the 401 retry path and the normal path)
  const payloadMap = new Map(payload.map((p) => [p.queueId, p]));

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
      connectTimeout: 60_000,
      bodyTimeout: 120_000,
    });

    if (!res.ok) {
      // ── 401: Token expired — attempt refresh and retry once ──────────────
      if (res.status === 401) {
        console.warn("[Sync] Push got 401 — attempting session refresh...");
        const refreshed = await refreshCloudSession();
        if (refreshed) {
          // Retry the push with the new token
          const newToken = getSessionToken();
          const retryRes = await cloudFetch(`${backendUrl}/api/edge/sync`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${newToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              restaurantId,
              deviceId: getDeviceId(),
              schemaVersion: SYNC_SCHEMA_VERSION,
              pushedAt: new Date().toISOString(),
              batch: payload,
            }),
            connectTimeout: 60_000,
            bodyTimeout: 120_000,
          });

          if (retryRes.ok) {
            const retryResult = await retryRes.json() as {
              accepted: number[];
              rejected: Array<{ queueId: number; error: string; outcome?: string }>;
            };
            markSynced(retryResult.accepted);
            const retryDequeueIds: number[] = [];
            if (retryResult.rejected && retryResult.rejected.length > 0) {
              for (const rej of retryResult.rejected) {
                if (rej.outcome === "rejected" || rej.outcome === "conflict" || rej.outcome === "duplicate") {
                  retryDequeueIds.push(rej.queueId);
                  const item = payloadMap.get(rej.queueId);
                  if (item) insertSyncAudit(rej.queueId, item.tableName, item.recordId, item.operation, rej.outcome, rej.error);
                } else {
                  incrementAttempts([rej.queueId], rej.error);
                }
              }
              if (retryDequeueIds.length > 0) markSynced(retryDequeueIds);
            }
            lastSyncAt = Date.now();
            lastSyncResult = {
              ok: true,
              pushed: payload.length,
              accepted: retryResult.accepted.length + retryDequeueIds.length,
              rejected: (retryResult.rejected || []).length - retryDequeueIds.length,
            };
            console.log(`[Sync] Push succeeded after token refresh — ${retryResult.accepted.length} accepted`);
            return lastSyncResult;
          }
          // Retry also failed — fall through to error handling
          const retryErrBody = await retryRes.json().catch(() => ({}));
          const retryErrorMsg = retryErrBody.error || `HTTP ${retryRes.status}`;
          incrementAttempts(batch.map((b) => b.id), retryErrorMsg);
          lastSyncAt = Date.now();
          lastSyncResult = { ok: false, pushed: payload.length, accepted: 0, rejected: payload.length, error: retryErrorMsg };
          console.error(`[Sync] Push failed after refresh: ${retryErrorMsg}`);
          return lastSyncResult;
        }
        // Refresh failed — don't increment attempts on the records (not their fault)
        lastSyncAt = Date.now();
        lastSyncResult = { ok: false, pushed: 0, accepted: 0, rejected: 0, error: "Session expired and refresh failed" };
        console.error("[Sync] Session expired — refresh failed. Manual re-registration required.");
        return lastSyncResult;
      }

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

    // Handle rejected records based on their outcome:
    // - "error": transient failure — increment attempts for retry
    // - "rejected"/"conflict"/"duplicate": permanent — write audit row, then dequeue
    //   (the cloud has seen this record and decided not to apply it)
    // - missing outcome: treat as error for backward compatibility
    const retryIds: number[] = [];
    const dequeueIds: number[] = [];
    if (result.rejected && result.rejected.length > 0) {
      for (const rej of result.rejected) {
        if (rej.outcome === "rejected" || rej.outcome === "conflict" || rej.outcome === "duplicate") {
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
let _sessionInvalidLoggedAt = 0;

async function runSyncCycle(): Promise<void> {
  if (!isSessionValid()) {
    // Session is invalid or expired — attempt a refresh before giving up.
    // This handles the case where the JWT expired between sync cycles.
    const refreshed = await refreshCloudSession();
    if (!refreshed) {
      const now = Date.now();
      if (now - _sessionInvalidLoggedAt > 60_000) {
        _sessionInvalidLoggedAt = now;
        console.warn("[Sync] Session invalid or expired — refresh failed. Re-register via POST /api/edge/register");
      }
      scheduleNextCycle(SYNC_INTERVAL_MS);
      return;
    }
    // Refresh succeeded — fall through to normal sync cycle
    console.log("[Sync] Session refreshed — continuing with sync cycle");
  }
  if (syncRunning) {
    scheduleNextCycle(SYNC_INTERVAL_MS);
    return;
  }

  syncRunning = true;
  let skipBackoff = false;
  const cycleStart = Date.now();
  try {
    const result = await pushSyncBatch();

    // Label exhausted records (attempts >= MAX_ATTEMPTS) with DEAD_LETTER prefix
    // so the recovery UI can surface them. This must run every cycle to catch
    // records that just crossed the attempt threshold.
    deadLetterExhausted();

    // Checkpoint WAL to keep the -wal file small and reads fast.
    // Without this, the WAL grows throughout a shift and every query
    // has to scan both the main DB and the WAL, causing progressive slowdown.
    try {
      getDb().query("PRAGMA wal_checkpoint(TRUNCATE)").run();
    } catch {
      // Non-fatal — checkpoint can fail if another connection is busy
    }

    // Record sync metrics for observability and alerting (Gap 8)
    const _db = getDb();
    const _pendingAfter = (_db.query("SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0").get() as any)?.c || 0;
    const _deadLetterAfter = (_db.query("SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0 AND attempts >= ?").get(MAX_ATTEMPTS) as any)?.c || 0;
    recordSyncMetric({
      cycleAt: cycleStart,
      pushed: result.pushed,
      accepted: result.accepted,
      rejected: result.rejected,
      deadLettered: _deadLetterAfter,
      latencyMs: Date.now() - cycleStart,
      ok: result.ok,
      error: result.error,
      pendingAfter: _pendingAfter,
      deadLetterAfter: _deadLetterAfter,
    });

    if (result.ok) {
      consecutiveFailures = 0;
    } else if (result.pushed > 0) {
      // Record-level failure — back off to avoid hammering the cloud.
      consecutiveFailures++;
      console.warn(`[Sync] Push failed (${consecutiveFailures} consecutive) — backing off for ${getBackoffDelay()}ms`);
    } else {
      // Session/network issue with no records pushed — don't back off.
      // Retry at the normal interval so we recover instantly when the
      // underlying issue (expired token, network outage, cloud restart) resolves.
      skipBackoff = true;
      console.warn(`[Sync] Push skipped (${result.error}) — retrying at normal interval`);
    }

    // Periodically pull config changes from cloud (printer config, menu updates, etc.)
    // This is a safety net in case socket events are missed.
    const now = Date.now();
    if (now - lastConfigPullAt >= CONFIG_PULL_INTERVAL_MS) {
      lastConfigPullAt = now;
      try {
        const pullResult = await pullIncrementalChanges();
        if (pullResult.success && pullResult.changesApplied && pullResult.changesApplied > 0) {
          console.log(`[Sync] Config pull applied ${pullResult.changesApplied} changes from cloud`);
        }
      } catch (pullErr) {
        console.warn("[Sync] Config pull failed:", (pullErr as Error)?.message || pullErr);
      }
    }

    // Periodically reconcile transactions: re-enqueue any settled order or
    // walk-in transaction whose sync record is missing, dead-lettered, or
    // permanently rejected. This is the guarantee that every transaction
    // reaches the cloud admin panel — "sync at all cost".
    if (now - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
      lastReconcileAt = now;
      try {
        const recon = reconcileTransactions();
        if (recon.enqueued > 0 || recon.reset > 0 || recon.backfilled > 0) {
          console.log(`[Sync] Reconciliation: ${recon.enqueued} re-enqueued, ${recon.reset} dead-letter resets, ${recon.backfilled} backfilled from legacy edge_config`);
        }
      } catch (reconErr) {
        console.warn("[Sync] Reconciliation failed:", (reconErr as Error)?.message || reconErr);
      }
    }
  } catch (err) {
    consecutiveFailures++;
    console.error("[Sync] Worker cycle error:", err);
  } finally {
    syncRunning = false;
  }

  // Check for critical alerts and log them (Gap 8)
  try {
    const alerts = getSyncAlerts();
    for (const alert of alerts) {
      if (alert.severity === "critical") {
        console.error(`[Sync Alert] ${alert.type}: ${alert.message}`);
      } else {
        console.warn(`[Sync Alert] ${alert.type}: ${alert.message}`);
      }
    }
  } catch {
    // Non-fatal — alerting should never break the sync loop
  }

  scheduleNextCycle(skipBackoff ? SYNC_INTERVAL_MS : getBackoffDelay());
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

  // Run reconciliation immediately on startup so transactions settled while
  // the edge was offline (or before this version) are re-enqueued before the
  // first normal sync cycle. Non-blocking — errors don't stop the worker.
  try {
    const recon = reconcileTransactions();
    if (recon.enqueued > 0 || recon.reset > 0 || recon.backfilled > 0) {
      console.log(`[Sync] Startup reconciliation: ${recon.enqueued} re-enqueued, ${recon.reset} dead-letter resets, ${recon.backfilled} backfilled`);
    }
  } catch (err) {
    console.warn("[Sync] Startup reconciliation failed:", (err as Error)?.message || err);
  }

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

// ─── Reconciliation worker — guarantees transactions reach the cloud ──────────
//
// Scans every locally settled order and every walk-in transaction_record, and
// re-enqueues a `transaction` / `walkin_transaction` sync row whenever:
//   - the record is missing from sync_queue entirely, or
//   - the only queue row is dead-lettered (attempts >= MAX_ATTEMPTS), or
//   - the only queue row was permanently rejected/conflicted/duplicated by the
//     cloud (we still re-enqueue because a rejected transaction means the
//     admin panel will never see it — better to retry than to silently lose
//     revenue data).
//
// For orders settled before transaction_record existed (older app versions),
// we backfill the transaction_record row from the legacy edge_config
// `settle:<localTxnId>` key so the sync worker can reconstruct the payload.
//
// Runs on startup and every RECONCILE_INTERVAL_MS inside the sync cycle.
// This is the safety net that makes "sync at all cost" true: even if the
// original enqueue was lost, the queue row was dequeued as a duplicate, or
// the worker dead-lettered the record, the reconciliation pass will put it
// back in the queue.

const RECONCILE_INTERVAL_MS = 5 * 60_000; // every 5 minutes
let lastReconcileAt = 0;

export function reconcileTransactions(): { enqueued: number; reset: number; backfilled: number } {
  const db = getDb();
  let enqueued = 0;
  let reset = 0;
  let backfilled = 0;

  // ── 1. Settled orders → transaction sync ──────────────────────────────────
  // A settled order must have a transaction_record + a queue row that is either
  // pending or synced-applied. If the queue row is missing, dead-lettered, or
  // permanently rejected, we re-enqueue.
  const settledOrders = db.query(
    `SELECT id, restaurant_id
     FROM order_record
     WHERE status = 'SETTLED'
       AND NOT EXISTS (SELECT 1 FROM edge_config WHERE key = 'txn_deleted:' || order_record.id)`,
  ).all() as Array<{ id: string; restaurant_id: string }>;

  for (const order of settledOrders) {
    // Find the transaction_record for this order. If missing (older app
    // version), try to backfill from edge_config settle:* key.
    let txnRow = db.query("SELECT id, payload FROM transaction_record WHERE order_id = ? AND kind = 'settle' ORDER BY created_at DESC LIMIT 1").get(order.id) as { id: string; payload: string } | null;

    if (!txnRow) {
      // Backfill from legacy edge_config settle:* key.
      const settleRow = db.query(
        "SELECT value FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = ? LIMIT 1",
      ).get(order.id) as { value: string } | null;
      if (!settleRow || !settleRow.value) continue;
      let settleData: any;
      try { settleData = JSON.parse(settleRow.value); } catch { continue; }
      const localTxnId = settleData.localTxnId;
      if (!localTxnId) continue;
      // Persist into transaction_record so future sync cycles can read it.
      try {
        db.query(
          "INSERT INTO transaction_record (id, restaurant_id, order_id, kind, payload, cloud_synced, created_at) VALUES (?, ?, ?, 'settle', ?, 0, ?) ON CONFLICT(id) DO NOTHING",
        ).run(localTxnId, order.restaurant_id, order.id, settleRow.value, Date.now());
        backfilled++;
        txnRow = { id: localTxnId, payload: settleRow.value };
      } catch {
        continue;
      }
    }

    const localTxnId = txnRow.id;
    const pendingRow = db.query(
      "SELECT id, synced, attempts, last_error FROM sync_queue WHERE table_name = 'transaction' AND record_id = ? ORDER BY id DESC LIMIT 1",
    ).get(localTxnId) as { id: number; synced: number; attempts: number; last_error: string | null } | null;

    if (!pendingRow) {
      // Missing from queue — re-enqueue.
      db.query("INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES ('transaction', ?, 'insert', ?)")
        .run(localTxnId, Date.now());
      enqueued++;
      continue;
    }

    if (pendingRow.synced === 1) {
      // Dequeued. Check if it was permanently rejected — if so, re-enqueue
      // because the admin panel will never see the revenue otherwise.
      const auditRow = db.query(
        "SELECT outcome FROM sync_audit WHERE queue_id = ? AND table_name = 'transaction' ORDER BY audited_at DESC LIMIT 1",
      ).get(pendingRow.id) as { outcome: string } | null;
      if (auditRow && ["rejected", "conflict", "duplicate"].includes(auditRow.outcome)) {
        db.query("INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES ('transaction', ?, 'insert', ?)")
          .run(localTxnId, Date.now());
        enqueued++;
      }
      continue;
    }

    // synced = 0 — still in queue. If dead-lettered, reset attempts so the
    // normal worker (which now excludes DEAD_LETTER rows) picks it up again.
    if (pendingRow.attempts >= MAX_ATTEMPTS) {
      db.query("UPDATE sync_queue SET attempts = 0, last_error = NULL WHERE id = ?").run(pendingRow.id);
      reset++;
    }
  }

  // ── 2. Walk-in transactions → walkin_transaction sync ─────────────────────
  const walkinRows = db.query(
    "SELECT id, restaurant_id FROM transaction_record WHERE kind = 'walkin'",
  ).all() as Array<{ id: string; restaurant_id: string }>;

  for (const row of walkinRows) {
    const localId = row.id;
    const pendingRow = db.query(
      "SELECT id, synced, attempts FROM sync_queue WHERE table_name = 'walkin_transaction' AND record_id = ? ORDER BY id DESC LIMIT 1",
    ).get(localId) as { id: number; synced: number; attempts: number } | null;

    if (!pendingRow) {
      db.query("INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES ('walkin_transaction', ?, 'insert', ?)")
        .run(localId, Date.now());
      enqueued++;
      continue;
    }

    if (pendingRow.synced === 1) {
      const auditRow = db.query(
        "SELECT outcome FROM sync_audit WHERE queue_id = ? AND table_name = 'walkin_transaction' ORDER BY audited_at DESC LIMIT 1",
      ).get(pendingRow.id) as { outcome: string } | null;
      if (auditRow && ["rejected", "conflict", "duplicate"].includes(auditRow.outcome)) {
        db.query("INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES ('walkin_transaction', ?, 'insert', ?)")
          .run(localId, Date.now());
        enqueued++;
      }
      continue;
    }

    if (pendingRow.attempts >= MAX_ATTEMPTS) {
      db.query("UPDATE sync_queue SET attempts = 0, last_error = NULL WHERE id = ?").run(pendingRow.id);
      reset++;
    }
  }

  // ── 3. Legacy walk-in rows only in edge_config (no transaction_record) ────
  const legacyWalkin = db.query("SELECT key, value FROM edge_config WHERE key LIKE 'walkin_txn:%'").all() as Array<{ key: string; value: string }>;
  for (const row of legacyWalkin) {
    const localId = row.key.replace("walkin_txn:", "");
    const exists = db.query("SELECT 1 FROM transaction_record WHERE id = ?").get(localId);
    if (exists) continue;
    let data: any;
    try { data = JSON.parse(row.value); } catch { continue; }
    try {
      db.query(
        "INSERT INTO transaction_record (id, restaurant_id, order_id, kind, payload, cloud_synced, created_at) VALUES (?, ?, ?, 'walkin', ?, 0, ?) ON CONFLICT(id) DO NOTHING",
      ).run(localId, data.restaurantId, data.orderId || null, row.value, Date.now());
      backfilled++;
      // Re-enqueue if missing.
      const pendingRow = db.query(
        "SELECT id, synced, attempts FROM sync_queue WHERE table_name = 'walkin_transaction' AND record_id = ? ORDER BY id DESC LIMIT 1",
      ).get(localId) as { id: number; synced: number; attempts: number } | null;
      if (!pendingRow) {
        db.query("INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES ('walkin_transaction', ?, 'insert', ?)")
          .run(localId, Date.now());
        enqueued++;
      } else if (pendingRow.synced === 1) {
        const auditRow = db.query(
          "SELECT outcome FROM sync_audit WHERE queue_id = ? AND table_name = 'walkin_transaction' ORDER BY audited_at DESC LIMIT 1",
        ).get(pendingRow.id) as { outcome: string } | null;
        if (auditRow && ["rejected", "conflict", "duplicate"].includes(auditRow.outcome)) {
          db.query("INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES ('walkin_transaction', ?, 'insert', ?)")
            .run(localId, Date.now());
          enqueued++;
        }
      } else if (pendingRow.attempts >= MAX_ATTEMPTS) {
        db.query("UPDATE sync_queue SET attempts = 0, last_error = NULL WHERE id = ?").run(pendingRow.id);
        reset++;
      }
    } catch { /* ignore */ }
  }

  return { enqueued, reset, backfilled };
}
