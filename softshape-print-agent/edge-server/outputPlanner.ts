// ─────────────────────────────────────────────────────────────────────────────
// outputPlanner.ts — Output Planner: Intent → Job transformation
// ─────────────────────────────────────────────────────────────────────────────
// Transforms an OutputIntent into one or more OutputJobs. This is where the
// Runtime injects policy: resolving printers, selecting renderers, determining
// copies, assigning priority.
//
// For R2, single-job planning only. Multi-job expansion (e.g., KOT → kitchen
// + bar) comes in R3.
// ─────────────────────────────────────────────────────────────────────────────

import type { OutputIntent, OutputJob, Destination } from "@softshape/output";
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

export function planOutputIntent(
  intent: OutputIntent,
  restaurantId: string,
): OutputJob[] {
  const printerConfig = getOutletPrinterConfig(restaurantId);

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
