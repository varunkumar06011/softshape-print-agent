// ─────────────────────────────────────────────────────────────────────────────
// xReportTotals.ts — sales totals for the X report (pure SQLite, unit-testable)
// ─────────────────────────────────────────────────────────────────────────────
import type { Database } from "bun:sqlite";

export interface XReportSales {
  totalSales: number;
  cashAmount: number;
  cardAmount: number;
  upiAmount: number;
  otherAmount: number;
  tipsAmount: number;
}

/**
 * Sum settled bills + walk-in sales between startTs and endTs (epoch ms).
 *
 * - Settled orders: payment data from edge_config settle:*, else the durable
 *   transaction_record, else (amount absent) the order's total counted as "other".
 *   A recorded grandTotal of 0 (complimentary bill) is honoured as 0.
 * - Orders deleted from Past Transactions (txn_deleted:<id>) are excluded.
 * - Walk-in transactions are included unless their order was already counted.
 */
export function computeXReportSales(db: Database, restaurantId: string, startTs: number, endTs: number): XReportSales {
  const orders = db.query(
    "SELECT id, total_amount FROM order_record WHERE restaurant_id = ? AND status = 'SETTLED' AND paid_at >= ? AND paid_at <= ?"
      + " AND NOT EXISTS (SELECT 1 FROM edge_config WHERE key = 'txn_deleted:' || order_record.id)"
  ).all(restaurantId, startTs, endTs) as any[];

  let totalSales = 0, cashAmount = 0, cardAmount = 0, upiAmount = 0, otherAmount = 0, tipsAmount = 0;

  // Attribute one settlement to payment buckets. Single-method bills put the whole
  // grand total on that method; MIXED bills use the recorded split and any
  // remainder goes to "other" so the buckets always add up to totalSales.
  const addPayment = (pd: any, grand: number) => {
    totalSales += grand;
    tipsAmount += Number(pd.tipAmount || 0);
    const method = String(pd.paymentMethod || pd.method || "CASH").toUpperCase();
    if (method === "CASH") cashAmount += grand;
    else if (method === "CARD") cardAmount += grand;
    else if (method === "UPI") upiAmount += grand;
    else if (method === "MIXED" || method === "SPLIT") {
      const c = Number(pd.cashAmount || 0), k = Number(pd.cardAmount || 0), u = Number(pd.upiAmount || 0), o = Number(pd.otherAmount || 0);
      cashAmount += c; cardAmount += k; upiAmount += u;
      otherAmount += o + Math.max(0, grand - c - k - u - o);
    } else otherAmount += grand;
  };

  const countedOrderIds = new Set<string>();
  for (const order of orders) {
    countedOrderIds.add(order.id);
    let raw: string | undefined = (db.query("SELECT value FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = ?").get(order.id) as any)?.value;
    if (!raw) {
      raw = (db.query("SELECT payload FROM transaction_record WHERE order_id = ? AND kind = 'settle' ORDER BY created_at DESC LIMIT 1").get(order.id) as any)?.payload;
    }
    let pd: any = null;
    if (raw) { try { pd = JSON.parse(raw); } catch {} }
    const recordedGrand = pd && pd.grandTotal != null && pd.grandTotal !== "" ? Number(pd.grandTotal) : NaN;
    if (Number.isFinite(recordedGrand)) {
      addPayment(pd, recordedGrand);
    } else {
      const fallback = Number(order.total_amount || 0);
      if (fallback > 0) addPayment({ paymentMethod: "OTHER", tipAmount: pd?.tipAmount }, fallback);
    }
  }

  const walkinRows = db.query("SELECT value FROM edge_config WHERE key LIKE 'walkin_txn:%'").all() as any[];
  for (const row of walkinRows) {
    try {
      const txn = JSON.parse(row.value);
      if (txn.restaurantId !== restaurantId) continue;
      if (txn.orderId && countedOrderIds.has(txn.orderId)) continue;
      const paidMs = txn.paidAt ? new Date(txn.paidAt).getTime() : Number(txn.createdAt || 0);
      if (!(paidMs >= startTs && paidMs <= endTs)) continue;
      const grand = Number(txn.grandTotal || txn.amount || 0);
      if (grand > 0) addPayment({ ...txn, paymentMethod: txn.method }, grand);
    } catch {}
  }

  return { totalSales, cashAmount, cardAmount, upiAmount, otherAmount, tipsAmount };
}
