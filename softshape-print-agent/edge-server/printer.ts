// ─────────────────────────────────────────────────────────────────────────────
// printer.ts — Direct printer communication via Tauri or fallback HTTP
// ─────────────────────────────────────────────────────────────────────────────
// Sends raw ESC/POS bytes directly to the printer. No socket relay, no Redis.
//
// Two modes:
//   1. Tauri mode: window.__TAURI__.invoke('print_raw', ...) — direct USB
//   2. HTTP fallback: POST to existing print agent's /print endpoint
//      (used when edge server runs standalone without Tauri webview)
//
// Printer resolution:
//   - If printerName is an IP:port → network printer (Tauri print_network)
//   - Otherwise → USB/local printer (Tauri print_raw)
// ─────────────────────────────────────────────────────────────────────────────

import { getConfig } from "./db.ts";

// ── Tauri invoke helper ──────────────────────────────────────────────────────

function getTauriInvoke(): ((cmd: string, args?: any) => Promise<any>) | null {
  const t = (globalThis as any).window?.__TAURI__;
  if (!t) return null;
  if (typeof t.invoke === "function") return t.invoke.bind(t);
  if (t.tauri && typeof t.tauri.invoke === "function") return t.tauri.invoke.bind(t.tauri);
  return null;
}

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
  method: "tauri" | "http" | "noop";
}

// ── Print to a specific printer ──────────────────────────────────────────────

export async function printToPrinter(
  printerName: string,
  escposData: { type: string; format: string; data: string }[]
): Promise<PrintResult> {
  const rawBytes = escposToBytes(escposData);

  if (rawBytes.length === 0) {
    return { ok: false, printerName, bytes: 0, error: "Empty print data", method: "noop" };
  }

  // ── Try Tauri first (direct USB) ──────────────────────────────────────────
  const invoke = getTauriInvoke();
  if (invoke) {
    try {
      const netMatch = printerName.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/);
      if (netMatch) {
        await invoke("print_network", {
          ip: netMatch[1],
          port: parseInt(netMatch[2], 10),
          bytes: rawBytes,
        });
      } else {
        await invoke("print_raw", {
          printerName,
          bytes: rawBytes,
        });
      }
      console.log(`[Printer] Printed via Tauri → ${printerName} (${rawBytes.length} bytes)`);
      return { ok: true, printerName, bytes: rawBytes.length, method: "tauri" };
    } catch (err: any) {
      console.error(`[Printer] Tauri print failed → ${printerName}:`, err?.message || err);
      // Fall through to HTTP fallback
    }
  }

  // ── HTTP fallback: send to the cashier's internal print bridge ──────────────
  const printAgentUrl = (
    process.env.PRINT_BRIDGE_URL ||
    getConfig("print_bridge_url") ||
    getConfig("print_agent_http_url") ||
    "http://127.0.0.1:3101"
  ).replace(/\/+$/, "");
  if (printAgentUrl) {
    try {
      const res = await fetch(`${printAgentUrl}/print`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobType: "KOT",
          printerName,
          bytes: rawBytes,
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (result.ok) {
        console.log(`[Printer] Printed via internal bridge → ${printerName} (${rawBytes.length} bytes)`);
        return { ok: true, printerName, bytes: rawBytes.length, method: "http" };
      }
      return { ok: false, printerName, bytes: rawBytes.length, error: result.error || "HTTP print failed", method: "http" };
    } catch (err: any) {
      console.error(`[Printer] HTTP fallback failed → ${printerName}:`, err?.message || err);
    }
  }

  // ── No printer available — log and return error ───────────────────────────
  return {
    ok: false,
    printerName,
    bytes: rawBytes.length,
    error: "No printer available (Tauri not found, HTTP fallback unavailable)",
    method: "noop",
  };
}

// ── Print to multiple printers (for grouped KOT routing) ─────────────────────

export async function printGrouped(
  groups: Array<{ printerName: string; escposData: { type: string; format: string; data: string }[] }>
): Promise<PrintResult[]> {
  const results: PrintResult[] = [];

  // Print all groups in parallel — different printers can print simultaneously
  const promises = groups.map(async (g) => {
    if (!g.printerName || g.escposData.length === 0) {
      return { ok: false, printerName: g.printerName || "unknown", bytes: 0, error: "No printer or data", method: "noop" } as PrintResult;
    }
    return printToPrinter(g.printerName, g.escposData);
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
  const normalized = printers.map((p: any) => ({
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

  return undefined;
}
