// ─────────────────────────────────────────────────────────────────────────────
// sqlite/orders.ts — SQLite update functions for order events
// ─────────────────────────────────────────────────────────────────────────────
// These functions are called by the projection registry inside the same
// transaction that appends the event. They are:
//   - deterministic: same event + same prior state ⇒ same result
//   - idempotent: applying the same event twice must not double-apply
//   - synchronous: no network, no timers, no async work
//   - side-effect free outside SQLite
//
// The handler receives the StoredOperationalEvent and updates v2_order /
// v2_order_item tables. It never reads or writes the v1 order_record table.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import type { StoredOperationalEvent } from "../contract/operationalEvents.ts";
import { OPERATIONAL_EVENT_TYPES } from "../contract/operationalEvents.ts";

// ── ORDER_CREATED ────────────────────────────────────────────────────────────

function applyOrderCreated(db: Database, event: StoredOperationalEvent): void {
  const p = event.payload as {
    tableId: string;
    captainId?: string | null;
    platform?: string;
  };

  // Idempotent: if the order already exists (replay), do nothing.
  const existing = db.query("SELECT 1 FROM v2_order WHERE id = ?").get(event.aggregateId);
  if (existing) return;

  db.query(
    `INSERT INTO v2_order (id, restaurant_id, table_id, status, total_amount, captain_id, platform, created_at, updated_at, revision)
     VALUES (?, ?, ?, 'OPEN', 0, ?, ?, ?, ?, 1)`,
  ).run(
    event.aggregateId,
    event.restaurantId,
    p.tableId,
    p.captainId ?? null,
    p.platform ?? "DINE_IN",
    event.occurredAt,
    event.occurredAt,
  );
}

// ── ORDER_ITEMS_ADDED ────────────────────────────────────────────────────────

function applyOrderItemsAdded(db: Database, event: StoredOperationalEvent): void {
  const p = event.payload as {
    items: Array<{
      id: string;
      menuItemId: string;
      name: string;
      price: number;
      quantity: number;
      notes?: string | null;
    }>;
  };

  for (const item of p.items) {
    // Idempotent: skip if this item already exists (replay).
    const existing = db.query("SELECT 1 FROM v2_order_item WHERE id = ?").get(item.id);
    if (existing) continue;

    db.query(
      `INSERT INTO v2_order_item (id, order_id, menu_item_id, name, price, quantity, notes, status, kot_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, ?, ?)`,
    ).run(
      item.id,
      event.aggregateId,
      item.menuItemId,
      item.name,
      item.price,
      item.quantity,
      item.notes ?? null,
      event.occurredAt,
      event.occurredAt,
    );
  }

  // Recalculate order total from active items.
  recalcOrderTotal(db, event.aggregateId, event.occurredAt);
}

// ── ORDER_ITEM_CANCELLED ─────────────────────────────────────────────────────

function applyOrderItemCancelled(db: Database, event: StoredOperationalEvent): void {
  const p = event.payload as {
    orderItemId: string;
  };

  // Idempotent: if already cancelled, skip.
  const row = db.query("SELECT status FROM v2_order_item WHERE id = ?").get(p.orderItemId) as
    | { status: string }
    | undefined;
  if (!row) return;
  if (row.status === "CANCELLED") return;

  db.query(
    `UPDATE v2_order_item SET status = 'CANCELLED', updated_at = ? WHERE id = ?`,
  ).run(event.occurredAt, p.orderItemId);

  recalcOrderTotal(db, event.aggregateId, event.occurredAt);
}

// ── ORDER_ITEM_QUANTITY_CHANGED ──────────────────────────────────────────────
// This uses ORDER_STATUS_CHANGED as the event type, but the payload carries
// quantity change details. In practice, quantity changes are modeled as
// ORDER_ITEMS_ADDED with a delta or as a dedicated event. Since the frozen
// event catalog does not have a dedicated quantity-changed event, we handle
// quantity changes through ORDER_ITEMS_ADDED with the same item ID (upsert
// semantics in the projection).
//
// Actually, looking at the frozen event types, there is no
// ORDER_ITEM_QUANTITY_CHANGED. The workflow uses ORDER_ITEMS_ADDED to add
// items and ORDER_ITEM_CANCELLED to remove items. Quantity updates are
// modeled as adding more of the same item (which increases quantity) or
// cancelling (which removes). This keeps the event log simple and the
// projections straightforward.

// ── ORDER_VOIDED ─────────────────────────────────────────────────────────────

function applyOrderVoided(db: Database, event: StoredOperationalEvent): void {
  db.query(
    `UPDATE v2_order SET status = 'VOIDED', updated_at = ?, revision = revision + 1 WHERE id = ?`,
  ).run(event.occurredAt, event.aggregateId);
}

// ── Helper: recalculate order total from active items ────────────────────────

function recalcOrderTotal(db: Database, orderId: string, updatedAt: number): void {
  const row = db.query(
    `SELECT COALESCE(SUM(price * quantity), 0) AS total
     FROM v2_order_item
     WHERE order_id = ? AND status = 'ACTIVE'`,
  ).get(orderId) as { total: number };

  db.query(
    `UPDATE v2_order SET total_amount = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`,
  ).run(row.total, updatedAt, orderId);
}

// ── Projection handler (dispatched by event type) ────────────────────────────

export function ordersProjection(db: Database, event: StoredOperationalEvent): void {
  switch (event.eventType) {
    case OPERATIONAL_EVENT_TYPES.ORDER_CREATED:
      return applyOrderCreated(db, event);
    case OPERATIONAL_EVENT_TYPES.ORDER_ITEMS_ADDED:
      return applyOrderItemsAdded(db, event);
    case OPERATIONAL_EVENT_TYPES.ORDER_ITEM_CANCELLED:
      return applyOrderItemCancelled(db, event);
    case OPERATIONAL_EVENT_TYPES.ORDER_VOIDED:
      return applyOrderVoided(db, event);
    default:
      return;
  }
}

// ── Query helpers (used by the query layer, not by projections) ──────────────

export interface OrderRow {
  id: string;
  restaurant_id: string;
  table_id: string;
  status: string;
  total_amount: number;
  captain_id: string | null;
  platform: string;
  created_at: number;
  updated_at: number;
  revision: number;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  menu_item_id: string;
  name: string;
  price: number;
  quantity: number;
  notes: string | null;
  status: string;
  kot_id: string | null;
  created_at: number;
  updated_at: number;
}

export function getOrder(db: Database, orderId: string): OrderRow | null {
  return (db.query("SELECT * FROM v2_order WHERE id = ?").get(orderId) as OrderRow) ?? null;
}

export function getOrderItems(db: Database, orderId: string): OrderItemRow[] {
  return db.query("SELECT * FROM v2_order_item WHERE order_id = ? ORDER BY created_at").all(orderId) as OrderItemRow[];
}

export function getActiveOrderItems(db: Database, orderId: string): OrderItemRow[] {
  return db
    .query("SELECT * FROM v2_order_item WHERE order_id = ? AND status = 'ACTIVE' ORDER BY created_at")
    .all(orderId) as OrderItemRow[];
}

export function getOrderByTable(db: Database, tableId: string, restaurantId: string): OrderRow | null {
  return (db
    .query("SELECT * FROM v2_order WHERE table_id = ? AND restaurant_id = ? AND status = 'OPEN' ORDER BY created_at DESC LIMIT 1")
    .get(tableId, restaurantId) as OrderRow) ?? null;
}
