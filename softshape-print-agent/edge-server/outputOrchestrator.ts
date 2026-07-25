// ─────────────────────────────────────────────────────────────────────────────
// outputOrchestrator.ts — Output Orchestrator: render + queue + dispatch
// ─────────────────────────────────────────────────────────────────────────────
// Processes an OutputIntent through the full pipeline:
//   1. Plan:   Intent → Jobs (resolve printer, select renderer, set copies)
//   2. Render: payload → RenderedOutput blocks via renderer registry
//   3. Queue:  persist to SQLite print_job table
//   4. Dispatch: attempt immediate print, fall back to background queue
//   5. Emit:   EventBus notification for UI updates
// ─────────────────────────────────────────────────────────────────────────────

import type { OutputIntent, OutputJob } from "@softshape/output";
import { render } from "@softshape/output";
import { planOutputIntent } from "./outputPlanner.ts";
import { createPrintJob } from "./db.ts";
import { dispatchSinglePrintJob } from "./orderService.ts";
import { emitEvent } from "./eventBus.ts";
import { EVENT_NAMES } from "./contract/events.ts";

export async function processOutputIntent(
  intent: OutputIntent,
  restaurantId: string,
  orderId?: string,
): Promise<{ jobs: { jobId: number | null; ok: boolean; error?: string }[] }> {
  const jobs = planOutputIntent(intent, restaurantId);

  const results: { jobId: number | null; ok: boolean; error?: string }[] = [];

  for (const job of jobs) {
    const rendered = render(job.intent, job.payload);
    if (!rendered || rendered.blocks.length === 0) {
      results.push({ jobId: null, ok: false, error: "Renderer produced no output" });
      continue;
    }

    const eventId = intent.intentId || `${job.intent}-${Date.now()}`;
    const jobId = createPrintJob({
      eventId,
      restaurantId,
      orderId: orderId || (job.payload.orderId as string),
      kotId: job.payload.kotId as string,
      kotNumber: job.payload.kotNumber as number,
      tableId: job.payload.tableId as string,
      printerName: job.destination.printerName,
      jobType: job.intent,
      escposData: rendered.blocks,
      itemSummary: (job.payload.itemSummary as any[]) || [],
      captainName: (job.payload.captainName as string) || null,
    });

    if (jobId) {
      dispatchSinglePrintJob(eventId, {
        printerName: job.destination.printerName,
        escposData: rendered.blocks,
        type: job.intent,
      }, job.payload.requestId as string | undefined);
    }

    emitEvent({
      event: EVENT_NAMES.PRINT_COMPLETED,
      data: { jobId: jobId || 0, printerName: job.destination.printerName || "unknown", ok: Boolean(job.destination.printerName) } as any,
    });

    results.push({ jobId, ok: !!job.destination.printerName, error: job.destination.printerName ? undefined : "No printer resolved" });
  }

  return { jobs: results };
}
