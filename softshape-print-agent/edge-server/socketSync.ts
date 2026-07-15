// ─────────────────────────────────────────────────────────────────────────────
// socketSync.ts — Real-time cloud → edge sync via Socket.IO
// ─────────────────────────────────────────────────────────────────────────────
// Connects to the cloud backend's Socket.IO server and listens for
// config change events. When the cloud detects a change (menu item added,
// price updated, table reconfigured, etc.), it emits to this socket client
// which immediately applies the change to local SQLite.
//
// This provides near-instant config propagation (< 1 second) compared to
// the 60-second polling interval of pullIncrementalChanges().
//
// Events handled:
//   edge:config_change  — { table, operation, row } → applyChange()
//   edge:config_batch   — { changes: [...] } → applyChangesBatch()
//   edge:full_resync    — triggers downloadFullConfig()
//   edge:table_update   — { tableId, status, ... } → direct table upsert
//
// Connection lifecycle:
//   - Connects on startup if session is valid
//   - Reconnects automatically with exponential backoff
//   - Re-authenticates on reconnect
//   - Falls back to polling if socket fails after 3 attempts
// ─────────────────────────────────────────────────────────────────────────────

import { io, type Socket } from "socket.io-client";
import { getBackendUrl, getSessionToken, getRestaurantId, isSessionValid } from "./auth.ts";
import { applyChangesBatch, downloadFullConfig } from "./config.ts";
import { getDb, setSyncState } from "./db.ts";

let socket: Socket | null = null;
let connectionAttempts = 0;
let fallbackToPolling = false;

// ─── Start socket sync client ────────────────────────────────────────────────

export function startSocketSync(): void {
  if (socket) return;

  const backendUrl = getBackendUrl();
  const token = getSessionToken();
  const restaurantId = getRestaurantId();

  if (!backendUrl || !token || !restaurantId) {
    console.log("[SocketSync] No valid session — skipping socket connection");
    return;
  }

  console.log(`[SocketSync] Connecting to ${backendUrl}...`);

  socket = io(backendUrl, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 30_000,
    timeout: 10_000,
    auth: {
      token,
      restaurantId,
      clientType: "edge_server",
    },
  });

  // ── Connection events ──────────────────────────────────────────────────────

  socket.on("connect", () => {
    console.log("[SocketSync] Connected to cloud");
    connectionAttempts = 0;
    fallbackToPolling = false;

    // Register as edge server
    socket!.emit("edge:register", {
      restaurantId,
      sessionToken: token,
      edgeVersion: "17.3.0",
    });
  });

  socket.on("disconnect", (reason: string) => {
    console.log(`[SocketSync] Disconnected: ${reason}`);
  });

  socket.on("connect_error", (err: any) => {
    connectionAttempts++;
    console.error(`[SocketSync] Connection error (${connectionAttempts}): ${err.message}`);

    if (connectionAttempts >= 3 && !fallbackToPolling) {
      fallbackToPolling = true;
      console.log("[SocketSync] Falling back to polling-only mode after 3 failures");
    }
  });

  socket.on("reconnect", (attempt: number) => {
    console.log(`[SocketSync] Reconnected after ${attempt} attempts`);
    connectionAttempts = 0;

    // Re-register after reconnect
    socket!.emit("edge:register", {
      restaurantId,
      sessionToken: token,
      edgeVersion: "17.3.0",
    });
  });

  // ── Cloud → edge sync events ───────────────────────────────────────────────

  socket.on("edge:config_change", (data: any) => {
    try {
      const applied = applyChangesBatch([data]);
      if (applied > 0) {
        setSyncState("last_socket_sync", new Date().toISOString());
        console.log(`[SocketSync] Applied 1 change (${data.table})`);
      }
    } catch (err) {
      console.error("[SocketSync] Failed to apply config_change:", err);
    }
  });

  socket.on("edge:config_batch", (data: any) => {
    try {
      const changes = data.changes || [];
      if (changes.length === 0) return;
      const applied = applyChangesBatch(changes);
      setSyncState("last_socket_sync", new Date().toISOString());
      console.log(`[SocketSync] Applied ${applied}/${changes.length} changes`);
    } catch (err) {
      console.error("[SocketSync] Failed to apply config_batch:", err);
    }
  });

  socket.on("edge:full_resync", async () => {
    console.log("[SocketSync] Full resync requested by cloud");
    try {
      const result = await downloadFullConfig();
      console.log(`[SocketSync] Full resync complete: ${result.tablesLoaded || 0} rows loaded`);
    } catch (err) {
      console.error("[SocketSync] Full resync failed:", err);
    }
  });

  socket.on("edge:table_update", (data: any) => {
    try {
      const db = getDb();
      const t = data.table || data;
      if (t && t.id) {
        // Build dynamic SET clause — only update fields present in the payload
        const sets: string[] = ["updated_at = unixepoch()"];
        const params: any[] = [];

        if (t.status !== undefined) { sets.push("status = ?"); params.push(t.status); }
        if (t.workflowStatus !== undefined) { sets.push("workflow_status = ?"); params.push(t.workflowStatus); }
        if (t.currentBill !== undefined) { sets.push("current_bill = ?"); params.push(Number(t.currentBill)); }
        if (t.captainId !== undefined) { sets.push("captain_id = ?"); params.push(t.captainId || null); }
        if (t.guests !== undefined) { sets.push("guests = ?"); params.push(Number(t.guests)); }
        if (t.kotHistory !== undefined) { sets.push("kot_history = ?"); params.push(typeof t.kotHistory === "string" ? t.kotHistory : JSON.stringify(t.kotHistory)); }
        if (t.discount !== undefined) { sets.push("discount = ?"); params.push(t.discount ? Number(t.discount) : null); }
        if (t.sessionStartedAt !== undefined) { sets.push("session_started_at = ?"); params.push(typeof t.sessionStartedAt === "number" ? t.sessionStartedAt : new Date(t.sessionStartedAt).getTime()); }

        if (sets.length === 1) return; // Only updated_at — nothing to update

        params.push(t.id);
        db.query(`UPDATE "table" SET ${sets.join(", ")} WHERE id = ?`).run(...params);
        setSyncState("last_socket_sync", new Date().toISOString());
        console.log(`[SocketSync] Table ${t.id} updated (${sets.length - 1} fields)`);
      }
    } catch (err) {
      console.error("[SocketSync] Failed to apply table_update:", err);
    }
  });

  // ── Heartbeat ──────────────────────────────────────────────────────────────

  socket.on("edge:heartbeat_ack", () => {
    // Cloud acknowledged our heartbeat — connection is healthy
  });
}

// ─── Send heartbeat ──────────────────────────────────────────────────────────

export function sendHeartbeat(): void {
  if (!socket || !socket.connected) return;
  const restaurantId = getRestaurantId();
  if (!restaurantId) return;

  socket.emit("edge:heartbeat", {
    restaurantId,
    timestamp: Date.now(),
    pendingSync: 0, // Could query sync_queue count here
  });
}

// ─── Stop socket sync ────────────────────────────────────────────────────────

export function stopSocketSync(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
    console.log("[SocketSync] Disconnected and stopped");
  }
}

// ─── Check if in fallback polling mode ────────────────────────────────────────

export function isInFallbackMode(): boolean {
  return fallbackToPolling;
}

// ─── Get socket connection status ────────────────────────────────────────────

export function getSocketStatus(): {
  connected: boolean;
  connectionAttempts: number;
  fallbackToPolling: boolean;
  lastSocketSync: string | null;
} {
  const db = getDb();
  const lastSocketSync = (db.query("SELECT value FROM sync_state WHERE key = 'last_socket_sync'").get() as any)?.value || null;

  return {
    connected: socket?.connected || false,
    connectionAttempts,
    fallbackToPolling,
    lastSocketSync,
  };
}

// ─── Heartbeat interval ──────────────────────────────────────────────────────

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    sendHeartbeat();
  }, 30_000); // Every 30 seconds
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
