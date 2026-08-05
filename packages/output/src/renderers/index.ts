import type { OutputIntentType } from "../models/OutputIntent";
import type { RenderedOutput } from "../models/RenderedOutput";

export type RenderFn = (payload: Record<string, unknown>) => RenderedOutput | null;

const registry = new Map<string, RenderFn>();

export function register(intent: OutputIntentType, fn: RenderFn): void {
  registry.set(intent, fn);
}

export function resolve(intent: OutputIntentType): RenderFn | undefined {
  return registry.get(intent);
}

export function render(intent: OutputIntentType, payload: Record<string, unknown>): RenderedOutput | null {
  const fn = registry.get(intent);
  return fn ? fn(payload) : null;
}

// ── Register ESC/POS renderers at import time ────────────────────────────────
import { renderFoodKOT, renderLiquorKOT } from "./escpos/renderKot";
import { renderFinalBill, renderBill } from "./escpos/renderBill";
import { renderCancelKOT } from "./escpos/renderCancel";
import { renderTableSwap } from "./escpos/renderTableSwap";
import { renderXReport } from "./escpos/renderXReport";
import { renderExpenditure } from "./escpos/renderExpenditure";
import { renderReceipt } from "./escpos/renderReceipt";

register("PRINT_KOT", (p) => renderFoodKOT(p as any));
register("PRINT_LIQUOR_KOT", (p) => renderLiquorKOT(p as any));
register("PRINT_BILL", (p) => renderFinalBill(p as any));
register("PRINT_CANCEL_KOT", (p) => renderCancelKOT(p as any));
register("PRINT_TABLE_SWAP", (p) => renderTableSwap(p as any));
register("PRINT_X_REPORT", (p) => renderXReport(p as any));
register("PRINT_EXPENDITURE", (p) => renderExpenditure(p as any));
register("PRINT_RECEIPT", (p) => renderReceipt(p as any, (p as any).tax as any));
