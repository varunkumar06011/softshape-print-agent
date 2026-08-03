// ─────────────────────────────────────────────────────────────────────────────
// backfill-stuck-transactions.ts
// ─────────────────────────────────────────────────────────────────────────────
// One-time script that re-enqueues sync_queue entries for settled transactions
// that are missing from the queue (dequeued as rejected/conflict, dead-lettered,
// or never enqueued due to silent failures).
//
// Scans order_record for status='SETTLED' rows, checks if a settle:* key exists
// in edge_config for that order, and if no pending sync_queue entry exists for
// the transaction, re-enqueues it so the sync worker pushes it to the cloud.
//
// Also handles walk-in transactions (walkin_txn:* keys in edge_config).
//
// Features:
//   --dry-run          Preview without making changes
//   --days=N           Only scan orders settled within the last N days (default: all)
//   --report=<path>    Write a JSON recovery report to the given path
//   --no-cloud-check   Skip cloud verification (re-enqueue without checking cloud)
//
// Cloud verification: before re-enqueuing, the script calls
// POST /api/edge/verify-transactions to check which orders already have
// transactions in the cloud. Orders that the cloud already has are skipped
// (no unnecessary retries). This requires a valid session token in edge_config.
//
// USAGE (from the edge-server machine):
//   cd edge-server
//   bun run dev-scripts/backfill-stuck-transactions.ts --dry-run --days=3
//   bun run dev-scripts/backfill-stuck-transactions.ts --days=3 --report=./recovery-report.json
// ─────────────────────────────────────────────────────────────────────────────

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeFileSync } from "node:fs";

// ── Parse CLI flags ──────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const NO_CLOUD_CHECK = process.argv.includes("--no-cloud-check");

let DAYS: number | null = null;
const daysArg = process.argv.find((a) => a.startsWith("--days="));
if (daysArg) {
  const n = parseInt(daysArg.split("=")[1], 10);
  if (!isNaN(n) && n > 0) DAYS = n;
}

let REPORT_PATH: string | null = null;
const reportArg = process.argv.find((a) => a.startsWith("--report="));
if (reportArg) {
  REPORT_PATH = reportArg.split("=")[1];
}

// Resolve DB path — mirrors the logic in recovery.ts DEFAULT_DB_PATH
const DB_PATH = process.env.EDGE_DB_PATH
  || join(homedir(), ".softshape", "edge.db");

console.log(`[Backfill] DB path: ${DB_PATH}`);
console.log(`[Backfill] Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE (will re-enqueue)"}`);
console.log(`[Backfill] Time window: ${DAYS ? `last ${DAYS} days` : "all time"}`);
console.log(`[Backfill] Cloud verification: ${NO_CLOUD_CHECK ? "DISABLED" : "enabled"}`);
if (REPORT_PATH) console.log(`[Backfill] Report file: ${REPORT_PATH}`);
console.log("");

let db: Database;
try {
  db = new Database(DB_PATH, { readonly: DRY_RUN });
} catch (err: any) {
  console.error(`[Backfill] Failed to open DB at ${DB_PATH}: ${err.message}`);
  console.error("[Backfill] If the edge server is running, it may have a lock on the DB.");
  console.error("[Backfill] Stop the edge server first, then re-run this script.");
  process.exit(1);
}

// ── Load session for cloud verification ──────────────────────────────────────

interface SessionInfo {
  sessionToken: string;
  restaurantId: string;
  backendUrl: string;
}

function loadSessionFromDb(): SessionInfo | null {
  const row = db.query("SELECT key, value FROM edge_config WHERE key IN ('session_token', 'restaurant_id', 'backend_url')").all() as { key: string; value: string }[];
  const map = new Map(row.map((r) => [r.key, r.value]));
  const token = map.get("session_token");
  const restaurantId = map.get("restaurant_id");
  const backendUrl = map.get("backend_url");
  if (!token || !restaurantId || !backendUrl) return null;
  return { sessionToken: token, restaurantId, backendUrl };
}

// ── Cloud verification: check which orders already have cloud transactions ───

async function verifyCloudTransactions(orderIds: string[], session: SessionInfo): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();

  const confirmed = new Set<string>();
  // Batch in chunks of 500 to stay within reasonable payload sizes
  const BATCH_SIZE = 500;
  for (let i = 0; i < orderIds.length; i += BATCH_SIZE) {
    const chunk = orderIds.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(`${session.backendUrl}/api/edge/verify-transactions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.sessionToken}`,
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

// ── 1. Find all settled orders (optionally time-windowed) ────────────────────

interface SettledOrder {
  id: string;
  restaurant_id: string;
  paid_at: number;
  bill_number: string | null;
}

const timeFilter = DAYS ? `AND paid_at > ${Date.now() - DAYS * 24 * 60 * 60 * 1000}` : "";
const settledOrders = db.query(
  `SELECT id, restaurant_id, paid_at, bill_number
   FROM order_record
   WHERE status = 'SETTLED'
   ${timeFilter}
   AND NOT EXISTS (SELECT 1 FROM edge_config WHERE key = 'txn_deleted:' || order_record.id)
   ORDER BY paid_at DESC`
).all() as SettledOrder[];

console.log(`[Backfill] Found ${settledOrders.length} settled orders${DAYS ? ` (last ${DAYS} days)` : ""}`);

// ── 2. Resolve settle records and build the list of transactions to check ────

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

const checks: PendingCheck[] = [];
let skippedNoSettleRecord = 0;

for (const order of settledOrders) {
  const settleRow = db.query(
    `SELECT value FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = ?`
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
    `SELECT id, synced, attempts FROM sync_queue WHERE table_name = 'transaction' AND record_id = ? ORDER BY id DESC LIMIT 1`
  ).get(localTxnId) as { id: number; synced: number; attempts: number } | null;

  let auditOutcome: string | null = null;
  if (pendingQueueRow) {
    const auditRow = db.query(
      `SELECT outcome FROM sync_audit WHERE queue_id = ? AND table_name = 'transaction' ORDER BY audited_at DESC LIMIT 1`
    ).get(pendingQueueRow.id) as { outcome: string } | null;
    auditOutcome = auditRow?.outcome || null;
  }

  checks.push({ order, settleData, pendingQueueRow, auditOutcome });
}

// ── 3. Cloud verification: which orders already have cloud transactions? ─────

let cloudConfirmed = new Set<string>();
let cloudCheckEnabled = false;
if (!NO_CLOUD_CHECK) {
  const session = loadSessionFromDb();
  if (!session) {
    console.warn("[Backfill] No valid session in edge_config — cloud verification disabled.");
    console.warn("[Backfill] Use --no-cloud-check to suppress this warning, or re-link the device.");
  } else {
    console.log("[Backfill] Verifying transactions against cloud...");
    // Only check orders that are candidates for re-enqueue (missing from queue
    // or dequeued as rejected/conflict). Orders already pending in the queue
    // don't need cloud verification — the sync worker will push them.
    const orderIdsToCheck = checks
      .filter((c) => !c.pendingQueueRow || c.pendingQueueRow.synced === 1)
      .map((c) => c.order.id);
    cloudConfirmed = await verifyCloudTransactions(orderIdsToCheck, session);
    cloudCheckEnabled = true;
    console.log(`[Backfill] Cloud has ${cloudConfirmed.size} of ${orderIdsToCheck.length} candidate transactions already confirmed.`);
  }
}

// ── 4. Re-enqueue missing/rejected transactions ──────────────────────────────

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
        // Was dequeued as rejected/conflict — check cloud first
        if (cloudCheckEnabled && cloudConfirmed.has(order.id)) {
          skippedCloudConfirmed++;
          continue;
        }
        if (DRY_RUN) {
          console.log(`[DRY RUN] Would re-enqueue transaction ${settleData.localTxnId} for order ${order.id} (was ${auditOutcome})`);
        } else {
          db.query(
            `INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`
          ).run("transaction", settleData.localTxnId, "insert", Date.now());
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
    db.query(
      `INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`
    ).run("transaction", settleData.localTxnId, "insert", Date.now());
    console.log(`[Backfill] Enqueued transaction ${settleData.localTxnId} for order ${order.id} (₹${settleData.grandTotal || 0})`);
  }
  enqueuedCount++;
  enqueuedDetails.push({ orderId: order.id, txnId: settleData.localTxnId, grandTotal: settleData.grandTotal || 0, reason: "missing from queue" });
}

// ── 5. Handle walk-in transactions ────────────────────────────────────────────

const walkinRows = db.query(
  `SELECT key, value FROM edge_config WHERE key LIKE 'walkin_txn:%'`
).all() as { key: string; value: string }[];

console.log(`[Backfill] Found ${walkinRows.length} walk-in transaction records`);

let walkinEnqueued = 0;
let walkinSkippedQueued = 0;
let walkinSkippedSynced = 0;

for (const row of walkinRows) {
  const localId = row.key.replace("walkin_txn:", "");

  const pendingQueueRow = db.query(
    `SELECT id, synced FROM sync_queue WHERE table_name = 'walkin_transaction' AND record_id = ? ORDER BY id DESC LIMIT 1`
  ).get(localId) as { id: number; synced: number } | null;

  if (pendingQueueRow) {
    if (pendingQueueRow.synced === 0) {
      walkinSkippedQueued++;
    } else {
      walkinSkippedSynced++;
    }
    continue;
  }

  // No sync_queue entry — re-enqueue
  // (Walk-in transactions don't have order IDs, so cloud verification by
  // orderId doesn't apply. The sync endpoint's duplicate detection handles
  // this — if the cloud already has it, it'll return "duplicate" and the
  // edge will dequeue it without re-enqueuing.)
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would enqueue walk-in transaction ${localId}`);
  } else {
    db.query(
      `INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`
    ).run("walkin_transaction", localId, "insert", Date.now());
    console.log(`[Backfill] Enqueued walk-in transaction ${localId}`);
  }
  walkinEnqueued++;
}

// ── 6. Recovery report ────────────────────────────────────────────────────────

interface RecoveryReport {
  generatedAt: number;
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

const report: RecoveryReport = {
  generatedAt: Date.now(),
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
  // Verification passes if no permanent failures and all scanned orders are
  // accounted for (enqueued, skipped with reason, or confirmed in cloud).
  verificationPassed: permanentFailures.length === 0,
};

// ── 7. Summary output ─────────────────────────────────────────────────────────

console.log("");
console.log("─── Backfill Summary ───");
console.log(`  Settled orders scanned:     ${settledOrders.length}`);
console.log(`  Transactions re-enqueued:   ${enqueuedCount}`);
console.log(`  Walk-in txns re-enqueued:   ${walkinEnqueued}`);
console.log(`  Skipped (already queued):   ${skippedAlreadyQueued}`);
console.log(`  Skipped (already synced):   ${skippedAlreadySynced}`);
console.log(`  Skipped (no settle record): ${skippedNoSettleRecord}`);
console.log(`  Skipped (cloud confirmed):  ${skippedCloudConfirmed}`);
console.log(`  Skipped (duplicate outcome):${skippedDuplicateOutcome}`);
console.log(`  Skipped (permanent failure):${skippedPermanentOutcome}`);
if (permanentFailures.length > 0) {
  console.log("");
  console.log(`  ⚠ Permanent failures (require manual investigation):`);
  for (const pf of permanentFailures) {
    console.log(`    Order ${pf.orderId} (bill: ${pf.billNumber || "N/A"}) — txn ${pf.txnId} — outcome: ${pf.outcome}`);
  }
}
console.log("");
console.log(`  Verification: ${report.verificationPassed ? "PASSED" : "ATTENTION NEEDED (permanent failures exist)"}`);

if (REPORT_PATH) {
  try {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`[Backfill] Recovery report written to ${REPORT_PATH}`);
  } catch (err: any) {
    console.error(`[Backfill] Failed to write report to ${REPORT_PATH}: ${err.message}`);
  }
}

console.log("");
if (DRY_RUN) {
  console.log("[Backfill] Dry run complete — no changes made.");
  console.log("[Backfill] Run without --dry-run to apply changes.");
} else {
  console.log("[Backfill] Done. The sync worker will push re-enqueued records on the next cycle (within 10s).");
  console.log("[Backfill] Monitor with: grep '[Sync]' edge-server.log | tail -f");
}

db.close();
