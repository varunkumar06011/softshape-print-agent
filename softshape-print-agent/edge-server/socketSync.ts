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
import { applyChangesBatch } from "./config.ts";
import { getDb, setSyncState, updatePrintJobStatus, createPrintJob, claimPrintJob } from "./db.ts";
import { printToPrinter, resolvePrinterName } from "./printer.ts";
import { printerLog } from "./contract/logger.ts";

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

    // Register as edge server with print capability.
    // The cloud routes print_job events directly to this edge server.
    socket!.emit("edge:register", {
      restaurantId,
      sessionToken: token,
      edgeVersion: "23.12.10",
      capabilities: ["print"],
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

    // Re-register after reconnect with the CURRENT session token (not the
    // stale closure-captured one). If the JWT was refreshed while the socket
    // was disconnected, the old token would be expired and the cloud would
    // reject the re-registration. Always read the latest token from the
    // session store.
    const freshToken = getSessionToken();
    socket!.emit("edge:register", {
      restaurantId,
      sessionToken: freshToken || token,
      edgeVersion: "23.12.10",
      capabilities: ["print"],
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
      const { runtimeManager } = await import("./runtimeManager.ts");
      const result = await runtimeManager.runConfigSync();
      console.log(`[SocketSync] Full resync complete: ${result.tablesLoaded || 0} rows loaded`);
    } catch (err) {
      console.error("[SocketSync] Full resync failed:", err);
    }
  });

  // Cloud → edge: trigger reconciliation + immediate sync push.
  // Emitted by the admin panel's "Recover Missing" button via the cloud
  // endpoint POST /api/transactions/trigger-edge-reconcile. This allows
  // the admin to trigger recovery from any browser without needing direct
  // HTTP access to the edge server.
  socket.on("edge:trigger_reconcile", async () => {
    console.log("[SocketSync] Reconcile trigger received from cloud");
    try {
      const { reconcileTransactions, manualSyncPush } = await import("./sync.ts");
      const recon = reconcileTransactions();
      console.log(`[SocketSync] Reconciliation: ${recon.enqueued} re-enqueued, ${recon.reset} dead-letter resets, ${recon.backfilled} backfilled`);
      const pushResult = await manualSyncPush();
      console.log(`[SocketSync] Manual push: ok=${pushResult.ok}, pushed=${pushResult.pushed}, accepted=${pushResult.accepted}`);
    } catch (err) {
      console.error("[SocketSync] Trigger reconcile failed:", err);
    }
  });

  socket.on("edge:table_update", (data: any) => {
    try {
      const db = getDb();
      const t = data.table || data;
      if (t && t.id) {
        // Edge server is authoritative for live table business state.
        // Reject cloud-direct writes to business fields — these must flow
        // through edge command routes (createOrder, settleOrder, etc.) which
        // handle idempotency, revision increments, and KOT integrity.
        const businessFields = ["status", "workflowStatus", "currentBill", "captainId", "guests", "kotHistory", "sessionStartedAt", "discount"];
        const hasBusinessField = businessFields.some(f => t[f] !== undefined);
        if (hasBusinessField) {
          console.warn(`[SocketSync] Rejected cloud-direct table_update for ${t.id} — business state is edge-authoritative`);
          return;
        }

        // Only config-level fields (number, capacity, sectionId) are accepted
        const sets: string[] = ["updated_at = unixepoch()"];
        const params: any[] = [];

        if (t.number !== undefined) { sets.push("number = ?"); params.push(Number(t.number)); }
        if (t.capacity !== undefined) { sets.push("capacity = ?"); params.push(Number(t.capacity)); }
        if (t.sectionId !== undefined) { sets.push("section_id = ?"); params.push(t.sectionId); }

        if (sets.length === 1) return; // Only updated_at — nothing to update

        // Increment revision for any accepted config update
        sets.push("revision = (SELECT revision FROM \"table\" WHERE id = ?) + 1");
        params.push(t.id);
        params.push(t.id);
        db.query(`UPDATE "table" SET ${sets.join(", ")} WHERE id = ?`).run(...params);
        setSyncState("last_socket_sync", new Date().toISOString());
        console.log(`[SocketSync] Table ${t.id} config updated (${sets.length - 2} fields)`);
      }
    } catch (err) {
      console.error("[SocketSync] Failed to apply table_update:", err);
    }
  });

  // R5: edge:print_ack listener removed — cloud no longer relays print jobs.
  // The runtime SQLite queue is the sole retry owner (ADR-001).

  // ── Direct cloud print_job handler ────────────────────────────────────────
  // The cloud sends print_job events directly to this edge server for
  // cloud-originated prints (e.g. admin reprint from another device).
  // The Runtime prints them via the isolated print service on :3103 and
  // sends print:ack back to the cloud.
  socket.on("print_job", async (envelope: any) => {
    try {
      await handleCloudPrintJob(envelope);
    } catch (err) {
      console.error(`[SocketSync] Failed to handle cloud print_job:`, err);
      // Best-effort ack even on unexpected error
      if (envelope?.eventId) {
        sendPrintAck(envelope.eventId, false, String(err instanceof Error ? err.message : err), envelope?.data?.requestId);
      }
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

// ─── Send print ack to cloud ──────────────────────────────────────────────────

export function sendPrintAck(eventId: string, ok: boolean, error?: string | null, requestId?: string | null): void {
  if (!socket || !socket.connected) return;
  const restaurantId = getRestaurantId();
  if (!restaurantId) return;

  socket.emit("print:ack", {
    restaurantId,
    eventId,
    requestId: requestId || undefined,
    status: ok ? "success" : "failed",
    error: error || undefined,
  });
}

// ─── Handle cloud print_job event ───────────────────────────────────────────
// Receives a print_job envelope from the cloud, creates a durable print_job
// row in SQLite, dispatches it to the print service, and sends print:ack.

async function handleCloudPrintJob(envelope: any): Promise<void> {
  const { type, data, eventId } = envelope;
  if (!eventId) {
    console.warn("[SocketSync] Cloud print_job missing eventId — cannot track");
    sendPrintAck("", false, "Missing eventId in print_job", data?.requestId);
    return;
  }

  const restaurantId = getRestaurantId();
  if (!restaurantId) {
    console.warn("[SocketSync] Cannot handle cloud print_job — no restaurantId");
    sendPrintAck(eventId, false, "Edge server not authenticated", data?.requestId);
    return;
  }

  // Resolve target printer from job type + data
  let targetPrinter: string | null = data?.printerName || null;
  if (!targetPrinter) {
    // Try printer mapping from edge config
    try {
      const db = getDb();
      const mapping = JSON.parse(db.query("SELECT value FROM edge_config WHERE key = 'printer_mapping'").get() as any)?.value || "{}";
      if (type === "KOT" || type === "CANCEL_KOT") targetPrinter = mapping.kitchen || null;
      else if (type === "BAR_KOT") targetPrinter = mapping.bar || null;
      else if (type === "BILL" || type === "FINAL_BILL" || type === "CANCELLED_BILL" || type === "EXPENDITURE" || type === "X_REPORT") targetPrinter = mapping.bill || null;
      else if (type === "TABLE_SWAP") targetPrinter = mapping.kitchen || null;
    } catch { /* ignore */ }
  }

  // Fallback: resolve from outlet printer_config if printer_mapping didn't have it (RC-5 fix)
  if (!targetPrinter && restaurantId) {
    try {
      const db = getDb();
      const row = db.query("SELECT printer_config FROM outlet WHERE id = ?").get(restaurantId) as { printer_config: string } | undefined;
      const pc = row?.printer_config ? JSON.parse(row.printer_config) : {};
      if (type === "KOT" || type === "CANCEL_KOT") targetPrinter = resolvePrinterName(null, "KOT_PRINTER", null, pc) || null;
      else if (type === "BAR_KOT") targetPrinter = resolvePrinterName(null, "BAR_PRINTER", null, pc) || null;
      else if (type === "BILL" || type === "FINAL_BILL" || type === "CANCELLED_BILL" || type === "EXPENDITURE" || type === "X_REPORT") targetPrinter = resolvePrinterName(null, "BILL_PRINTER", null, pc) || null;
      else if (type === "TABLE_SWAP") targetPrinter = resolvePrinterName(null, "KOT_PRINTER", null, pc) || null;
    } catch { /* ignore */ }
  }

  if (!targetPrinter) {
    console.warn(`[SocketSync] No printer resolved for cloud print_job ${type} (${eventId})`);
    sendPrintAck(eventId, false, `No printer resolved for ${type}`, data?.requestId);
    return;
  }

  const escposData = data?.escposData;
  if (!escposData || (Array.isArray(escposData) && escposData.length === 0)) {
    console.warn(`[SocketSync] No ESC/POS data in cloud print_job ${type} (${eventId})`);
    sendPrintAck(eventId, false, `No ESC/POS data for ${type}`, data?.requestId);
    return;
  }

  // Create a durable print_job row (idempotent via ON CONFLICT DO NOTHING)
  createPrintJob({
    eventId,
    restaurantId,
    orderId: data?.orderId || null,
    kotId: data?.kotId || null,
    kotNumber: data?.kotNumber || null,
    tableId: data?.tableId || null,
    printerName: targetPrinter,
    jobType: type,
    escposData,
    itemSummary: data?.itemSummary || [],
    captainName: data?.captainName || null,
  });

  // Claim the job for printing
  if (!claimPrintJob(eventId)) {
    console.log(`[SocketSync] Cloud print_job ${eventId} already being processed`);
    return;
  }

  printerLog.info(`Cloud print_job received: ${type} → ${targetPrinter} (eventId=${eventId})`);

  // Dispatch to the print service
  try {
    const result = await printToPrinter(targetPrinter, escposData, eventId, type);
    if (result.ok) {
      updatePrintJobStatus(eventId, "printed", null, "cloud_direct");
      sendPrintAck(eventId, true, null, data?.requestId);
      printerLog.info(`Cloud print_job printed: ${type} → ${targetPrinter} (${result.bytes} bytes via ${result.method}, eventId=${eventId})`);
    } else {
      updatePrintJobStatus(eventId, "retrying", result.error || "Print failed", "cloud_direct");
      sendPrintAck(eventId, false, result.error || "Print failed", data?.requestId);
      printerLog.warn(`Cloud print_job failed: ${type} → ${targetPrinter}: ${result.error} (eventId=${eventId})`);
    }
  } catch (err: any) {
    updatePrintJobStatus(eventId, "retrying", err?.message || String(err), "cloud_direct");
    sendPrintAck(eventId, false, err?.message || String(err), data?.requestId);
    printerLog.error(`Cloud print_job dispatch error: ${type} → ${targetPrinter}: ${err instanceof Error ? err.message : err} (eventId=${eventId})`);
  }
}

// R5: relayPrintViaCloud removed — cloud relay path eliminated.
// The runtime SQLite queue is the sole retry owner (ADR-001).

export function isCloudSocketConnected(): boolean {
  return socket?.connected || false;
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
