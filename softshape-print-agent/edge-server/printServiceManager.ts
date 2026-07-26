// ─────────────────────────────────────────────────────────────────────────────
// printServiceManager.ts — Manages the isolated Rust print service process
// ─────────────────────────────────────────────────────────────────────────────
// The Runtime spawns the print service as a child process on :3103 and
// supervises it via supervisor.ts. If the print service crashes, the
// supervisor respawns it automatically (with crash-loop guard).
//
// The print service handles all physical printing:
//   - USB printers via Win32 RawDocToPrinter
//   - Network printers via TCP
//
// The Runtime's print queue worker sends jobs to this service via HTTP.
// If the service is down, jobs remain in the SQLite queue and are retried
// when the service comes back online.
// ─────────────────────────────────────────────────────────────────────────────

import { supervisor } from "./supervisor.ts";
import { runtimeLog, printerLog } from "./contract/logger.ts";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PRINT_SERVICE_PORT = 3103;
const PRINT_SERVICE_NAME = "print-service";

// ── Resolve the print service executable path ────────────────────────────────

function resolvePrintServiceExe(): string | null {
  const candidates: string[] = [];

  // 1. Explicit env override
  if (process.env.PRINT_SERVICE_EXE) {
    candidates.push(process.env.PRINT_SERVICE_EXE);
  }

  // 2. Sibling directory relative to edge-server (monorepo / development)
  //    edge-server/ → ../print-service/target/release/print-service.exe
  const moduleDir = typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
  candidates.push(join(moduleDir, "..", "print-service", "target", "release", "print-service.exe"));
  candidates.push(join(moduleDir, "..", "print-service", "target", "debug", "print-service.exe"));

  // 3. Same directory as edge-server.exe (bundled deployment)
  candidates.push(join(moduleDir, "print-service.exe"));

  // 4. Common install locations
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    if (localAppData) {
      candidates.push(join(localAppData, "Softshape", "bin", "print-service.exe"));
    }
    candidates.push(join("C:", "Program Files", "Softshape", "print-service.exe"));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ── Start the print service ──────────────────────────────────────────────────

export function startPrintService(): boolean {
  const exe = resolvePrintServiceExe();
  if (!exe) {
    const moduleDir = typeof __dirname !== "undefined"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
    const candidates: string[] = [];
    if (process.env.PRINT_SERVICE_EXE) candidates.push(process.env.PRINT_SERVICE_EXE);
    candidates.push(join(moduleDir, "..", "print-service", "target", "release", "print-service.exe"));
    candidates.push(join(moduleDir, "..", "print-service", "target", "debug", "print-service.exe"));
    candidates.push(join(moduleDir, "print-service.exe"));
    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || "";
      if (localAppData) candidates.push(join(localAppData, "Softshape", "bin", "print-service.exe"));
      candidates.push(join("C:", "Program Files", "Softshape", "print-service.exe"));
    }
    runtimeLog.warn("Print service executable not found — printing will not work", {
      searchedPaths: candidates,
      edgeServerDir: moduleDir,
    });
    return false;
  }

  supervisor.register({
    name: PRINT_SERVICE_NAME,
    exe,
    port: PRINT_SERVICE_PORT,
    healthPath: "/health",
    env: {
      PRINT_SERVICE_PORT: String(PRINT_SERVICE_PORT),
    },
  });

  supervisor.start(PRINT_SERVICE_NAME);
  runtimeLog.info("Print service started", { exe, port: PRINT_SERVICE_PORT });
  return true;
}

// ── Stop the print service ───────────────────────────────────────────────────

export function stopPrintService(): void {
  supervisor.stop(PRINT_SERVICE_NAME);
  runtimeLog.info("Print service stopped");
}

// ── Check if the print service is ready ──────────────────────────────────────

export function isPrintServiceReady(): boolean {
  const status = supervisor.getStatus(PRINT_SERVICE_NAME);
  return status?.ready ?? false;
}

// ── Get print service status ─────────────────────────────────────────────────

export function getPrintServiceStatus(): {
  running: boolean;
  ready: boolean;
  state: string;
  lastError: string | null;
  pid: number | null;
} {
  const status = supervisor.getStatus(PRINT_SERVICE_NAME);
  if (!status) {
    return { running: false, ready: false, state: "unknown", lastError: null, pid: null };
  }
  return {
    running: status.running,
    ready: status.ready,
    state: status.state,
    lastError: status.lastError,
    pid: status.pid,
  };
}

// ── Send a print job to the print service ────────────────────────────────────

export async function sendToPrintService(
  printerName: string,
  bytes: Uint8Array,
): Promise<{ ok: boolean; error?: string }> {
  if (!isPrintServiceReady()) {
    return { ok: false, error: "Print service is not ready" };
  }

  try {
    const res = await fetch(`http://127.0.0.1:${PRINT_SERVICE_PORT}/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ printerName, bytes: Array.from(bytes) }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const body = await res.json() as { ok: boolean; error?: string };
      return body;
    }

    const text = await res.text().catch(() => "unknown error");
    return { ok: false, error: `Print service returned ${res.status}: ${text}` };
  } catch (err) {
    printerLog.error("Failed to send job to print service", {
      printerName,
      error: String(err),
    });
    return { ok: false, error: String(err) };
  }
}

// ── List printers via the print service ──────────────────────────────────────

export async function listPrintersViaService(): Promise<
  Array<{ name: string; isDefault: boolean }>
> {
  if (!isPrintServiceReady()) {
    return [];
  }

  try {
    const res = await fetch(`http://127.0.0.1:${PRINT_SERVICE_PORT}/printers`, {
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      return await res.json() as Array<{ name: string; isDefault: boolean }>;
    }
  } catch {
    // Service may be temporarily unavailable
  }

  return [];
}
