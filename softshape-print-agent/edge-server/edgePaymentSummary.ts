// Edge PaymentSummary — mirrors the cloud paymentSummaryService so edge and
// cloud produce identical accounting results from the same source rows.
//
// This module is intentionally pure (no DB imports) so it can be tested in
// isolation and reused by edge parity tests.

import { createHash } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EdgeTransaction {
  id: string;
  method: string;
  grandTotal: any;
  amount?: any;
  tipAmount?: any;
  cashAmount?: any;
  cardAmount?: any;
  upiAmount?: any;
  otherAmount?: any;
  cashTipAmount?: any;
  cardTipAmount?: any;
  upiTipAmount?: any;
  otherTipAmount?: any;
  paidAt?: any;
}

export interface EdgeExpenditure {
  id: string;
  amount: any;
  status: string;
  entryType: string;
  paymentMethod?: string | null;
}

export interface EdgePaymentSummary {
  totalSales: number;
  totalTips: number;
  unallocatedLegacyTips: number;
  collections: {
    cash: number;
    card: number;
    upi: number;
    other: number;
  };
  billByMethod: {
    cash: number;
    card: number;
    upi: number;
    other: number;
  };
  tipByMethod: {
    cash: number;
    card: number;
    upi: number;
    other: number;
  };
  cashExpenditures: number;
  totalExpenditures: number;
  tipsPaid: number;
  netCashMovement: number;
  expectedCash: number;
  sourceFingerprint: string;
  invariants: {
    billAllocationValid: boolean;
    tipAllocationValid: boolean;
    collectionConservationValid: boolean;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function num(v: any): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ── Fingerprint ──────────────────────────────────────────────────────────────

export function buildEdgeSourceFingerprint(
  transactions: EdgeTransaction[],
  expenditures: EdgeExpenditure[],
): string {
  const sortedTx = [...transactions].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sortedExp = [...expenditures].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const txHash = createHash("sha256");
  for (const t of sortedTx) {
    txHash.update(
      `${t.id}|${num(t.grandTotal)}|${num(t.tipAmount)}|${t.method}|${t.paidAt ?? ""}|` +
      `${num(t.cashAmount)}|${num(t.cardAmount)}|${num(t.upiAmount)}|${num(t.otherAmount)}|` +
      `${num(t.cashTipAmount)}|${num(t.cardTipAmount)}|${num(t.upiTipAmount)}|${num(t.otherTipAmount)}\n`,
    );
  }
  const expHash = createHash("sha256");
  for (const e of sortedExp) {
    expHash.update(`${e.id}|${num(e.amount)}|${e.status}|${e.entryType}|${e.paymentMethod ?? ""}\n`);
  }
  return createHash("sha256")
    .update(txHash.digest("hex") + "|" + expHash.digest("hex"))
    .digest("hex");
}

// ── Per-transaction allocation recovery ──────────────────────────────────────

interface TransactionAllocations {
  grandTotal: number;
  tipAmount: number;
  bill: { cash: number; card: number; upi: number; other: number };
  tip: { cash: number; card: number; upi: number; other: number };
  hasUnallocatedLegacyTip: boolean;
}

function deriveTransactionAllocations(txn: EdgeTransaction): TransactionAllocations {
  const method = String(txn.method || "").toUpperCase();
  const grandTotal = round2(num(txn.grandTotal ?? txn.amount));
  const tipAmount = round2(num(txn.tipAmount));

  // Recover bill allocations.
  const hasExplicitBillSplit =
    num(txn.cashAmount) > 0 || num(txn.cardAmount) > 0 ||
    num(txn.upiAmount) > 0 || num(txn.otherAmount) > 0;

  let bill: { cash: number; card: number; upi: number; other: number };
  if (hasExplicitBillSplit) {
    bill = {
      cash: round2(num(txn.cashAmount)),
      card: round2(num(txn.cardAmount)),
      upi: round2(num(txn.upiAmount)),
      other: round2(num(txn.otherAmount)),
    };
  } else if (method === "CASH") {
    bill = { cash: grandTotal, card: 0, upi: 0, other: 0 };
  } else if (method === "CARD") {
    bill = { cash: 0, card: grandTotal, upi: 0, other: 0 };
  } else if (method === "UPI") {
    bill = { cash: 0, card: 0, upi: grandTotal, other: 0 };
  } else if (method === "OTHER") {
    bill = { cash: 0, card: 0, upi: 0, other: grandTotal };
  } else {
    // Legacy MIXED with no explicit split — bucket as Other.
    bill = { cash: 0, card: 0, upi: 0, other: grandTotal };
  }

  // Recover tip allocations.
  const hasExplicitTipSplit =
    num(txn.cashTipAmount) > 0 || num(txn.cardTipAmount) > 0 ||
    num(txn.upiTipAmount) > 0 || num(txn.otherTipAmount) > 0;

  let tip: { cash: number; card: number; upi: number; other: number };
  let hasUnallocatedLegacyTip = false;

  if (hasExplicitTipSplit) {
    tip = {
      cash: round2(num(txn.cashTipAmount)),
      card: round2(num(txn.cardTipAmount)),
      upi: round2(num(txn.upiTipAmount)),
      other: round2(num(txn.otherTipAmount)),
    };
  } else if (tipAmount > 0) {
    // Default the full tip to the primary payment method.
    if (method === "CASH") tip = { cash: tipAmount, card: 0, upi: 0, other: 0 };
    else if (method === "CARD") tip = { cash: 0, card: tipAmount, upi: 0, other: 0 };
    else if (method === "UPI") tip = { cash: 0, card: 0, upi: tipAmount, other: 0 };
    else if (method === "OTHER") tip = { cash: 0, card: 0, upi: 0, other: tipAmount };
    else {
      // Legacy MIXED with no tip split — cannot reconstruct tip tender.
      tip = { cash: 0, card: 0, upi: 0, other: 0 };
      hasUnallocatedLegacyTip = true;
    }
  } else {
    tip = { cash: 0, card: 0, upi: 0, other: 0 };
  }

  return { grandTotal, tipAmount, bill, tip, hasUnallocatedLegacyTip };
}

// ── Main builder ─────────────────────────────────────────────────────────────

export function buildEdgePaymentSummary(
  transactions: EdgeTransaction[],
  expenditures: EdgeExpenditure[],
): EdgePaymentSummary {
  let totalSales = 0;
  let totalTips = 0;
  let unallocatedLegacyTips = 0;

  const billByMethod = { cash: 0, card: 0, upi: 0, other: 0 };
  const tipByMethod = { cash: 0, card: 0, upi: 0, other: 0 };

  let billInvariantValid = true;
  let tipInvariantValid = true;
  let collectionConservationValid = true;

  for (const txn of transactions) {
    const alloc = deriveTransactionAllocations(txn);
    const grandTotal = alloc.grandTotal;
    const tipAmount = alloc.tipAmount;

    totalSales = round2(totalSales + grandTotal);
    totalTips = round2(totalTips + tipAmount);

    billByMethod.cash = round2(billByMethod.cash + alloc.bill.cash);
    billByMethod.card = round2(billByMethod.card + alloc.bill.card);
    billByMethod.upi = round2(billByMethod.upi + alloc.bill.upi);
    billByMethod.other = round2(billByMethod.other + alloc.bill.other);

    tipByMethod.cash = round2(tipByMethod.cash + alloc.tip.cash);
    tipByMethod.card = round2(tipByMethod.card + alloc.tip.card);
    tipByMethod.upi = round2(tipByMethod.upi + alloc.tip.upi);
    tipByMethod.other = round2(tipByMethod.other + alloc.tip.other);

    if (alloc.hasUnallocatedLegacyTip) {
      unallocatedLegacyTips = round2(unallocatedLegacyTips + tipAmount);
    }

    // Validate per-transaction invariants.
    const billSum = round2(alloc.bill.cash + alloc.bill.card + alloc.bill.upi + alloc.bill.other);
    const tipSum = round2(alloc.tip.cash + alloc.tip.card + alloc.tip.upi + alloc.tip.other);
    const allAllocValues = [alloc.bill.cash, alloc.bill.card, alloc.bill.upi, alloc.bill.other,
      alloc.tip.cash, alloc.tip.card, alloc.tip.upi, alloc.tip.other];
    if (allAllocValues.some(v => !Number.isFinite(v) || v < 0)) {
      billInvariantValid = false;
      collectionConservationValid = false;
    }
    if (billSum !== grandTotal) billInvariantValid = false;
    if (tipSum !== (alloc.hasUnallocatedLegacyTip ? 0 : tipAmount)) {
      if (!alloc.hasUnallocatedLegacyTip) tipInvariantValid = false;
    }
    if (round2(billSum + tipSum) !== round2(grandTotal + tipAmount)) {
      collectionConservationValid = false;
    }
  }

  const collections = {
    cash: round2(billByMethod.cash + tipByMethod.cash),
    card: round2(billByMethod.card + tipByMethod.card),
    upi: round2(billByMethod.upi + tipByMethod.upi),
    other: round2(billByMethod.other + tipByMethod.other),
  };

  // Expenditures — cash vs non-cash by payment method.
  const totalExpenditures = round2(expenditures.reduce((s, e) => s + num(e.amount), 0));
  const nonCash = round2(
    expenditures
      .filter(e => e.paymentMethod && String(e.paymentMethod).toUpperCase() !== "CASH")
      .reduce((s, e) => s + num(e.amount), 0),
  );
  const cashExpenditures = round2(totalExpenditures - nonCash);

  // Mandatory same-day cash tip payout.
  const tipsPaid = totalTips;
  const netCashMovement = round2(collections.cash - cashExpenditures - tipsPaid);
  const expectedCash = netCashMovement;

  const sourceFingerprint = buildEdgeSourceFingerprint(transactions, expenditures);

  return {
    totalSales,
    totalTips,
    unallocatedLegacyTips,
    collections,
    billByMethod,
    tipByMethod,
    cashExpenditures,
    totalExpenditures,
    tipsPaid,
    netCashMovement,
    expectedCash,
    sourceFingerprint,
    invariants: {
      billAllocationValid: billInvariantValid,
      tipAllocationValid: tipInvariantValid,
      collectionConservationValid,
    },
  };
}

// ── X-Report state machine ───────────────────────────────────────────────────
// Mirrors the cloud xReportService state machine so edge and cloud enforce
// identical legal transitions.

export type XReportStatus = "DRAFT" | "PAYOUT_CONFIRMED" | "FINALIZED";

interface EdgeXReportState {
  reportStatus: XReportStatus;
  reportVersion: number;
  sourceFingerprint: string | null;
  tipsPaidConfirmedAt: number | null;
  tipsPaidConfirmedBy: string | null;
  snapshot: EdgePaymentSummary | null; // frozen on PAYOUT_CONFIRMED / FINALIZED
}

export function legalTransition(
  from: XReportStatus,
  to: XReportStatus,
  tipsAmount: number,
): boolean {
  if (to === "PAYOUT_CONFIRMED") {
    // Only DRAFT → PAYOUT_CONFIRMED, and only when tips > 0.
    return from === "DRAFT" && tipsAmount > 0;
  }
  if (to === "FINALIZED") {
    // DRAFT → FINALIZED (tips = 0) or PAYOUT_CONFIRMED → FINALIZED (tips > 0).
    if (from === "DRAFT") return tipsAmount === 0;
    if (from === "PAYOUT_CONFIRMED") return true;
    return false;
  }
  if (to === "DRAFT") {
    // Only FINALIZED → DRAFT (reopen).
    return from === "FINALIZED";
  }
  return false;
}

export function initialState(): EdgeXReportState {
  return {
    reportStatus: "DRAFT",
    reportVersion: 1,
    sourceFingerprint: null,
    tipsPaidConfirmedAt: null,
    tipsPaidConfirmedBy: null,
    snapshot: null,
  };
}
