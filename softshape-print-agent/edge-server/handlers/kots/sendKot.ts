// ─────────────────────────────────────────────────────────────────────────────
// handlers/kots/sendKot.ts — SendKot command handler
// ─────────────────────────────────────────────────────────────────────────────
// Generates a KOT from all active, unsent order items. Assigns a daily
// sequential KOT number (IST date-scoped). The KOT event carries the full
// item snapshot so the cloud and projections have everything they need.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import { RUNTIME_ERROR_CODES, RuntimeError } from "../../contract/errors.ts";
import { OPERATIONAL_EVENT_TYPES } from "../../contract/operationalEvents.ts";
import type { CommandContext, CommandOutcome, EmittedEvent } from "../../core/commandBus.ts";
import { getOrder, getActiveOrderItems } from "../../sqlite/orders.ts";
import { getNextKotNumber, getKotsForOrder } from "../../sqlite/kots.ts";
import { getKolkataDateString } from "../../db.ts";
import type { SendKotInput, SendKotResult } from "../commands.ts";

export function handleSendKot(
  db: Database,
  input: SendKotInput,
  _ctx: CommandContext,
): CommandOutcome<SendKotResult> {
  if (!input.kotId) throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "kotId is required");
  if (!input.orderId) throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "orderId is required");
  if (!input.tableId) throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "tableId is required");

  const order = getOrder(db, input.orderId);
  if (!order) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.AGGREGATE_NOT_FOUND, `Order '${input.orderId}' not found`);
  }
  if (order.status !== "OPEN") {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED,
      `Order '${input.orderId}' is ${order.status}, cannot send KOT`,
    );
  }

  // Check for duplicate KOT ID
  const existingKots = getKotsForOrder(db, input.orderId);
  if (existingKots.some((k) => k.id === input.kotId)) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.DUPLICATE_EVENT_ID,
      `KOT '${input.kotId}' already exists for order '${input.orderId}'`,
    );
  }

  // Get active items that have NOT already been sent to a KOT
  const activeItems = getActiveOrderItems(db, input.orderId);
  const unsentItems = activeItems.filter((item) => !item.kot_id);

  if (unsentItems.length === 0) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED,
      `Order '${input.orderId}' has no unsent items to include in KOT`,
    );
  }

  const kotNumber = getNextKotNumber(db, order.restaurant_id);
  const counterDate = getKolkataDateString();

  const event: EmittedEvent = {
    eventType: OPERATIONAL_EVENT_TYPES.KOT_SENT,
    aggregateId: input.kotId,
    payload: {
      kotId: input.kotId,
      orderId: input.orderId,
      tableId: input.tableId,
      kotNumber,
      counterDate,
      items: unsentItems.map((item) => ({
        id: crypto.randomUUID(),
        orderItemId: item.id,
        menuItemId: item.menu_item_id,
        name: item.name,
        quantity: item.quantity,
        price: item.price,
        notes: item.notes,
      })),
    },
  };

  return {
    result: {
      kotId: input.kotId,
      kotNumber,
      counterDate,
      itemCount: unsentItems.length,
    },
    events: [event],
  };
}
