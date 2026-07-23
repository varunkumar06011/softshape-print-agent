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

  // Mock: first call resolves to KitchenPrinter, second to BarPrinter
  let callCount = 0;
  mockResolvePrinterName.mockImplementation((_, target) => {
    callCount++;
    if (target === "BAR_PRINTER") return "BarPrinter";
    return "KitchenPrinter";
  });

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

  // Should produce 2 jobs: one for kitchen, one for bar
  expect(jobs.length).toBeGreaterThanOrEqual(2);
  const kitchenJob = jobs.find(j => j.destination.printerName === "KitchenPrinter");
  const barJob = jobs.find(j => j.destination.printerName === "BarPrinter");
  expect(kitchenJob).toBeDefined();
  expect(kitchenJob.intent).toBe("PRINT_KOT");
  expect(barJob).toBeDefined();
  expect(barJob.intent).toBe("PRINT_LIQUOR_KOT");
});

test("planOutputIntent splits items by menuType in legacy fallback (R3)", async () => {
  const { planOutputIntent } = await import("../outputPlanner.ts");

  // No printerName on items, no resolvePrinterName match → legacy fallback
  mockResolvePrinterName.mockImplementation(() => null);

  const intent: OutputIntent = {
    type: "OUTPUT",
    intentId: "test-plan-legacy",
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

  const jobs = planOutputIntent(intent, "test-restaurant-id");

  // Legacy fallback: split by menuType → 2 jobs (kitchen + bar), both with null printer
  const foodJobs = jobs.filter(j => j.intent === "PRINT_KOT");
  const liquorJobs = jobs.filter(j => j.intent === "PRINT_LIQUOR_KOT");
  expect(foodJobs.length).toBe(1);
  expect(liquorJobs.length).toBe(1);
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
