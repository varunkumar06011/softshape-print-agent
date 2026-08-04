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
  const amount = Number(data.amount);
  const safeData: ExpenditurePrintData = {
    ...data,
    amount: Number.isFinite(amount) ? amount : 0,
    expenditureNo: Number(data.expenditureNo) || 0,
    paidToName: data.paidToName || '',
    paidToType: data.paidToType || '',
    status: data.status || 'ACTIVE',
    restaurant: data.restaurant
      ? {
          ...data.restaurant,
          name: data.restaurant.name != null ? String(data.restaurant.name) : undefined,
          receiptHeader: data.restaurant.receiptHeader != null ? String(data.restaurant.receiptHeader) : undefined,
          receiptSubHeader: data.restaurant.receiptSubHeader != null ? String(data.restaurant.receiptSubHeader) : undefined,
          address: data.restaurant.address != null ? String(data.restaurant.address) : undefined,
          phone: data.restaurant.phone != null ? String(data.restaurant.phone) : undefined,
          gstin: data.restaurant.gstin != null ? String(data.restaurant.gstin) : undefined,
        }
      : undefined,
  };
  return toBlocks(renderExpenditure(safeData));
}
