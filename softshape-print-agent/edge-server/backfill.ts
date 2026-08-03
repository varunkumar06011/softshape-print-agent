// ─────────────────────────────────────────────────────────────────────────────
// backfill.ts — One-time recovery: re-enqueue stuck/missing transactions
// ─────────────────────────────────────────────────────────────────────────────
// Scans order_record for status='SETTLED' rows, checks if a settle:* key exists
// in edge_config for that order, and if no pending sync_queue entry exists for
// the transaction, re-enqueues it so the sync worker pushes it to the cloud.
//
// Also handles walk-in transactions (walkin_txn:* keys in edge_config).
//
// Cloud verification: before re-enqueuing, calls POST /api/edge/verify-transactions
// to check which orders already have transactions in the cloud. Orders that the
// cloud already has are skipped (no unnecessary retries).
//
// Exposed as POST /api/edge/sync/backfill — runs inside the edge server process,
// so there are no DB lock concerns (same connection as the sync worker).
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, enqueueSync } from "./db.ts";
import { loadSession } from "./auth.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BackfillOptions {
  dryRun?: boolean;
  days?: number | null;
  noCloudCheck?: boolean;
}

export interface BackfillResult {
  mode: "dry-run" | "live";
  timeWindowDays: number | null;
  cloudVerificationEnabled: boolean;
  summary: {
    settledOrdersScanned: number;
    transactionsEnqueued: number;
    walkinTransactionsEnqueued: number;
    skippedAlreadyQueued: number;
    skippedAlreadySynced: number;
    skippedNoSettleRecord: number;
    skippedCloudConfirmed: number;
    skippedDuplicateOutcome: number;
    skippedPermanentOutcome: number;
    walkinSkippedQueued: number;
    walkinSkippedSynced: number;
  };
  enqueuedTransactions: Array<{ orderId: string; txnId: string; grandTotal: number; reason: string }>;
  permanentFailures: Array<{ orderId: string; txnId: string; outcome: string; billNumber: string | null }>;
  verificationPassed: boolean;
}

interface SettledOrder {
  id: string;
  restaurant_id: string;
  paid_at: number;
  bill_number: string | null;
}

interface SettleRecord {
  orderId: string;
  localTxnId: string;
  grandTotal: number;
  settledAt: number;
}

interface PendingCheck {
  order: SettledOrder;
  settleData: SettleRecord;
  pendingQueueRow: { id: number; synced: number; attempts: number } | null;
  auditOutcome: string | null;
}

// ── Cloud verification ───────────────────────────────────────────────────────

async function verifyCloudTransactions(
  orderIds: string[],
  backendUrl: string,
  sessionToken: string,
): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();

  const confirmed = new Set<string>();
  const BATCH_SIZE = 500;
  for (let i = 0; i < orderIds.length; i += BATCH_SIZE) {
    const chunk = orderIds.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(`${backendUrl}/api/edge/verify-transactions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ orderIds: chunk }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        console.warn(`[Backfill] Cloud verify returned HTTP ${res.status} for chunk ${i}-${i + chunk.length} — treating as unverified`);
        continue;
      }
      const data = await res.json() as { confirmed: string[] };
      for (const id of data.confirmed) confirmed.add(id);
    } catch (err: any) {
      console.warn(`[Backfill] Cloud verify failed for chunk ${i}-${i + chunk.length}: ${err.message} — treating as unverified`);
    }
  }
  return confirmed;
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function runBackfill(options: BackfillOptions = {}): Promise<BackfillResult> {
  const DRY_RUN = options.dryRun ?? false;
  const NO_CLOUD_CHECK = options.noCloudCheck ?? false;
  const DAYS = options.days ?? null;

  const db = getDb();

  console.log(`[Backfill] Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE (will re-enqueue)"}`);
  console.log(`[Backfill] Time window: ${DAYS ? `last ${DAYS} days` : "all time"}`);
  console.log(`[Backfill] Cloud verification: ${NO_CLOUD_CHECK ? "DISABLED" : "enabled"}`);

  // ── 1. Find all settled orders (optionally time-windowed) ──────────────────

  const timeFilter = DAYS ? `AND paid_at > ${Date.now() - DAYS * 24 * 60 * 60 * 1000}` : "";
  const settledOrders = db.query(
    `SELECT id, restaurant_id, paid_at, bill_number
     FROM order_record
     WHERE status = 'SETTLED'
     ${timeFilter}
     AND NOT EXISTS (SELECT 1 FROM edge_config WHERE key = 'txn_deleted:' || order_record.id)
     ORDER BY paid_at DESC`,
  ).all() as SettledOrder[];

  console.log(`[Backfill] Found ${settledOrders.length} settled orders${DAYS ? ` (last ${DAYS} days)` : ""}`);

  // ── 2. Resolve settle records and build the list of transactions to check ──

  const checks: PendingCheck[] = [];
  let skippedNoSettleRecord = 0;

  for (const order of settledOrders) {
    const settleRow = db.query(
      `SELECT value FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = ?`,
    ).get(order.id) as { value: string } | null;

    if (!settleRow) {
      skippedNoSettleRecord++;
      continue;
    }

    let settleData: SettleRecord;
    try {
      settleData = JSON.parse(settleRow.value);
    } catch {
      console.warn(`[Backfill] Malformed settle record for order ${order.id} — skipping`);
      skippedNoSettleRecord++;
      continue;
    }

    const localTxnId = settleData.localTxnId;
    if (!localTxnId) {
      console.warn(`[Backfill] No localTxnId in settle record for order ${order.id} — skipping`);
      skippedNoSettleRecord++;
      continue;
    }

    const pendingQueueRow = db.query(
      `SELECT id, synced, attempts FROM sync_queue WHERE table_name = 'transaction' AND record_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(localTxnId) as { id: number; synced: number; attempts: number } | null;

    let auditOutcome: string | null = null;
    if (pendingQueueRow) {
      const auditRow = db.query(
        `SELECT outcome FROM sync_audit WHERE queue_id = ? AND table_name = 'transaction' ORDER BY audited_at DESC LIMIT 1`,
      ).get(pendingQueueRow.id) as { outcome: string } | null;
      auditOutcome = auditRow?.outcome || null;
    }

    checks.push({ order, settleData, pendingQueueRow, auditOutcome });
  }

  // ── 3. Cloud verification: which orders already have cloud transactions? ───

  let cloudConfirmed = new Set<string>();
  let cloudCheckEnabled = false;

  if (!NO_CLOUD_CHECK) {
    const session = loadSession();
    if (!session) {
      console.warn("[Backfill] No valid session in edge_config — cloud verification disabled.");
    } else {
      console.log("[Backfill] Verifying transactions against cloud...");
      const orderIdsToCheck = checks
        .filter((c) => !c.pendingQueueRow || c.pendingQueueRow.synced === 1)
        .map((c) => c.order.id);
      cloudConfirmed = await verifyCloudTransactions(orderIdsToCheck, session.backendUrl, session.sessionToken);
      cloudCheckEnabled = true;
      console.log(`[Backfill] Cloud has ${cloudConfirmed.size} of ${orderIdsToCheck.length} candidate transactions already confirmed.`);
    }
  }

  // ── 4. Re-enqueue missing/rejected transactions ────────────────────────────

  let enqueuedCount = 0;
  let skippedAlreadyQueued = 0;
  let skippedAlreadySynced = 0;
  let skippedCloudConfirmed = 0;
  let skippedDuplicateOutcome = 0;
  let skippedPermanentOutcome = 0;
  const permanentFailures: Array<{ orderId: string; txnId: string; outcome: string; billNumber: string | null }> = [];
  const enqueuedDetails: Array<{ orderId: string; txnId: string; grandTotal: number; reason: string }> = [];

  for (const check of checks) {
    const { order, settleData, pendingQueueRow, auditOutcome } = check;

    if (pendingQueueRow) {
      if (pendingQueueRow.synced === 1) {
        // Dequeued — check audit outcome to decide whether to re-enqueue
        if (auditOutcome === "duplicate") {
          skippedDuplicateOutcome++;
          continue;
        }
        if (auditOutcome === "permanent") {
          skippedPermanentOutcome++;
          permanentFailures.push({
            orderId: order.id,
            txnId: settleData.localTxnId,
            outcome: auditOutcome,
            billNumber: order.bill_number,
          });
          continue;
        }
        if (auditOutcome === "rejected" || auditOutcome === "conflict") {
          if (cloudCheckEnabled && cloudConfirmed.has(order.id)) {
            skippedCloudConfirmed++;
            continue;
          }
          if (DRY_RUN) {
            console.log(`[DRY RUN] Would re-enqueue transaction ${settleData.localTxnId} for order ${order.id} (was ${auditOutcome})`);
          } else {
            enqueueSync("transaction", settleData.localTxnId, "insert");
            console.log(`[Backfill] Re-enqueued transaction ${settleData.localTxnId} for order ${order.id} (was ${auditOutcome})`);
          }
          enqueuedCount++;
          enqueuedDetails.push({ orderId: order.id, txnId: settleData.localTxnId, grandTotal: settleData.grandTotal || 0, reason: `was ${auditOutcome}` });
          continue;
        }
        // Other outcomes (e.g., "applied" but queue row marked synced) — already synced
        skippedAlreadySynced++;
        continue;
      } else {
        // Still pending in queue — will be picked up by sync worker
        skippedAlreadyQueued++;
        continue;
      }
    }

    // No sync_queue entry at all — check cloud first, then re-enqueue
    if (cloudCheckEnabled && cloudConfirmed.has(order.id)) {
      skippedCloudConfirmed++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`[DRY RUN] Would enqueue transaction ${settleData.localTxnId} for order ${order.id} (₹${settleData.grandTotal || 0})`);
    } else {
      enqueueSync("transaction", settleData.localTxnId, "insert");
      console.log(`[Backfill] Enqueued transaction ${settleData.localTxnId} for order ${order.id} (₹${settleData.grandTotal || 0})`);
    }
    enqueuedCount++;
    enqueuedDetails.push({ orderId: order.id, txnId: settleData.localTxnId, grandTotal: settleData.grandTotal || 0, reason: "missing from queue" });
  }

  // ── 5. Handle walk-in transactions ──────────────────────────────────────────

  const walkinRows = db.query(
    `SELECT key, value FROM edge_config WHERE key LIKE 'walkin_txn:%'`,
  ).all() as { key: string; value: string }[];

  console.log(`[Backfill] Found ${walkinRows.length} walk-in transaction records`);

  let walkinEnqueued = 0;
  let walkinSkippedQueued = 0;
  let walkinSkippedSynced = 0;

  for (const row of walkinRows) {
    const localId = row.key.replace("walkin_txn:", "");

    const pendingQueueRow = db.query(
      `SELECT id, synced FROM sync_queue WHERE table_name = 'walkin_transaction' AND record_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(localId) as { id: number; synced: number } | null;

    if (pendingQueueRow) {
      if (pendingQueueRow.synced === 0) {
        walkinSkippedQueued++;
      } else {
        walkinSkippedSynced++;
      }
      continue;
    }

    if (DRY_RUN) {
      console.log(`[DRY RUN] Would enqueue walk-in transaction ${localId}`);
    } else {
      enqueueSync("walkin_transaction", localId, "insert");
      console.log(`[Backfill] Enqueued walk-in transaction ${localId}`);
    }
    walkinEnqueued++;
  }

  // ── 6. Build result ─────────────────────────────────────────────────────────

  const result: BackfillResult = {
    mode: DRY_RUN ? "dry-run" : "live",
    timeWindowDays: DAYS,
    cloudVerificationEnabled: cloudCheckEnabled,
    summary: {
      settledOrdersScanned: settledOrders.length,
      transactionsEnqueued: enqueuedCount,
      walkinTransactionsEnqueued: walkinEnqueued,
      skippedAlreadyQueued,
      skippedAlreadySynced,
      skippedNoSettleRecord,
      skippedCloudConfirmed,
      skippedDuplicateOutcome,
      skippedPermanentOutcome,
      walkinSkippedQueued,
      walkinSkippedSynced,
    },
    enqueuedTransactions: enqueuedDetails,
    permanentFailures,
    verificationPassed: permanentFailures.length === 0,
  };

  console.log(`[Backfill] Done. Enqueued: ${enqueuedCount} transactions, ${walkinEnqueued} walk-in. Verification: ${result.verificationPassed ? "PASSED" : "FAILED"}`);

  return result;
}
