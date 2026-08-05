// ─────────────────────────────────────────────────────────────────────────────
// handlers/index.ts — Registration module for Milestone 2
// ─────────────────────────────────────────────────────────────────────────────
// Wires all command handlers and projection handlers into the Runtime v2
// command bus and projection registry. This is the only place that knows
// about both the handler implementations and the core infrastructure.
//
// Call registerMilestone2Handlers() once at startup, after the schema is
// initialized and before the server starts accepting commands.
// ─────────────────────────────────────────────────────────────────────────────

import { registerCommand, resetCommandRegistry } from "../core/commandBus.ts";
import { registerProjection, resetProjectionRegistry } from "../core/projections.ts";
import { OPERATIONAL_EVENT_TYPES } from "../contract/operationalEvents.ts";

import { ordersProjection } from "../sqlite/orders.ts";
import { kotsProjection } from "../sqlite/kots.ts";
import { billsProjection } from "../sqlite/bills.ts";

import { handleCreateOrder } from "./orders/createOrder.ts";
import { handleAddOrderItems } from "./orders/addOrderItems.ts";
import { handleCancelOrderItem } from "./orders/cancelOrderItem.ts";
import { handleVoidOrder } from "./orders/voidOrder.ts";
import { handleSendKot } from "./kots/sendKot.ts";
import { handleCancelKot } from "./kots/cancelKot.ts";
import { handleGenerateBill } from "./bills/generateBill.ts";

import { COMMAND_TYPES } from "./commands.ts";
import type {
  CreateOrderInput,
  AddOrderItemsInput,
  CancelOrderItemInput,
  VoidOrderInput,
  SendKotInput,
  CancelKotInput,
  GenerateBillInput,
} from "./commands.ts";

// ── Event types handled by Milestone 2 projections ───────────────────────────

const MILESTONE_2_EVENT_TYPES = [
  OPERATIONAL_EVENT_TYPES.ORDER_CREATED,
  OPERATIONAL_EVENT_TYPES.ORDER_ITEMS_ADDED,
  OPERATIONAL_EVENT_TYPES.ORDER_ITEM_CANCELLED,
  OPERATIONAL_EVENT_TYPES.ORDER_VOIDED,
  OPERATIONAL_EVENT_TYPES.KOT_SENT,
  OPERATIONAL_EVENT_TYPES.KOT_CANCELLED,
  OPERATIONAL_EVENT_TYPES.BILL_GENERATED,
  OPERATIONAL_EVENT_TYPES.BILL_EDITED,
] as const;

// ── Register all projections and commands ────────────────────────────────────

export function registerMilestone2Handlers(): void {
  // ── Projections (SQLite update functions) ──────────────────────────────────
  // Each projection handles a set of event types and owns specific tables.
  // The registry is a plain map — no lifecycle, no auto-discovery.

  registerProjection({
    name: "orders",
    eventTypes: [
      OPERATIONAL_EVENT_TYPES.ORDER_CREATED,
      OPERATIONAL_EVENT_TYPES.ORDER_ITEMS_ADDED,
      OPERATIONAL_EVENT_TYPES.ORDER_ITEM_CANCELLED,
      OPERATIONAL_EVENT_TYPES.ORDER_VOIDED,
    ],
    handler: ordersProjection,
    tables: ["v2_order", "v2_order_item"],
  });

  registerProjection({
    name: "kots",
    eventTypes: [
      OPERATIONAL_EVENT_TYPES.KOT_SENT,
      OPERATIONAL_EVENT_TYPES.KOT_CANCELLED,
    ],
    handler: kotsProjection,
    tables: ["v2_kot", "v2_kot_item"],
  });

  registerProjection({
    name: "bills",
    eventTypes: [
      OPERATIONAL_EVENT_TYPES.BILL_GENERATED,
      OPERATIONAL_EVENT_TYPES.BILL_EDITED,
    ],
    handler: billsProjection,
    tables: ["v2_bill"],
  });

  // ── Commands ───────────────────────────────────────────────────────────────
  // Each command handler receives a DTO, validates, and emits events.
  // The command bus handles the atomic transaction (event + projection + commit).

  registerCommand<CreateOrderInput, { orderId: string; status: string }>({
    type: COMMAND_TYPES.CREATE_ORDER,
    handler: handleCreateOrder,
    entityType: "order",
    resolveEntityId: (input) => input.orderId,
    minRole: "CAPTAIN",
  });

  registerCommand<AddOrderItemsInput, { orderId: string; itemsAdded: number }>({
    type: COMMAND_TYPES.ADD_ORDER_ITEMS,
    handler: handleAddOrderItems,
    entityType: "order",
    resolveEntityId: (input) => input.orderId,
    minRole: "CAPTAIN",
  });

  registerCommand<CancelOrderItemInput, { orderId: string; orderItemId: string }>({
    type: COMMAND_TYPES.CANCEL_ORDER_ITEM,
    handler: handleCancelOrderItem,
    entityType: "order",
    resolveEntityId: (input) => input.orderId,
    minRole: "CAPTAIN",
  });

  registerCommand<VoidOrderInput, { orderId: string; status: string }>({
    type: COMMAND_TYPES.VOID_ORDER,
    handler: handleVoidOrder,
    entityType: "order",
    resolveEntityId: (input) => input.orderId,
    minRole: "CASHIER",
  });

  registerCommand<SendKotInput, { kotId: string; kotNumber: number; counterDate: string; itemCount: number }>({
    type: COMMAND_TYPES.SEND_KOT,
    handler: handleSendKot,
    entityType: "kot",
    resolveEntityId: (input) => input.kotId,
    minRole: "CAPTAIN",
  });

  registerCommand<CancelKotInput, { kotId: string; status: string }>({
    type: COMMAND_TYPES.CANCEL_KOT,
    handler: handleCancelKot,
    entityType: "kot",
    resolveEntityId: (input) => input.kotId,
    minRole: "CAPTAIN",
  });

  registerCommand<GenerateBillInput, {
    billId: string;
    billNumber: number;
    counterDate: string;
    subtotal: number;
    taxAmount: number;
    serviceCharge: number;
    totalAmount: number;
  }>({
    type: COMMAND_TYPES.GENERATE_BILL,
    handler: handleGenerateBill,
    entityType: "bill",
    resolveEntityId: (input) => input.billId,
    minRole: "CASHIER",
  });
}

// ── Test helper: reset and re-register ───────────────────────────────────────

export function resetMilestone2Handlers(): void {
  resetCommandRegistry();
  resetProjectionRegistry();
}

export { MILESTONE_2_EVENT_TYPES };
