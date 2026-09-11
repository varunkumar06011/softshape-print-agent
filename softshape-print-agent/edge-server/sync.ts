// ─────────────────────────────────────────────────────────────────────────────
// sync.ts — Edge → Cloud sync worker (v2: revision-based complete-order-payload)
// ─────────────────────────────────────────────────────────────────────────────
// Replaces the per-record dependency-tracked sync system with revision-based
// complete-order-payload sync. Each order is sent as one atomic snapshot
// (order + items + KOTs + kot_items + transactions). The cloud creates
// everything in a single Prisma transaction. Revision-based conditional
// updates prevent stale payloads from marking newer local state as synced.
//
// Design:
//   - Runs every 5 seconds (configurable via EDGE_SYNC_INTERVAL_MS)
//   - Collects up to 10 orders where revision > cloud_synced_version
//   - Builds complete payload inside SQLite read transaction (consistent snapshot)
//   - Pushes 10 orders concurrently via Promise.allSettled
//   - On success: conditional UPDATE cloud_synced_version = snapshotRevision
//     WHERE revision = snapshotRevision (prevents stale-payload races)
//   - Expenditures and walk-in transactions: separate standalone payloads
//   - One-shot cloud comparison on startup (reconcileWithCloud)
//   - No sync_queue, no dependency tracking, no reconciliation loops
//
// Config sync (tables, sections, floors, menu, users, outlets) is unchanged —
// still uses pullIncrementalChanges() + pullBusinessChanges() + startSocketSync().
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, getTransactionRecord } from "./db.ts";
import { getBackendUrl, getSessionToken, getRestaurantId, isSessionValid, getDeviceId, saveSession, loadSession } from "./auth.ts";
import { cloudFetch } from "./cloudFetch.ts";
import { pullIncrementalChanges } from "./config.ts";
import { startSocketSync } from "./socketSync.ts";

const SYNC_INTERVAL_MS = parseInt(process.env.EDGE_SYNC_INTERVAL_MS || "5000", 10);
const CONFIG_PULL_INTERVAL_MS = parseInt(process.env.EDGE_CONFIG_PULL_INTERVAL_MS || "60000", 10);
const BUSINESS_PULL_INTERVAL_MS = parseInt(process.env.EDGE_BUSINESS_PULL_INTERVAL_MS || "30000", 10);
const RECONCILE_INTERVAL_MS = 30 * 60_000; // every 30 minutes
const MAX_CONCURRENT_PUSHES = 10; // cap in-flight cloud requests per cycle
// Config-queue rows that keep erroring past this many attempts are left
// synced=0 but no longer pushed — they still surface via the sync alerts
// (dead-letter detector flags attempts >= 5) for manual review.
const CONFIG_DEAD_LETTER_THRESHOLD = 50;
const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60_000; // every 5 minutes
const MAX_ORDERS_PER_CYCLE = 50;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const STUCK_RECORD_THRESHOLD = 100; // sync_attempt_count > 100 → stuck (was 10, too aggressive)
const STUCK_RECORD_AGE_MS = 30 * 60_000; // pending > 30 min → stuck

let syncRunning = false;
let lastSyncAt = 0;
let lastConfigPullAt = 0;
let lastBusinessPullAt = 0;
let lastReconcileAt = 0;
let lastWalCheckpointAt = 0;
let consecutiveFailures = 0;
let lastSyncResult: { ok: boolean; pushed: number; accepted: number; rejected: number; error?: string } | null = null;
let _cloudRegistrationAttempted = false;
let _lastRefreshAttemptAt = 0;
const REFRESH_COOLDOWN_MS = 60_000;

function getBackoffDelay(): number {
  if (consecutiveFailures === 0) return SYNC_INTERVAL_MS;
  const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, consecutiveFailures - 1), BACKOFF_MAX_MS);
  return delay;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Order sync — complete payload, revision-based
// ═══════════════════════════════════════════════════════════════════════════════

interface PendingOrder {
  id: string;
  revision: number;
  cloud_synced_version: number;
  created_at: number;
}

function collectUnsyncedOrders(): PendingOrder[] {
  const db = getDb();
  return db.query(
    `SELECT id, revision, cloud_synced_version, created_at
     FROM order_record
     WHERE revision > cloud_synced_version AND is_deleted = 0
       AND sync_attempt_count < ?  -- dead-letter: stop retrying stuck records
     -- Least-recently-attempted first: never-tried records (NULL → 0) go
     -- before old failures, so a few poison records can't head-block the queue.
     ORDER BY COALESCE(last_sync_attempt_at, 0) ASC, created_at ASC
     LIMIT ?`,
  ).all(STUCK_RECORD_THRESHOLD, MAX_ORDERS_PER_CYCLE) as PendingOrder[];
}

// Build a complete order payload inside a SQLite read transaction for a
// consistent snapshot. No mixing of version A order with version B items.
function buildOrderPayload(orderId: string): { payload: any; snapshotRevision: number } | null {
  const db = getDb();
  db.query("BEGIN").run();
  try {
    const order = db.query("SELECT * FROM order_record WHERE id = ?").get(orderId) as any;
    if (!order) {
      db.query("ROLLBACK").run();
      return null;
    }
    const items = db.query("SELECT * FROM order_item WHERE order_id = ?").all(orderId) as any[];
    const kots = db.query("SELECT * FROM kot WHERE order_id = ?").all(orderId) as any[];
    const kotItems = kots.flatMap((kot) =>
      db.query("SELECT * FROM kot_item WHERE kot_id = ?").all(kot.id) as any[],
    );
    const transactions = db.query(
      "SELECT * FROM transaction_record WHERE order_id = ? AND kind = 'settle' ORDER BY created_at ASC",
    ).all(orderId) as any[];

    db.query("COMMIT").run();

    // Build the payload — map edge column names to the cloud-expected shapes
    const orderPayload = {
      id: order.id,
      table_id: order.table_id,
      table_number: order.table_number || null,
      table_section_id: order.table_section_id || null,
      restaurant_id: order.restaurant_id,
      status: order.status,
      total_amount: order.total_amount,
      billing_requested: order.billing_requested,
      billing_requested_at: order.billing_requested_at,
      created_at: order.created_at,
      updated_at: order.updated_at,
      bill_number: order.bill_number,
      paid_at: order.paid_at,
      last_request_id: order.last_request_id,
      captain_id: order.captain_id,
      platform: order.platform,
      created_by_user_id: order.created_by_user_id,
      is_extra_table: order.is_extra_table,
    };

    const itemsPayload = items.map((i) => ({
      id: i.id,
      order_id: i.order_id,
      menu_item_id: i.menu_item_id,
      name: i.name,
      price: i.price,
      quantity: i.quantity,
      notes: i.notes,
      menu_type: i.menu_type,
      cancelled_quantity: i.cancelled_quantity,
      removed_from_bill: i.removed_from_bill,
      pour_from_inventory_item_id: i.pour_from_inventory_item_id,
    }));

    const kotsPayload = kots.map((k) => {
      const kiRows = kotItems.filter((ki) => ki.kot_id === k.id);
      return {
        id: k.id,
        kot_number: k.kot_number,
        counter_date: k.counter_date,
        captain_id: k.captain_id,
        created_at: k.created_at,
        items: kiRows.map((ki) => ({
          id: ki.id,
          order_item_id: ki.order_item_id,
          menu_item_id: ki.menu_item_id,
          name: ki.name,
          quantity: ki.quantity,
          price: ki.price,
          notes: ki.notes,
          status: ki.status,
          created_at: ki.created_at,
        })),
      };
    });

    const transactionsPayload = transactions.map((t) => {
      const payload = getTransactionRecord(t.id) || JSON.parse(t.payload || "{}");
      return payload;
    });

    return {
      payload: {
        order: orderPayload,
        items: itemsPayload,
        kots: kotsPayload,
        transactions: transactionsPayload,
      },
      snapshotRevision: order.revision,
    };
  } catch (err) {
    try { db.query("ROLLBACK").run(); } catch {}
    throw err;
  }
}

// Conditional update: only mark synced if revision hasn't advanced during flight.
function markOrderSynced(orderId: string, snapshotRevision: number): boolean {
  const db = getDb();
  const result = db.query(
    "UPDATE order_record SET cloud_synced_version = ?, cloud_synced = 1, sync_attempt_count = 0, last_sync_error = NULL WHERE id = ? AND revision = ?",
  ).run(snapshotRevision, orderId, snapshotRevision);
  if ((result.changes || 0) === 0) return false;
  // The order snapshot carried its kind='settle' transaction_records — they are
  // in the cloud now too. Mark them synced so getOrderSyncStatus / backup purge
  // see the true state (revision guard passed → the txns match this snapshot).
  db.query(
    "UPDATE transaction_record SET cloud_synced_version = sync_version, cloud_synced = 1, sync_attempt_count = 0, last_sync_error = NULL WHERE order_id = ?",
  ).run(orderId);
  return true;
}

// Error classes that can never self-heal: FK violations, Prisma validation
// failures, or the backend explicitly flagging permanence. They get a large
// attempt bump so the record exits the retry set in ~5 cycles instead of
// head-blocking the queue until the 100-attempt stuck threshold.
function isPermanentSyncError(msg: string): boolean {
  return /permanent":\s*true|Foreign key constraint violated|Argument `\w+` is missing|Unknown argument/i.test(msg);
}

function failureStep(errorMsg: string, permanent = false): number {
  return (permanent || isPermanentSyncError(errorMsg)) ? 20 : 1;
}

function recordOrderSyncFailure(orderId: string, errorMsg: string, permanent = false): void {
  const db = getDb();
  db.query(
    "UPDATE order_record SET sync_attempt_count = sync_attempt_count + ?, last_sync_attempt_at = ?, last_sync_error = ? WHERE id = ?",
  ).run(failureStep(errorMsg, permanent), Date.now(), errorMsg.slice(0, 500), orderId);
}

async function pushOrder(order: PendingOrder): Promise<{ ok: boolean; duplicate?: boolean; error?: string }> {
  const backendUrl = getBackendUrl();
  const restaurantId = getRestaurantId();
  const token = getSessionToken();

  let built: { payload: any; snapshotRevision: number } | null;
  try {
    built = buildOrderPayload(order.id);
  } catch (err: any) {
    recordOrderSyncFailure(order.id, `buildOrderPayload error: ${err.message || err}`);
    return { ok: false, error: err.message || "build error" };
  }
  if (!built) {
    // Order was deleted locally — mark as synced to stop retrying
    markOrderSynced(order.id, order.revision);
    return { ok: true };
  }

  try {
    const res = await cloudFetch(`${backendUrl}/api/edge/sync-order`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        restaurantId,
        deviceId: getDeviceId(),
        snapshotRevision: built.snapshotRevision,
        ...built.payload,
      }),
      // Whole-order payloads are one transaction cloud-side — under load the
      // server can take >15s before sending headers. 30s matches the reconcile
      // budget and keeps legitimate slow commits from being read as failures.
      connectTimeout: 30_000,
      bodyTimeout: 30_000,
    });

    if (res.status === 401) {
      return { ok: false, error: "401" };
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const errorMsg = errBody.error || `HTTP ${res.status}`;
      // Other 4xx (except retryable 408/429) can't self-heal — the payload or
      // resource state won't change on retry, so count them permanent-class.
      const permanent = errBody.permanent === true
        || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
      recordOrderSyncFailure(order.id, errorMsg, permanent);
      return { ok: false, error: errorMsg };
    }

    const result = await res.json() as { outcome: "applied" | "duplicate"; appliedRevision: number };
    // Conditional update — only marks synced if revision hasn't advanced
    markOrderSynced(order.id, result.appliedRevision);
    return { ok: true, duplicate: result.outcome === "duplicate" };
  } catch (err: any) {
    recordOrderSyncFailure(order.id, err.message || "Network error");
    return { ok: false, error: err.message || "Network error" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Expenditure sync — standalone, revision-based
// ═══════════════════════════════════════════════════════════════════════════════

interface PendingExpenditure {
  id: string;
  sync_version: number;
  cloud_synced_version: number;
}

function collectUnsyncedExpenditures(): PendingExpenditure[] {
  const db = getDb();
  return db.query(
    `SELECT id, sync_version, cloud_synced_version
     FROM expenditure
     WHERE sync_version > cloud_synced_version
       AND sync_attempt_count < ?  -- dead-letter: stop retrying stuck records
     ORDER BY COALESCE(last_sync_attempt_at, 0) ASC, created_at ASC
     LIMIT ?`,
  ).all(STUCK_RECORD_THRESHOLD, MAX_ORDERS_PER_CYCLE) as PendingExpenditure[];
}

function markExpenditureSynced(id: string, snapshotRevision: number): boolean {
  const db = getDb();
  const result = db.query(
    "UPDATE expenditure SET cloud_synced_version = ?, cloud_synced = 1, sync_attempt_count = 0, last_sync_error = NULL WHERE id = ? AND sync_version = ?",
  ).run(snapshotRevision, id, snapshotRevision);
  return (result.changes || 0) > 0;
}

function recordExpenditureSyncFailure(id: string, errorMsg: string, permanent = false): void {
  const db = getDb();
  db.query(
    "UPDATE expenditure SET sync_attempt_count = sync_attempt_count + ?, last_sync_attempt_at = ?, last_sync_error = ? WHERE id = ?",
  ).run(failureStep(errorMsg, permanent), Date.now(), errorMsg.slice(0, 500), id);
}

async function pushExpenditure(exp: PendingExpenditure): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();
  const backendUrl = getBackendUrl();
  const restaurantId = getRestaurantId();
  const token = getSessionToken();

  const row = db.query("SELECT * FROM expenditure WHERE id = ?").get(exp.id) as any;
  if (!row) {
    markExpenditureSynced(exp.id, exp.sync_version);
    return { ok: true };
  }

  const expenditurePayload = {
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
    employeeId: row.employee_id || null,
    ledgerCategoryId: row.ledger_category_id || null,
    entryType: row.entry_type || "EXPENSE",
  };

  try {
    const res = await cloudFetch(`${backendUrl}/api/edge/sync-expenditure`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        restaurantId,
        deviceId: getDeviceId(),
        snapshotRevision: exp.sync_version,
        expenditure: expenditurePayload,
      }),
      connectTimeout: 15_000,
      bodyTimeout: 30_000,
    });

    if (res.status === 401) return { ok: false, error: "401" };
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const errorMsg = errBody.error || `HTTP ${res.status}`;
      const permanent = errBody.permanent === true
        || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
      recordExpenditureSyncFailure(exp.id, errorMsg, permanent);
      return { ok: false, error: errorMsg };
    }

    const result = await res.json() as { appliedRevision: number };
    markExpenditureSynced(exp.id, result.appliedRevision);
    return { ok: true };
  } catch (err: any) {
    recordExpenditureSyncFailure(exp.id, err.message || "Network error");
    return { ok: false, error: err.message || "Network error" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Walk-in transaction sync — standalone, revision-based
// ═══════════════════════════════════════════════════════════════════════════════

interface PendingWalkin {
  id: string;
  sync_version: number;
  cloud_synced_version: number;
}

function collectUnsyncedWalkins(): PendingWalkin[] {
  const db = getDb();
  return db.query(
    `SELECT id, sync_version, cloud_synced_version
     FROM transaction_record
     WHERE kind = 'walkin' AND sync_version > cloud_synced_version
       AND sync_attempt_count < ?  -- dead-letter: stop retrying stuck records
     ORDER BY COALESCE(last_sync_attempt_at, 0) ASC, created_at ASC
     LIMIT ?`,
  ).all(STUCK_RECORD_THRESHOLD, MAX_ORDERS_PER_CYCLE) as PendingWalkin[];
}

function markWalkinSynced(id: string, snapshotRevision: number): boolean {
  const db = getDb();
  const result = db.query(
    "UPDATE transaction_record SET cloud_synced_version = ?, cloud_synced = 1, sync_attempt_count = 0, last_sync_error = NULL WHERE id = ? AND sync_version = ?",
  ).run(snapshotRevision, id, snapshotRevision);
  return (result.changes || 0) > 0;
}

function recordWalkinSyncFailure(id: string, errorMsg: string, permanent = false): void {
  const db = getDb();
  db.query(
    "UPDATE transaction_record SET sync_attempt_count = sync_attempt_count + ?, last_sync_attempt_at = ?, last_sync_error = ? WHERE id = ?",
  ).run(failureStep(errorMsg, permanent), Date.now(), errorMsg.slice(0, 500), id);
}

async function pushWalkin(walkin: PendingWalkin): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();
  const backendUrl = getBackendUrl();
  const restaurantId = getRestaurantId();
  const token = getSessionToken();

  const payload = getTransactionRecord(walkin.id);
  if (!payload) {
    // Row genuinely gone (hard-deleted between collect and push) → nothing to
    // sync. But if the row exists and only the payload is unreadable, that's
    // data corruption — record a failure so it stays pending and visible as a
    // stuck record instead of being silently marked synced.
    const rowExists = getDb()
      .query("SELECT 1 FROM transaction_record WHERE id = ?")
      .get(walkin.id);
    if (!rowExists) {
      markWalkinSynced(walkin.id, walkin.sync_version);
      return { ok: true };
    }
    recordWalkinSyncFailure(walkin.id, "Transaction payload missing or corrupt");
    return { ok: false, error: "Payload corrupt" };
  }

  try {
    const res = await cloudFetch(`${backendUrl}/api/edge/sync-walkin-transaction`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        restaurantId,
        deviceId: getDeviceId(),
        snapshotRevision: walkin.sync_version,
        transaction: { id: walkin.id, ...payload },
      }),
      connectTimeout: 15_000,
      bodyTimeout: 30_000,
    });

    if (res.status === 401) return { ok: false, error: "401" };
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const errorMsg = errBody.error || `HTTP ${res.status}`;
      const permanent = errBody.permanent === true
        || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
      recordWalkinSyncFailure(walkin.id, errorMsg, permanent);
      return { ok: false, error: errorMsg };
    }

    const result = await res.json() as { appliedRevision: number };
    markWalkinSynced(walkin.id, result.appliedRevision);
    return { ok: true };
  } catch (err: any) {
    recordWalkinSyncFailure(walkin.id, err.message || "Network error");
    return { ok: false, error: err.message || "Network error" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cloud reconciliation — one-shot on startup, detects cloud-missing records
// ═══════════════════════════════════════════════════════════════════════════════

async function reconcileWithCloud(): Promise<{ ordersReset: number; expendituresReset: number; walkinsReset: number }> {
  const db = getDb();
  const backendUrl = getBackendUrl();
  const restaurantId = getRestaurantId();
  const token = getSessionToken();

  if (!backendUrl || !restaurantId || !token) {
    return { ordersReset: 0, expendituresReset: 0, walkinsReset: 0 };
  }

  // Determine the reconciliation window: from the oldest locally retained
  // business date to today. Use the oldest order/expenditure/transaction date.
  const oldestOrder = db.query("SELECT MIN(created_at) as min_at FROM order_record").get() as { min_at?: number } | null;
  const oldestExpenditure = db.query("SELECT MIN(created_at) as min_at FROM expenditure").get() as { min_at?: number } | null;
  const oldestWalkin = db.query("SELECT MIN(created_at) as min_at FROM transaction_record WHERE kind = 'walkin'").get() as { min_at?: number } | null;

  const minDates = [oldestOrder?.min_at, oldestExpenditure?.min_at, oldestWalkin?.min_at].filter(Boolean) as number[];
  if (minDates.length === 0) {
    return { ordersReset: 0, expendituresReset: 0, walkinsReset: 0 };
  }

  const oldestAt = Math.min(...minDates);
  const oldestDate = new Date(oldestAt);
  // Format as YYYY-MM-DD in IST (UTC+5:30)
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const fromDate = new Date(oldestAt + istOffsetMs).toISOString().slice(0, 10);
  const toDate = new Date(Date.now() + istOffsetMs).toISOString().slice(0, 10);

  const cloudOrderIds = new Set<string>();
  const cloudTxnIds = new Set<string>();
  const cloudExpenditureIds = new Set<string>();
  const cloudWalkinIds = new Set<string>();

  // Paginate through all cloud records in the window
  let cursor: string | null = null;
  const limit = 500;
  let pages = 0;
  const maxPages = 200; // safety cap (200 * 500 = 100k records)

  try {
    while (pages < maxPages) {
      const url = `${backendUrl}/api/edge/sync-state?fromDate=${fromDate}&toDate=${toDate}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await cloudFetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        connectTimeout: 30_000,
        bodyTimeout: 60_000,
      });

      if (!res.ok) {
        console.warn(`[Sync] reconcileWithCloud: HTTP ${res.status} — skipping reconciliation`);
        return { ordersReset: 0, expendituresReset: 0, walkinsReset: 0 };
      }

      const data = await res.json() as {
        orders: Array<{ id: string }>;
        transactionLocalIds: string[];
        expenditureIds: string[];
        walkinLocalIds: string[];
        nextCursor: string | null;
      };

      for (const o of data.orders) cloudOrderIds.add(o.id);
      for (const t of data.transactionLocalIds) cloudTxnIds.add(t);
      for (const e of data.expenditureIds) cloudExpenditureIds.add(e);
      for (const w of data.walkinLocalIds) cloudWalkinIds.add(w);

      if (!data.nextCursor) break;
      cursor = data.nextCursor;
      pages++;
    }
  } catch (err: any) {
    console.warn(`[Sync] reconcileWithCloud failed: ${err.message || err}`);
    return { ordersReset: 0, expendituresReset: 0, walkinsReset: 0 };
  }

  // Compare local synced records against cloud. If local says synced but cloud
  // doesn't have the ID, reset cloud_synced_version = 0 so the worker re-pushes.
  // All resets run inside ONE transaction — thousands of individual UPDATEs
  // each fsyncing is what blocked the event loop when this was enabled before.
  let ordersReset = 0;
  let expendituresReset = 0;
  let walkinsReset = 0;

  db.transaction(() => {
    // Orders: local cloud_synced_version > 0 means "synced". If cloud doesn't
    // have the ID, reset to 0.
    const syncedOrders = db.query(
      "SELECT id FROM order_record WHERE cloud_synced_version > 0 AND is_deleted = 0",
    ).all() as Array<{ id: string }>;
    const resetOrder = db.query("UPDATE order_record SET cloud_synced_version = 0, cloud_synced = 0 WHERE id = ?");
    for (const o of syncedOrders) {
      if (!cloudOrderIds.has(o.id)) {
        resetOrder.run(o.id);
        ordersReset++;
      }
    }

    // Expenditures
    const syncedExps = db.query(
      "SELECT id FROM expenditure WHERE cloud_synced_version > 0",
    ).all() as Array<{ id: string }>;
    const resetExp = db.query("UPDATE expenditure SET cloud_synced_version = 0, cloud_synced = 0 WHERE id = ?");
    for (const e of syncedExps) {
      if (!cloudExpenditureIds.has(e.id)) {
        resetExp.run(e.id);
        expendituresReset++;
      }
    }

    // Walk-in transactions
    const syncedWalkins = db.query(
      "SELECT id FROM transaction_record WHERE kind = 'walkin' AND cloud_synced_version > 0",
    ).all() as Array<{ id: string }>;
    const resetWalkin = db.query("UPDATE transaction_record SET cloud_synced_version = 0, cloud_synced = 0 WHERE id = ?");
    for (const w of syncedWalkins) {
      if (!cloudWalkinIds.has(w.id)) {
        resetWalkin.run(w.id);
        walkinsReset++;
      }
    }
  })();

  // Settled-order transactions (kind='settle'): these are part of the order
  // payload, so if the order is missing from cloud, the transaction is too.
  // The order reset above already handles this — no separate walk-in reset needed.

  if (ordersReset > 0 || expendituresReset > 0 || walkinsReset > 0) {
    console.log(`[Sync] Reconciliation: reset ${ordersReset} orders, ${expendituresReset} expenditures, ${walkinsReset} walkins (cloud-missing)`);
  }

  return { ordersReset, expendituresReset, walkinsReset };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Session management (preserved from v1)
// ═══════════════════════════════════════════════════════════════════════════════

async function refreshCloudSession(): Promise<boolean> {
  const session = loadSession();
  if (!session || !session.sessionToken) return false;

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

    try { startSocketSync(); } catch (err: any) {
      console.warn("[Sync] Socket sync start failed after refresh:", err.message || err);
    }

    return true;
  } catch (err: any) {
    console.warn("[Sync] Session refresh error:", err.message || err);
    return false;
  }
}

function isJwtExpiringSoon(expiresAt: number, thresholdMs: number = 24 * 60 * 60 * 1000): boolean {
  if (!expiresAt) return false;
  return Date.now() + thresholdMs > expiresAt;
}

async function ensureCloudSession(): Promise<boolean> {
  const session = loadSession();
  if (!session) return false;

  if (!session.sessionToken.startsWith("local-onboard-")) {
    if (isJwtExpiringSoon(session.expiresAt)) {
      const refreshed = await refreshCloudSession();
      if (!refreshed) {
        if (!isSessionValid()) return false;
      }
    }
    return true;
  }

  if (_cloudRegistrationAttempted) return false;
  _cloudRegistrationAttempted = true;
  console.warn("[Sync] Local onboarding token detected — offline registration is deprecated. Please re-link via /edge-setup.");
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Config push — edge → cloud sync for menu/category/users/etc.
// ═══════════════════════════════════════════════════════════════════════════════
// The revision-based sync above only pushes orders/expenditures/walkins.
// Config changes (menu_item, category, users, etc.) are enqueued via
// enqueueSync() into sync_queue but were never pushed. This section reads
// pending config entries, builds the payload from local SQLite, and sends
// a single batch to /api/edge/sync per cycle.
//
// Bounded to MAX_CONFIG_PER_CYCLE to avoid overwhelming the cloud or
// blocking the sync worker. Config changes are infrequent (cashier menu
// edits), so this is more than enough throughput.
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_CONFIG_PER_CYCLE = 10;

// Tables whose sync_queue entries should be pushed to the cloud via
// /api/edge/sync. Business data (orders, transactions, expenditures,
// walkins) is handled by the revision-based sync above.
const CONFIG_TABLES = new Set([
  "menu_item",
  "menu_item_variant",
  "category",
  "venue",
  "floor",
  "section",
  "table",
  "outlet",
  "users",
  "employee",
  "ledger_category",
]);

interface PendingConfig {
  queueId: number;
  tableName: string;
  recordId: string;
  operation: string;
}

function collectUnsyncedConfig(): PendingConfig[] {
  const db = getDb();
  const tableNames = Array.from(CONFIG_TABLES);
  const placeholders = tableNames.map(() => "?").join(",");
  return db.query(
    `SELECT id as queueId, table_name as tableName, record_id as recordId, operation
     FROM sync_queue
     WHERE synced = 0 AND attempts < ? AND table_name IN (${placeholders})
     ORDER BY created_at ASC
     LIMIT ?`,
  ).all(CONFIG_DEAD_LETTER_THRESHOLD, ...tableNames, MAX_CONFIG_PER_CYCLE) as PendingConfig[];
}

// Convert snake_case key to camelCase
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// Convert a SQLite row (snake_case keys) to a camelCase object
function rowToCamel(row: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    result[snakeToCamel(key)] = value;
  }
  return result;
}

// Build the data payload for a config item by reading its SQLite row.
// For menu_item, also includes nested venue_prices, venue_availabilities,
// and section_availabilities so the cloud can upsert them in one request.
function buildConfigPayload(tableName: string, recordId: string): any | null {
  const db = getDb();

  // Quote table name for SQLite reserved words (e.g., "table")
  const quotedTable = `"${tableName}"`;

  const row = db.query(`SELECT * FROM ${quotedTable} WHERE id = ?`).get(recordId) as any;
  if (!row) return null; // Row may have been hard-deleted

  const data = rowToCamel(row);

  // For menu_item, include nested venue prices + availabilities so the
  // cloud's upsertMenuItem can apply them in the same request.
  if (tableName === "menu_item") {
    const venuePrices = db.query(
      "SELECT venue_id, price, is_active FROM venue_price WHERE menu_item_id = ?",
    ).all(recordId) as any[];
    if (venuePrices.length > 0) {
      data.venuePrices = venuePrices.map((vp) => ({
        venueId: vp.venue_id,
        price: Number(vp.price),
        isActive: vp.is_active !== 0,
      }));
    }

    const venueAvail = db.query(
      "SELECT venue_id, is_available FROM venue_menu_item_availability WHERE menu_item_id = ?",
    ).all(recordId) as any[];
    if (venueAvail.length > 0) {
      data.venueAvailabilities = venueAvail.map((va) => ({
        venueId: va.venue_id,
        isAvailable: va.is_available !== 0,
      }));
    }

    const sectionAvail = db.query(
      "SELECT section_id, is_available FROM section_menu_item_availability WHERE menu_item_id = ?",
    ).all(recordId) as any[];
    if (sectionAvail.length > 0) {
      data.sectionAvailabilities = sectionAvail.map((sa) => ({
        sectionId: sa.section_id,
        isAvailable: sa.is_available !== 0,
      }));
    }
  }

  return data;
}

function markConfigSynced(queueId: number): void {
  const db = getDb();
  db.query("UPDATE sync_queue SET synced = 1 WHERE id = ?").run(queueId);
}

function markConfigAttempt(queueId: number, error: string): void {
  const db = getDb();
  db.query("UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?").run(error, queueId);
}

async function pushConfigBatch(): Promise<{ ok: boolean; pushed: number; accepted: number; rejected: number }> {
  const pending = collectUnsyncedConfig();
  if (pending.length === 0) {
    return { ok: true, pushed: 0, accepted: 0, rejected: 0 };
  }

  const backendUrl = getBackendUrl();
  const token = getSessionToken();
  const restaurantId = getRestaurantId();

  if (!backendUrl || !token || !restaurantId) {
    return { ok: false, pushed: 0, accepted: 0, rejected: 0 };
  }

  // Build the batch payload, skipping rows that no longer exist
  const batch: Array<{ queueId: number; tableName: string; recordId: string; operation: string; data: any }> = [];
  for (const item of pending) {
    const data = buildConfigPayload(item.tableName, item.recordId);
    if (data) {
      batch.push({
        queueId: item.queueId,
        tableName: item.tableName,
        recordId: item.recordId,
        operation: item.operation,
        data,
      });
    } else {
      // Row doesn't exist (hard-deleted) — mark as synced to dequeue
      markConfigSynced(item.queueId);
    }
  }

  if (batch.length === 0) {
    return { ok: true, pushed: 0, accepted: 0, rejected: 0 };
  }

  try {
    const res = await cloudFetch(`${backendUrl}/api/edge/sync`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ restaurantId, deviceId: getDeviceId(), batch }),
      timeout: 15_000,
    });

    if (!res.ok) {
      console.warn(`[Sync] Config push failed: HTTP ${res.status}`);
      return { ok: false, pushed: batch.length, accepted: 0, rejected: batch.length };
    }

    const result = (await res.json()) as { accepted: number[]; rejected: Array<{ queueId: number; error: string; outcome: string }> };
    const acceptedSet = new Set(result.accepted);

    for (const item of batch) {
      if (acceptedSet.has(item.queueId)) {
        markConfigSynced(item.queueId);
      } else {
        const rejectedItem = result.rejected.find((r) => r.queueId === item.queueId);
        if (rejectedItem && rejectedItem.outcome !== "error" && rejectedItem.outcome !== "waiting_dependency") {
          // Permanent rejection (duplicate, rejected, conflict) — safe to dequeue
          markConfigSynced(item.queueId);
        } else if (rejectedItem && rejectedItem.outcome === "waiting_dependency") {
          // Parent not yet synced — leave for retry next cycle without penalty
        } else {
          // Error — increment attempts for tracking
          markConfigAttempt(item.queueId, rejectedItem?.error || "Unknown error");
        }
      }
    }

    const acceptedCount = result.accepted.length;
    const rejectedCount = batch.length - acceptedCount;
    if (acceptedCount > 0) {
      console.log(`[Sync] Config push: ${acceptedCount}/${batch.length} accepted`);
    }

    return { ok: rejectedCount === 0 || acceptedCount > 0, pushed: batch.length, accepted: acceptedCount, rejected: rejectedCount };
  } catch (err) {
    console.warn("[Sync] Config push error:", (err as Error)?.message || err);
    return { ok: false, pushed: batch.length, accepted: 0, rejected: batch.length };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sync cycle — collect, push concurrently, mark synced
// ═══════════════════════════════════════════════════════════════════════════════

export async function pushSyncBatch(): Promise<{ ok: boolean; pushed: number; accepted: number; rejected: number; error?: string }> {
  const backendUrl = getBackendUrl();
  const restaurantId = getRestaurantId();

  if (!backendUrl || !restaurantId) {
    return { ok: false, pushed: 0, accepted: 0, rejected: 0, error: "No valid session" };
  }

  if (!(await ensureCloudSession())) {
    return { ok: false, pushed: 0, accepted: 0, rejected: 0, error: "No valid cloud session" };
  }

  // Collect all pending business records
  const pendingOrders = collectUnsyncedOrders();
  const pendingExpenditures = collectUnsyncedExpenditures();
  const pendingWalkins = collectUnsyncedWalkins();

  const totalBusinessPending = pendingOrders.length + pendingExpenditures.length + pendingWalkins.length;

  // Push business data (orders/expenses/walkins) if any are pending
  let businessAccepted = 0;
  let businessRejected = 0;
  let had401 = false;

  if (totalBusinessPending > 0) {
    // Push concurrently but bounded — launching up to 150 requests at once
    // exhausts sockets and starves the local API on the same event loop.
    const pushFns: Array<() => Promise<{ ok: boolean; error?: string }>> = [
      ...pendingOrders.map((o) => () => pushOrder(o)),
      ...pendingExpenditures.map((e) => () => pushExpenditure(e)),
      ...pendingWalkins.map((w) => () => pushWalkin(w)),
    ];

    for (let i = 0; i < pushFns.length; i += MAX_CONCURRENT_PUSHES) {
      const results = await Promise.allSettled(pushFns.slice(i, i + MAX_CONCURRENT_PUSHES).map((fn) => fn()));
      for (const r of results) {
        if (r.status === "fulfilled") {
          if (r.value.ok) {
            businessAccepted++;
          } else {
            businessRejected++;
            if (r.value.error === "401") had401 = true;
          }
        } else {
          businessRejected++;
        }
      }
    }
  }

  // Push config changes (menu_item, category, users, etc.) — single batch
  const configResult = await pushConfigBatch();

  // If any got 401, attempt session refresh for next cycle
  if (had401) {
    await refreshCloudSession();
  }

  const totalPending = totalBusinessPending + configResult.pushed;
  const accepted = businessAccepted + configResult.accepted;
  const rejected = businessRejected + configResult.rejected;

  lastSyncAt = Date.now();
  // Partial success is OK — only count as failure if ALL records failed.
  // This prevents a few stuck records from triggering backoff and blocking
  // new records from syncing at normal interval.
  const ok = rejected === 0 || accepted > 0;
  lastSyncResult = {
    ok,
    pushed: totalPending,
    accepted,
    rejected,
    ...(rejected > 0 ? { error: `${rejected} record(s) failed` } : {}),
  };

  if (accepted > 0) {
    console.log(`[Sync] Pushed ${totalPending} records — ${accepted} accepted, ${rejected} rejected`);
  }

  return lastSyncResult;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sync worker loop
// ═══════════════════════════════════════════════════════════════════════════════

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let _sessionInvalidLoggedAt = 0;

async function runSyncCycle(): Promise<void> {
  if (!isSessionValid()) {
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
    // Startup reconciliation removed — it fetches ALL cloud records and compares
    // with ALL local records, blocking SQLite for extended periods on large
    // existing databases. The periodic reconciliation (every 5 minutes) below
    // handles this after the Edge is already READY and serving requests.

    const result = await pushSyncBatch();

    // WAL checkpoint: use PASSIVE mode (non-blocking) instead of TRUNCATE
    // (which requires an exclusive lock and freezes all reads). PASSIVE
    // checkpoints as much as possible without waiting for readers. Only
    // run every 5 minutes to avoid repeated overhead.
    const now = Date.now();
    if (now - lastWalCheckpointAt >= WAL_CHECKPOINT_INTERVAL_MS) {
      lastWalCheckpointAt = now;
      try {
        getDb().query("PRAGMA wal_checkpoint(PASSIVE)").run();
      } catch { /* non-fatal */ }
    }

    if (result.ok) {
      consecutiveFailures = 0;
    } else if (result.pushed > 0) {
      consecutiveFailures++;
      console.warn(`[Sync] Push failed (${consecutiveFailures} consecutive) — backing off for ${getBackoffDelay()}ms`);
    } else {
      skipBackoff = true;
      console.warn(`[Sync] Push skipped (${result.error}) — retrying at normal interval`);
    }

    // Periodically pull config changes from cloud (printer config, menu, etc.)
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

    // Periodically pull business changes from cloud (orders, KOTs, table state)
    if (now - lastBusinessPullAt >= BUSINESS_PULL_INTERVAL_MS) {
      lastBusinessPullAt = now;
      try {
        const { pullBusinessChanges } = await import("./socketSync.ts");
        const pullResult = await pullBusinessChanges();
        if (pullResult.applied > 0) {
          console.log(`[Sync] Business pull applied ${pullResult.applied} changes from cloud`);
        }
      } catch (pullErr) {
        console.warn("[Sync] Business pull failed:", (pullErr as Error)?.message || pullErr);
      }
    }

    // Self-healing: records that hit the dead-letter threshold are excluded
    // from collection. Reset any that have been quiet for 30+ minutes so they
    // retry automatically — no manual intervention needed.
    resetStaleStuckRecords(now);

    // Periodic cloud reconciliation — catches records wrongly marked synced
    // (migrated rows, dead-lettered pushes, cloud-side loss). Paginated and
    // transaction-batched so it never blocks the event loop for long.
    if (now - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
      lastReconcileAt = now;
      try {
        const recon = await reconcileWithCloud();
        if (recon.ordersReset + recon.expendituresReset + recon.walkinsReset > 0) {
          console.warn(`[Sync] Reconcile requeued ${recon.ordersReset} orders, ${recon.expendituresReset} expenditures, ${recon.walkinsReset} walkins missing in cloud`);
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

  scheduleNextCycle(skipBackoff ? SYNC_INTERVAL_MS : getBackoffDelay());
}

// Reset stuck (dead-lettered) records whose last attempt is older than
// STUCK_RECORD_AGE_MS — they re-enter the pending pool and retry automatically.
function resetStaleStuckRecords(now: number): void {
  const db = getDb();
  const cutoff = now - STUCK_RECORD_AGE_MS;
  try {
    const tx = db.transaction(() => {
      db.query(
        "UPDATE order_record SET sync_attempt_count = 0, last_sync_error = NULL WHERE revision > cloud_synced_version AND sync_attempt_count >= ? AND (last_sync_attempt_at IS NULL OR last_sync_attempt_at < ?)",
      ).run(STUCK_RECORD_THRESHOLD, cutoff);
      db.query(
        "UPDATE expenditure SET sync_attempt_count = 0, last_sync_error = NULL WHERE sync_version > cloud_synced_version AND sync_attempt_count >= ? AND (last_sync_attempt_at IS NULL OR last_sync_attempt_at < ?)",
      ).run(STUCK_RECORD_THRESHOLD, cutoff);
      db.query(
        "UPDATE transaction_record SET sync_attempt_count = 0, last_sync_error = NULL WHERE sync_version > cloud_synced_version AND sync_attempt_count >= ? AND (last_sync_attempt_at IS NULL OR last_sync_attempt_at < ?)",
      ).run(STUCK_RECORD_THRESHOLD, cutoff);
    });
    tx();
  } catch (err) {
    console.warn("[Sync] Stuck-record auto-reset failed:", (err as Error)?.message || err);
  }
}

function scheduleNextCycle(delay: number): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  syncTimer = setTimeout(async () => {
    await runSyncCycle();
  }, delay);
}

export function startSyncWorker(): void {
  if (syncTimer) return;

  // Reset dead-lettered records on startup. After prolonged connectivity
  // issues, records accumulate sync_attempt_count > STUCK_RECORD_THRESHOLD
  // and are excluded from collectUnsyncedOrders(). Resetting gives every
  // unsynced record a fresh retry when the edge server starts.
  try {
    const db = getDb();
    const orderReset = db.query(
      "UPDATE order_record SET sync_attempt_count = 0, last_sync_error = NULL WHERE revision > cloud_synced_version AND sync_attempt_count > 0",
    ).run();
    const expReset = db.query(
      "UPDATE expenditure SET sync_attempt_count = 0, last_sync_error = NULL WHERE sync_version > cloud_synced_version AND sync_attempt_count > 0",
    ).run();
    const walkinReset = db.query(
      "UPDATE transaction_record SET sync_attempt_count = 0, last_sync_error = NULL WHERE kind = 'walkin' AND sync_version > cloud_synced_version AND sync_attempt_count > 0",
    ).run();
    const totalReset = (orderReset.changes || 0) + (expReset.changes || 0) + (walkinReset.changes || 0);
    if (totalReset > 0) {
      console.log(`[Sync] Startup reset: cleared dead-letter status on ${totalReset} stuck record(s) — they will retry syncing`);
    }

    // Repair legacy flag: records synced by the revision worker never got
    // cloud_synced = 1 (older v2 builds only set cloud_synced_version). Backup
    // purge and getOrderSyncStatus still read cloud_synced — backfill it for
    // records already fully synced.
    const orderFlagFix = db.query(
      "UPDATE order_record SET cloud_synced = 1 WHERE cloud_synced = 0 AND cloud_synced_version >= revision",
    ).run();
    const txnFlagFix = db.query(
      "UPDATE transaction_record SET cloud_synced = 1 WHERE cloud_synced = 0 AND cloud_synced_version >= sync_version",
    ).run();
    const expFlagFix = db.query(
      "UPDATE expenditure SET cloud_synced = 1 WHERE cloud_synced = 0 AND cloud_synced_version >= sync_version",
    ).run();
    const flagFixed = (orderFlagFix.changes || 0) + (txnFlagFix.changes || 0) + (expFlagFix.changes || 0);
    if (flagFixed > 0) {
      console.log(`[Sync] Startup repair: set cloud_synced=1 on ${flagFixed} already-synced record(s)`);
    }
  } catch (err) {
    console.warn("[Sync] Startup reset failed:", err);
  }

  const initialDelay = consecutiveFailures > 0 ? getBackoffDelay() : 5_000;
  console.log(`[Sync] Worker started (v2 revision-based) — initial delay: ${initialDelay}ms, base interval: ${SYNC_INTERVAL_MS}ms`);
  scheduleNextCycle(initialDelay);
}

export function stopSyncWorker(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
    console.log("[Sync] Worker stopped");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sync status — new shape with stuckRecords for failure visibility
// ═══════════════════════════════════════════════════════════════════════════════

export function getSyncStatus(): {
  workerRunning: boolean;
  lastSyncAt: number | null;
  lastSyncResult: typeof lastSyncResult;
  pendingCount: number;
  pendingOrders: number;
  pendingExpenditures: number;
  pendingWalkins: number;
  deadLetterCount: number;
  consecutiveFailures: number;
  nextSyncInMs: number;
  stuckRecords: Array<{ type: string; id: string; attempts: number; lastError: string | null; pendingSince: number }>;
} {
  const db = getDb();
  const pendingOrders = (db.query("SELECT COUNT(*) as c FROM order_record WHERE revision > cloud_synced_version AND is_deleted = 0").get() as any)?.c || 0;
  const pendingExpenditures = (db.query("SELECT COUNT(*) as c FROM expenditure WHERE sync_version > cloud_synced_version").get() as any)?.c || 0;
  const pendingWalkins = (db.query("SELECT COUNT(*) as c FROM transaction_record WHERE kind = 'walkin' AND sync_version > cloud_synced_version").get() as any)?.c || 0;

  // Stuck records: sync_attempt_count > STUCK_RECORD_THRESHOLD or pending > 30 min
  const stuckOrders = db.query(
    `SELECT id, sync_attempt_count, last_sync_error, created_at, last_sync_attempt_at
     FROM order_record
     WHERE revision > cloud_synced_version AND is_deleted = 0
       AND (sync_attempt_count > ? OR (last_sync_attempt_at IS NOT NULL AND ? - last_sync_attempt_at > ?))
     LIMIT 20`,
  ).all(STUCK_RECORD_THRESHOLD, Date.now(), STUCK_RECORD_AGE_MS) as any[];

  const stuckExps = db.query(
    `SELECT id, sync_attempt_count, last_sync_error, created_at, last_sync_attempt_at
     FROM expenditure
     WHERE sync_version > cloud_synced_version
       AND (sync_attempt_count > ? OR (last_sync_attempt_at IS NOT NULL AND ? - last_sync_attempt_at > ?))
     LIMIT 20`,
  ).all(STUCK_RECORD_THRESHOLD, Date.now(), STUCK_RECORD_AGE_MS) as any[];

  const stuckWalkins = db.query(
    `SELECT id, sync_attempt_count, last_sync_error, created_at, last_sync_attempt_at
     FROM transaction_record
     WHERE kind = 'walkin' AND sync_version > cloud_synced_version
       AND (sync_attempt_count > ? OR (last_sync_attempt_at IS NOT NULL AND ? - last_sync_attempt_at > ?))
     LIMIT 20`,
  ).all(STUCK_RECORD_THRESHOLD, Date.now(), STUCK_RECORD_AGE_MS) as any[];

  const stuckRecords = [
    ...stuckOrders.map((r) => ({ type: "order", id: r.id, attempts: r.sync_attempt_count, lastError: r.last_sync_error, pendingSince: r.last_sync_attempt_at || r.created_at })),
    ...stuckExps.map((r) => ({ type: "expenditure", id: r.id, attempts: r.sync_attempt_count, lastError: r.last_sync_error, pendingSince: r.last_sync_attempt_at || r.created_at })),
    ...stuckWalkins.map((r) => ({ type: "walkin", id: r.id, attempts: r.sync_attempt_count, lastError: r.last_sync_error, pendingSince: r.last_sync_attempt_at || r.created_at })),
  ];

  return {
    workerRunning: syncTimer !== null,
    lastSyncAt: lastSyncAt || null,
    lastSyncResult,
    pendingCount: pendingOrders + pendingExpenditures + pendingWalkins,
    pendingOrders,
    pendingExpenditures,
    pendingWalkins,
    deadLetterCount: stuckRecords.length,
    consecutiveFailures,
    nextSyncInMs: getBackoffDelay(),
    stuckRecords,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Manual sync trigger + dead-letter stubs (kept for backward compatibility)
// ═══════════════════════════════════════════════════════════════════════════════

export async function manualSyncPush(): Promise<{ ok: boolean; pushed: number; accepted: number; rejected: number; error?: string }> {
  if (syncRunning) {
    return { ok: true, pushed: 0, accepted: 0, rejected: 0, error: "Sync cycle already in progress — batch will be pushed shortly" };
  }
  return pushSyncBatch();
}

// The new sync system has no dead-letter queue — failed records stay pending
// (revision > cloud_synced_version) and retry next cycle. These stubs are kept
// for backward compatibility with server.ts endpoints that may still be called
// by older cashier UIs. They return empty/no-op results.

export function retryDeadLetters(): { reset: number } {
  // No dead letters in the new system — reset stuck records' attempt counters
  // so they're visible as "fresh" retries (the worker will pick them up naturally)
  const db = getDb();
  let reset = 0;
  const orderReset = db.query("UPDATE order_record SET sync_attempt_count = 0, last_sync_error = NULL WHERE revision > cloud_synced_version AND sync_attempt_count > 0").run();
  reset += orderReset.changes || 0;
  const expReset = db.query("UPDATE expenditure SET sync_attempt_count = 0, last_sync_error = NULL WHERE sync_version > cloud_synced_version AND sync_attempt_count > 0").run();
  reset += expReset.changes || 0;
  const walkinReset = db.query("UPDATE transaction_record SET sync_attempt_count = 0, last_sync_error = NULL WHERE kind = 'walkin' AND sync_version > cloud_synced_version AND sync_attempt_count > 0").run();
  reset += walkinReset.changes || 0;
  return { reset };
}

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
  // Return stuck records (high attempt count) as dead-letter records for the
  // recovery UI. Maps the new stuck-records to the old shape.
  const status = getSyncStatus();
  return status.stuckRecords.map((r, i) => ({
    id: i + 1,
    tableName: r.type === "order" ? "order" : r.type === "expenditure" ? "expenditure" : "walkin_transaction",
    recordId: r.id,
    operation: "insert",
    attempts: r.attempts,
    lastError: r.lastError,
    createdAt: r.pendingSince,
    payload: null,
  }));
}

export function discardDeadLetter(_queueId: number): { success: boolean } {
  // No dead letters to discard — the new system has no queue IDs.
  // Return success: false to indicate the operation is not applicable.
  return { success: false };
}

export function retrySingleDeadLetter(_queueId: number): { success: boolean } {
  // No dead letters to retry by queue ID — use retryDeadLetters() to reset all.
  return { success: false };
}

// Reconciliation stubs — the new system uses reconcileWithCloud() internally.
// These are kept for backward compatibility with server.ts endpoints.
export function reconcileOrders(): { enqueued: number; reset: number } {
  // No-op in the new system — reconciliation is handled by reconcileWithCloud()
  // which runs automatically on startup and every 5 minutes.
  return { enqueued: 0, reset: 0 };
}

export function reconcileTransactions(): { enqueued: number; reset: number; backfilled: number } {
  // No-op in the new system
  return { enqueued: 0, reset: 0, backfilled: 0 };
}
