// ─────────────────────────────────────────────────────────────────────────────
// outputOrchestrator.test.ts — Tests for the Output Orchestrator (R2)
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, mock, beforeEach } from "bun:test";
import type { OutputIntent } from "@softshape/output";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockCreatePrintJob = mock(() => 1);
const mockDispatchSinglePrintJob = mock(() => Promise.resolve());
const mockAwaitDispatchBounded = mock(() => Promise.resolve({ ok: true, printerName: "KitchenPrinter", bytes: 0, method: "print_service", eventId: "test" }));
const mockEmitEvent = mock(() => {});
const mockResolvePrinterName = mock(() => "KitchenPrinter");
const mockGetPrintJobByEventId = mock(() => ({ status: "printed", last_error: null, acked_via: "local" }));
const mockGetDb = mock(() => ({
  query: mock(() => ({ get: mock(() => ({ printer_config: "{}" })) })),
}));

mock.module("../db.ts", () => ({
  getDb: mockGetDb,
  createPrintJob: mockCreatePrintJob,
  getPrintJobByEventId: mockGetPrintJobByEventId,
}));

mock.module("../orderService.ts", () => ({
  dispatchSinglePrintJob: mockDispatchSinglePrintJob,
  awaitDispatchBounded: mockAwaitDispatchBounded,
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
  mockAwaitDispatchBounded.mockClear();
  mockEmitEvent.mockClear();
  mockResolvePrinterName.mockClear();
  mockGetPrintJobByEventId.mockClear();
  mockResolvePrinterName.mockImplementation(() => "KitchenPrinter");
  mockCreatePrintJob.mockImplementation(() => 42);
  mockAwaitDispatchBounded.mockImplementation(() => Promise.resolve({ ok: true, printerName: "KitchenPrinter", bytes: 0, method: "print_service", eventId: "test" }));
  mockGetPrintJobByEventId.mockImplementation(() => ({ status: "printed", last_error: null, acked_via: "local" }));
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
  expect(mockAwaitDispatchBounded).toHaveBeenCalledTimes(1);
  expect(mockEmitEvent).toHaveBeenCalledTimes(1);
});

test("processOutputIntent returns empty results when items array is empty", async () => {
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

  // Planner returns 0 jobs for empty items array
  expect(result.jobs).toHaveLength(0);
  expect(mockCreatePrintJob).not.toHaveBeenCalled();
  expect(mockAwaitDispatchBounded).not.toHaveBeenCalled();
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
        { name: "Kingfisher Beer", quantity: 1, price: 180, menuType: "LIQUOR", notes: null },
      ],
      kotId: "3",
      sectionName: "Bar",
      captainName: "Captain Test",
      requestId: "req-003",
    },
    priority: "CRITICAL",
  };

  const result = await processOutputIntent(intent, "test-restaurant-id");

  // Planner resolves printer for the item, produces 1 job
  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0].ok).toBe(true);
  expect(mockCreatePrintJob).toHaveBeenCalledTimes(1);
  expect(mockAwaitDispatchBounded).toHaveBeenCalledTimes(1);
});

test("processOutputIntent produces multiple jobs for mixed food+liquor KOT (R3)", async () => {
  const { processOutputIntent } = await import("../outputOrchestrator.ts");

  mockResolvePrinterName.mockImplementation((_, target) => {
    if (target === "BAR_PRINTER") return "BarPrinter";
    return "KitchenPrinter";
  });
  mockCreatePrintJob.mockImplementation(() => 99);

  // The planner filters items by intent type: PRINT_KOT processes only food,
  // PRINT_LIQUOR_KOT processes only liquor. orderService sends separate
  // intents for kitchen and bar — mirror that here.
  const foodIntent: OutputIntent = {
    type: "OUTPUT",
    intentId: "test-intent-kitchen-r3",
    intent: "PRINT_KOT",
    payload: {
      tableNumber: "T10",
      orderId: "ord-multi-r3",
      items: [
        { name: "Biryani", quantity: 2, price: 220, menuType: "FOOD", printerTarget: "KOT_PRINTER" },
      ],
      kotId: "10",
      sectionName: "Main Hall",
      captainName: "Captain Multi",
      requestId: "req-multi-r3",
    },
    priority: "CRITICAL",
  };

  const liquorIntent: OutputIntent = {
    type: "OUTPUT",
    intentId: "test-intent-bar-r3",
    intent: "PRINT_LIQUOR_KOT",
    payload: {
      tableNumber: "T10",
      orderId: "ord-multi-r3",
      items: [
        { name: "Beer", quantity: 1, price: 180, menuType: "LIQUOR", printerTarget: "BAR_PRINTER" },
      ],
      kotId: "10",
      sectionName: "Main Hall",
      captainName: "Captain Multi",
      requestId: "req-multi-r3",
    },
    priority: "CRITICAL",
  };

  const foodResult = await processOutputIntent(foodIntent, "test-restaurant-id", "ord-multi-r3");
  const liquorResult = await processOutputIntent(liquorIntent, "test-restaurant-id", "ord-multi-r3");

  // Each intent produces 1 job — 2 total across kitchen + bar
  expect(foodResult.jobs).toHaveLength(1);
  expect(liquorResult.jobs).toHaveLength(1);
  expect(foodResult.jobs[0].ok).toBe(true);
  expect(liquorResult.jobs[0].ok).toBe(true);
  expect(mockCreatePrintJob).toHaveBeenCalledTimes(2);
  expect(mockAwaitDispatchBounded).toHaveBeenCalledTimes(2);
  expect(mockEmitEvent).toHaveBeenCalledTimes(2);
});
