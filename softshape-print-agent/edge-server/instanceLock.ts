// ─────────────────────────────────────────────────────────────────────────────
// instanceLock.ts — Active instance lock with crash recovery
// ─────────────────────────────────────────────────────────────────────────────
// Ensures only one edge server instance is active per restaurant at a time.
// Uses a SQLite-based lock with TTL and heartbeat.
//
// Design:
//   - On startup, attempt to acquire the lock by inserting/updating edge_config
//   - If another instance holds the lock and its heartbeat is fresh, refuse to start
//   - If the lock holder's heartbeat is stale (crashed), take over
//   - Active instance heartbeats every 5 seconds
//   - Lock TTL: 15 seconds (3 missed heartbeats = stale)
//   - Force takeover: admin can manually release the lock via API
//
// This prevents duplicate sync workers and conflicting writes when:
//   - The edge server crashes and restarts
//   - Two instances are accidentally started on the same machine
//   - A stale process is still running after a deployment
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from "./db.ts";
import { getDeviceId } from "./auth.ts";
import os from "os";

const LOCK_KEY = "active_instance_lock";
const HEARTBEAT_INTERVAL_MS = 5_000;
const LOCK_TTL_MS = 15_000; // 3 missed heartbeats

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let currentLockHolder: string | null = null;

export interface InstanceLockInfo {
  instanceId: string;
  hostname: string;
  pid: number;
  acquiredAt: number;
  lastHeartbeat: number;
}

function getLocalInstanceId(): string {
  const deviceId = getDeviceId() || "unknown";
  const pid = process.pid;
  const hostname = os.hostname();
  return `${deviceId}:${hostname}:${pid}`;
}

function readLock(): InstanceLockInfo | null {
  const db = getDb();
  const row = db.query("SELECT value FROM edge_config WHERE key = ?").get(LOCK_KEY) as any;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as InstanceLockInfo;
  } catch {
    return null;
  }
}

function writeLock(info: InstanceLockInfo): void {
  const db = getDb();
  db.query(
    "INSERT INTO edge_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(LOCK_KEY, JSON.stringify(info), Date.now());
}

function deleteLock(): void {
  const db = getDb();
  db.query("DELETE FROM edge_config WHERE key = ?").run(LOCK_KEY);
}

// Attempt to acquire the active instance lock.
// Returns true if this instance is now the active one.
// If another instance holds a fresh lock, returns false with the holder info.
export function acquireInstanceLock(): { acquired: boolean; holder: InstanceLockInfo | null } {
  const existing = readLock();
  const now = Date.now();
  const myId = getLocalInstanceId();

  if (existing) {
    const isStale = now - existing.lastHeartbeat > LOCK_TTL_MS;
    const isMine = existing.instanceId === myId;

    if (!isStale && !isMine) {
      // Another live instance holds the lock
      return { acquired: false, holder: existing };
    }

    if (isMine) {
      // Re-acquiring on restart of same process — update heartbeat
      const info: InstanceLockInfo = {
        ...existing,
        lastHeartbeat: now,
      };
      writeLock(info);
      currentLockHolder = myId;
      return { acquired: true, holder: info };
    }

    // Stale lock — take over
    console.warn(`[InstanceLock] Taking over stale lock from ${existing.instanceId} (last heartbeat ${now - existing.lastHeartbeat}ms ago)`);
  }

  const info: InstanceLockInfo = {
    instanceId: myId,
    hostname: os.hostname(),
    pid: process.pid,
    acquiredAt: now,
    lastHeartbeat: now,
  };
  writeLock(info);
  currentLockHolder = myId;
  console.log(`[InstanceLock] Lock acquired by ${myId}`);
  return { acquired: true, holder: info };
}

// Start the heartbeat loop. Must be called after acquireInstanceLock succeeds.
export function startHeartbeatLoop(): void {
  if (heartbeatTimer) return;

  heartbeatTimer = setInterval(() => {
    const existing = readLock();
    const myId = getLocalInstanceId();

    if (!existing || existing.instanceId !== myId) {
      // Lost the lock — stop heartbeat and log warning
      console.warn("[InstanceLock] Lost lock (another instance took over?) — stopping heartbeat");
      stopHeartbeatLoop();
      currentLockHolder = null;
      return;
    }

    // Update heartbeat
    const info: InstanceLockInfo = {
      ...existing,
      lastHeartbeat: Date.now(),
    };
    writeLock(info);
  }, HEARTBEAT_INTERVAL_MS);
}

// Stop the heartbeat loop.
export function stopHeartbeatLoop(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// Release the lock gracefully (on shutdown).
export function releaseInstanceLock(): void {
  stopHeartbeatLoop();
  const existing = readLock();
  const myId = getLocalInstanceId();

  if (existing && existing.instanceId === myId) {
    deleteLock();
    console.log(`[InstanceLock] Lock released by ${myId}`);
  }
  currentLockHolder = null;
}

// Force-release the lock (admin action, e.g. via API).
// This allows a new instance to take over immediately.
export function forceReleaseLock(): { success: boolean } {
  deleteLock();
  stopHeartbeatLoop();
  currentLockHolder = null;
  console.log("[InstanceLock] Lock force-released by admin");
  return { success: true };
}

// Get the current lock status (for /api/edge/status endpoint).
export function getLockStatus(): { locked: boolean; holder: InstanceLockInfo | null; isThisInstance: boolean } {
  const existing = readLock();
  const myId = getLocalInstanceId();

  if (!existing) {
    return { locked: false, holder: null, isThisInstance: false };
  }

  const isStale = Date.now() - existing.lastHeartbeat > LOCK_TTL_MS;
  if (isStale) {
    return { locked: false, holder: existing, isThisInstance: false };
  }

  return {
    locked: true,
    holder: existing,
    isThisInstance: existing.instanceId === myId,
  };
}
