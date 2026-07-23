// ─────────────────────────────────────────────────────────────────────────────
// outputPlanner.ts — Output Planner: Intent → Job transformation
// ─────────────────────────────────────────────────────────────────────────────
// Transforms an OutputIntent into one or more OutputJobs. This is where the
// Runtime injects policy: resolving printers, selecting renderers, determining
// copies, assigning priority.
//
// R3: KOT intents (PRINT_KOT, PRINT_LIQUOR_KOT) now expand to multiple jobs
// by grouping items by resolved printer name. Non-KOT intents remain
// single-job.
// ─────────────────────────────────────────────────────────────────────────────

import type { OutputIntent, OutputJob, Destination, OutputIntentType } from "@softshape/output";
import { resolvePrinterName } from "./printer.ts";
import { getDb } from "./db.ts";
import { getRestaurantId } from "./auth.ts";

function getOutletPrinterConfig(restaurantId: string): Record<string, any> {
  const db = getDb();
  const row = db.query("SELECT printer_config FROM outlet WHERE id = ?").get(restaurantId) as { printer_config: string } | null;
  if (!row?.printer_config) return {};
  try {
    return JSON.parse(row.printer_config);
  } catch {
    return {};
  }
}

interface PlannerKotItem {
  name: string;
  quantity: number;
  price: number;
  notes?: string | null;
  menuType?: string;
  printerName?: string | null;
  printerTarget?: string | null;
  categoryPrinterTarget?: string | null;
}

/**
 * Group KOT items by resolved printer name and produce one OutputJob per group.
 * Mirrors the logic in orderService.ts:buildKotPrintGroups but produces OutputJob[]
 * instead of raw ESC/POS groups.
 */
function planKotJobs(
  intent: OutputIntent,
  restaurantId: string,
  printerConfig: Record<string, any>,
): OutputJob[] {
  const items = (intent.payload.items as PlannerKotItem[]) || [];
  if (items.length === 0) return [];

  // Resolve printer for each item
  const mappedItems = items.map((item) => ({
    ...item,
    printerName: item.printerName ?? resolvePrinterName(
      item.printerName ?? null,
      item.printerTarget ?? null,
      item.categoryPrinterTarget ?? null,
      printerConfig,
    ),
  }));

  // Group by resolved printer name
  const groupedByPrinter = new Map<string | null, PlannerKotItem[]>();
  for (const item of mappedItems) {
    const key = item.printerName ?? null;
    if (!groupedByPrinter.has(key)) groupedByPrinter.set(key, []);
    groupedByPrinter.get(key)!.push(item);
  }

  const jobs: OutputJob[] = [];
  const baseCopies = (intent.payload.copies as number) ?? 1;

  for (const [printerName, groupItems] of groupedByPrinter) {
    if (!printerName) {
      // Legacy fallback: split by menuType
      const kitchenItems = groupItems.filter(
        (i) => i.printerTarget !== "BAR_PRINTER" && i.menuType !== "LIQUOR",
      );
      const barItems = groupItems.filter(
        (i) => i.printerTarget === "BAR_PRINTER" || i.menuType === "LIQUOR",
      );

      if (kitchenItems.length > 0) {
        const fallbackPrinter = resolvePrinterName(null, "KOT_PRINTER", null, printerConfig);
        jobs.push(makeKotJob(intent, kitchenItems, fallbackPrinter ?? null, "PRINT_KOT", baseCopies));
      }
      if (barItems.length > 0) {
        const fallbackPrinter = resolvePrinterName(null, "BAR_PRINTER", null, printerConfig);
        jobs.push(makeKotJob(intent, barItems, fallbackPrinter ?? null, "PRINT_LIQUOR_KOT", baseCopies));
      }
    } else {
      // Precise routing: one job per printer
      const isAllLiquor = groupItems.every((i) => i.menuType === "LIQUOR");
      const jobIntent: OutputIntentType = isAllLiquor ? "PRINT_LIQUOR_KOT" : "PRINT_KOT";
      jobs.push(makeKotJob(intent, groupItems, printerName, jobIntent, baseCopies));
    }
  }

  return jobs;
}

function makeKotJob(
  intent: OutputIntent,
  items: PlannerKotItem[],
  printerName: string | null,
  jobIntent: OutputIntentType,
  copies: number,
): OutputJob {
  const destination: Destination = {
    printerName,
    printerTarget: null,
  };
  // Map menuType → type so renderers can filter by type === "food" | "liquor"
  const renderedItems = items.map((i) => ({
    ...i,
    type: i.menuType === "LIQUOR" ? "liquor" : "food",
  }));
  return {
    jobId: "",
    intentId: intent.intentId,
    renderer: "escpos",
    destination,
    copies,
    priority: intent.priority,
    intent: jobIntent,
    payload: { ...intent.payload, items: renderedItems },
  };
}

export function planOutputIntent(
  intent: OutputIntent,
  restaurantId: string,
): OutputJob[] {
  const printerConfig = getOutletPrinterConfig(restaurantId);

  // KOT intents: multi-job expansion by printer
  if (intent.intent === "PRINT_KOT" || intent.intent === "PRINT_LIQUOR_KOT") {
    return planKotJobs(intent, restaurantId, printerConfig);
  }

  // Non-KOT intents: single job
  const destination: Destination = {
    printerName: resolvePrinterName(
      intent.payload.printerName as string | null,
      intent.payload.printerTarget as string | null,
      intent.payload.categoryPrinterTarget as string | null,
      printerConfig,
    ) ?? null,
    printerTarget: (intent.payload.printerTarget as string) ?? null,
  };

  return [{
    jobId: "",
    intentId: intent.intentId,
    renderer: "escpos",
    destination,
    copies: (intent.payload.copies as number) ?? 1,
    priority: intent.priority,
    intent: intent.intent,
    payload: intent.payload,
  }];
}

export { getRestaurantId };
