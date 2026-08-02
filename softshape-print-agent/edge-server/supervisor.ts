// ─────────────────────────────────────────────────────────────────────────────
// supervisor.ts — Child process supervision for the Runtime (v1)
// ─────────────────────────────────────────────────────────────────────────────
// Ports the watchdog, crash-loop guard, and health probe logic from
// cashier-desktop/src-tauri/src/main.rs into the Runtime itself.
//
// The Runtime uses this to supervise child services (print service in Phase 2,
// future device drivers in Phase 6). The Runtime Host (Phase 3) uses the same
// pattern to supervise the Runtime itself.
//
// Constants match the original Rust implementation exactly:
//   WATCHDOG_INTERVAL_SECS = 10
//   CRASH_LIMIT = 5
//   CRASH_WINDOW_SECS = 30
//   HEALTH_PROBE_DEADLINE_SECS = 35
//   HEALTH_PROBE_INTERVAL_MS = 500
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, type Subprocess } from "bun";
import { runtimeLog } from "./contract/logger.ts";
import type { DriverState } from "./contract/states.ts";

// ── Constants (ported from main.rs) ──────────────────────────────────────────

const WATCHDOG_INTERVAL_SECS = 10;
const CRASH_LIMIT = 5;
const CRASH_WINDOW_SECS = 30;
const HEALTH_PROBE_DEADLINE_SECS = 35;
const HEALTH_PROBE_INTERVAL_MS = 500;

// ── Types ────────────────────────────────────────────────────────────────────

export interface SupervisedProcessConfig {
  name: string;
  exe: string;
  args?: string[];
  env?: Record<string, string>;
  port?: number;
  healthPath?: string;
  healthCheck?: (response: Response) => boolean;
}

interface SupervisedProcessState {
  config: SupervisedProcessConfig;
  child: Subprocess | null;
  running: boolean;
  ready: boolean;
  state: DriverState;
  lastError: string | null;
  respawnCount: number;
  lastRespawnAt: number | null;
  watchdogStop: boolean;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  healthProbeTimer: ReturnType<typeof setInterval> | null;
}

// ── Supervisor ───────────────────────────────────────────────────────────────

export class Supervisor {
  private processes: Map<string, SupervisedProcessState> = new Map();

  // ── Register a process for supervision (doesn't start it yet) ──────────────

  register(config: SupervisedProcessConfig): void {
    if (this.processes.has(config.name)) {
      runtimeLog.warn("Process already registered, replacing", { name: config.name });
      this.stop(config.name);
    }
    this.processes.set(config.name, {
      config,
      child: null,
      running: false,
      ready: false,
      state: "OFFLINE",
      lastError: null,
      respawnCount: 0,
      lastRespawnAt: null,
      watchdogStop: false,
      watchdogTimer: null,
      healthProbeTimer: null,
    });
    runtimeLog.info("Process registered for supervision", { name: config.name, exe: config.exe });
  }

  // ── Start a supervised process ─────────────────────────────────────────────

  start(name: string): boolean {
    const proc = this.processes.get(name);
    if (!proc) {
      runtimeLog.error("Cannot start unknown process", { name });
      return false;
    }

    this.setState(proc, "STARTING", "spawn requested");
    this.spawnProcess(proc);
    this.startWatchdog(proc);
    return true;
  }

  // ── Stop a supervised process ──────────────────────────────────────────────

  stop(name: string): void {
    const proc = this.processes.get(name);
    if (!proc) return;

    proc.watchdogStop = true;
    if (proc.watchdogTimer) {
      clearInterval(proc.watchdogTimer);
      proc.watchdogTimer = null;
    }
    if (proc.healthProbeTimer) {
      clearInterval(proc.healthProbeTimer);
      proc.healthProbeTimer = null;
    }

    this.setState(proc, "STOPPING", "stop requested");

    if (proc.child) {
      try {
        proc.child.kill();
      } catch {
        // Process may already be dead
      }
      proc.child = null;
    }

    proc.running = false;
    proc.ready = false;
    this.setState(proc, "OFFLINE", "stopped");
    runtimeLog.info("Process stopped", { name });
  }

  // ── Stop all supervised processes ──────────────────────────────────────────

  stopAll(): void {
    for (const name of this.processes.keys()) {
      this.stop(name);
    }
  }

  // ── Restart a supervised process (resets crash counters) ───────────────────

  restart(name: string): boolean {
    const proc = this.processes.get(name);
    if (!proc) return false;

    this.stop(name);
    proc.respawnCount = 0;
    proc.lastRespawnAt = null;
    proc.watchdogStop = false;
    return this.start(name);
  }

  // ── Get status of a supervised process ─────────────────────────────────────

  getStatus(name: string): {
    running: boolean;
    ready: boolean;
    state: DriverState;
    lastError: string | null;
    pid: number | null;
  } | null {
    const proc = this.processes.get(name);
    if (!proc) return null;
    return {
      running: proc.running,
      ready: proc.ready,
      state: proc.state,
      lastError: proc.lastError,
      pid: proc.child?.pid ?? null,
    };
  }

  // ── Get status of all supervised processes ─────────────────────────────────

  getAllStatuses(): Array<{ name: string; running: boolean; ready: boolean; state: DriverState; lastError: string | null; pid: number | null }> {
    return Array.from(this.processes.entries()).map(([name, proc]) => ({
      name,
      running: proc.running,
      ready: proc.ready,
      state: proc.state,
      lastError: proc.lastError,
      pid: proc.child?.pid ?? null,
    }));
  }

  // ── Internal: spawn a child process ────────────────────────────────────────

  private spawnProcess(proc: SupervisedProcessState): void {
    const { config } = proc;
    runtimeLog.info("Spawning process", { name: config.name, exe: config.exe });

    try {
      const child = spawn({
        cmd: [config.exe, ...(config.args || [])],
        env: { ...process.env, ...config.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      proc.child = child;
      proc.running = true;
      proc.lastRespawnAt = Date.now();

      // Pipe stdout/stderr to logs
      this.pipeOutput(proc, child);

      // Start health probe if port is configured
      if (config.port) {
        this.startHealthProbe(proc);
      } else {
        // No health endpoint — assume ready immediately
        proc.ready = true;
        this.setState(proc, "READY", "no health endpoint configured");
      }

      runtimeLog.info("Process spawned", {
        name: config.name,
        pid: child.pid,
      });
    } catch (err) {
      proc.running = false;
      proc.lastError = `Spawn failed: ${err}`;
      this.setState(proc, "OFFLINE", `spawn failed: ${err}`);
      runtimeLog.error("Process spawn failed", {
        name: config.name,
        error: String(err),
      });
    }
  }

  // ── Internal: pipe child stdout/stderr to logs ─────────────────────────────

  private pipeOutput(proc: SupervisedProcessState, child: Subprocess): void {
    const { name } = proc.config;
    const decoder = new TextDecoder();

    const drain = (stream: ReadableStream<Uint8Array> | null, level: "info" | "warn") => {
      if (!stream) return;
      const reader = stream.getReader();
      const pump = (): Promise<void> =>
        reader.read().then(({ done, value }) => {
          if (done) return;
          const text = decoder.decode(value).trim();
          if (text) {
            if (level === "warn") runtimeLog.warn(`[${name}] ${text}`);
            else runtimeLog.info(`[${name}] ${text}`);
          }
          return pump();
        }).catch(() => { /* stream closed */ });
      pump();
    };

    drain(child.stdout as ReadableStream<Uint8Array> | null, "info");
    drain(child.stderr as ReadableStream<Uint8Array> | null, "warn");
  }

  // ── Internal: watchdog — check process health every 10s, respawn on exit ───
  // Ports the exact logic from main.rs:547-634

  private startWatchdog(proc: SupervisedProcessState): void {
    proc.watchdogStop = false;
    runtimeLog.info("Watchdog started", {
      name: proc.config.name,
      intervalSecs: WATCHDOG_INTERVAL_SECS,
    });

    proc.watchdogTimer = setInterval(() => {
      if (proc.watchdogStop) {
        runtimeLog.info("Watchdog stopped", { name: proc.config.name });
        if (proc.watchdogTimer) clearInterval(proc.watchdogTimer);
        proc.watchdogTimer = null;
        return;
      }

      const needsRestart = this.checkProcessAlive(proc);
      if (!needsRestart) return;

      // ── Crash-loop guard (ported from main.rs:585-616) ──────────────────────
      const now = Date.now();
      const windowMs = CRASH_WINDOW_SECS * 1000;

      if (proc.lastRespawnAt && now - proc.lastRespawnAt < windowMs) {
        proc.respawnCount++;
      } else {
        proc.respawnCount = 1;
      }

      if (proc.respawnCount >= CRASH_LIMIT) {
        runtimeLog.error("Crash-loop detected, stopping respawn", {
          name: proc.config.name,
          crashes: proc.respawnCount,
          windowSecs: CRASH_WINDOW_SECS,
        });
        this.setState(proc, "OFFLINE", `crash-loop: ${proc.respawnCount} crashes in ${CRASH_WINDOW_SECS}s`);
        proc.lastError = `Process is crash-looping (${proc.respawnCount} times in ${CRASH_WINDOW_SECS}s). Reinstall or contact support.`;
        // Reset counter after cooldown so a future respawn is allowed
        proc.respawnCount = 0;
        proc.lastRespawnAt = null;
        return;
      }

      // ── Respawn ──────────────────────────────────────────────────────────────
      runtimeLog.info("Watchdog: respawning process", {
        name: proc.config.name,
        attempt: proc.respawnCount,
      });
      this.setState(proc, "STARTING", "respawning after crash");
      this.spawnProcess(proc);
    }, WATCHDOG_INTERVAL_SECS * 1000);
  }

  // ── Internal: check if process is still alive ──────────────────────────────

  private checkProcessAlive(proc: SupervisedProcessState): boolean {
    if (!proc.child) return true; // No child — needs spawn

    // In Bun, we check if the process is still running by checking exited status
    // Bun's Subprocess doesn't have a direct try_wait equivalent, but we can
    // check if the process has exited via the exitCode property
    const child = proc.child as any;
    if (child.exitCode !== null && child.exitCode !== undefined) {
      runtimeLog.info("Watchdog: process exited", {
        name: proc.config.name,
        exitCode: child.exitCode,
      });
      proc.child = null;
      proc.running = false;
      proc.ready = false;
      return true; // needs restart
    }

    // Check if the process is signal-killed
    if (child.signalCode !== null && child.signalCode !== undefined) {
      runtimeLog.info("Watchdog: process killed by signal", {
        name: proc.config.name,
        signal: child.signalCode,
      });
      proc.child = null;
      proc.running = false;
      proc.ready = false;
      return true;
    }

    return false; // still running
  }

  // ── Internal: health probe — poll /health until ready or timeout ───────────
  // Ports the exact logic from main.rs:249-286

  private startHealthProbe(proc: SupervisedProcessState): void {
    proc.ready = false;
    this.setState(proc, "STARTING", "health probe started");

    const startedAt = Date.now();
    const deadlineMs = HEALTH_PROBE_DEADLINE_SECS * 1000;
    const port = proc.config.port!;
    const healthPath = proc.config.healthPath || "/health";
    const healthCheck = proc.config.healthCheck || ((res: Response) => res.ok);
    let attempts = 0;

    runtimeLog.info("Health probe started", {
      name: proc.config.name,
      port,
      deadlineSecs: HEALTH_PROBE_DEADLINE_SECS,
    });

    proc.healthProbeTimer = setInterval(async () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= deadlineMs) {
        if (proc.healthProbeTimer) clearInterval(proc.healthProbeTimer);
        proc.healthProbeTimer = null;
        this.setState(proc, "DEGRADED", `health probe timeout after ${HEALTH_PROBE_DEADLINE_SECS}s`);
        proc.lastError = `Process is alive but /health did not respond within ${HEALTH_PROBE_DEADLINE_SECS} seconds`;
        runtimeLog.error("Health probe timeout", {
          name: proc.config.name,
          attempts,
          elapsedMs: elapsed,
        });
        return;
      }

      attempts++;
      try {
        const url = `http://127.0.0.1:${port}${healthPath}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (healthCheck(res)) {
          if (proc.healthProbeTimer) clearInterval(proc.healthProbeTimer);
          proc.healthProbeTimer = null;
          proc.ready = true;
          this.setState(proc, "READY", `health=ready after ${attempts} attempts`);
          runtimeLog.info("Health probe succeeded", {
            name: proc.config.name,
            attempts,
            elapsedMs: elapsed,
          });
        }
      } catch {
        // Connection refused — process not ready yet, keep polling
      }
    }, HEALTH_PROBE_INTERVAL_MS);
  }

  // ── Internal: set state and log transition ─────────────────────────────────

  private setState(proc: SupervisedProcessState, newState: DriverState, reason: string): void {
    const oldState = proc.state;
    proc.state = newState;
    if (newState === "READY") {
      proc.lastError = null;
    } else if (newState === "OFFLINE" || newState === "DEGRADED") {
      // lastError is set by caller
    }
    if (oldState !== newState) {
      runtimeLog.info("Process state changed", {
        name: proc.config.name,
        oldState,
        newState,
        reason,
      });
    }
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

export const supervisor = new Supervisor();
