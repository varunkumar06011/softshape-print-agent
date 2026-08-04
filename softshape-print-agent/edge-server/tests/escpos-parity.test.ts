// ─────────────────────────────────────────────────────────────────────────────
// escpos-parity.test.ts — ESC/POS bill parity test between backend and edge
// ─────────────────────────────────────────────────────────────────────────────
// Constructs one order with GST, a discount, and a service charge, runs it
// through both the backend's escpos.ts buildBill() and the edge server's
// escpos.ts buildBill(), and asserts the GST amount, discount amount, service
// charge amount, and final total are identical between the two.
//
// This is the guard against silent drift between the two implementations.
// Run with: bun test escpos-parity.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from "bun:test";
import { buildBill as edgeBuildBill } from "../escpos.ts";
import { buildBill as backendBuildBill, buildFinalBill as backendBuildFinalBill, type BillData } from "../../../../softshape-backend/src/utils/escpos.ts";

// ── Test data ─────────────────────────────────────────────────────────────────

const TEST_ITEMS = [
  { name: "Paneer Butter Masala", quantity: 1, price: 240, menuType: "FOOD" as const },
  { name: "Butter Naan", quantity: 2, price: 40, menuType: "FOOD" as const },
  { name: "Kingfisher Beer", quantity: 1, price: 180, menuType: "LIQUOR" as const },
];

const TEST_RESTAURANT = {
  name: "Test Restaurant",
  receiptHeader: "TEST RESTAURANT",
  receiptSubHeader: null,
  address: null,
  phone: null,
  gstin: "27ABCDE1234F1Z5",
};

const BASE_INPUT = {
  tableNumber: "T5",
  items: TEST_ITEMS,
  totalAmount: 500,
  restaurant: TEST_RESTAURANT,
  sectionTag: null,
  gstCategory: "NON_AC",
  gstRate: null,
  gstRegistered: true,
  pricesIncludeGst: false,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract numeric amounts from ESC/POS output strings.
 * Returns a map of label -> amount for known line types.
 */
function parseBillAmounts(escposData: { data: string }[]): {
  subtotal: number | null;
  cgst: number | null;
  sgst: number | null;
  serviceCharge: number | null;
  discount: number | null;
  total: number | null;
} {
  const raw = escposData[0]?.data || "";
  const result: any = {
    subtotal: null,
    cgst: null,
    sgst: null,
    serviceCharge: null,
    discount: null,
    total: null,
  };

  // Match "Subtotal" line
  const subMatch = raw.match(/Subtotal\s+Rs\.([\d.]+)/);
  if (subMatch) result.subtotal = parseFloat(subMatch[1]);

  // Match "CGST" line
  const cgstMatch = raw.match(/CGST\s+Rs\.([\d.]+)/);
  if (cgstMatch) result.cgst = parseFloat(cgstMatch[1]);

  // Match "SGST" line
  const sgstMatch = raw.match(/SGST\s+Rs\.([\d.]+)/);
  if (sgstMatch) result.sgst = parseFloat(sgstMatch[1]);

  // Match "Service Charge" line
  const scMatch = raw.match(/Service Charge\s+\d+%\s+Rs\.([\d.]+)/);
  if (scMatch) result.serviceCharge = parseFloat(scMatch[1]);

  // Match "(-) Discount" line — amount may have padStart spaces after colon
  const discMatch = raw.match(/\(-\) Discount\s+\d+%\s*:\s*(\d+)/);
  if (discMatch) result.discount = parseInt(discMatch[1], 10);

  // Match "TOTAL" line
  const totalMatch = raw.match(/TOTAL\s+Rs\.([\d.]+)/);
  if (totalMatch) result.total = parseFloat(totalMatch[1]);

  return result;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("ESC/POS parity — GST only (no discount, no service charge)", () => {
  const edgeResult = edgeBuildBill(BASE_INPUT);
  const backendResult = backendBuildBill(BASE_INPUT);

  const edge = parseBillAmounts(edgeResult as any);
  const backend = parseBillAmounts(backendResult as any);

  expect(edge.subtotal).toBe(backend.subtotal);
  expect(edge.cgst).toBe(backend.cgst);
  expect(edge.sgst).toBe(backend.sgst);
  expect(edge.serviceCharge).toBe(backend.serviceCharge);
  expect(edge.discount).toBe(backend.discount);
  expect(edge.total).toBe(backend.total);
});

test("ESC/POS parity — GST + 10% discount", () => {
  const input = { ...BASE_INPUT, discountPercent: 10 };

  const edgeResult = edgeBuildBill(input);
  const backendResult = backendBuildBill(input);

  const edge = parseBillAmounts(edgeResult as any);
  const backend = parseBillAmounts(backendResult as any);

  expect(edge.subtotal).toBe(backend.subtotal);
  expect(edge.cgst).toBe(backend.cgst);
  expect(edge.sgst).toBe(backend.sgst);
  expect(edge.discount).toBe(backend.discount);
  expect(edge.total).toBe(backend.total);
});

test("ESC/POS parity — GST + 5% service charge", () => {
  const input = { ...BASE_INPUT, serviceChargePercent: 5 };

  const edgeResult = edgeBuildBill(input);
  const backendResult = backendBuildBill(input);

  const edge = parseBillAmounts(edgeResult as any);
  const backend = parseBillAmounts(backendResult as any);

  expect(edge.subtotal).toBe(backend.subtotal);
  expect(edge.cgst).toBe(backend.cgst);
  expect(edge.sgst).toBe(backend.sgst);
  expect(edge.serviceCharge).toBe(backend.serviceCharge);
  expect(edge.total).toBe(backend.total);
});

test("ESC/POS parity — GST + 5% service charge + 10% discount", () => {
  const input = { ...BASE_INPUT, discountPercent: 10, serviceChargePercent: 5 };

  const edgeResult = edgeBuildBill(input);
  const backendResult = backendBuildBill(input);

  const edge = parseBillAmounts(edgeResult as any);
  const backend = parseBillAmounts(backendResult as any);

  expect(edge.subtotal).toBe(backend.subtotal);
  expect(edge.cgst).toBe(backend.cgst);
  expect(edge.sgst).toBe(backend.sgst);
  expect(edge.serviceCharge).toBe(backend.serviceCharge);
  expect(edge.discount).toBe(backend.discount);
  expect(edge.total).toBe(backend.total);
});

test("ESC/POS parity — AC GST rate (18%) + discount + service charge", () => {
  const input = {
    ...BASE_INPUT,
    gstCategory: "AC",
    discountPercent: 15,
    serviceChargePercent: 10,
  };

  const edgeResult = edgeBuildBill(input);
  const backendResult = backendBuildBill(input);

  const edge = parseBillAmounts(edgeResult as any);
  const backend = parseBillAmounts(backendResult as any);

  expect(edge.subtotal).toBe(backend.subtotal);
  expect(edge.cgst).toBe(backend.cgst);
  expect(edge.sgst).toBe(backend.sgst);
  expect(edge.serviceCharge).toBe(backend.serviceCharge);
  expect(edge.discount).toBe(backend.discount);
  expect(edge.total).toBe(backend.total);
});

test("ESC/POS parity — pricesIncludeGst with discount and service charge", () => {
  const input = {
    ...BASE_INPUT,
    pricesIncludeGst: true,
    discountPercent: 10,
    serviceChargePercent: 5,
  };

  const edgeResult = edgeBuildBill(input);
  const backendResult = backendBuildBill(input);

  const edge = parseBillAmounts(edgeResult as any);
  const backend = parseBillAmounts(backendResult as any);

  expect(edge.subtotal).toBe(backend.subtotal);
  expect(edge.cgst).toBe(backend.cgst);
  expect(edge.sgst).toBe(backend.sgst);
  expect(edge.serviceCharge).toBe(backend.serviceCharge);
  expect(edge.discount).toBe(backend.discount);
  expect(edge.total).toBe(backend.total);
});

test("ESC/POS parity — GST-unregistered (no tax) with discount", () => {
  const input = {
    ...BASE_INPUT,
    gstRegistered: false,
    discountPercent: 10,
  };

  const edgeResult = edgeBuildBill(input);
  const backendResult = backendBuildBill(input);

  const edge = parseBillAmounts(edgeResult as any);
  const backend = parseBillAmounts(backendResult as any);

  expect(edge.subtotal).toBe(backend.subtotal);
  expect(edge.cgst).toBe(backend.cgst);
  expect(edge.sgst).toBe(backend.sgst);
  expect(edge.discount).toBe(backend.discount);
  expect(edge.total).toBe(backend.total);
});

test("ESC/POS parity — custom GST rate (12%) with discount and service charge", () => {
  const input = {
    ...BASE_INPUT,
    gstRate: 12,
    discountPercent: 8,
    serviceChargePercent: 3,
  };

  const edgeResult = edgeBuildBill(input);
  const backendResult = backendBuildBill(input);

  const edge = parseBillAmounts(edgeResult as any);
  const backend = parseBillAmounts(backendResult as any);

  expect(edge.subtotal).toBe(backend.subtotal);
  expect(edge.cgst).toBe(backend.cgst);
  expect(edge.sgst).toBe(backend.sgst);
  expect(edge.serviceCharge).toBe(backend.serviceCharge);
  expect(edge.discount).toBe(backend.discount);
  expect(edge.total).toBe(backend.total);
});

// ─────────────────────────────────────────────────────────────────────────────
// buildFinalBill vs buildBill parity — ensures the two backend bill builders
// can't drift from each other on service charge, discount, and total.
// buildFinalBill is used for the online bill-print path; buildBill is used by
// the edge server. If they drift, one path prints wrong bills.
// ─────────────────────────────────────────────────────────────────────────────

function parseFinalBillAmounts(result: any[]) {
  // buildFinalBill returns [{ type: 'raw', format: 'plain', data: '...' }]
  const text = typeof result[0]?.data === 'string' ? result[0].data : result.join("");
  const subtotalMatch = text.match(/Sub Total\s*:\s*(\d+)/);
  const cgstMatch = text.match(/CGST\s*:\s*(\d+)/);
  const sgstMatch = text.match(/SGST\s*:\s*(\d+)/);
  const scMatch = text.match(/Service Charge\s*(\d+)%\s*:\s*(\d+)/);
  const discMatch = text.match(/Discount\s*(\d+)%\s*:\s*(\d+)/);
  const totalMatch = text.match(/Grand Total\s+(\d+)/);

  return {
    subtotal: subtotalMatch ? parseInt(subtotalMatch[1]) : 0,
    cgst: cgstMatch ? parseInt(cgstMatch[1]) : 0,
    sgst: sgstMatch ? parseInt(sgstMatch[1]) : 0,
    serviceCharge: scMatch ? parseInt(scMatch[2]) : 0,
    discount: discMatch ? parseInt(discMatch[2]) : 0,
    total: totalMatch ? parseInt(totalMatch[1]) : 0,
  };
}

function makeBillData(opts: {
  subtotal: number;
  discount?: { percent: number; amount: number };
  serviceCharge?: { percent: number; amount: number };
  tax: { cgst: number; sgst: number; total: number };
  grandTotal: number;
}): BillData {
  return {
    billNumber: "TEST-001",
    date: "12/07/2026",
    time: "09:30 PM",
    tableNumber: "T1",
    captain: "Test",
    items: TEST_ITEMS.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      price: i.price,
      amount: i.price * i.quantity,
      menuType: i.menuType,
    })),
    subtotal: opts.subtotal,
    discount: opts.discount,
    serviceCharge: opts.serviceCharge,
    tax: opts.tax,
    grandTotal: opts.grandTotal,
    section: "Main Hall",
    itemCount: TEST_ITEMS.length,
    qtyCount: TEST_ITEMS.reduce((s, i) => s + i.quantity, 0),
  };
}

test("buildFinalBill vs buildBill parity — GST + 5% service charge + 10% discount", () => {
  const foodSubtotal = TEST_ITEMS.filter((i) => i.menuType === "FOOD").reduce((s, i) => s + i.price * i.quantity, 0);
  const liquorSubtotal = TEST_ITEMS.filter((i) => i.menuType !== "FOOD").reduce((s, i) => s + i.price * i.quantity, 0);
  const gstRate = 5;
  const scPercent = 5;
  const discPercent = 10;

  // buildBill formula: discount first, then tax on discountedSubtotal, then service charge on (discountedSubtotal + tax)
  const totalSubtotal = foodSubtotal + liquorSubtotal;
  const discountAmount = Math.round(totalSubtotal * (discPercent / 100) * 100) / 100;
  const discountedSubtotal = Math.max(0, totalSubtotal - discountAmount);
  const tax = Math.round(discountedSubtotal * gstRate / 100 * 100) / 100;
  const cgst = Math.round(tax / 2 * 100) / 100;
  const sgst = Math.round(tax / 2 * 100) / 100;
  const serviceChargeAmount = Math.round((discountedSubtotal + tax) * (scPercent / 100) * 100) / 100;
  const total = Math.round(Math.max(0, discountedSubtotal + tax + serviceChargeAmount) * 100) / 100;

  const buildBillInput = {
    items: TEST_ITEMS.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price, menuType: i.menuType })),
    restaurantName: "Test Restaurant",
    billNumber: "TEST-001",
    tableNumber: "T1",
    captainName: "Test",
    gstRate,
    gstRegistered: true,
    pricesIncludeGst: false,
    discountPercent: discPercent,
    serviceChargePercent: scPercent,
  };

  const finalBillData = makeBillData({
    subtotal: Math.round(totalSubtotal),
    discount: { percent: discPercent, amount: Math.round(discountAmount) },
    serviceCharge: { percent: scPercent, amount: Math.round(serviceChargeAmount) },
    tax: { cgst, sgst, total: tax },
    grandTotal: total,
  });

  const buildBillResult = parseBillAmounts(backendBuildBill(buildBillInput as any) as any);
  const finalBillResult = parseFinalBillAmounts(backendBuildFinalBill(finalBillData) as any);

  // Both buildBill and buildFinalBill round to integers.
  // Compare values to verify the calculation matches.
  expect(finalBillResult.serviceCharge).toBe(Math.round(buildBillResult.serviceCharge));
  expect(finalBillResult.discount).toBe(Math.round(buildBillResult.discount));
  expect(finalBillResult.total).toBe(Math.round(buildBillResult.total));
});

test("buildFinalBill vs buildBill parity — no service charge, no discount", () => {
  const foodSubtotal = TEST_ITEMS.filter((i) => i.menuType === "FOOD").reduce((s, i) => s + i.price * i.quantity, 0);
  const liquorSubtotal = TEST_ITEMS.filter((i) => i.menuType !== "FOOD").reduce((s, i) => s + i.price * i.quantity, 0);
  const gstRate = 5;

  // buildBill formula: tax on full subtotal (no gstEnabled=false on any item)
  const totalSubtotal = foodSubtotal + liquorSubtotal;
  const tax = Math.round(totalSubtotal * gstRate / 100 * 100) / 100;
  const cgst = Math.round(tax / 2 * 100) / 100;
  const sgst = Math.round(tax / 2 * 100) / 100;
  const total = Math.round(totalSubtotal + tax);

  const buildBillInput = {
    items: TEST_ITEMS.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price, menuType: i.menuType })),
    restaurantName: "Test Restaurant",
    billNumber: "TEST-002",
    tableNumber: "T1",
    captainName: "Test",
    gstRate,
    gstRegistered: true,
    pricesIncludeGst: false,
  };

  const finalBillData = makeBillData({
    subtotal: Math.round(totalSubtotal),
    tax: { cgst, sgst, total: tax },
    grandTotal: total,
  });

  const buildBillResult = parseBillAmounts(backendBuildBill(buildBillInput as any) as any);
  const finalBillResult = parseFinalBillAmounts(backendBuildFinalBill(finalBillData) as any);

  expect(finalBillResult.serviceCharge).toBe(0);
  expect(finalBillResult.discount).toBe(0);
  expect(finalBillResult.total).toBe(Math.round(buildBillResult.total));
});

test("buildFinalBill vs buildBill parity — 10% service charge only (no discount)", () => {
  const foodSubtotal = TEST_ITEMS.filter((i) => i.menuType === "FOOD").reduce((s, i) => s + i.price * i.quantity, 0);
  const liquorSubtotal = TEST_ITEMS.filter((i) => i.menuType !== "FOOD").reduce((s, i) => s + i.price * i.quantity, 0);
  const gstRate = 12;
  const scPercent = 10;

  // buildBill formula: tax on full subtotal (no gstEnabled=false), no discount, service charge on (subtotal + tax)
  const totalSubtotal = foodSubtotal + liquorSubtotal;
  const tax = Math.round(totalSubtotal * gstRate / 100 * 100) / 100;
  const cgst = Math.round(tax / 2 * 100) / 100;
  const sgst = Math.round(tax / 2 * 100) / 100;
  const serviceChargeAmount = Math.round((totalSubtotal + tax) * (scPercent / 100) * 100) / 100;
  const total = Math.round(totalSubtotal + tax + serviceChargeAmount);

  const buildBillInput = {
    items: TEST_ITEMS.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price, menuType: i.menuType })),
    restaurantName: "Test Restaurant",
    billNumber: "TEST-003",
    tableNumber: "T1",
    captainName: "Test",
    gstRate,
    gstRegistered: true,
    pricesIncludeGst: false,
    serviceChargePercent: scPercent,
  };

  const finalBillData = makeBillData({
    subtotal: Math.round(totalSubtotal),
    serviceCharge: { percent: scPercent, amount: Math.round(serviceChargeAmount) },
    tax: { cgst, sgst, total: tax },
    grandTotal: total,
  });

  const buildBillResult = parseBillAmounts(backendBuildBill(buildBillInput as any) as any);
  const finalBillResult = parseFinalBillAmounts(backendBuildFinalBill(finalBillData) as any);

  expect(finalBillResult.serviceCharge).toBe(Math.round(buildBillResult.serviceCharge));
  expect(finalBillResult.serviceCharge).toBeGreaterThan(0);
  expect(finalBillResult.discount).toBe(0);
  expect(finalBillResult.total).toBe(Math.round(buildBillResult.total));
});
