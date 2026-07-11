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

import { getDb } from "./db.ts";
import { getBackendUrl, getSessionToken, getRestaurantId, isSessionValid } from "./auth.ts";

const SYNC_INTERVAL_MS = parseInt(process.env.EDGE_SYNC_INTERVAL_MS || "10000", 10);
const MAX_BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;

let syncRunning = false;
let lastSyncAt = 0;
let lastSyncResult: { ok: boolean; pushed: number; accepted: number; rejected: number; error?: string } | null = null;

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
  // Get pending records, prioritizing oldest first, skipping exhausted ones
  return db.query(`
    SELECT * FROM sync_queue
    WHERE synced = 0 AND attempts < ?
    ORDER BY created_at ASC
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
      const table = db.query("SELECT * FROM table WHERE id = ?").get(recordId) as any;
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

    default:
      return null;
  }
}

// ─── Mark records as synced or update attempts ───────────────────────────────

function markSynced(queueIds: number[]): void {
  if (queueIds.length === 0) return;
  const db = getDb();
  const placeholders = queueIds.map(() => "?").join(",");
  db.query(`UPDATE sync_queue SET synced = 1 WHERE id IN (${placeholders})`).run(...queueIds);
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

export async function pushSyncBatch(): Promise<{ ok: boolean; pushed: number; accepted: number; rejected: number; error?: string }> {
  const backendUrl = getBackendUrl();
  const token = getSessionToken();
  const restaurantId = getRestaurantId();

  if (!backendUrl || !token || !restaurantId) {
    return { ok: false, pushed: 0, accepted: 0, rejected: 0, error: "No valid session" };
  }

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
    const res = await fetch(`${backendUrl}/api/edge/sync`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        restaurantId,
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
      rejected: Array<{ queueId: number; error: string }>;
    };

    // Mark accepted records as synced
    markSynced(result.accepted);

    // Increment attempts for rejected records
    if (result.rejected && result.rejected.length > 0) {
      for (const rej of result.rejected) {
        incrementAttempts([rej.queueId], rej.error);
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
      accepted: result.accepted.length,
      rejected: (result.rejected || []).length,
    };

    if (result.accepted.length > 0) {
      console.log(`[Sync] Pushed ${payload.length} records — ${result.accepted.length} accepted, ${(result.rejected || []).length} rejected`);
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

// ─── Sync worker loop ────────────────────────────────────────────────────────

let syncTimer: ReturnType<typeof setInterval> | null = null;

export function startSyncWorker(): void {
  if (syncTimer) return;

  console.log(`[Sync] Worker started — interval: ${SYNC_INTERVAL_MS}ms`);

  // Initial push after 5 seconds (let server warm up)
  setTimeout(async () => {
    if (!isSessionValid()) return;
    try {
      await pushSyncBatch();
      deadLetterExhausted();
    } catch (err) {
      console.error("[Sync] Initial push error:", err);
    }
  }, 5_000);

  // Regular interval
  syncTimer = setInterval(async () => {
    if (!isSessionValid()) return;
    if (syncRunning) return; // Skip if previous cycle still running

    syncRunning = true;
    try {
      await pushSyncBatch();
      deadLetterExhausted();
    } catch (err) {
      console.error("[Sync] Worker cycle error:", err);
    } finally {
      syncRunning = false;
    }
  }, SYNC_INTERVAL_MS);
}

export function stopSyncWorker(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
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
} {
  const db = getDb();
  const pendingCount = (db.query("SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0 AND attempts < ?").get(MAX_ATTEMPTS) as any)?.c || 0;
  const deadLetterCount = (db.query("SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0 AND attempts >= ?").get(MAX_ATTEMPTS) as any)?.c || 0;

  return {
    workerRunning: syncTimer !== null,
    lastSyncAt: lastSyncAt || null,
    lastSyncResult,
    pendingCount,
    deadLetterCount,
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
