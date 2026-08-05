// ─────────────────────────────────────────────────────────────────────────────
// handlers/orders/addOrderItems.ts — AddOrderItems command handler
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import { RUNTIME_ERROR_CODES, RuntimeError } from "../../contract/errors.ts";
import { OPERATIONAL_EVENT_TYPES } from "../../contract/operationalEvents.ts";
import type { CommandContext, CommandOutcome, EmittedEvent } from "../../core/commandBus.ts";
import { getOrder } from "../../sqlite/orders.ts";
import type { AddOrderItemsInput, AddOrderItemsResult } from "../commands.ts";

export function handleAddOrderItems(
  db: Database,
  input: AddOrderItemsInput,
  _ctx: CommandContext,
): CommandOutcome<AddOrderItemsResult> {
  if (!input.orderId) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "orderId is required");
  }
  if (!input.items || input.items.length === 0) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "items must be a non-empty array");
  }

  // Validate each item
  for (const item of input.items) {
    if (!item.id) throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "each item requires an id");
    if (!item.menuItemId) throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "each item requires a menuItemId");
    if (!item.name) throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "each item requires a name");
    if (typeof item.price !== "number" || item.price < 0) {
      throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "each item requires a non-negative price");
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "each item requires a positive integer quantity");
    }
  }

  // Order must exist and be OPEN
  const order = getOrder(db, input.orderId);
  if (!order) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.AGGREGATE_NOT_FOUND, `Order '${input.orderId}' not found`);
  }
  if (order.status !== "OPEN") {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED,
      `Order '${input.orderId}' is ${order.status}, cannot add items`,
    );
  }

  const event: EmittedEvent = {
    eventType: OPERATIONAL_EVENT_TYPES.ORDER_ITEMS_ADDED,
    aggregateId: input.orderId,
    payload: { items: input.items },
  };

  return {
    result: { orderId: input.orderId, itemsAdded: input.items.length },
    events: [event],
  };
}
