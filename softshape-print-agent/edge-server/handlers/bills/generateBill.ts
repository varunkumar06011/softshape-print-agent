// ─────────────────────────────────────────────────────────────────────────────
// handlers/bills/generateBill.ts — GenerateBill command handler
// ─────────────────────────────────────────────────────────────────────────────
// Generates a bill from the current order state. Calculates subtotal from
// active order items, applies tax and service charge. Does NOT include any
// payment concepts — payments are Milestone 3.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import { RUNTIME_ERROR_CODES, RuntimeError } from "../../contract/errors.ts";
import { OPERATIONAL_EVENT_TYPES } from "../../contract/operationalEvents.ts";
import type { CommandContext, CommandOutcome, EmittedEvent } from "../../core/commandBus.ts";
import { getOrder, getActiveOrderItems } from "../../sqlite/orders.ts";
import { getBillForOrder, getNextBillNumber } from "../../sqlite/bills.ts";
import { getKolkataDateString } from "../../db.ts";
import type { GenerateBillInput, GenerateBillResult } from "../commands.ts";

export function handleGenerateBill(
  db: Database,
  input: GenerateBillInput,
  _ctx: CommandContext,
): CommandOutcome<GenerateBillResult> {
  if (!input.billId) throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "billId is required");
  if (!input.orderId) throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "orderId is required");

  const order = getOrder(db, input.orderId);
  if (!order) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.AGGREGATE_NOT_FOUND, `Order '${input.orderId}' not found`);
  }
  if (order.status === "VOIDED") {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED,
      `Order '${input.orderId}' is voided, cannot generate bill`,
    );
  }
  if (order.status === "BILLED") {
    // Check if a bill already exists — if so, reject as duplicate
    const existingBill = getBillForOrder(db, input.orderId);
    if (existingBill) {
      throw new RuntimeError(
        RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED,
        `Order '${input.orderId}' already has a bill`,
      );
    }
  }

  // Check for duplicate bill ID
  const existingById = getBillForOrder(db, input.orderId);
  if (existingById && existingById.id === input.billId) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.DUPLICATE_EVENT_ID,
      `Bill '${input.billId}' already exists`,
    );
  }

  // Calculate bill amounts from active order items
  const items = getActiveOrderItems(db, input.orderId);
  if (items.length === 0) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED,
      `Order '${input.orderId}' has no active items to bill`,
    );
  }

  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const taxRate = input.taxRate ?? 0;
  const serviceChargePercent = input.serviceChargePercent ?? 0;
  const taxAmount = Math.round(subtotal * (taxRate / 100) * 100) / 100;
  const serviceCharge = Math.round(subtotal * (serviceChargePercent / 100) * 100) / 100;
  const totalAmount = Math.round((subtotal + taxAmount + serviceCharge) * 100) / 100;

  const billNumber = getNextBillNumber(db, order.restaurant_id);
  const counterDate = getKolkataDateString();

  const event: EmittedEvent = {
    eventType: OPERATIONAL_EVENT_TYPES.BILL_GENERATED,
    aggregateId: input.billId,
    payload: {
      billId: input.billId,
      orderId: input.orderId,
      billNumber,
      counterDate,
      subtotal,
      taxAmount,
      serviceCharge,
      totalAmount,
    },
  };

  return {
    result: {
      billId: input.billId,
      billNumber,
      counterDate,
      subtotal,
      taxAmount,
      serviceCharge,
      totalAmount,
    },
    events: [event],
  };
}
