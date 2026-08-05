// ─────────────────────────────────────────────────────────────────────────────
// sqlite/kots.ts — SQLite update functions for KOT events
// ─────────────────────────────────────────────────────────────────────────────
// Updates v2_kot and v2_kot_item tables atomically with KOT_SENT and
// KOT_CANCELLED events. Also marks order items as sent (kot_id) when a KOT
// is generated.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import type { StoredOperationalEvent } from "../contract/operationalEvents.ts";
import { OPERATIONAL_EVENT_TYPES } from "../contract/operationalEvents.ts";
import { getKolkataDateString } from "../db.ts";

// ── KOT_SENT ─────────────────────────────────────────────────────────────────

function applyKotSent(db: Database, event: StoredOperationalEvent): void {
  const p = event.payload as {
    kotId: string;
    orderId: string;
    tableId: string;
    kotNumber: number;
    counterDate: string;
    items: Array<{
      id: string;
      orderItemId: string;
      menuItemId: string;
      name: string;
      quantity: number;
      price: number;
      notes?: string | null;
    }>;
  };

  // Idempotent: if KOT already exists (replay), do nothing.
  const existing = db.query("SELECT 1 FROM v2_kot WHERE id = ?").get(p.kotId);
  if (existing) return;

  db.query(
    `INSERT INTO v2_kot (id, restaurant_id, table_id, order_id, kot_number, counter_date, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'SENT', ?)`,
  ).run(
    p.kotId,
    event.restaurantId,
    p.tableId,
    p.orderId,
    p.kotNumber,
    p.counterDate,
    event.occurredAt,
  );

  for (const item of p.items) {
    db.query(
      `INSERT INTO v2_kot_item (id, kot_id, order_item_id, menu_item_id, name, quantity, price, notes, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?)`,
    ).run(
      item.id,
      p.kotId,
      item.orderItemId,
      item.menuItemId,
      item.name,
      item.quantity,
      item.price,
      item.notes ?? null,
      event.occurredAt,
    );

    // Link the order item to this KOT.
    db.query(
      `UPDATE v2_order_item SET kot_id = ?, updated_at = ? WHERE id = ?`,
    ).run(p.kotId, event.occurredAt, item.orderItemId);
  }
}

// ── KOT_CANCELLED ────────────────────────────────────────────────────────────

function applyKotCancelled(db: Database, event: StoredOperationalEvent): void {
  const p = event.payload as {
    kotId: string;
  };

  // Idempotent: if already cancelled, skip.
  const row = db.query("SELECT status FROM v2_kot WHERE id = ?").get(p.kotId) as
    | { status: string }
    | undefined;
  if (!row || row.status === "CANCELLED") return;

  db.query(
    `UPDATE v2_kot SET status = 'CANCELLED', cancelled_at = ? WHERE id = ?`,
  ).run(event.occurredAt, p.kotId);

  db.query(
    `UPDATE v2_kot_item SET status = 'CANCELLED' WHERE kot_id = ?`,
  ).run(p.kotId);

  // Unlink order items from this KOT so they can be re-sent if needed.
  db.query(
    `UPDATE v2_order_item SET kot_id = NULL, updated_at = ? WHERE kot_id = ?`,
  ).run(event.occurredAt, p.kotId);
}

// ── Projection handler ───────────────────────────────────────────────────────

export function kotsProjection(db: Database, event: StoredOperationalEvent): void {
  switch (event.eventType) {
    case OPERATIONAL_EVENT_TYPES.KOT_SENT:
      return applyKotSent(db, event);
    case OPERATIONAL_EVENT_TYPES.KOT_CANCELLED:
      return applyKotCancelled(db, event);
    default:
      return;
  }
}

// ── Query helpers ────────────────────────────────────────────────────────────

export interface KotRow {
  id: string;
  restaurant_id: string;
  table_id: string;
  order_id: string;
  kot_number: number;
  counter_date: string;
  status: string;
  created_at: number;
  cancelled_at: number | null;
}

export interface KotItemRow {
  id: string;
  kot_id: string;
  order_item_id: string;
  menu_item_id: string;
  name: string;
  quantity: number;
  price: number;
  notes: string | null;
  status: string;
  created_at: number;
}

export function getKot(db: Database, kotId: string): KotRow | null {
  return (db.query("SELECT * FROM v2_kot WHERE id = ?").get(kotId) as KotRow) ?? null;
}

export function getKotItems(db: Database, kotId: string): KotItemRow[] {
  return db.query("SELECT * FROM v2_kot_item WHERE kot_id = ? ORDER BY created_at").all(kotId) as KotItemRow[];
}

export function getKotsForOrder(db: Database, orderId: string): KotRow[] {
  return db
    .query("SELECT * FROM v2_kot WHERE order_id = ? ORDER BY created_at")
    .all(orderId) as KotRow[];
}

export function getNextKotNumber(db: Database, restaurantId: string): number {
  const counterDate = getKolkataDateString();
  const row = db.query(
    `SELECT MAX(kot_number) AS max_num FROM v2_kot WHERE restaurant_id = ? AND counter_date = ?`,
  ).get(restaurantId, counterDate) as { max_num: number | null };
  return (row.max_num ?? 0) + 1;
}
