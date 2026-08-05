// ─────────────────────────────────────────────────────────────────────────────
// handlers/orders/voidOrder.ts — VoidOrder command handler
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import { RUNTIME_ERROR_CODES, RuntimeError } from "../../contract/errors.ts";
import { OPERATIONAL_EVENT_TYPES } from "../../contract/operationalEvents.ts";
import type { CommandContext, CommandOutcome, EmittedEvent } from "../../core/commandBus.ts";
import { getOrder } from "../../sqlite/orders.ts";
import type { VoidOrderInput, VoidOrderResult } from "../commands.ts";

export function handleVoidOrder(
  db: Database,
  input: VoidOrderInput,
  _ctx: CommandContext,
): CommandOutcome<VoidOrderResult> {
  if (!input.orderId) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "orderId is required");
  }

  const order = getOrder(db, input.orderId);
  if (!order) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.AGGREGATE_NOT_FOUND, `Order '${input.orderId}' not found`);
  }
  if (order.status === "VOIDED") {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED,
      `Order '${input.orderId}' is already voided`,
    );
  }
  if (order.status === "BILLED") {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED,
      `Order '${input.orderId}' is billed, cannot void`,
    );
  }

  const event: EmittedEvent = {
    eventType: OPERATIONAL_EVENT_TYPES.ORDER_VOIDED,
    aggregateId: input.orderId,
    payload: {},
  };

  return {
    result: { orderId: input.orderId, status: "VOIDED" },
    events: [event],
  };
}
