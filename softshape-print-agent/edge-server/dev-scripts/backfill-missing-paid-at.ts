// ─────────────────────────────────────────────────────────────────────────────
// backfill-missing-paid-at.ts
// ─────────────────────────────────────────────────────────────────────────────
// One-time fix: SETTLED orders that arrived via sync without paid_at never
// appeared in the X report or any other date-based report.
//
// For every order_record with status='SETTLED' and paid_at NULL/0, paid_at is set to
// the first available of:
//   1. settledAt from the edge_config settle:* record for the order
//   2. settledAt from the transaction_record (kind='settle') payload
//   3. the order's updated_at
// Nothing else is touched (no revision bump, no sync queue changes).
// Idempotent: re-running only affects orders still missing paid_at.
//
// USAGE (on the edge-server machine, with the edge server STOPPED):
//   cd edge-server
//   bun run dev-scripts/backfill-missing-paid-at.ts --dry-run   # preview
//   bun run dev-scripts/backfill-missing-paid-at.ts             # apply (copies DB to .bak first)
//   EDGE_DB_PATH=/path/to/edge.db bun run dev-scripts/backfill-missing-paid-at.ts
// ─────────────────────────────────────────────────────────────────────────────

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { copyFileSync, existsSync } from "node:fs";

const DRY_RUN = process.argv.includes("--dry-run");
const DB_PATH = process.env.EDGE_DB_PATH || join(homedir(), ".softshape", "edge.db");

console.log(`[PaidAtBackfill] DB path: ${DB_PATH}`);
console.log(`[PaidAtBackfill] Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE"}`);

if (!existsSync(DB_PATH)) {
  console.error(`[PaidAtBackfill] DB not found at ${DB_PATH}`);
  process.exit(1);
}

if (!DRY_RUN) {
  const backup = `${DB_PATH}.pre-paid-at-backfill.${Date.now()}.bak`;
  copyFileSync(DB_PATH, backup);
  console.log(`[PaidAtBackfill] Backup written: ${backup}`);
}

const db = DRY_RUN ? new Database(DB_PATH, { readonly: true }) : new Database(DB_PATH);

const settledAtOf = (raw: string | undefined | null): number | null => {
  if (!raw) return null;
  try {
    const v = Number(JSON.parse(raw)?.settledAt);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
};

const orders = db.query(
  "SELECT id, updated_at FROM order_record WHERE status = 'SETTLED' AND (paid_at IS NULL OR paid_at = 0) AND is_deleted = 0"
).all() as Array<{ id: string; updated_at: number | null }>;

console.log(`[PaidAtBackfill] SETTLED orders missing paid_at: ${orders.length}`);

const update = DRY_RUN ? null : db.query("UPDATE order_record SET paid_at = ? WHERE id = ? AND (paid_at IS NULL OR paid_at = 0)");
const counts = { settleRecord: 0, transactionRecord: 0, updatedAt: 0, skipped: 0 };
const plan: Array<{ id: string; paidAt: number }> = [];

for (const o of orders) {
  const settleRow = db.query("SELECT value FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = ?").get(o.id) as any;
  let ts = settledAtOf(settleRow?.value);
  if (ts) counts.settleRecord++;
  if (!ts) {
    const txn = db.query("SELECT payload FROM transaction_record WHERE order_id = ? AND kind = 'settle' ORDER BY created_at DESC LIMIT 1").get(o.id) as any;
    ts = settledAtOf(txn?.payload);
    if (ts) counts.transactionRecord++;
  }
  if (!ts && Number(o.updated_at) > 0) { ts = Number(o.updated_at); counts.updatedAt++; }
  if (!ts) { counts.skipped++; continue; }
  plan.push({ id: o.id, paidAt: ts });
}

if (!DRY_RUN && plan.length > 0) {
  db.transaction(() => { for (const p of plan) update!.run(p.paidAt, p.id); })();
}

console.log(`[PaidAtBackfill] ${DRY_RUN ? "Would update" : "Updated"} ${plan.length} order(s): ` +
  `${counts.settleRecord} from settle record, ${counts.transactionRecord} from transaction_record, ` +
  `${counts.updatedAt} from updated_at; ${counts.skipped} skipped (no timestamp available)`);
for (const p of plan.slice(0, 10)) console.log(`  ${p.id} -> ${new Date(p.paidAt).toISOString()}`);
if (plan.length > 10) console.log(`  ... and ${plan.length - 10} more`);
db.close();
