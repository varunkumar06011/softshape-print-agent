// ─────────────────────────────────────────────────────────────────────────────
// runtimeManager.ts — Central runtime lifecycle coordinator
// ─────────────────────────────────────────────────────────────────────────────
// The single owner of: startup, shutdown, restart, sync, health, runtime state,
// watchdog, and background job coordination.
//
// Nothing else in the edge-server should call downloadFullConfig(),
// startSyncWorker(), startSocketSync(), warmCache(), verify(), or setState()
// directly. Everything goes through RuntimeManager.
//
// State separation (per production hardening plan):
//   RuntimeState      — lifecycle readiness (BOOTING → STARTING → READY)
//   ConfigSyncState   — config download pipeline (IDLE → DOWNLOADING → ... → READY)
//   ConnectionState   — cloud connectivity (OFFLINE → CONNECTING → ONLINE)
//
// isOperational = (RuntimeState === READY)
// The UI checks this single boolean — no inference from side effects.
// ─────────────────────────────────────────────────────────────────────────────

import {
  type RuntimeState,
  type ConfigSyncState,
  type ConnectionState,
  RUNTIME_STATE_TRANSITIONS,
  CONFIG_SYNC_STATE_TRANSITIONS,
  CONNECTION_STATE_TRANSITIONS,
  isValidTransition,
} from "./contract/states.ts";
import { runtimeLog } from "./contract/logger.ts";
import { emitEvent } from "./eventBus.ts";
import { EVENT_NAMES } from "./contract/events.ts";
import { getDeviceId, getRestaurantId, isSessionValid, isLocalReady, loadSession } from "./auth.ts";
import { getDb, getSyncState, setSyncState } from "./db.ts";
import { downloadFullConfig } from "./config.ts";
import { startSyncWorker, stopSyncWorker, getSyncStatus } from "./sync.ts";
import { startSocketSync, stopSocketSync, getSocketStatus, isInFallbackMode } from "./socketSync.ts";
import { startHeartbeat, stopHeartbeat } from "./socketSync.ts";
import { startHeartbeatLoop, stopHeartbeatLoop, releaseInstanceLock, acquireInstanceLock } from "./instanceLock.ts";
import { startPrintService, stopPrintService } from "./printServiceManager.ts";
import { runDailyMaintenance, runPeriodicBackup } from "./backup.ts";
import { getRecoveryStatus } from "./db.ts";

// ── Singleton ────────────────────────────────────────────────────────────────

class RuntimeManager {
  private _runtimeState: RuntimeState = "BOOTING";
  private _configSyncState: ConfigSyncState = "IDLE";
  private _connectionState: ConnectionState = "OFFLINE";
  private _startupError: string = "";
  private _syncId: string = "";
  private _startupBeganAt: number = 0;
  private _lastSyncAt: number = 0;
  private _syncAttempt: number = 0;
  private _syncMutex: boolean = false;
  private _backgroundRetryTimer: ReturnType<typeof setInterval> | null = null;
  private _connectionCheckTimer: ReturnType<typeof setInterval> | null = null;
  private _maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private _backupTimer: ReturnType<typeof setInterval> | null = null;

  // ── Public state accessors ──────────────────────────────────────────────────

  get runtimeState(): RuntimeState {
    return this._runtimeState;
  }

  get configSyncState(): ConfigSyncState {
    return this._configSyncState;
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  get isOperational(): boolean {
    return this._runtimeState === "READY";
  }

  get startupError(): string {
    return this._startupError;
  }

  get syncId(): string {
    return this._syncId;
  }

  get isSyncing(): boolean {
    return this._syncMutex;
  }

  // ── Full status snapshot for /health and /runtime/status ────────────────────

  getStatus(): {
    runtimeState: RuntimeState;
    configSyncState: ConfigSyncState;
    connectionState: ConnectionState;
    isOperational: boolean;
    startupError: string | null;
    syncId: string;
    lastSyncAt: number;
    syncAttempt: number;
    configSyncVerified: boolean;
  } {
    return {
      runtimeState: this._runtimeState,
      configSyncState: this._configSyncState,
      connectionState: this._connectionState,
      isOperational: this.isOperational,
      startupError: this._startupError || null,
      syncId: this._syncId,
      lastSyncAt: this._lastSyncAt,
      syncAttempt: this._syncAttempt,
      configSyncVerified: getSyncState("config_sync_verified") === "true",
    };
  }

  // ── State transitions (private — only RuntimeManager changes its own state) ─

  private setRuntimeState(newState: RuntimeState, reason: string): void {
    const oldState = this._runtimeState;
    if (oldState === newState) return;

    if (!isValidTransition(RUNTIME_STATE_TRANSITIONS, oldState, newState)) {
      runtimeLog.warn("Invalid runtime state transition", { oldState, newState, reason });
      return;
    }

    this._runtimeState = newState;
    runtimeLog.info("Runtime state changed", {
      oldState,
      newState,
      reason,
      isOperational: newState === "READY",
      restaurantId: getRestaurantId(),
      deviceId: getDeviceId(),
      elapsedMs: this._startupBeganAt ? Date.now() - this._startupBeganAt : 0,
    });

    emitEvent({
      event: EVENT_NAMES.RUNTIME_STATE_CHANGED,
      data: {
        oldState,
        newState,
        isOperational: newState === "READY",
        reason,
      },
    });
  }

  private setConfigSyncState(newState: ConfigSyncState, reason: string, error?: string): void {
    const oldState = this._configSyncState;
    if (oldState === newState) return;

    if (!isValidTransition(CONFIG_SYNC_STATE_TRANSITIONS, oldState, newState)) {
      runtimeLog.warn("Invalid config sync state transition", { oldState, newState, reason });
      return;
    }

    this._configSyncState = newState;
    runtimeLog.info("Config sync state changed", {
      oldState,
      newState,
      reason,
      attempt: this._syncAttempt,
      error: error || null,
      syncId: this._syncId,
      restaurantId: getRestaurantId(),
      deviceId: getDeviceId(),
    });

    emitEvent({
      event: EVENT_NAMES.CONFIG_SYNC_STATE_CHANGED,
      data: {
        oldState,
        newState,
        reason,
        attempt: this._syncAttempt,
        error,
      },
    });
  }

  private setConnectionState(newState: ConnectionState, reason: string): void {
    const oldState = this._connectionState;
    if (oldState === newState) return;

    if (!isValidTransition(CONNECTION_STATE_TRANSITIONS, oldState, newState)) {
      runtimeLog.warn("Invalid connection state transition", { oldState, newState, reason });
      return;
    }

    this._connectionState = newState;
    runtimeLog.info("Connection state changed", {
      oldState,
      newState,
      reason,
      restaurantId: getRestaurantId(),
      deviceId: getDeviceId(),
    });

    emitEvent({
      event: EVENT_NAMES.CONNECTION_STATE_CHANGED,
      data: {
        oldState,
        newState,
        reason,
      },
    });
  }

  // ── Emit sync progress event ────────────────────────────────────────────────

  emitSyncProgress(stage: string, entity: string, current: number, total: number): void {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    runtimeLog.debug("Sync progress", { stage, entity, current, total, percent, syncId: this._syncId });
    emitEvent({
      event: EVENT_NAMES.CONFIG_SYNC_PROGRESS,
      data: { stage, entity, current, total, percent },
    });
  }

  // ── Startup sequence ────────────────────────────────────────────────────────
  // This is the single entry point for the entire runtime lifecycle.
  // Replaces the scattered setTimeout(0) + conditional startSyncWorker() blocks
  // that were in server.ts:2376-2509.

  async startup(): Promise<void> {
    this._startupBeganAt = Date.now();
    this._syncId = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    runtimeLog.info("RuntimeManager startup initiated", {
      syncId: this._syncId,
      restaurantId: getRestaurantId(),
      deviceId: getDeviceId(),
    });

    this.setRuntimeState("STARTING", "startup initiated");

    // ── Step 1: Run startup maintenance (backup + prune) ──────────────────────
    try {
      runDailyMaintenance(getDb());
      runtimeLog.info("Startup maintenance complete");
    } catch (err: any) {
      this._startupError = err?.message || String(err);
      runtimeLog.error("Startup maintenance failed (non-fatal)", {
        error: err?.stack || err,
      });
    }

    // ── Step 2: Check for database recovery ──────────────────────────────────
    const recovery = getRecoveryStatus();
    if (recovery.recovered) {
      runtimeLog.warn("Database was recovered from corruption", {
        recoveryMessage: recovery.message,
      });
    }

    // ── Step 3: Start print service ──────────────────────────────────────────
    try {
      startPrintService();
      runtimeLog.info("Print service started");
    } catch (err: any) {
      runtimeLog.error("Print service failed to start (non-fatal)", {
        error: err?.stack || err,
      });
    }

    // ── Step 4: Check session validity → determine auth readiness ────────────
    if (isSessionValid()) {
      runtimeLog.info("Session valid — proceeding with background services");

      const lockResult = acquireInstanceLock();
      if (!lockResult.acquired) {
        runtimeLog.warn("Instance lock held by another instance — sync services disabled", {
          holder: lockResult.holder?.instanceId,
        });
      } else {
        startHeartbeatLoop();
        startSyncWorker();
        startSocketSync();
        startHeartbeat();
        this.startIncrementalPolling();
        runtimeLog.info("Background sync services started");
      }
    } else {
      runtimeLog.info("No valid session — waiting for registration via POST /api/edge/register");
    }

    // ── Step 5: If session valid and config not yet downloaded, trigger sync ──
    if (isSessionValid() && !isLocalReady()) {
      runtimeLog.info("Session valid but local config not ready — starting config sync");
      this.runConfigSync().catch((err) => {
        runtimeLog.error("Initial config sync failed", {
          error: err?.stack || err,
          syncId: this._syncId,
        });
      });
    } else if (isSessionValid() && isLocalReady()) {
      runtimeLog.info("Local config already ready — skipping initial sync");
    }

    // ── Step 6: If database was recovered, force config re-download ──────────
    if (recovery.recovered && isSessionValid()) {
      runtimeLog.warn("Database recovered — forcing config re-download");
      this.runConfigSync().catch((err) => {
        runtimeLog.error("Recovery config re-download failed", {
          error: err?.stack || err,
        });
      });
    }

    // ── Step 7: Declare READY if local data is available ─────────────────────
    // The runtime is READY when it can serve local data (isLocalReady).
    // Connection state and sync state are tracked independently.
    if (isLocalReady()) {
      this.setRuntimeState("READY", "local data available");
    } else if (!isSessionValid()) {
      // No session — runtime is READY to accept registration requests,
      // but isOperational will be false until onboarding completes.
      // We set READY so /health responds, but isLocalReady() gates operations.
      this.setRuntimeState("READY", "ready for registration");
    } else {
      // Session valid but config not yet downloaded — stay STARTING
      // until config sync completes. The runConfigSync call above will
      // transition to READY when it succeeds.
      runtimeLog.info("Waiting for config sync to complete before READY");
    }

    // ── Step 8: Start background timers ──────────────────────────────────────
    this.startMaintenanceTimers();
    this.startConnectionMonitor();
  }

  // ── Config sync pipeline ────────────────────────────────────────────────────
  // This is the ONLY entry point for triggering a config sync.
  // The sync mutex ensures only one sync runs at a time — no concurrent
  // startup sync + manual sync + socket-triggered sync.

  async runConfigSync(): Promise<{ success: boolean; error?: string; tablesLoaded?: number }> {
    if (this._syncMutex) {
      runtimeLog.warn("Config sync already in progress — ignoring request", {
        syncId: this._syncId,
        currentState: this._configSyncState,
      });
      return { success: false, error: "Sync already in progress" };
    }

    this._syncMutex = true;
    this._syncAttempt++;
    this._lastSyncAt = Date.now();
    const attemptStart = Date.now();

    this.setConfigSyncState("DOWNLOADING", `sync attempt ${this._syncAttempt}`);

    try {
      const result = await downloadFullConfig((stage) => {
        if (stage === "validating") {
          this.setConfigSyncState("VALIDATING", "schema validation passed");
        } else if (stage === "committing") {
          this.setConfigSyncState("COMMITTING", "writing to SQLite transaction");
        } else if (stage === "verifying") {
          this.setConfigSyncState("VERIFYING", "post-commit verification");
        }
      });

      if (!result.success) {
        this.setConfigSyncState("FAILED", `sync failed: ${result.error}`, result.error);
        this.scheduleRetry();
        return result;
      }

      this.setConfigSyncState("READY", `sync complete: ${result.tablesLoaded || 0} rows loaded`);

      // Transition runtime to READY if it wasn't already
      if (this._runtimeState !== "READY") {
        this.setRuntimeState("READY", "config sync complete");
      }

      runtimeLog.info("Config sync successful", {
        syncId: this._syncId,
        attempt: this._syncAttempt,
        tablesLoaded: result.tablesLoaded || 0,
        elapsedMs: Date.now() - attemptStart,
        restaurantId: getRestaurantId(),
        deviceId: getDeviceId(),
      });

      return result;
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      this.setConfigSyncState("FAILED", `sync error: ${errorMsg}`, errorMsg);
      runtimeLog.error("Config sync error", {
        syncId: this._syncId,
        attempt: this._syncAttempt,
        error: err?.stack || err,
        elapsedMs: Date.now() - attemptStart,
        restaurantId: getRestaurantId(),
        deviceId: getDeviceId(),
      });
      this.scheduleRetry();
      return { success: false, error: errorMsg };
    } finally {
      this._syncMutex = false;
    }
  }

  // ── Retry with exponential backoff ──────────────────────────────────────────
  // 2s → 4s → 8s → 16s → 30s → 60s, then background retry forever (every 60s)

  private scheduleRetry(): void {
    const backoffMs = this._syncAttempt <= 6
      ? [2_000, 4_000, 8_000, 16_000, 30_000, 60_000][this._syncAttempt - 1] || 60_000
      : 60_000;

    runtimeLog.info("Scheduling config sync retry", {
      attempt: this._syncAttempt,
      backoffMs,
      syncId: this._syncId,
    });

    setTimeout(() => {
      if (this._runtimeState === "STOPPING" || this._runtimeState === "STOPPED") return;
      this.runConfigSync().catch((err) => {
        runtimeLog.error("Retry config sync failed", { error: err?.stack || err });
      });
    }, backoffMs);
  }

  // ── Incremental polling ─────────────────────────────────────────────────────

  private _pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private _pollStarted = false;

  private startIncrementalPolling(): void {
    if (this._pollStarted) return;
    this._pollStarted = true;

    const schedulePoll = (): void => {
      if (this._pollIntervalId) clearInterval(this._pollIntervalId);
      const intervalMs = isInFallbackMode() ? 15_000 : 60_000;
      this._pollIntervalId = setInterval(async () => {
        if (!isSessionValid()) return;
        if (this._runtimeState === "STOPPING" || this._runtimeState === "STOPPED") return;
        if (this._syncMutex) {
          runtimeLog.debug("Skipping incremental poll — full sync in progress");
          return;
        }
        try {
          const { pullIncrementalChanges } = await import("./config.ts");
          const result = await pullIncrementalChanges();
          if (result.success && result.changesApplied && result.changesApplied > 0) {
            runtimeLog.info("Incremental sync applied", { changes: result.changesApplied });
          }
        } catch (err) {
          runtimeLog.warn("Incremental sync failed", { error: err });
        }
        const currentMs = isInFallbackMode() ? 15_000 : 60_000;
        if (currentMs !== intervalMs) {
          schedulePoll();
        }
      }, intervalMs);
    };
    schedulePoll();

    setTimeout(async () => {
      if (this._runtimeState === "STOPPING" || this._runtimeState === "STOPPED") return;
      if (this._syncMutex) {
        runtimeLog.debug("Skipping initial incremental sync — full sync in progress");
        return;
      }
      try {
        const { pullIncrementalChanges } = await import("./config.ts");
        const result = await pullIncrementalChanges();
        if (result.success) {
          runtimeLog.info("Initial incremental sync complete", { changes: result.changesApplied || 0 });
        }
      } catch {
        // Will retry in the interval
      }
    }, 3_000);
  }

  // ── Connection monitor ──────────────────────────────────────────────────────
  // Checks cloud connectivity every 30 seconds and updates ConnectionState.

  private startConnectionMonitor(): void {
    this._connectionCheckTimer = setInterval(() => {
      if (this._runtimeState === "STOPPING" || this._runtimeState === "STOPPED") return;

      const socketStatus = getSocketStatus();
      const wasOnline = this._connectionState === "ONLINE" || this._connectionState === "DEGRADED";

      if (socketStatus.connected && !wasOnline) {
        this.setConnectionState("CONNECTING", "socket connected");
        this.setConnectionState("ONLINE", "cloud reachable");
      } else if (!socketStatus.connected && wasOnline) {
        this.setConnectionState("OFFLINE", "cloud unreachable");
      } else if (socketStatus.connected && isInFallbackMode() && this._connectionState === "ONLINE") {
        this.setConnectionState("DEGRADED", "in fallback mode");
      } else if (socketStatus.connected && !isInFallbackMode() && this._connectionState === "DEGRADED") {
        this.setConnectionState("ONLINE", "fallback resolved");
      }
    }, 30_000);
  }

  // ── Maintenance timers ──────────────────────────────────────────────────────

  private startMaintenanceTimers(): void {
    // Daily maintenance every 24 hours
    this._maintenanceTimer = setInterval(() => {
      if (this._runtimeState === "STOPPING" || this._runtimeState === "STOPPED") return;
      try {
        runDailyMaintenance(getDb());
      } catch (err) {
        runtimeLog.warn("Scheduled maintenance failed", { error: err });
      }
    }, 24 * 60 * 60 * 1000);

    // Periodic backup every 30 minutes
    this._backupTimer = setInterval(() => {
      if (this._runtimeState === "STOPPING" || this._runtimeState === "STOPPED") return;
      try {
        runPeriodicBackup(getDb());
      } catch (err) {
        runtimeLog.warn("Periodic backup failed", { error: err });
      }
    }, 30 * 60 * 1000);
  }

  // ── Shutdown ────────────────────────────────────────────────────────────────
  // The ONLY way to stop all services. Called by /runtime/shutdown or SIGINT/SIGTERM.

  async shutdown(): Promise<void> {
    runtimeLog.info("RuntimeManager shutdown initiated", {
      runtimeState: this._runtimeState,
      restaurantId: getRestaurantId(),
      deviceId: getDeviceId(),
    });

    this.setRuntimeState("STOPPING", "shutdown requested");

    // Stop background timers immediately
    if (this._connectionCheckTimer) clearInterval(this._connectionCheckTimer);
    if (this._maintenanceTimer) clearInterval(this._maintenanceTimer);
    if (this._backupTimer) clearInterval(this._backupTimer);
    if (this._pollIntervalId) clearInterval(this._pollIntervalId);
    if (this._backgroundRetryTimer) clearInterval(this._backgroundRetryTimer);

    // Stop services in dependency order with a 5-second overall timeout.
    // If any service hangs (e.g., a socket that won't close), we don't
    // block process exit indefinitely — we log a warning and proceed.
    const SHUTDOWN_TIMEOUT_MS = 5_000;
    const stopAllServices = async (): Promise<void> => {
      try { stopPrintService(); } catch (err) { runtimeLog.warn("Print service stop failed", { error: err }); }
      try { stopHeartbeat(); } catch (err) { runtimeLog.warn("Heartbeat stop failed", { error: err }); }
      try { stopSocketSync(); } catch (err) { runtimeLog.warn("Socket sync stop failed", { error: err }); }
      try { stopSyncWorker(); } catch (err) { runtimeLog.warn("Sync worker stop failed", { error: err }); }
      try { stopHeartbeatLoop(); } catch (err) { runtimeLog.warn("Heartbeat loop stop failed", { error: err }); }
      try { releaseInstanceLock(); } catch (err) { runtimeLog.warn("Instance lock release failed", { error: err }); }
    };

    await Promise.race([
      stopAllServices(),
      new Promise<void>((resolve) => setTimeout(() => {
        runtimeLog.warn("Shutdown timeout — some services did not stop within 5s, proceeding anyway");
        resolve();
      }, SHUTDOWN_TIMEOUT_MS)),
    ]);

    this.setConnectionState("OFFLINE", "shutdown");
    this.setRuntimeState("STOPPED", "shutdown complete");

    runtimeLog.info("RuntimeManager shutdown complete", {
      elapsedMs: this._startupBeganAt ? Date.now() - this._startupBeganAt : 0,
    });
  }

  // ── Restart ─────────────────────────────────────────────────────────────────
  // Called by /runtime/restart. Graceful shutdown then process exit.
  // The Runtime Host will respawn the process.

  async restart(): Promise<void> {
    runtimeLog.info("Runtime restart requested");
    await this.shutdown();
    // The Host's watchdog will detect the exit and respawn
    setTimeout(() => process.exit(0), 500);
  }

  // ── Health check ────────────────────────────────────────────────────────────
  // Returns a structured health snapshot for /health endpoint.

  getHealth(): {
    status: "ok" | "initializing" | "error";
    runtimeState: RuntimeState;
    configSyncState: ConfigSyncState;
    connectionState: ConnectionState;
    isOperational: boolean;
    startupError: string | null;
    syncId: string;
    lastSyncAt: number;
    syncAttempt: number;
    configSyncVerified: boolean;
    configCountMismatches: string;
    configIntegrityViolations: string;
  } {
    const isReady = this._runtimeState === "READY";
    const verified = getSyncState("config_sync_verified") === "true";
    const countMismatches = getSyncState("config_count_mismatches") || "";
    const integrityViolations = getSyncState("config_integrity_violations") || "[]";
    return {
      status: this._runtimeState === "CRASH_LOOP"
        ? "error"
        : isReady
          ? "ok"
          : "initializing",
      runtimeState: this._runtimeState,
      configSyncState: this._configSyncState,
      connectionState: this._connectionState,
      isOperational: this.isOperational,
      startupError: this._startupError || null,
      syncId: this._syncId,
      lastSyncAt: this._lastSyncAt,
      syncAttempt: this._syncAttempt,
      configSyncVerified: verified,
      configCountMismatches: countMismatches,
      configIntegrityViolations: integrityViolations,
    };
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

export const runtimeManager = new RuntimeManager();
