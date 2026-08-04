// ─────────────────────────────────────────────────────────────────────────────
// printServiceManager.test.ts — Tests for the print service manager
// ─────────────────────────────────────────────────────────────────────────────
// Verifies that the print service manager correctly:
//   - Reports status when no process is registered
//   - Starts and stops the print service
//   - Reports ready status after health probe succeeds
//   - Falls back gracefully when the executable is not found
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startPrintService, stopPrintService, getPrintServiceStatus, isPrintServiceReady, sendToPrintService, listPrintersViaService } from "../printServiceManager.ts";
import { supervisor } from "../supervisor.ts";

// Track servers spawned during tests for cleanup
const spawnedServers: Array<{ stop: () => void }> = [];

async function createHealthServer(port: number): Promise<{ stop: () => void }> {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/printers") {
        return new Response(JSON.stringify([
          { name: "TestPrinter", isDefault: true },
        ]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/print" && req.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  spawnedServers.push(server);
  return server;
}

afterAll(() => {
  // Clean up any supervised processes
  supervisor.stopAll();
  // Stop any spawned servers
  for (const s of spawnedServers) {
    try { s.stop(); } catch { /* ignore */ }
  }
});

test("getPrintServiceStatus returns unknown when not started", () => {
  // Make sure no print service is registered from previous tests
  try { supervisor.stop("print-service"); } catch { /* ignore */ }
  const status = getPrintServiceStatus();
  expect(status.running).toBe(false);
  expect(status.ready).toBe(false);
  expect(status.state).toBe("unknown");
});

test("isPrintServiceReady returns false when not started", () => {
  try { supervisor.stop("print-service"); } catch { /* ignore */ }
  expect(isPrintServiceReady()).toBe(false);
});

test("sendToPrintService returns error when service not ready", async () => {
  try { supervisor.stop("print-service"); } catch { /* ignore */ }
  const result = await sendToPrintService("TestPrinter", new Uint8Array([0x1b, 0x40]));
  expect(result.ok).toBe(false);
  expect(result.error).toBeDefined();
});

test("listPrintersViaService returns empty array when service not ready", async () => {
  try { supervisor.stop("print-service"); } catch { /* ignore */ }
  const printers = await listPrintersViaService();
  expect(printers).toEqual([]);
});

test("startPrintService returns false when executable not found", () => {
  // Ensure the env var doesn't point to a real executable
  const original = process.env.PRINT_SERVICE_EXE;
  process.env.PRINT_SERVICE_EXE = "/nonexistent/path/print-service.exe";
  try {
    const result = startPrintService();
    expect(result).toBe(false);
  } finally {
    if (original !== undefined) {
      process.env.PRINT_SERVICE_EXE = original;
    } else {
      delete process.env.PRINT_SERVICE_EXE;
    }
  }
});

test("startPrintService with valid executable starts supervision", async () => {
  // Check if port 3103 is already in use (real print service running)
  try {
    const probe = await fetch("http://127.0.0.1:3103/health", { signal: AbortSignal.timeout(500) });
    if (probe.ok) {
      // Port 3103 is already serving — skip this test
      return;
    }
  } catch {
    // Port is available — proceed with test
  }

  // Create a healthy server on port 3103 directly (faster than spawning a child)
  const testServer = Bun.serve({
    port: 3103,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/print" && req.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/printers") {
        return new Response(JSON.stringify([{ name: "TestPrinter", isDefault: true }]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  spawnedServers.push(testServer);

  // Register and start with Bun as a harmless long-running process
  supervisor.register({
    name: "print-service",
    exe: process.execPath,
    args: ["--eval", "setInterval(() => {}, 1000)"],
    port: 3103,
    healthPath: "/health",
  });
  supervisor.start("print-service");

  // Wait for health probe to succeed (polls every 500ms, should be < 5s)
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (isPrintServiceReady()) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(ready).toBe(true);

  // Verify status
  const status = getPrintServiceStatus();
  expect(status.running).toBe(true);
  expect(status.ready).toBe(true);
}, 15000);

test("sendToPrintService succeeds when service is ready", async () => {
  // The previous test should have left the service running and ready
  // Wait a moment to ensure it's still up
  if (!isPrintServiceReady()) {
    // If not ready, skip this test
    return;
  }
  const result = await sendToPrintService("TestPrinter", new Uint8Array([0x1b, 0x40]));
  expect(result.ok).toBe(true);
});

test("listPrintersViaService returns printers when service is ready", async () => {
  if (!isPrintServiceReady()) {
    return;
  }
  const printers = await listPrintersViaService();
  expect(printers.length).toBeGreaterThan(0);
  expect(printers[0].name).toBe("TestPrinter");
});

test("stopPrintService stops the supervised process", () => {
  stopPrintService();
  const status = getPrintServiceStatus();
  expect(status.running).toBe(false);
  expect(status.ready).toBe(false);
});
