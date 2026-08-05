// ─────────────────────────────────────────────────────────────────────────────
// sqlite/bills.ts — SQLite update functions for bill events
// ─────────────────────────────────────────────────────────────────────────────
// Updates v2_bill table atomically with BILL_GENERATED events.
// No payment concepts — payments are Milestone 3.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import type { StoredOperationalEvent } from "../contract/operationalEvents.ts";
import { OPERATIONAL_EVENT_TYPES } from "../contract/operationalEvents.ts";
import { getKolkataDateString } from "../db.ts";

// ── BILL_GENERATED ───────────────────────────────────────────────────────────

function applyBillGenerated(db: Database, event: StoredOperationalEvent): void {
  const p = event.payload as {
    billId: string;
    orderId: string;
    billNumber: number;
    counterDate: string;
    subtotal: number;
    taxAmount: number;
    serviceCharge: number;
    totalAmount: number;
  };

  // Idempotent: if bill already exists (replay), do nothing.
  const existing = db.query("SELECT 1 FROM v2_bill WHERE id = ?").get(p.billId);
  if (existing) return;

  db.query(
    `INSERT INTO v2_bill (id, restaurant_id, order_id, bill_number, counter_date, subtotal, tax_amount, service_charge, total_amount, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'GENERATED', ?)`,
  ).run(
    p.billId,
    event.restaurantId,
    p.orderId,
    p.billNumber,
    p.counterDate,
    p.subtotal,
    p.taxAmount,
    p.serviceCharge,
    p.totalAmount,
    event.occurredAt,
  );

  // Mark the order as BILLED.
  db.query(
    `UPDATE v2_order SET status = 'BILLED', updated_at = ?, revision = revision + 1 WHERE id = ?`,
  ).run(event.occurredAt, p.orderId);
}

// ── BILL_EDITED ──────────────────────────────────────────────────────────────

function applyBillEdited(db: Database, event: StoredOperationalEvent): void {
  const p = event.payload as {
    billId: string;
    subtotal?: number;
    taxAmount?: number;
    serviceCharge?: number;
    totalAmount?: number;
  };

  // Build dynamic update for only the fields that are present.
  const sets: string[] = [];
  const params: (string | number)[] = [];

  if (typeof p.subtotal === "number") {
    sets.push("subtotal = ?");
    params.push(p.subtotal);
  }
  if (typeof p.taxAmount === "number") {
    sets.push("tax_amount = ?");
    params.push(p.taxAmount);
  }
  if (typeof p.serviceCharge === "number") {
    sets.push("service_charge = ?");
    params.push(p.serviceCharge);
  }
  if (typeof p.totalAmount === "number") {
    sets.push("total_amount = ?");
    params.push(p.totalAmount);
  }

  if (sets.length === 0) return;

  db.query(
    `UPDATE v2_bill SET ${sets.join(", ")} WHERE id = ?`,
  ).run(...params, p.billId);
}

// ── Projection handler ───────────────────────────────────────────────────────

export function billsProjection(db: Database, event: StoredOperationalEvent): void {
  switch (event.eventType) {
    case OPERATIONAL_EVENT_TYPES.BILL_GENERATED:
      return applyBillGenerated(db, event);
    case OPERATIONAL_EVENT_TYPES.BILL_EDITED:
      return applyBillEdited(db, event);
    default:
      return;
  }
}

// ── Query helpers ────────────────────────────────────────────────────────────

export interface BillRow {
  id: string;
  restaurant_id: string;
  order_id: string;
  bill_number: number;
  counter_date: string;
  subtotal: number;
  tax_amount: number;
  service_charge: number;
  total_amount: number;
  status: string;
  created_at: number;
}

export function getBill(db: Database, billId: string): BillRow | null {
  return (db.query("SELECT * FROM v2_bill WHERE id = ?").get(billId) as BillRow) ?? null;
}

export function getBillForOrder(db: Database, orderId: string): BillRow | null {
  return (db
    .query("SELECT * FROM v2_bill WHERE order_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(orderId) as BillRow) ?? null;
}

export function getNextBillNumber(db: Database, restaurantId: string): number {
  const counterDate = getKolkataDateString();
  const row = db.query(
    `SELECT MAX(bill_number) AS max_num FROM v2_bill WHERE restaurant_id = ? AND counter_date = ?`,
  ).get(restaurantId, counterDate) as { max_num: number | null };
  return (row.max_num ?? 0) + 1;
}
