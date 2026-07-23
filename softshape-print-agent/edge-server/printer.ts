// ─────────────────────────────────────────────────────────────────────────────
// printer.ts — Direct printer communication via isolated print service
// ─────────────────────────────────────────────────────────────────────────────
// Sends raw ESC/POS bytes to the isolated Rust print service on :3103.
// No Tauri, no HTTP bridge — the Runtime is headless.
//
// Printer resolution:
//   - If printerName is an IP:port → network printer
//   - Otherwise → USB/local printer
// ─────────────────────────────────────────────────────────────────────────────

import { sendToPrintService, isPrintServiceReady } from "./printServiceManager.ts";

// ── Convert ESC/POS data string to byte array ────────────────────────────────

function escposToBytes(escposData: { type: string; format: string; data: string }[]): number[] {
  const rawString = escposData.map((d) => d.data || "").join("");
  return Array.from(new TextEncoder().encode(rawString));
}

// ── Print job result ─────────────────────────────────────────────────────────

export interface PrintResult {
  ok: boolean;
  printerName: string;
  bytes: number;
  error?: string;
  method: "print_service" | "noop";
}

// ── Print to a specific printer ──────────────────────────────────────────────

export async function printToPrinter(
  printerName: string,
  escposData: { type: string; format: string; data: string }[],
  eventId?: string,
  jobType?: string,
): Promise<PrintResult> {
  const rawBytes = escposToBytes(escposData);
  let lastError: string | null = null;

  if (rawBytes.length === 0) {
    return { ok: false, printerName, bytes: 0, error: "Empty print data", method: "noop" };
  }

  // ── Print service: isolated Rust process on :3103 (Phase 4) ──────────────
  if (isPrintServiceReady()) {
    const result = await sendToPrintService(printerName, new Uint8Array(rawBytes));
    if (result.ok) {
      console.log(`[Printer] Printed via print service → ${printerName} (${rawBytes.length} bytes)`);
      return { ok: true, printerName, bytes: rawBytes.length, method: "print_service" };
    }
    lastError = result.error || "Print service failed";
    console.warn(`[Printer] Print service failed → ${printerName}: ${lastError}`);
  } else {
    lastError = "Print service is not ready";
  }

  // ── No printer available — log and return error ───────────────────────────
  return {
    ok: false,
    printerName,
    bytes: rawBytes.length,
    error: lastError,
    method: "noop",
  };
}

// ── Print to multiple printers (for grouped KOT routing) ─────────────────────

export async function printGrouped(
  groups: Array<{ printerName: string; escposData: { type: string; format: string; data: string }[]; type?: string }>,
  requestId?: string,
): Promise<PrintResult[]> {
  const results: PrintResult[] = [];

  // Print all groups in parallel — different printers can print simultaneously
  const promises = groups.map(async (g, i) => {
    if (!g.printerName || g.escposData.length === 0) {
      return { ok: false, printerName: g.printerName || "unknown", bytes: 0, error: "No printer or data", method: "noop" } as PrintResult;
    }
    const eventId = `${g.type || "KOT"}-${requestId || Date.now()}-${i}`;
    return printToPrinter(g.printerName, g.escposData, eventId, g.type);
  });

  const settled = await Promise.allSettled(promises);
  for (const s of settled) {
    if (s.status === "fulfilled") {
      results.push(s.value);
    } else {
      results.push({ ok: false, printerName: "unknown", bytes: 0, error: String(s.reason), method: "noop" });
    }
  }

  return results;
}

// ── Printer name resolution (ported from backend) ────────────────────────────

export function resolvePrinterName(
  itemPrinterName: string | null | undefined,
  itemPrinterTarget: string | null | undefined,
  categoryPrinterTarget: string | null | undefined,
  printerConfig: Record<string, any>
): string | undefined {
  // 1. Direct item-level physical printer override (highest priority)
  if (itemPrinterName) return itemPrinterName;

  const target = (itemPrinterTarget || categoryPrinterTarget)?.trim();
  if (!target) return undefined;

  // 2. If target is an actual known printer name, use it directly
  const printers = printerConfig?.printers || [];
  const available: string[] = printerConfig?.availablePrinters || [];
  const allKnownNames = new Set([
    ...printers.map((p: any) => p.name).filter(Boolean),
    ...available,
  ]);

  if (allKnownNames.has(target)) return target;

  // 3. Legacy fallback: old enum values
  const normalized: Array<{ name: string; type: string; nameLower: string }> = printers.map((p: any) => ({
    name: p.name,
    type: String(p.type || "").toUpperCase(),
    nameLower: String(p.name || "").toLowerCase(),
  }));

  const legacyTarget = target.toUpperCase();
  if (legacyTarget === "BAR_PRINTER") {
    return normalized.find((p) => p.type === "BAR")?.name
      || normalized.find((p) => p.nameLower.includes("bar"))?.name;
  }
  if (legacyTarget === "KOT_PRINTER") {
    return normalized.find((p) => p.type === "KITCHEN")?.name
      || normalized.find((p) => p.nameLower.includes("kitchen"))?.name
      || normalized.find((p) => p.type === "KOT")?.name;
  }
  if (legacyTarget === "BILL_PRINTER") {
    return normalized.find((p) => p.type === "BILL")?.name
      || normalized.find((p) => p.nameLower.includes("bill"))?.name;
  }

  return undefined;
}
