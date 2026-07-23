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
  renderCancelKOT,
} from "@softshape/output";
import type {
  PrintItem,
  OrderData,
  BillPrintRestaurant,
  BillPrintInput,
  CancelKotItem,
  CancelKotPrintInput,
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
  type CancelKotItem,
  type CancelKotPrintInput,
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

export function buildCancelKOT(input: CancelKotPrintInput): RawBlock[] {
  return toBlocks(renderCancelKOT(input));
}
