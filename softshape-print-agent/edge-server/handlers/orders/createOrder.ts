// ─────────────────────────────────────────────────────────────────────────────
// handlers/orders/createOrder.ts — CreateOrder command handler
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import { RUNTIME_ERROR_CODES, RuntimeError } from "../../contract/errors.ts";
import { OPERATIONAL_EVENT_TYPES } from "../../contract/operationalEvents.ts";
import type { CommandContext, CommandOutcome, EmittedEvent } from "../../core/commandBus.ts";
import { getOrder } from "../../sqlite/orders.ts";
import type { CreateOrderInput, CreateOrderResult } from "../commands.ts";

export function handleCreateOrder(
  db: Database,
  input: CreateOrderInput,
  ctx: CommandContext,
): CommandOutcome<CreateOrderResult> {
  // Validate: order ID must be present
  if (!input.orderId) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "orderId is required");
  }
  if (!input.tableId) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "tableId is required");
  }

  // Check for duplicate order (not a replay — a different request creating the same ID)
  const existing = getOrder(db, input.orderId);
  if (existing) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.DUPLICATE_EVENT_ID,
      `Order '${input.orderId}' already exists`,
      { orderId: input.orderId },
    );
  }

  const event: EmittedEvent = {
    eventType: OPERATIONAL_EVENT_TYPES.ORDER_CREATED,
    aggregateId: input.orderId,
    payload: {
      tableId: input.tableId,
      captainId: input.captainId ?? ctx.actorId,
      platform: input.platform ?? "DINE_IN",
    },
  };

  return {
    result: { orderId: input.orderId, status: "OPEN" },
    events: [event],
  };
}
