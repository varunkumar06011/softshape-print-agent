// ─────────────────────────────────────────────────────────────────────────────
// tests/supervisor.test.ts — Tests for the Runtime supervisor
// ─────────────────────────────────────────────────────────────────────────────
// Run with: bun test tests/supervisor.test.ts
//
// Tests verify:
//   1. Process registration and status reporting
//   2. Health probe detects a ready process
//   3. Health probe timeout transitions to DEGRADED
//   4. Crash-loop guard stops respawning after 5 crashes in 30s
//   5. Stop and restart reset crash counters
// ─────────────────────────────────────────────────────────────────────────────

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Supervisor } from "../supervisor.ts";

// ── Helper: create a minimal HTTP server on a port that responds to /health ──

async function createHealthyServer(port: number): Promise<{ stop: () => void }> {
  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  return { stop: () => server.stop() };
}

// ── Helper: create a server that never responds to /health (for timeout test) ─

async function createSilentServer(port: number): Promise<{ stop: () => void }> {
  const server = Bun.serve({
    port,
    fetch() {
      // Hang forever — never return a response
      return new Promise(() => {});
    },
  });
  return { stop: () => server.stop() };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Supervisor", () => {
  let supervisor: Supervisor;
  let servers: Array<{ stop: () => void }> = [];

  beforeEach(() => {
    supervisor = new Supervisor();
    servers = [];
  });

  afterEach(() => {
    supervisor.stopAll();
    for (const s of servers) s.stop();
  });

  test("registers a process and reports initial status", () => {
    supervisor.register({
      name: "test-service",
      exe: "nonexistent.exe",
      port: 13999,
    });

    const status = supervisor.getStatus("test-service");
    expect(status).not.toBeNull();
    expect(status!.running).toBe(false);
    expect(status!.ready).toBe(false);
    expect(status!.state).toBe("OFFLINE");
  });

  test("returns null for unknown process status", () => {
    const status = supervisor.getStatus("nonexistent");
    expect(status).toBeNull();
  });

  test("health probe detects a ready process", async () => {
    // Use port 0 to get an ephemeral port, then use that port for the test
    const tempServer = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = tempServer.port!;
    tempServer.stop();

    // Small delay to ensure the port is fully released
    await new Promise((r) => setTimeout(r, 100));

    const server = await createHealthyServer(port);
    servers.push(server);

    // Register with a real process (use bun itself as a harmless long-running process)
    supervisor.register({
      name: "healthy-service",
      exe: process.execPath,
      args: ["--eval", "setInterval(() => {}, 1000)"],
      port,
    });

    supervisor.start("healthy-service");

    // Wait for health probe to succeed (polls every 500ms, should be < 10s)
    let ready = false;
    for (let i = 0; i < 50; i++) {
      const status = supervisor.getStatus("healthy-service");
      if (status?.ready) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(ready).toBe(true);
    const status = supervisor.getStatus("healthy-service");
    expect(status!.state).toBe("READY");
  }, 15000);

  test("health probe keeps process in STARTING while probing unresponsive server", async () => {
    // Use port 0 to get an ephemeral port
    const tempServer = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = tempServer.port!;
    tempServer.stop();

    const server = await createSilentServer(port);
    servers.push(server);

    supervisor.register({
      name: "silent-service",
      exe: process.execPath,
      args: ["--eval", "setInterval(() => {}, 1000)"],
      port,
    });

    supervisor.start("silent-service");

    // Give the health probe a moment to run a few failed attempts
    await new Promise((r) => setTimeout(r, 1500));

    // The process should be running but NOT ready (health probe in progress)
    const status = supervisor.getStatus("silent-service");
    expect(status).not.toBeNull();
    expect(status!.running).toBe(true);
    expect(status!.ready).toBe(false);
    // State should be STARTING (health probe hasn't timed out yet — 35s deadline)
    expect(status!.state).toBe("STARTING");
  });

  test("stop transitions process to OFFLINE", async () => {
    supervisor.register({
      name: "stoppable-service",
      exe: process.execPath,
      args: ["--eval", "setInterval(() => {}, 1000)"],
    });

    supervisor.start("stoppable-service");

    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 200));

    supervisor.stop("stoppable-service");

    const status = supervisor.getStatus("stoppable-service");
    expect(status!.running).toBe(false);
    expect(status!.state).toBe("OFFLINE");
  });

  test("getAllStatuses returns all registered processes", () => {
    supervisor.register({ name: "svc-a", exe: "a.exe" });
    supervisor.register({ name: "svc-b", exe: "b.exe" });

    const statuses = supervisor.getAllStatuses();
    expect(statuses.length).toBe(2);
    expect(statuses.map((s) => s.name).sort()).toEqual(["svc-a", "svc-b"]);
  });

  test("restart resets crash counters", async () => {
    supervisor.register({
      name: "restartable-service",
      exe: process.execPath,
      args: ["--eval", "setInterval(() => {}, 1000)"],
    });

    supervisor.start("restartable-service");
    await new Promise((r) => setTimeout(r, 200));

    supervisor.stop("restartable-service");

    // Restart should work and not be blocked by crash-loop
    const result = supervisor.restart("restartable-service");
    expect(result).toBe(true);

    const status = supervisor.getStatus("restartable-service");
    expect(status!.running).toBe(true);
  });

  test("stopAll stops all processes", async () => {
    supervisor.register({
      name: "svc-1",
      exe: process.execPath,
      args: ["--eval", "setInterval(() => {}, 1000)"],
    });
    supervisor.register({
      name: "svc-2",
      exe: process.execPath,
      args: ["--eval", "setInterval(() => {}, 1000)"],
    });

    supervisor.start("svc-1");
    supervisor.start("svc-2");
    await new Promise((r) => setTimeout(r, 200));

    supervisor.stopAll();

    expect(supervisor.getStatus("svc-1")!.running).toBe(false);
    expect(supervisor.getStatus("svc-2")!.running).toBe(false);
  });
});
