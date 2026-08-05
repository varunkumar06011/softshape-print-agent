// ─────────────────────────────────────────────────────────────────────────────
// handlers/orders/cancelOrderItem.ts — CancelOrderItem command handler
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import { RUNTIME_ERROR_CODES, RuntimeError } from "../../contract/errors.ts";
import { OPERATIONAL_EVENT_TYPES } from "../../contract/operationalEvents.ts";
import type { CommandContext, CommandOutcome, EmittedEvent } from "../../core/commandBus.ts";
import { getOrder, getOrderItems } from "../../sqlite/orders.ts";
import type { CancelOrderItemInput, CancelOrderItemResult } from "../commands.ts";

export function handleCancelOrderItem(
  db: Database,
  input: CancelOrderItemInput,
  _ctx: CommandContext,
): CommandOutcome<CancelOrderItemResult> {
  if (!input.orderId) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "orderId is required");
  }
  if (!input.orderItemId) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "orderItemId is required");
  }

  const order = getOrder(db, input.orderId);
  if (!order) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.AGGREGATE_NOT_FOUND, `Order '${input.orderId}' not found`);
  }
  if (order.status !== "OPEN") {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED,
      `Order '${input.orderId}' is ${order.status}, cannot cancel items`,
    );
  }

  // Find the item and verify it's active
  const items = getOrderItems(db, input.orderId);
  const item = items.find((i) => i.id === input.orderItemId);
  if (!item) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.AGGREGATE_NOT_FOUND,
      `Order item '${input.orderItemId}' not found in order '${input.orderId}'`,
    );
  }
  if (item.status === "CANCELLED") {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED,
      `Order item '${input.orderItemId}' is already cancelled`,
    );
  }

  const event: EmittedEvent = {
    eventType: OPERATIONAL_EVENT_TYPES.ORDER_ITEM_CANCELLED,
    aggregateId: input.orderId,
    payload: { orderItemId: input.orderItemId },
  };

  return {
    result: { orderId: input.orderId, orderItemId: input.orderItemId },
    events: [event],
  };
}
