// ─────────────────────────────────────────────────────────────────────────────
// outputOrchestrator.test.ts — Tests for the Output Orchestrator (R2)
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, mock, beforeEach } from "bun:test";
import type { OutputIntent } from "@softshape/output";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockCreatePrintJob = mock(() => 1);
const mockDispatchSinglePrintJob = mock(() => Promise.resolve());
const mockEmitEvent = mock(() => {});
const mockResolvePrinterName = mock(() => "KitchenPrinter");
const mockGetDb = mock(() => ({
  query: mock(() => ({ get: mock(() => ({ printer_config: "{}" })) })),
}));

mock.module("../db.ts", () => ({
  getDb: mockGetDb,
  createPrintJob: mockCreatePrintJob,
}));

mock.module("../orderService.ts", () => ({
  dispatchSinglePrintJob: mockDispatchSinglePrintJob,
}));

mock.module("../eventBus.ts", () => ({
  emitEvent: mockEmitEvent,
}));

mock.module("../contract/events.ts", () => ({
  EVENT_NAMES: {
    PRINT_COMPLETED: "print.completed",
    PRINT_FAILED: "print.failed",
  },
}));

mock.module("../printer.ts", () => ({
  resolvePrinterName: mockResolvePrinterName,
}));

mock.module("../auth.ts", () => ({
  getRestaurantId: () => "test-restaurant-id",
}));

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockCreatePrintJob.mockClear();
  mockDispatchSinglePrintJob.mockClear();
  mockEmitEvent.mockClear();
  mockResolvePrinterName.mockClear();
  mockResolvePrinterName.mockImplementation(() => "KitchenPrinter");
  mockCreatePrintJob.mockImplementation(() => 42);
});

test("processOutputIntent renders and queues a PRINT_KOT job", async () => {
  const { processOutputIntent } = await import("../outputOrchestrator.ts");

  const intent: OutputIntent = {
    type: "OUTPUT",
    intentId: "test-intent-001",
    intent: "PRINT_KOT",
    payload: {
      tableNumber: "T5",
      orderId: "ord-123",
      items: [
        { name: "Chicken Biryani", quantity: 2, price: 220, type: "food", notes: null },
      ],
      kotId: "1",
      sectionName: "Main Hall",
      captainName: "Captain Test",
      requestId: "req-001",
    },
    priority: "CRITICAL",
  };

  const result = await processOutputIntent(intent, "test-restaurant-id", "ord-123");

  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0].ok).toBe(true);
  expect(result.jobs[0].jobId).toBe(42);
  expect(mockCreatePrintJob).toHaveBeenCalledTimes(1);
  expect(mockDispatchSinglePrintJob).toHaveBeenCalledTimes(1);
  expect(mockEmitEvent).toHaveBeenCalledTimes(1);
});

test("processOutputIntent returns error when renderer produces no output", async () => {
  const { processOutputIntent } = await import("../outputOrchestrator.ts");

  const intent: OutputIntent = {
    type: "OUTPUT",
    intentId: "test-intent-002",
    intent: "PRINT_KOT",
    payload: {
      tableNumber: "T5",
      orderId: "ord-456",
      items: [],
      kotId: "2",
      sectionName: "Main Hall",
      captainName: "Captain Test",
      requestId: "req-002",
    },
    priority: "NORMAL",
  };

  const result = await processOutputIntent(intent, "test-restaurant-id");

  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0].ok).toBe(false);
  expect(result.jobs[0].error).toBe("Renderer produced no output");
  expect(mockCreatePrintJob).not.toHaveBeenCalled();
  expect(mockDispatchSinglePrintJob).not.toHaveBeenCalled();
});

test("processOutputIntent handles PRINT_LIQUOR_KOT intent", async () => {
  const { processOutputIntent } = await import("../outputOrchestrator.ts");

  const intent: OutputIntent = {
    type: "OUTPUT",
    intentId: "test-intent-003",
    intent: "PRINT_LIQUOR_KOT",
    payload: {
      tableNumber: "T5",
      orderId: "ord-789",
      items: [
        { name: "Kingfisher Beer", quantity: 1, price: 180, type: "liquor", notes: null },
      ],
      kotId: "3",
      sectionName: "Bar",
      captainName: "Captain Test",
      requestId: "req-003",
    },
    priority: "CRITICAL",
  };

  const result = await processOutputIntent(intent, "test-restaurant-id");

  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0].ok).toBe(true);
  expect(mockCreatePrintJob).toHaveBeenCalledTimes(1);
  expect(mockDispatchSinglePrintJob).toHaveBeenCalledTimes(1);
});
