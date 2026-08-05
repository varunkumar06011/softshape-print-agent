// ─────────────────────────────────────────────────────────────────────────────
// handlers/kots/cancelKot.ts — CancelKot command handler
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import { RUNTIME_ERROR_CODES, RuntimeError } from "../../contract/errors.ts";
import { OPERATIONAL_EVENT_TYPES } from "../../contract/operationalEvents.ts";
import type { CommandContext, CommandOutcome, EmittedEvent } from "../../core/commandBus.ts";
import { getKot } from "../../sqlite/kots.ts";
import type { CancelKotInput, CancelKotResult } from "../commands.ts";

export function handleCancelKot(
  db: Database,
  input: CancelKotInput,
  _ctx: CommandContext,
): CommandOutcome<CancelKotResult> {
  if (!input.kotId) throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "kotId is required");
  if (!input.orderId) throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "orderId is required");

  const kot = getKot(db, input.kotId);
  if (!kot) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.AGGREGATE_NOT_FOUND, `KOT '${input.kotId}' not found`);
  }
  if (kot.order_id !== input.orderId) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED,
      `KOT '${input.kotId}' does not belong to order '${input.orderId}'`,
    );
  }
  if (kot.status === "CANCELLED") {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED,
      `KOT '${input.kotId}' is already cancelled`,
    );
  }

  const event: EmittedEvent = {
    eventType: OPERATIONAL_EVENT_TYPES.KOT_CANCELLED,
    aggregateId: input.kotId,
    payload: { kotId: input.kotId },
  };

  return {
    result: { kotId: input.kotId, status: "CANCELLED" },
    events: [event],
  };
}
