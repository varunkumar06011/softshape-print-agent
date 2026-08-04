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
// USAGE (from the edge-server machine):
//   cd edge-server
//   bun run dev-scripts/backfill-stuck-transactions.ts
//
// Or with a dry-run first:
//   bun run dev-scripts/backfill-stuck-transactions.ts --dry-run
// ─────────────────────────────────────────────────────────────────────────────

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";

const DRY_RUN = process.argv.includes("--dry-run");

// Resolve DB path — mirrors the logic in recovery.ts DEFAULT_DB_PATH
const DB_PATH = process.env.EDGE_DB_PATH
  || join(homedir(), ".softshape", "edge.db");

console.log(`[Backfill] DB path: ${DB_PATH}`);
console.log(`[Backfill] Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE (will re-enqueue)"}`);
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

// ── 1. Find all settled orders ────────────────────────────────────────────────

interface SettledOrder {
  id: string;
  restaurant_id: string;
  paid_at: number;
  bill_number: string | null;
}

const settledOrders = db.query(
  `SELECT id, restaurant_id, paid_at, bill_number
   FROM order_record
   WHERE status = 'SETTLED'
   AND NOT EXISTS (SELECT 1 FROM edge_config WHERE key = 'txn_deleted:' || order_record.id)
   ORDER BY paid_at DESC`
).all() as SettledOrder[];

console.log(`[Backfill] Found ${settledOrders.length} settled orders`);

// ── 2. For each settled order, check if a settle:* record exists and if
//       a pending sync_queue entry exists for the transaction. ─────────────────

interface SettleRecord {
  orderId: string;
  localTxnId: string;
  grandTotal: number;
  settledAt: number;
}

let enqueuedCount = 0;
let skippedAlreadyQueued = 0;
let skippedNoSettleRecord = 0;
let skippedAlreadySynced = 0;

for (const order of settledOrders) {
  // Find the settle:* key for this order
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

  // Check if there's already a pending sync_queue entry for this transaction
  const pendingQueueRow = db.query(
    `SELECT id, synced, attempts FROM sync_queue WHERE table_name = 'transaction' AND record_id = ? ORDER BY id DESC LIMIT 1`
  ).get(localTxnId) as { id: number; synced: number; attempts: number } | null;

  if (pendingQueueRow) {
    if (pendingQueueRow.synced === 1) {
      // Already synced — check if it was dequeued as rejected/conflict
      const auditRow = db.query(
        `SELECT outcome FROM sync_audit WHERE queue_id = ? AND table_name = 'transaction' ORDER BY audited_at DESC LIMIT 1`
      ).get(pendingQueueRow.id) as { outcome: string } | null;

      if (auditRow && (auditRow.outcome === "rejected" || auditRow.outcome === "conflict" || auditRow.outcome === "duplicate")) {
        // Was dequeued as rejected/conflict — re-enqueue
        if (DRY_RUN) {
          console.log(`[DRY RUN] Would re-enqueue transaction ${localTxnId} for order ${order.id} (was ${auditRow.outcome})`);
        } else {
          db.query(
            `INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`
          ).run("transaction", localTxnId, "insert", Date.now());
          console.log(`[Backfill] Re-enqueued transaction ${localTxnId} for order ${order.id} (was ${auditRow.outcome})`);
        }
        enqueuedCount++;
      } else {
        skippedAlreadySynced++;
      }
    } else {
      // Still pending in queue — will be picked up by sync worker
      skippedAlreadyQueued++;
    }
  } else {
    // No sync_queue entry at all — re-enqueue
    if (DRY_RUN) {
      console.log(`[DRY RUN] Would enqueue transaction ${localTxnId} for order ${order.id} (₹${settleData.grandTotal || 0})`);
    } else {
      db.query(
        `INSERT INTO sync_queue (table_name, record_id, operation, created_at) VALUES (?, ?, ?, ?)`
      ).run("transaction", localTxnId, "insert", Date.now());
      console.log(`[Backfill] Enqueued transaction ${localTxnId} for order ${order.id} (₹${settleData.grandTotal || 0})`);
    }
    enqueuedCount++;
  }
}

// ── 3. Handle walk-in transactions ────────────────────────────────────────────

const walkinRows = db.query(
  `SELECT key, value FROM edge_config WHERE key LIKE 'walkin_txn:%'`
).all() as { key: string; value: string }[];

console.log(`[Backfill] Found ${walkinRows.length} walk-in transaction records`);

let walkinEnqueued = 0;

for (const row of walkinRows) {
  const localId = row.key.replace("walkin_txn:", "");

  // Check if pending sync_queue entry exists
  const pendingQueueRow = db.query(
    `SELECT id, synced FROM sync_queue WHERE table_name = 'walkin_transaction' AND record_id = ? ORDER BY id DESC LIMIT 1`
  ).get(localId) as { id: number; synced: number } | null;

  if (pendingQueueRow) {
    if (pendingQueueRow.synced === 0) {
      skippedAlreadyQueued++;
    } else {
      skippedAlreadySynced++;
    }
    continue;
  }

  // No sync_queue entry — re-enqueue
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

// ── 4. Summary ────────────────────────────────────────────────────────────────

console.log("");
console.log("─── Backfill Summary ───");
console.log(`  Settled orders scanned:     ${settledOrders.length}`);
console.log(`  Transactions re-enqueued:   ${enqueuedCount}`);
console.log(`  Walk-in txns re-enqueued:   ${walkinEnqueued}`);
console.log(`  Skipped (already queued):   ${skippedAlreadyQueued}`);
console.log(`  Skipped (already synced):   ${skippedAlreadySynced}`);
console.log(`  Skipped (no settle record): ${skippedNoSettleRecord}`);
console.log("");

if (DRY_RUN) {
  console.log("[Backfill] Dry run complete — no changes made.");
  console.log("[Backfill] Run without --dry-run to apply changes.");
} else {
  console.log("[Backfill] Done. The sync worker will push re-enqueued records on the next cycle (within 10s).");
  console.log("[Backfill] Monitor with: grep '[Sync]' edge-server.log | tail -f");
}

db.close();
