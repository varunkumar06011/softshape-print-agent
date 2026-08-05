// ─────────────────────────────────────────────────────────────────────────────
// contract/orderProtocol.ts — FROZEN Order Protocol (Milestone 2)
// ─────────────────────────────────────────────────────────────────────────────
// This file is the single source of truth for the Order/KOT/Bill protocol.
// Everything declared here is FROZEN after Milestone 2 sign-off:
//
//   - Event names will not be renamed or removed.
//   - Command names will not be renamed or removed.
//   - Error codes will not be renamed or removed.
//   - Status mapping will not be changed.
//
// New behavior is added via NEW events/commands, never by modifying existing
// ones. This is what lets the Runtime, Cloud, Admin, and Reports all trust
// the same wire format without coordination.
//
// ─── FREEZE SCOPE ────────────────────────────────────────────────────────────
//
// Events (frozen):
//   order.created
//   order.items_added
//   order.item_cancelled
//   order.voided
//   kot.sent
//   kot.cancelled
//   bill.generated
//   bill.edited
//
// Commands (frozen):
//   CREATE_ORDER
//   ADD_ORDER_ITEMS
//   CANCEL_ORDER_ITEM
//   VOID_ORDER
//   SEND_KOT
//   CANCEL_KOT
//   GENERATE_BILL
//
// Error codes (frozen, order-specific):
//   ORDER_NOT_FOUND          → AGGREGATE_NOT_FOUND
//   ORDER_ALREADY_VOIDED     → BUSINESS_RULE_REJECTED
//   ORDER_ALREADY_BILLED     → BUSINESS_RULE_REJECTED
//   KOT_NOT_FOUND            → AGGREGATE_NOT_FOUND
//   KOT_ALREADY_SENT         → DUPLICATE_EVENT_ID
//   KOT_ALREADY_CANCELLED    → BUSINESS_RULE_REJECTED
//   KOT_NO_UNSENT_ITEMS      → BUSINESS_RULE_REJECTED
//   BILL_NOT_FOUND           → AGGREGATE_NOT_FOUND
//   BILL_ALREADY_EXISTS      → BUSINESS_RULE_REJECTED
//   BILL_NO_ACTIVE_ITEMS     → BUSINESS_RULE_REJECTED
//
// Status mapping (frozen — v2 Runtime status → cloud OrderStatus enum):
//   OPEN    → PENDING
//   BILLED  → BILLING_REQUESTED
//   VOIDED  → CANCELLED
//
// ─────────────────────────────────────────────────────────────────────────────

import { OPERATIONAL_EVENT_TYPES } from "./operationalEvents.ts";

// ── Frozen event list ────────────────────────────────────────────────────────

export const FROZEN_ORDER_EVENTS = [
  OPERATIONAL_EVENT_TYPES.ORDER_CREATED,
  OPERATIONAL_EVENT_TYPES.ORDER_ITEMS_ADDED,
  OPERATIONAL_EVENT_TYPES.ORDER_ITEM_CANCELLED,
  OPERATIONAL_EVENT_TYPES.ORDER_VOIDED,
  OPERATIONAL_EVENT_TYPES.KOT_SENT,
  OPERATIONAL_EVENT_TYPES.KOT_CANCELLED,
  OPERATIONAL_EVENT_TYPES.BILL_GENERATED,
  OPERATIONAL_EVENT_TYPES.BILL_EDITED,
] as const;

// ── Frozen command list ──────────────────────────────────────────────────────

export const FROZEN_ORDER_COMMANDS = [
  "CREATE_ORDER",
  "ADD_ORDER_ITEMS",
  "CANCEL_ORDER_ITEM",
  "VOID_ORDER",
  "SEND_KOT",
  "CANCEL_KOT",
  "GENERATE_BILL",
] as const;

// ── Status mapping (single source of truth) ──────────────────────────────────
// The v2 Runtime uses a simplified status enum (OPEN/BILLED/VOIDED). The cloud
// uses a richer OrderStatus enum. This mapping is the ONLY place that translates
// between them. The Runtime, Cloud, Admin, and Reports must all import from here
// — never duplicate this mapping.

export type V2OrderStatus = "OPEN" | "BILLED" | "VOIDED";

export type CloudOrderStatus = "PENDING" | "BILLING_REQUESTED" | "CANCELLED";

export const V2_TO_CLOUD_STATUS: Record<V2OrderStatus, CloudOrderStatus> = {
  OPEN: "PENDING",
  BILLED: "BILLING_REQUESTED",
  VOIDED: "CANCELLED",
};

export function v2StatusToCloud(status: string): CloudOrderStatus {
  const mapped = V2_TO_CLOUD_STATUS[status as V2OrderStatus];
  if (!mapped) {
    throw new Error(`Unknown v2 order status '${status}' — no cloud mapping defined`);
  }
  return mapped;
}

// ── Freeze verification ──────────────────────────────────────────────────────
// A test can import these arrays and assert that the underlying registries
// still contain exactly these entries. If someone adds or removes a frozen
// event/command, the test breaks — which is the point.

export function isFrozenOrderEvent(eventType: string): boolean {
  return (FROZEN_ORDER_EVENTS as readonly string[]).includes(eventType);
}

export function isFrozenOrderCommand(commandType: string): boolean {
  return (FROZEN_ORDER_COMMANDS as readonly string[]).includes(commandType);
}
