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
import { getBackendUrl, getSessionToken, getRestaurantId, isSessionValid, getDeviceId } from "./auth.ts";
import { applyChangesBatch } from "./config.ts";
import { getDb, setSyncState, getSyncState, updatePrintJobStatus, createPrintJob, claimPrintJob, cancelPrintJob, getConfig } from "./db.ts";
import { printToPrinter, resolvePrinterName } from "./printer.ts";
import { printerLog } from "./contract/logger.ts";
import { listPrintersViaService } from "./printServiceManager.ts";

let socket: Socket | null = null;
let connectionAttempts = 0;
let fallbackToPolling = false;

// KOT job types are duplicate-prone — a silently retried KOT causes the kitchen
// to prepare the same food twice. Failed KOT prints are marked "failed" (not
// "retrying") so the background dispatch loop never re-dispatches them.
function isKotJobType(type: string): boolean {
  const t = (type || "").toUpperCase();
  return t === "KOT" || t === "BAR_KOT" || t === "CANCEL_KOT";
}

// ─── Gather this edge server's available printer names ──────────────────────
// Uses the LIVE print service to detect actual OS printers physically connected
// to THIS machine. This is critical for multi-desktop setups where two desktops
// share the same outlet but have different printers — the cloud-synced config
// is identical on both desktops, so only the live print service can tell them
// apart.
//
// Falls back to config-based sources if the print service is not ready yet
// (e.g. during early startup). The heartbeat will send the accurate list once
// the print service is up.
async function getAvailablePrinters(): Promise<string[]> {
  const printers = new Set<string>();

  // 1. Live print service — actual OS printers connected to THIS machine
  try {
    const live = await listPrintersViaService();
    for (const p of live) {
      if (p?.name) printers.add(p.name);
    }
  } catch { /* print service not ready — fall back to config */ }

  // If the print service returned printers, use ONLY those — they are the
  // ground truth for what's physically connected to this machine.
  if (printers.size > 0) return Array.from(printers);

  // 2. Fallback: edge config printer_mapping (kitchen/bar/bill → printer name)
  //    Used when the print service is not ready yet. The heartbeat will
  //    send the accurate list once the print service is up.
  try {
    const mappingRaw = getConfig("printer_mapping");
    if (mappingRaw) {
      const mapping = JSON.parse(mappingRaw);
      for (const v of Object.values(mapping)) {
        if (typeof v === "string" && v) printers.add(v);
      }
    }
  } catch { /* ignore */ }

  return Array.from(printers);
}

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

  socket.on("connect", async () => {
    console.log("[SocketSync] Connected to cloud");
    connectionAttempts = 0;
    fallbackToPolling = false;

    // Register as edge server with print capability.
    // Register immediately without availablePrinters so the cloud accepts
    // the connection fast. Then asynchronously fetch the live printer list
    // from the print service and send it via edge:printers_report.
    socket!.emit("edge:register", {
      restaurantId,
      sessionToken: token,
      edgeVersion: "23.12.27",
      capabilities: ["print"],
    });

    // Asynchronously report available printers to the cloud.
    // This uses the live print service to detect actual OS printers on THIS
    // machine — critical for multi-desktop routing.
    try {
      const printers = await getAvailablePrinters();
      if (printers.length > 0) {
        socket!.emit("edge:printers_report", { restaurantId, availablePrinters: printers });
        console.log(`[SocketSync] Reported ${printers.length} printers to cloud: ${printers.join(", ")}`);
      }
    } catch (err) {
      console.warn("[SocketSync] Failed to report printers:", err);
    }
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

  socket.on("reconnect", async (attempt: number) => {
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
      edgeVersion: "23.12.27",
      capabilities: ["print"],
    });

    // Re-report available printers after reconnect
    try {
      const printers = await getAvailablePrinters();
      if (printers.length > 0) {
        socket!.emit("edge:printers_report", { restaurantId, availablePrinters: printers });
      }
    } catch { /* non-fatal */ }

    // ── Business sync catch-up ──────────────────────────────────────────────
    // Fetch business state (orders, KOTs, table status) that was missed while
    // the socket was disconnected. Real-time events are not buffered by
    // Socket.IO — without this catch-up, any order created on another edge
    // during the disconnect would be permanently missed.
    try {
      const result = await pullBusinessChanges();
      if (result.applied > 0) {
        console.log(`[SocketSync] Reconnect catch-up: ${result.applied} business records applied`);
      }
    } catch (err) {
      console.warn("[SocketSync] Reconnect business catch-up failed:", err);
    }
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

  // ── Cross-edge business state sync ─────────────────────────────────────────
  // When another edge server syncs an order/kot/table to cloud, the cloud
  // relays the record to all other connected edge servers via this event.
  // We upsert it into local SQLite so /api/edge/tables returns the correct
  // state without waiting for the 60s config pull.
  //
  // The origin edge skips its own data (it already has the record).
  // All upserts are idempotent and mark records as cloud_synced=1 so the
  // sync worker doesn't push them back to cloud.
  socket.on("edge:business_sync", (data: any) => {
    try {
      const originDeviceId = data.originDeviceId || null;
      const myDeviceId = getDeviceId();
      if (originDeviceId && myDeviceId && originDeviceId === myDeviceId) {
        return; // skip own data
      }
      const tableName = data.table;
      const row = data.row;
      if (!tableName || !row) return;

      const applied = applyBusinessSync(tableName, row);
      if (applied) {
        setSyncState("last_socket_sync", new Date().toISOString());
        console.log(`[SocketSync] Business sync applied: ${tableName}/${row.id || "?"}`);
      }
    } catch (err) {
      console.error("[SocketSync] Failed to apply business_sync:", err);
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

export async function sendHeartbeat(): Promise<void> {
  if (!socket || !socket.connected) return;
  const restaurantId = getRestaurantId();
  if (!restaurantId) return;

  // Fetch live printers from the print service for accurate ownership tracking
  let availablePrinters: string[] = [];
  try {
    availablePrinters = await getAvailablePrinters();
  } catch { /* non-fatal */ }

  socket.emit("edge:heartbeat", {
    restaurantId,
    timestamp: Date.now(),
    pendingSync: 0,
    availablePrinters,
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
      // KOT prints: mark as "failed" (not "retrying") to prevent the background
      // dispatch loop from silently reprinting and causing double-cooking.
      const failStatus = isKotJobType(type) ? "failed" : "retrying";
      updatePrintJobStatus(eventId, failStatus, result.error || "Print failed", "cloud_direct");
      sendPrintAck(eventId, false, result.error || "Print failed", data?.requestId);
      printerLog.warn(`Cloud print_job failed: ${type} → ${targetPrinter}: ${result.error} (eventId=${eventId})`);
    }
  } catch (err: any) {
    const errStatus = isKotJobType(type) ? "failed" : "retrying";
    updatePrintJobStatus(eventId, errStatus, err?.message || String(err), "cloud_direct");
    sendPrintAck(eventId, false, err?.message || String(err), data?.requestId);
    printerLog.error(`Cloud print_job dispatch error: ${type} → ${targetPrinter}: ${err instanceof Error ? err.message : err} (eventId=${eventId})`);
  }
}

// R5: relayPrintViaCloud removed — cloud relay path eliminated.
// The runtime SQLite queue is the sole retry owner (ADR-001).

// ─── Cross-edge business state upsert ────────────────────────────────────────
// Applies an order/kot/table record received from another edge server (via
// cloud relay) to local SQLite. All upserts are idempotent:
//   - If the record already exists with cloud_synced=1 and same/newer
//     updated_at, skip it (we already have this data or a newer version).
//   - If the record exists with cloud_synced=0 (we created it locally),
//     update it only if the incoming data is newer (remote has a newer state).
//   - If the record doesn't exist, insert it with cloud_synced=1 (we received
//     it from cloud, no need to push it back).
//
// This function does NOT enqueue sync records — the data came FROM cloud, so
// pushing it back would create a loop.

function applyBusinessSync(tableName: string, row: any): boolean {
  const db = getDb();

  switch (tableName) {
    case "order":
      return upsertOrderFromSync(db, row);
    case "order_item":
      return upsertOrderItemFromSync(db, row);
    case "kot":
      return upsertKotFromSync(db, row);
    case "kot_item":
      return upsertKotItemFromSync(db, row);
    case "table":
      return upsertTableFromSync(db, row);
    default:
      return false;
  }
}

function upsertOrderFromSync(db: any, row: any): boolean {
  const orderId = row.id || row.order_id;
  if (!orderId) return false;

  const existing = db.query("SELECT updated_at, cloud_synced, table_id FROM order_record WHERE id = ?").get(orderId) as any;
  const incomingUpdatedAt = Number(row.updated_at || row.updatedAt || Date.now());

  if (existing) {
    // Skip if local is same or newer
    if (Number(existing.updated_at) >= incomingUpdatedAt) return false;
    // Update existing order (remote has newer state).
    // table_id is critical — without it, a table transfer on Edge A
    // (Table 5 → Table 8) won't propagate to Edge B, leaving Edge B
    // showing the order on the wrong table.
    db.query(`UPDATE order_record SET
      table_id = ?, status = ?, total_amount = ?, captain_id = ?, bill_number = ?,
      billing_requested = ?, revision = ?, updated_at = ?, cloud_synced = 1
      WHERE id = ?`).run(
      row.table_id || row.tableId || existing.table_id,
      row.status || "PREPARING",
      Number(row.total_amount || row.totalAmount || 0),
      row.captain_id || row.captainId || null,
      row.bill_number || row.billNumber || null,
      row.billing_requested || 0,
      Number(row.revision || 1),
      incomingUpdatedAt,
      orderId,
    );
  } else {
    // Insert new order from remote edge
    db.query(`INSERT INTO order_record
      (id, table_id, restaurant_id, status, total_amount, captain_id, platform,
       created_by_user_id, last_request_id, created_at, updated_at, cloud_synced,
       is_extra_table, bill_number, billing_requested)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
      orderId,
      row.table_id || row.tableId,
      row.restaurant_id || row.restaurantId,
      row.status || "PREPARING",
      Number(row.total_amount || row.totalAmount || 0),
      row.captain_id || row.captainId || null,
      row.platform || "DINE_IN",
      row.created_by_user_id || row.createdByUserId || null,
      row.last_request_id || row.lastRequestId || null,
      Number(row.created_at || row.createdAt || Date.now()),
      incomingUpdatedAt,
      row.is_extra_table || row.isExtraTable ? 1 : 0,
      row.bill_number || row.billNumber || null,
      row.billing_requested || 0,
    );
  }

  // Upsert nested items if present
  if (Array.isArray(row.items)) {
    for (const item of row.items) {
      upsertOrderItemFromSync(db, { ...item, order_id: orderId });
    }
  }
  return true;
}

function upsertOrderItemFromSync(db: any, row: any): boolean {
  const itemId = row.id || row.order_item_id;
  if (!itemId) return false;
  const orderId = row.order_id || row.orderId;
  if (!orderId) return false;

  const existing = db.query("SELECT id FROM order_item WHERE id = ?").get(itemId) as any;
  if (existing) {
    db.query(`UPDATE order_item SET
      quantity = ?, cancelled_quantity = ?, removed_from_bill = ?, notes = ?, cloud_synced = 1
      WHERE id = ?`).run(
      Number(row.quantity || 1),
      Number(row.cancelled_quantity || row.cancelledQuantity || 0),
      row.removed_from_bill || row.removedFromBill ? 1 : 0,
      row.notes || null,
      itemId,
    );
  } else {
    db.query(`INSERT INTO order_item
      (id, order_id, menu_item_id, name, price, quantity, notes, menu_type, cloud_synced,
       cancelled_quantity, removed_from_bill)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
      itemId,
      orderId,
      row.menu_item_id || row.menuItemId,
      row.name,
      Number(row.price || 0),
      Number(row.quantity || 1),
      row.notes || null,
      row.menu_type || row.menuType || "FOOD",
      Number(row.cancelled_quantity || row.cancelledQuantity || 0),
      row.removed_from_bill || row.removedFromBill ? 1 : 0,
    );
  }
  return true;
}

function upsertKotFromSync(db: any, row: any): boolean {
  const kotId = row.id || row.kot_id;
  if (!kotId) return false;

  const existing = db.query("SELECT id FROM kot WHERE id = ?").get(kotId) as any;
  if (existing) return false; // KOTs are immutable — skip if already exists

  db.query(`INSERT INTO kot
    (id, restaurant_id, table_id, order_id, kot_number, counter_date, captain_id, created_at, cloud_synced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO NOTHING`).run(
    kotId,
    row.restaurant_id || row.restaurantId,
    row.table_id || row.tableId,
    row.order_id || row.orderId,
    Number(row.kot_number || row.kotNumber || 0),
    row.counter_date || row.counterDate || "",
    row.captain_id || row.captainId || null,
    Number(row.created_at || row.createdAt || Date.now()),
  );

  // Upsert nested items if present
  if (Array.isArray(row.items)) {
    for (const item of row.items) {
      upsertKotItemFromSync(db, { ...item, kot_id: kotId });
    }
  }
  return true;
}

function upsertKotItemFromSync(db: any, row: any): boolean {
  const itemId = row.id || row.kot_item_id;
  if (!itemId) return false;
  const kotId = row.kot_id || row.kotId;
  if (!kotId) return false;

  db.query(`INSERT INTO kot_item
    (id, kot_id, order_item_id, menu_item_id, name, quantity, price, notes, status, created_at, cloud_synced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status, cloud_synced = 1`).run(
    itemId,
    kotId,
    row.order_item_id || row.orderItemId,
    row.menu_item_id || row.menuItemId,
    row.name,
    Number(row.quantity || 1),
    Number(row.price || 0),
    row.notes || null,
    row.status || "SENT",
    Number(row.created_at || row.createdAt || Date.now()),
  );
  return true;
}

function upsertTableFromSync(db: any, row: any): boolean {
  const tableId = row.id;
  if (!tableId) return false;

  const existing = db.query("SELECT updated_at FROM \"table\" WHERE id = ?").get(tableId) as any;
  const incomingUpdatedAt = Number(row.updatedAt || row.updated_at || Date.now());

  if (existing) {
    // Skip if local is same or newer
    if (Number(existing.updated_at) >= incomingUpdatedAt) return false;
    // Update business fields from remote edge
    const sets: string[] = ["updated_at = ?"];
    const params: any[] = [incomingUpdatedAt];

    if (row.status !== undefined) { sets.push("status = ?"); params.push(row.status); }
    if (row.workflowStatus !== undefined || row.workflow_status !== undefined) {
      sets.push("workflow_status = ?");
      params.push(row.workflowStatus || row.workflow_status);
    }
    if (row.currentBill !== undefined || row.current_bill !== undefined) {
      sets.push("current_bill = ?");
      params.push(Number(row.currentBill || row.current_bill || 0));
    }
    if (row.captainId !== undefined || row.captain_id !== undefined) {
      sets.push("captain_id = ?");
      params.push(row.captainId || row.captain_id || null);
    }
    if (row.guests !== undefined) { sets.push("guests = ?"); params.push(Number(row.guests || 0)); }
    if (row.discount !== undefined) {
      sets.push("discount = ?");
      params.push(row.discount ? Number(row.discount) : null);
    }
    if (row.sessionStartedAt !== undefined || row.session_started_at !== undefined) {
      sets.push("session_started_at = ?");
      params.push(row.sessionStartedAt || row.session_started_at || null);
    }
    if (row.kotHistory !== undefined || row.kot_history !== undefined) {
      const kh = row.kotHistory || row.kot_history;
      sets.push("kot_history = ?");
      params.push(typeof kh === "string" ? kh : JSON.stringify(kh || []));
    }

    params.push(tableId);
    db.query(`UPDATE "table" SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  } else {
    // Table doesn't exist locally — skip (config sync will create it)
    return false;
  }
  return true;
}

// ─── Business sync catch-up (recovery path) ──────────────────────────────────
// Called on reconnect and periodically to fetch business state that was missed
// while the edge was offline. Applies through the same applyBusinessSync()
// functions used for real-time socket events.
//
// The watermark "last_business_sync" in sync_state tracks the last successful
// catch-up timestamp. On each call, we fetch changes since that timestamp and
// update the watermark after applying them.

export async function pullBusinessChanges(): Promise<{ success: boolean; applied: number; error?: string }> {
  const backendUrl = getBackendUrl();
  const token = getSessionToken();
  const restaurantId = getRestaurantId();

  if (!backendUrl || !token || !restaurantId) {
    return { success: false, applied: 0, error: "No valid session" };
  }

  const since = getSyncState("last_business_sync") || new Date(0).toISOString();

  try {
    const { cloudFetch } = await import("./cloudFetch.ts");
    const res = await cloudFetch(`${backendUrl}/api/edge/business-changes?since=${encodeURIComponent(since)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      connectTimeout: 10_000,
      bodyTimeout: 30_000,
      retries: 2,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { success: false, applied: 0, error: body.error || `HTTP ${res.status}` };
    }

    const data = await res.json();
    let applied = 0;

    if (data.changes && Array.isArray(data.changes) && data.changes.length > 0) {
      for (const change of data.changes) {
        try {
          const ok = applyBusinessSync(change.table, change.row);
          if (ok) applied++;
        } catch (err) {
          console.warn(`[SocketSync] Business catch-up failed for ${change.table}/${change.row?.id}:`, err);
        }
      }
    }

    // Update the watermark — next catch-up starts from here
    setSyncState("last_business_sync", data.timestamp || new Date().toISOString());

    if (applied > 0) {
      console.log(`[SocketSync] Business catch-up applied ${applied}/${data.changes.length} changes since ${since}`);
    }

    return { success: true, applied };
  } catch (err: any) {
    return { success: false, applied: 0, error: err?.message || String(err) };
  }
}

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
