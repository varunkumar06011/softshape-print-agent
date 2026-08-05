// ─────────────────────────────────────────────────────────────────────────────
// runtime-v2-order-protocol-freeze.test.ts — Order Protocol Freeze Verification
// ─────────────────────────────────────────────────────────────────────────────
// Asserts that the frozen Order protocol (events, commands, status mapping)
// remains unchanged. If someone adds, removes, or renames a frozen entry,
// these tests break — which is the entire point of a freeze.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, test, expect } from "bun:test";
import { OPERATIONAL_EVENT_TYPES } from "../contract/operationalEvents.ts";
import { RUNTIME_ERROR_CODES } from "../contract/errors.ts";
import {
  FROZEN_ORDER_EVENTS,
  FROZEN_ORDER_COMMANDS,
  V2_TO_CLOUD_STATUS,
  v2StatusToCloud,
  isFrozenOrderEvent,
  isFrozenOrderCommand,
} from "../contract/orderProtocol.ts";
import { COMMAND_TYPES } from "../handlers/commands.ts";
import { registerMilestone2Handlers, resetMilestone2Handlers, MILESTONE_2_EVENT_TYPES } from "../handlers/index.ts";
import { getRegisteredCommands } from "../core/commandBus.ts";
import { discoverProjections } from "../core/projections.ts";

describe("Order Protocol Freeze", () => {
  // ── Frozen events ──────────────────────────────────────────────────────────

  test("frozen event list contains exactly the 8 Milestone 2 events", () => {
    expect(FROZEN_ORDER_EVENTS.length).toBe(8);
    expect([...FROZEN_ORDER_EVENTS]).toEqual([
      "order.created",
      "order.items_added",
      "order.item_cancelled",
      "order.voided",
      "kot.sent",
      "kot.cancelled",
      "bill.generated",
      "bill.edited",
    ]);
  });

  test("every frozen event exists in OPERATIONAL_EVENT_TYPES", () => {
    const allEventTypes = Object.values(OPERATIONAL_EVENT_TYPES);
    for (const eventType of FROZEN_ORDER_EVENTS) {
      expect(allEventTypes).toContain(eventType);
    }
  });

  test("isFrozenOrderEvent recognizes all frozen events", () => {
    for (const eventType of FROZEN_ORDER_EVENTS) {
      expect(isFrozenOrderEvent(eventType)).toBe(true);
    }
    expect(isFrozenOrderEvent("order.something_new")).toBe(false);
  });

  // ── Frozen commands ─────────────────────────────────────────────────────────

  test("frozen command list contains exactly the 7 Milestone 2 commands", () => {
    expect(FROZEN_ORDER_COMMANDS.length).toBe(7);
    expect([...FROZEN_ORDER_COMMANDS]).toEqual([
      "CREATE_ORDER",
      "ADD_ORDER_ITEMS",
      "CANCEL_ORDER_ITEM",
      "VOID_ORDER",
      "SEND_KOT",
      "CANCEL_KOT",
      "GENERATE_BILL",
    ]);
  });

  test("handler COMMAND_TYPES match the frozen command list", () => {
    for (const cmd of FROZEN_ORDER_COMMANDS) {
      expect(Object.values(COMMAND_TYPES)).toContain(cmd);
    }
  });

  test("isFrozenOrderCommand recognizes all frozen commands", () => {
    for (const cmd of FROZEN_ORDER_COMMANDS) {
      expect(isFrozenOrderCommand(cmd)).toBe(true);
    }
    expect(isFrozenOrderCommand("SOMETHING_NEW")).toBe(false);
  });

  test("all frozen commands are registered in the command bus", () => {
    resetMilestone2Handlers();
    registerMilestone2Handlers();
    const registered = getRegisteredCommands();
    for (const cmd of FROZEN_ORDER_COMMANDS) {
      expect(registered).toContain(cmd);
    }
  });

  // ── Frozen status mapping ───────────────────────────────────────────────────

  test("status mapping has exactly 3 entries", () => {
    expect(Object.keys(V2_TO_CLOUD_STATUS).length).toBe(3);
  });

  test("OPEN maps to PENDING", () => {
    expect(v2StatusToCloud("OPEN")).toBe("PENDING");
  });

  test("BILLED maps to BILLING_REQUESTED", () => {
    expect(v2StatusToCloud("BILLED")).toBe("BILLING_REQUESTED");
  });

  test("VOIDED maps to CANCELLED", () => {
    expect(v2StatusToCloud("VOIDED")).toBe("CANCELLED");
  });

  test("unknown status throws", () => {
    expect(() => v2StatusToCloud("SOMETHING_NEW")).toThrow();
  });

  // ── Frozen error codes ──────────────────────────────────────────────────────

  test("order-specific error codes map to frozen base codes", () => {
    // These base error codes are what the handlers throw. They must not be
    // renamed or removed.
    expect(RUNTIME_ERROR_CODES.AGGREGATE_NOT_FOUND).toBe("AGGREGATE_NOT_FOUND");
    expect(RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED).toBe("BUSINESS_RULE_REJECTED");
    expect(RUNTIME_ERROR_CODES.DUPLICATE_EVENT_ID).toBe("DUPLICATE_EVENT_ID");
    expect(RUNTIME_ERROR_CODES.VALIDATION_FAILED).toBe("VALIDATION_FAILED");
  });

  // ── Projection coverage ─────────────────────────────────────────────────────

  test("every frozen event has a registered projection", () => {
    resetMilestone2Handlers();
    registerMilestone2Handlers();
    const discovery = discoverProjections([...FROZEN_ORDER_EVENTS]);
    expect(discovery.eventTypesWithoutHandlers).toEqual([]);
    expect(discovery.duplicateEventTypes).toEqual([]);
  });

  test("Milestone 2 event types match frozen event list", () => {
    expect([...MILESTONE_2_EVENT_TYPES].sort()).toEqual([...FROZEN_ORDER_EVENTS].sort());
  });
});
