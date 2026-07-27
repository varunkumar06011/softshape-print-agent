// ─────────────────────────────────────────────────────────────────────────────
// outputPlanner.test.ts — Tests for the Output Planner (R2 + R3)
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, mock, beforeEach } from "bun:test";
import type { OutputIntent } from "@softshape/output";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockResolvePrinterName = mock(() => "KitchenPrinter");
const mockGetDb = mock(() => ({
  query: mock(() => ({
    get: mock(() => ({ printer_config: '{"printers":[{"name":"KitchenPrinter","type":"KITCHEN"}]}' })),
  })),
}));

mock.module("../printer.ts", () => ({
  resolvePrinterName: mockResolvePrinterName,
}));

mock.module("../db.ts", () => ({
  getDb: mockGetDb,
}));

mock.module("../auth.ts", () => ({
  getRestaurantId: () => "test-restaurant-id",
}));

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockResolvePrinterName.mockClear();
  mockResolvePrinterName.mockImplementation(() => "KitchenPrinter");
});

test("planOutputIntent transforms a PRINT_KOT intent with explicit printer into a single job", async () => {
  const { planOutputIntent } = await import("../outputPlanner.ts");

  const intent: OutputIntent = {
    type: "OUTPUT",
    intentId: "test-plan-001",
    intent: "PRINT_KOT",
    payload: {
      tableNumber: "T5",
      orderId: "ord-123",
      items: [{ name: "Biryani", quantity: 2, price: 220, type: "food", printerName: "KitchenPrinter" }],
      kotId: "1",
    },
    priority: "CRITICAL",
  };

  const jobs = planOutputIntent(intent, "test-restaurant-id");

  expect(jobs).toHaveLength(1);
  expect(jobs[0].intent).toBe("PRINT_KOT");
  expect(jobs[0].renderer).toBe("escpos");
  expect(jobs[0].destination.printerName).toBe("KitchenPrinter");
  expect(jobs[0].copies).toBe(1);
  expect(jobs[0].priority).toBe("CRITICAL");
  expect(jobs[0].intentId).toBe("test-plan-001");
});

test("planOutputIntent expands PRINT_KOT into multiple jobs by printer (R3)", async () => {
  const { planOutputIntent } = await import("../outputPlanner.ts");

  // Mock: resolve to different printers based on target
  mockResolvePrinterName.mockImplementation((_, target) => {
    if (target === "BAR_PRINTER") return "BarPrinter";
    return "KitchenPrinter";
  });

  // PRINT_KOT with only food items — liquor items are filtered out.
  // Multi-printer expansion still works when food items target different printers.
  const intent: OutputIntent = {
    type: "OUTPUT",
    intentId: "test-plan-multi",
    intent: "PRINT_KOT",
    payload: {
      tableNumber: "T5",
      orderId: "ord-multi",
      items: [
        { name: "Biryani", quantity: 2, price: 220, menuType: "FOOD", printerTarget: "KOT_PRINTER" },
        { name: "Beer", quantity: 1, price: 180, menuType: "LIQUOR", printerTarget: "BAR_PRINTER" },
      ],
      kotId: "5",
    },
    priority: "CRITICAL",
  };

  const jobs = planOutputIntent(intent, "test-restaurant-id");

  // PRINT_KOT filters to food items only → 1 job for KitchenPrinter
  expect(jobs).toHaveLength(1);
  expect(jobs[0].intent).toBe("PRINT_KOT");
  expect(jobs[0].destination.printerName).toBe("KitchenPrinter");
});


test("planOutputIntent filters PRINT_LIQUOR_KOT to liquor items only", async () => {
  const { planOutputIntent } = await import("../outputPlanner.ts");

  mockResolvePrinterName.mockImplementation((_, target) => {
    if (target === "KOT_PRINTER") return "KitchenPrinter";
    return "BarPrinter";
  });

  const intent: OutputIntent = {
    type: "OUTPUT",
    intentId: "test-plan-liquor-filter",
    intent: "PRINT_LIQUOR_KOT",
    payload: {
      tableNumber: "T5",
      orderId: "ord-liquor-filter",
      items: [
        { name: "Biryani", quantity: 2, price: 220, menuType: "FOOD", printerTarget: "KOT_PRINTER" },
        { name: "Beer", quantity: 1, price: 180, menuType: "LIQUOR", printerTarget: "BAR_PRINTER" },
      ],
      kotId: "5L",
    },
    priority: "CRITICAL",
  };

  const jobs = planOutputIntent(intent, "test-restaurant-id");

  // PRINT_LIQUOR_KOT filters to liquor items only → 1 job for BarPrinter
  expect(jobs).toHaveLength(1);
  expect(jobs[0].intent).toBe("PRINT_LIQUOR_KOT");
  expect(jobs[0].destination.printerName).toBe("BarPrinter");
});

test("planOutputIntent legacy fallback produces single job per intent (R3)", async () => {
  const { planOutputIntent } = await import("../outputPlanner.ts");

  // No printerName on items, no resolvePrinterName match → legacy fallback
  mockResolvePrinterName.mockImplementation(() => null);

  // PRINT_KOT with mixed items → only food items processed → 1 kitchen job
  const foodIntent: OutputIntent = {
    type: "OUTPUT",
    intentId: "test-plan-legacy-food",
    intent: "PRINT_KOT",
    payload: {
      tableNumber: "T5",
      orderId: "ord-legacy",
      items: [
        { name: "Biryani", quantity: 2, price: 220, menuType: "FOOD" },
        { name: "Beer", quantity: 1, price: 180, menuType: "LIQUOR" },
      ],
      kotId: "6",
    },
    priority: "NORMAL",
  };

  const foodJobs = planOutputIntent(foodIntent, "test-restaurant-id");
  expect(foodJobs).toHaveLength(1);
  expect(foodJobs[0].intent).toBe("PRINT_KOT");

  // PRINT_LIQUOR_KOT with mixed items → only liquor items processed → 1 bar job
  const liquorIntent: OutputIntent = {
    type: "OUTPUT",
    intentId: "test-plan-legacy-liquor",
    intent: "PRINT_LIQUOR_KOT",
    payload: {
      tableNumber: "T5",
      orderId: "ord-legacy",
      items: [
        { name: "Biryani", quantity: 2, price: 220, menuType: "FOOD" },
        { name: "Beer", quantity: 1, price: 180, menuType: "LIQUOR" },
      ],
      kotId: "6L",
    },
    priority: "NORMAL",
  };

  const liquorJobs = planOutputIntent(liquorIntent, "test-restaurant-id");
  expect(liquorJobs).toHaveLength(1);
  expect(liquorJobs[0].intent).toBe("PRINT_LIQUOR_KOT");
});

test("planOutputIntent resolves printer from printer config when no explicit name", async () => {
  const { planOutputIntent } = await import("../outputPlanner.ts");

  const intent: OutputIntent = {
    type: "OUTPUT",
    intentId: "test-plan-002",
    intent: "PRINT_LIQUOR_KOT",
    payload: {
      tableNumber: "T5",
      orderId: "ord-456",
      items: [{ name: "Beer", quantity: 1, price: 180, type: "liquor" }],
      kotId: "2",
      printerTarget: "BAR_PRINTER",
    },
    priority: "HIGH",
  };

  mockResolvePrinterName.mockImplementation(() => "BarPrinter");

  const jobs = planOutputIntent(intent, "test-restaurant-id");

  expect(jobs).toHaveLength(1);
  expect(jobs[0].destination.printerName).toBe("BarPrinter");
});

test("planOutputIntent sets copies from payload when provided", async () => {
  const { planOutputIntent } = await import("../outputPlanner.ts");

  const intent: OutputIntent = {
    type: "OUTPUT",
    intentId: "test-plan-003",
    intent: "PRINT_BILL",
    payload: {
      tableNumber: "T5",
      orderId: "ord-789",
      items: [],
      copies: 3,
    },
    priority: "NORMAL",
  };

  const jobs = planOutputIntent(intent, "test-restaurant-id");

  expect(jobs[0].copies).toBe(3);
});

test("planOutputIntent defaults copies to 1 when not specified", async () => {
  const { planOutputIntent } = await import("../outputPlanner.ts");

  const intent: OutputIntent = {
    type: "OUTPUT",
    intentId: "test-plan-004",
    intent: "PRINT_BILL",
    payload: {
      tableNumber: "T5",
      orderId: "ord-000",
      items: [],
    },
    priority: "NORMAL",
  };

  const jobs = planOutputIntent(intent, "test-restaurant-id");

  expect(jobs[0].copies).toBe(1);
});
