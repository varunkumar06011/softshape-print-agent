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

// ── Resolve candidate paths for the print service executable ─────────────────
// IMPORTANT: when edge-server is built with `bun build --compile`, __dirname /
// import.meta.url resolve to the embedded virtual filesystem (e.g. /$bunfs/root),
// NOT the real folder on disk. In that case the only reliable anchor is
// process.execPath — the actual path of the running edge-server.exe. Tauri
// bundles print-service.exe as a sibling resource next to edge-server.exe, so
// the execPath-based candidates are the ones that match in production.

function printServiceExeCandidates(): { candidates: string[]; moduleDir: string; execDir: string } {
  const candidates: string[] = [];
  const execDir = dirname(process.execPath);
  const moduleDirForEnv = typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

  // 1. Explicit env override — authoritative. If an operator points us at a
  //    specific executable we must not silently fall back to a different one.
  if (process.env.PRINT_SERVICE_EXE) {
    return {
      candidates: [process.env.PRINT_SERVICE_EXE],
      moduleDir: moduleDirForEnv,
      execDir,
    };
  }

  // 2. Sibling of the running executable (bundled/production deployment)
  candidates.push(join(execDir, "print-service.exe"));
  candidates.push(join(execDir, "resources", "print-service.exe"));
  candidates.push(join(execDir, "..", "print-service.exe"));
  candidates.push(join(execDir, "..", "resources", "print-service.exe"));

  // 3. Source-tree layout relative to this module (development with `bun run`)
  const moduleDir = moduleDirForEnv;
  candidates.push(join(moduleDir, "..", "print-service", "target", "release", "print-service.exe"));
  candidates.push(join(moduleDir, "..", "print-service", "target", "debug", "print-service.exe"));
  candidates.push(join(moduleDir, "print-service.exe"));

  // 4. Working directory (service launched from the install folder)
  candidates.push(join(process.cwd(), "print-service.exe"));
  candidates.push(join(process.cwd(), "resources", "print-service.exe"));

  // 5. Common install locations
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    if (localAppData) {
      candidates.push(join(localAppData, "Softshape", "bin", "print-service.exe"));
    }
    candidates.push(join("C:", "Program Files", "Softshape", "print-service.exe"));
  }

  return { candidates, moduleDir, execDir };
}

function resolvePrintServiceExe(): string | null {
  const { candidates } = printServiceExeCandidates();
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* unreadable path — keep searching */ }
  }
  return null;
}

export function getPrintServiceExeDiagnostics(): {
  resolvedExe: string | null;
  execPath: string;
  execDir: string;
  moduleDir: string;
  cwd: string;
  searchedPaths: string[];
} {
  const { candidates, moduleDir, execDir } = printServiceExeCandidates();
  return {
    resolvedExe: resolvePrintServiceExe(),
    execPath: process.execPath,
    execDir,
    moduleDir,
    cwd: process.cwd(),
    searchedPaths: candidates,
  };
}

// ── Start the print service ──────────────────────────────────────────────────

export function startPrintService(): boolean {
  const exe = resolvePrintServiceExe();
  if (!exe) {
    const { candidates, moduleDir, execDir } = printServiceExeCandidates();
    runtimeLog.warn("Print service executable not found — printing will not work", {
      searchedPaths: candidates,
      edgeServerDir: moduleDir,
      execDir,
      execPath: process.execPath,
      cwd: process.cwd(),
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
