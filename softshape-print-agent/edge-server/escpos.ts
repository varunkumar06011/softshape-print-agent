// ─────────────────────────────────────────────────────────────────────────────
// ESC/POS Builders — Compatibility shim for @softshape/output
// ─────────────────────────────────────────────────────────────────────────────
// This file re-exports the shared renderer package functions with the original
// builder names and return types. Existing imports from "./escpos" continue
// to work unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import {
  renderFoodKOT,
  renderLiquorKOT,
  renderBill,
  renderFinalBill,
  renderCancelKOT,
  renderXReport,
  renderExpenditure,
} from "@softshape/output";
import type {
  PrintItem,
  OrderData,
  BillPrintRestaurant,
  BillPrintInput,
  BillData,
  CancelKotItem,
  CancelKotPrintInput,
  XReportData,
  ExpenditurePrintData,
  RenderedOutput,
} from "@softshape/output";

type RawBlock = { type: string; format: string; data: string };

function toBlocks(rendered: RenderedOutput): RawBlock[] {
  return rendered.blocks as unknown as RawBlock[];
}

export {
  type PrintItem,
  type OrderData,
  type BillPrintRestaurant,
  type BillPrintInput,
  type BillData,
  type CancelKotItem,
  type CancelKotPrintInput,
  type XReportData,
  type ExpenditurePrintData,
};

export function buildFoodKOT(orderData: OrderData): RawBlock[] {
  return toBlocks(renderFoodKOT(orderData));
}

export function buildLiquorKOT(orderData: OrderData): RawBlock[] {
  return toBlocks(renderLiquorKOT(orderData));
}

export function buildBill(input: BillPrintInput): RawBlock[] {
  return toBlocks(renderBill(input));
}

export function buildFinalBill(data: BillData): RawBlock[] {
  return toBlocks(renderFinalBill(data));
}

export function buildCancelKOT(input: CancelKotPrintInput): RawBlock[] {
  return toBlocks(renderCancelKOT(input));
}

export function buildXReport(data: XReportData): RawBlock[] {
  return toBlocks(renderXReport(data));
}

export function buildExpenditure(data: ExpenditurePrintData): RawBlock[] {
  return toBlocks(renderExpenditure(data));
}
