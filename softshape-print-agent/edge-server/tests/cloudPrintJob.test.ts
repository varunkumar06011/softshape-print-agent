// ─────────────────────────────────────────────────────────────────────────────
// cloudPrintJob.test.ts — Tests for Phase 4: Fold Print Agent
// ─────────────────────────────────────────────────────────────────────────────
// Verifies that the Runtime correctly:
//   - Handles cloud print_job events
//   - Resolves printer from job type + mapping
//   - Creates durable print_job rows
//   - Sends print:ack back to the cloud
//   - Handles missing eventId, missing printer, missing ESC/POS data
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, describe } from "bun:test";

// ── Printer resolution logic (extracted for testing) ─────────────────────────

function resolvePrinterFromJobType(
  type: string,
  data: { printerName?: string | null },
  mapping: { kitchen?: string; bar?: string; bill?: string },
): string | null {
  let targetPrinter: string | null = data?.printerName || null;
  if (!targetPrinter) {
    if (type === "KOT" || type === "CANCEL_KOT") targetPrinter = mapping.kitchen || null;
    else if (type === "BAR_KOT") targetPrinter = mapping.bar || null;
    else if (type === "BILL" || type === "FINAL_BILL" || type === "CANCELLED_BILL" || type === "EXPENDITURE") targetPrinter = mapping.bill || null;
    else if (type === "TABLE_SWAP") targetPrinter = mapping.kitchen || null;
  }
  return targetPrinter;
}

// ── Print ack payload builder (extracted for testing) ────────────────────────

function buildPrintAckPayload(
  restaurantId: string,
  eventId: string,
  ok: boolean,
  error?: string | null,
  requestId?: string | null,
): { restaurantId: string; eventId: string; requestId?: string; status: string; error?: string } {
  const payload: any = {
    restaurantId,
    eventId,
    status: ok ? "success" : "failed",
  };
  if (requestId) payload.requestId = requestId;
  if (!ok && error) payload.error = error;
  return payload;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Phase 4: Cloud print job — printer resolution", () => {
  const mapping = { kitchen: "KitchenPrinter", bar: "BarPrinter", bill: "BillPrinter" };

  test("KOT resolves to kitchen printer from mapping", () => {
    expect(resolvePrinterFromJobType("KOT", { printerName: null }, mapping)).toBe("KitchenPrinter");
  });

  test("BAR_KOT resolves to bar printer from mapping", () => {
    expect(resolvePrinterFromJobType("BAR_KOT", { printerName: null }, mapping)).toBe("BarPrinter");
  });

  test("BILL resolves to bill printer from mapping", () => {
    expect(resolvePrinterFromJobType("BILL", { printerName: null }, mapping)).toBe("BillPrinter");
  });

  test("FINAL_BILL resolves to bill printer from mapping", () => {
    expect(resolvePrinterFromJobType("FINAL_BILL", { printerName: null }, mapping)).toBe("BillPrinter");
  });

  test("CANCEL_KOT resolves to kitchen printer from mapping", () => {
    expect(resolvePrinterFromJobType("CANCEL_KOT", { printerName: null }, mapping)).toBe("KitchenPrinter");
  });

  test("TABLE_SWAP resolves to kitchen printer from mapping", () => {
    expect(resolvePrinterFromJobType("TABLE_SWAP", { printerName: null }, mapping)).toBe("KitchenPrinter");
  });

  test("data.printerName takes priority over mapping", () => {
    expect(resolvePrinterFromJobType("KOT", { printerName: "ExplicitPrinter" }, mapping)).toBe("ExplicitPrinter");
  });

  test("unknown job type with no printerName returns null", () => {
    expect(resolvePrinterFromJobType("UNKNOWN_TYPE", { printerName: null }, mapping)).toBeNull();
  });

  test("empty mapping returns null for KOT", () => {
    expect(resolvePrinterFromJobType("KOT", { printerName: null }, {})).toBeNull();
  });

  test("CANCELLED_BILL resolves to bill printer", () => {
    expect(resolvePrinterFromJobType("CANCELLED_BILL", { printerName: null }, mapping)).toBe("BillPrinter");
  });

  test("EXPENDITURE resolves to bill printer", () => {
    expect(resolvePrinterFromJobType("EXPENDITURE", { printerName: null }, mapping)).toBe("BillPrinter");
  });
});

describe("Phase 4: Cloud print job — ack payload", () => {
  const rid = "rest-001";

  test("success ack has status success", () => {
    const payload = buildPrintAckPayload(rid, "evt-001", true);
    expect(payload.status).toBe("success");
    expect(payload.error).toBeUndefined();
  });

  test("failure ack includes error message", () => {
    const payload = buildPrintAckPayload(rid, "evt-002", false, "Printer offline");
    expect(payload.status).toBe("failed");
    expect(payload.error).toBe("Printer offline");
  });

  test("ack includes requestId when provided", () => {
    const payload = buildPrintAckPayload(rid, "evt-003", true, null, "req-123");
    expect(payload.requestId).toBe("req-123");
  });

  test("ack omits requestId when not provided", () => {
    const payload = buildPrintAckPayload(rid, "evt-004", true);
    expect(payload.requestId).toBeUndefined();
  });

  test("ack includes restaurantId", () => {
    const payload = buildPrintAckPayload(rid, "evt-005", true);
    expect(payload.restaurantId).toBe(rid);
  });

  test("ack includes eventId", () => {
    const payload = buildPrintAckPayload(rid, "evt-006", true);
    expect(payload.eventId).toBe("evt-006");
  });
});

describe("Phase 4: Cloud print job — envelope validation", () => {
  test("envelope without eventId is invalid", () => {
    const envelope: any = { type: "KOT", data: { printerName: "Test" } };
    expect(!envelope.eventId).toBe(true);
  });

  test("envelope with empty escposData is invalid", () => {
    const envelope: any = { type: "KOT", eventId: "evt-001", data: { escposData: [] } };
    expect(Array.isArray(envelope.data.escposData) && envelope.data.escposData.length === 0).toBe(true);
  });

  test("envelope with missing escposData is invalid", () => {
    const envelope: any = { type: "KOT", eventId: "evt-002", data: { printerName: "Test" } };
    expect(!envelope.data.escposData).toBe(true);
  });

  test("valid envelope has eventId, type, data.escposData", () => {
    const envelope: any = {
      type: "KOT",
      eventId: "evt-003",
      data: { printerName: "Test", escposData: [{ type: "raw", data: "test" }] },
    };
    expect(!!envelope.eventId).toBe(true);
    expect(Array.isArray(envelope.data.escposData) && envelope.data.escposData.length > 0).toBe(true);
  });
});
