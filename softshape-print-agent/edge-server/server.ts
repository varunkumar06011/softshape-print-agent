// ─────────────────────────────────────────────────────────────────────────────
// server.ts — SoftShape Edge Server (entry point)
// ─────────────────────────────────────────────────────────────────────────────
// Runs on the restaurant's billing PC alongside the print agent.
// Handles the hot path: order creation, KOT printing, table reads.
//
// Endpoints:
//   GET  /health                — edge server health check
//   GET  /api/edge/status       — session + config sync status
//   POST /api/edge/register     — register edge server with cloud (setup token)
//   POST /api/edge/config/sync  — trigger full config download from cloud
//   POST /api/edge/config/pull  — trigger incremental config pull
//   POST /api/edge/order        — create order + KOT (local DB + direct print)
//   POST /api/edge/order/cancel — cancel KOT item (print cancel ticket)
//   POST /api/edge/kot/reprint  — reprint KOT for an order
//   POST /api/edge/order/request-billing — mark order as billing requested
//   POST /api/edge/order/print-bill     — assign bill number + print bill
//   POST /api/edge/order/settle         — settle order + free table
//   POST /api/edge/order/swap-table     — swap two tables
//   POST /api/edge/order/transfer-items — transfer items between tables
//   POST /api/edge/order/edit-bill      — edit bill before settlement
//   POST /api/edge/order/confirm-payment — confirm payment for order
//   POST /api/edge/order/status         — update order status
//   GET  /api/edge/orders       — active orders with items (for KDS)
//   GET  /api/edge/tables       — sections with nested tables + active orders
//   GET  /api/edge/tables/flat  — flat list of all tables
//   GET  /api/edge/sections     — sections with venue + floor info
//   GET  /api/edge/menu         — full menu with categories, items, variants
//   GET  /api/edge/menu/items   — lean flat list for POS
//   GET  /api/edge/venues       — venues with floors and sections
//   GET  /api/edge/outlet       — outlet settings
//   GET  /api/edge/staff        — list active staff (for PIN login screen)
//   POST /api/edge/auth/pin     — verify staff PIN (offline device-unlock)
//   GET  /api/edge/sync/status  — sync worker status
//   POST /api/edge/sync/push    — manually trigger sync push
//   POST /api/edge/sync/retry   — retry dead-lettered records
//   GET  /api/edge/sync/socket  — socket connection status
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, closeDb, getConfig, setConfig, getSyncState, setSyncState, enqueueSync, getRecoveryStatus } from "./db.ts";
import os from "os";
import { runDailyMaintenance, runPeriodicBackup } from "./backup.ts";
import { loadSession, saveSession, clearSession, isSessionValid, isLocalReady, getBackendUrl, getRestaurantId, getDeviceId, getEdgeApiKey, saveEdgeApiKey } from "./auth.ts";
import { downloadFullConfig, pullIncrementalChanges } from "./config.ts";
import { createOrder, updateOrderItems, cancelKotItem, reprintKot, requestBillingEdge, printBillEdge, settleOrderEdge, swapTableEdge, transferItemsEdge, editBillEdge, confirmPaymentEdge, updateOrderStatusEdge, markOrderPaidEdge, saveTransactionEdge, listTransactionsEdge } from "./orderService.ts";
import { getTablesForRestaurant, getTablesFlat, getSections, getMenu, getMenuItems, getVenues, getOutletSettings, getActiveOrders } from "./reads.ts";
import { startSyncWorker, stopSyncWorker, getSyncStatus, manualSyncPush, retryDeadLetters, getDeadLetterRecords, discardDeadLetter, retrySingleDeadLetter } from "./sync.ts";
import { startSocketSync, stopSocketSync, getSocketStatus, startHeartbeat, stopHeartbeat, isInFallbackMode } from "./socketSync.ts";
import { acquireInstanceLock, startHeartbeatLoop, stopHeartbeatLoop, releaseInstanceLock, forceReleaseLock, getLockStatus } from "./instanceLock.ts";
import { cloudFetch } from "./cloudFetch.ts";
import { initLanBroadcast, registerClient, unregisterClient, getLanClientCount } from "./lanBroadcast.ts";

const PORT = parseInt(process.env.EDGE_PORT || "3101", 10);
let startupState: "starting" | "ready" | "error" = "starting";
let startupError = "";

// ── CORS headers for LAN access (captain/cashier apps on other devices) ──────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Edge-Key",
};

function jsonResponse(data: any, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

function errorResponse(error: string, status = 400): Response {
  return jsonResponse({ error }, status);
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleRequest(req: Request, url: URL): Promise<Response> {
  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── LAN API key auth (staged rollout) ────────────────────────────────────────
  // Public routes that don't require the edge API key. Everything else must either
  // present the correct X-Edge-Key header or wait until the restaurant has flipped
  // enforcement via EDGE_REQUIRE_KEY=true.
  const PUBLIC_LAN_PATHS = new Set([
    "/health",
    "/api/edge/register",
    "/api/edge/onboard",
    "/api/edge/sections",
    "/api/edge/tables",
    "/api/edge/tables/flat",
    "/api/edge/menu",
    "/api/edge/menu/items",
    "/api/edge/venues",
    "/api/edge/outlet",
    "/api/edge/order",
    "/api/edge/order/update",
    "/api/edge/order/cancel",
    "/api/edge/order/cancel-items",
    "/api/edge/order/print-bill",
    "/api/edge/order/settle",
    "/api/edge/order/confirm-payment",
    "/api/edge/order/status",
    "/api/edge/orders",
  ]);

  if (!PUBLIC_LAN_PATHS.has(url.pathname)) {
    const configuredKey = getEdgeApiKey();
    const requireKey = process.env.EDGE_REQUIRE_KEY === "true";
    const provided = req.headers.get("X-Edge-Key");

    if (configuredKey && provided && provided !== configuredKey) {
      return errorResponse("Invalid edge API key", 401);
    }
    if (requireKey && (!provided || provided !== configuredKey)) {
      return errorResponse("Missing or invalid edge API key", 401);
    }
  }

  // ── GET /health ─────────────────────────────────────────────────────────────
  if (url.pathname === "/health" && req.method === "GET") {
    if (startupState !== "ready") {
      return jsonResponse({
        status: startupState === "error" ? "error" : "initializing",
        service: "softshape-edge-server",
        version: "18.5.0",
        uptime: process.uptime(),
        error: startupError || null,
      });
    }
    const session = loadSession();
    const recovery = getRecoveryStatus();
    // Include LAN IP so captain devices can verify they found the right edge server
    let lanIp = null;
    try {
      const nets = os.networkInterfaces();
      for (const iface of Object.values(nets)) {
        for (const addr of iface || []) {
          if (addr.family === "IPv4" && !addr.internal) {
            lanIp = addr.address;
            break;
          }
        }
        if (lanIp) break;
      }
    } catch { /* ignore */ }
    return jsonResponse({
      status: "ok",
      service: "softshape-edge-server",
      version: "17.1.0",
      sessionValid: isSessionValid(),
      restaurantId: session?.restaurantId || null,
      restaurantName: session?.restaurantName || null,
      uptime: process.uptime(),
      databaseRecovered: recovery.recovered,
      recoveryMessage: recovery.message || null,
      lanIp,
      edgePort: PORT,
      maintenanceError: startupError || null,
    });
  }

  // ── GET /api/edge/status ────────────────────────────────────────────────────
  if (url.pathname === "/api/edge/status" && req.method === "GET") {
    const session = loadSession();
    if (!session) {
      return jsonResponse({
        registered: false,
        sessionValid: false,
      });
    }

    const lastFullSync = getSyncState("last_full_config_sync") || null;
    const lastIncrementalSync = getSyncState("last_incremental_sync") || null;

    // Count local rows for status (scoped to this restaurant only)
    const db = getDb();
    const rid = session.restaurantId;
    const tableCount = (db.query("SELECT COUNT(*) as c FROM \"table\" WHERE restaurant_id = ?").get(rid) as any)?.c || 0;
    const menuItemCount = (db.query("SELECT COUNT(*) as c FROM menu_item WHERE is_deleted = 0 AND restaurant_id = ?").get(rid) as any)?.c || 0;
    const orderCount = (db.query("SELECT COUNT(*) as c FROM order_record WHERE is_deleted = 0 AND restaurant_id = ?").get(rid) as any)?.c || 0;
    const pendingSyncCount = (db.query("SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0").get() as any)?.c || 0;

    return jsonResponse({
      registered: true,
      sessionValid: isSessionValid(),
      restaurantId: session.restaurantId,
      restaurantName: session.restaurantName,
      restaurantCode: session.restaurantCode,
      backendUrl: session.backendUrl,
      lastFullConfigSync: lastFullSync,
      lastIncrementalSync: lastIncrementalSync,
      localStats: {
        tables: tableCount,
        menuItems: menuItemCount,
        activeOrders: orderCount,
        pendingSyncRecords: pendingSyncCount,
      },
    });
  }

  // ── POST /api/edge/register — register with cloud using setup token ────────
  if (url.pathname === "/api/edge/register" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const { setupToken, restaurantCode, backendUrl } = body;

    if (!setupToken || !backendUrl) {
      return errorResponse("setupToken and backendUrl are required");
    }

    // Detect LAN IP so the captain app can discover this edge server via the
    // backend's /api/print/agent-endpoint response instead of a 15s LAN scan.
    let lanIp: string | null = null;
    try {
      const nets = os.networkInterfaces();
      for (const iface of Object.values(nets)) {
        for (const addr of iface || []) {
          if (addr.family === "IPv4" && !addr.internal) {
            lanIp = addr.address;
            break;
          }
        }
        if (lanIp) break;
      }
    } catch { /* ignore */ }

    // Call cloud backend to register the agent
    try {
      const res = await cloudFetch(`${backendUrl}/api/print/agent-register`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${setupToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentId: getDeviceId(),
          printerMapping: {},
          ...(restaurantCode ? { restaurantCode } : {}),
          ...(lanIp ? { lanIp } : {}),
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        return errorResponse(errBody.error || `Registration failed: HTTP ${res.status}`);
      }

      const data = await res.json();

      // Save session
      const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
      saveSession({
        sessionToken: data.sessionToken,
        restaurantId: data.restaurantId,
        restaurantName: data.restaurantName || "",
        restaurantCode: restaurantCode || "",
        backendUrl,
        expiresAt,
        edgeApiKey: data.edgeApiKey,
      });
      if (data.edgeApiKey) {
        saveEdgeApiKey(data.edgeApiKey);
      }

      // Trigger initial config download
      const configResult = await downloadFullConfig();

      if (!configResult.success) {
        // Config download failed — clear the session so the broken first attempt
        // doesn't become permanently invisible on next launch (isLocalReady would
        // otherwise see the saved session + a partial outlet row and skip to "ready").
        clearSession();
        return errorResponse(
          `Registration succeeded but config download failed: ${configResult.error || 'unknown error'}. ` +
          'Please retry — your setup token may still be valid.',
          500
        );
      }

      return jsonResponse({
        success: true,
        restaurantId: data.restaurantId,
        restaurantName: data.restaurantName,
        configDownloaded: true,
        tablesLoaded: configResult.tablesLoaded || 0,
      });
    } catch (err: any) {
      return errorResponse(err.message || "Failed to connect to backend");
    }
  }

  // ── POST /api/edge/config/sync — trigger full config re-download ───────────
  if (url.pathname === "/api/edge/config/sync" && req.method === "POST") {
    if (!isSessionValid()) {
      return errorResponse("No valid session — register first", 401);
    }

    const result = await downloadFullConfig();
    if (!result.success) {
      return errorResponse(result.error || "Config sync failed");
    }

    return jsonResponse({
      success: true,
      tablesLoaded: result.tablesLoaded,
      syncedAt: new Date().toISOString(),
    });
  }

  // ── POST /api/edge/config/pull — trigger incremental pull ──────────────────
  if (url.pathname === "/api/edge/config/pull" && req.method === "POST") {
    if (!isSessionValid()) {
      return errorResponse("No valid session", 401);
    }

    const result = await pullIncrementalChanges();
    if (!result.success) {
      return errorResponse(result.error || "Incremental pull failed");
    }

    return jsonResponse({
      success: true,
      changesApplied: result.changesApplied,
      pulledAt: new Date().toISOString(),
    });
  }

  // ── POST /api/edge/logout — clear session and data ─────────────────────────
  if (url.pathname === "/api/edge/logout" && req.method === "POST") {
    clearSession();
    // Optionally clear local data too
    // (keep it for now — might want to re-register)
    return jsonResponse({ success: true });
  }

  // ── POST /api/edge/order — create order + KOT (the hot path) ──────────────
  if (url.pathname === "/api/edge/order" && req.method === "POST") {
    if (!isLocalReady()) {
      return errorResponse("No valid session", 401);
    }

    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) {
      return errorResponse("No restaurant ID in session", 500);
    }

    const result = await createOrder(restaurantId, {
      tableId: body.tableId,
      items: body.items || [],
      captainId: body.captainId,
      captainName: body.captainName,
      createdByUserId: body.createdByUserId || body.userId,
      platform: body.platform,
      requestId: body.requestId,
      orderByRole: body.orderByRole,
      localPrinted: body.localPrinted || false,
      kotEventIds: body.kotEventIds || null,
    });

    if (!result.success) {
      return jsonResponse(result, result.statusCode || 400);
    }

    return jsonResponse(result);
  }

  // ── POST /api/edge/order/update — add items to existing order + print new KOT ──
  if (url.pathname === "/api/edge/order/update" && req.method === "POST") {
    if (!isSessionValid()) {
      return errorResponse("No valid session", 401);
    }

    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) {
      return errorResponse("No restaurant ID in session", 500);
    }

    if (!body.orderId) {
      return errorResponse("orderId is required", 400);
    }

    const result = await updateOrderItems(restaurantId, {
      orderId: body.orderId,
      tableId: body.tableId,
      items: body.items || [],
      captainId: body.captainId,
      captainName: body.captainName,
      createdByUserId: body.createdByUserId || body.userId,
      platform: body.platform,
      requestId: body.requestId,
      orderByRole: body.orderByRole,
      localPrinted: body.localPrinted || false,
      kotEventIds: body.kotEventIds || null,
    });

    if (!result.success) {
      return jsonResponse(result, result.statusCode || 400);
    }

    return jsonResponse(result);
  }

  // ── POST /api/edge/order/cancel — cancel KOT item ──────────────────────────
  if (url.pathname === "/api/edge/order/cancel" && req.method === "POST") {
    if (!isLocalReady()) {
      return errorResponse("No valid session", 401);
    }

    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) {
      return errorResponse("No restaurant ID in session", 500);
    }

    const result = await cancelKotItem({
      orderId: body.orderId,
      restaurantId,
      orderItemId: body.orderItemId,
      cancelQuantity: body.cancelQuantity,
      cancelledBy: body.cancelledBy || "Staff",
      tableNumber: body.tableNumber,
      requestId: body.requestId,
      localPrinted: body.localPrinted || false,
    });

    if (!result.success) {
      return errorResponse(result.error || "Cancel failed", 400);
    }

    return jsonResponse(result);
  }

  // ── POST /api/edge/order/cancel-items — cancel multiple KOT items ───────────
  if (url.pathname === "/api/edge/order/cancel-items" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);

    const items = body.items || [];
    if (!items.length) return errorResponse("No items to cancel", 400);

    const results = [];
    for (const item of items) {
      const result = await cancelKotItem({
        orderId: body.orderId,
        restaurantId,
        orderItemId: item.orderItemId,
        cancelQuantity: item.cancelQuantity || 1,
        cancelledBy: body.cancelledBy || "Staff",
        tableNumber: body.tableNumber,
        requestId: body.requestId,
        localPrinted: body.localPrinted || false,
      });
      results.push({ orderItemId: item.orderItemId, success: result.success, error: result.error });
    }

    const allSuccess = results.every(r => r.success);
    return jsonResponse({ success: allSuccess, results });
  }

  // ── POST /api/edge/kot/reprint — reprint KOT for an order ──────────────────
  if (url.pathname === "/api/edge/kot/reprint" && req.method === "POST") {
    if (!isLocalReady()) {
      return errorResponse("No valid session", 401);
    }

    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) {
      return errorResponse("No restaurant ID in session", 500);
    }

    const result = await reprintKot({
      orderId: body.orderId,
      restaurantId,
      kotNumber: body.kotNumber,
    });

    if (!result.success) {
      return errorResponse(result.error || "Reprint failed", 400);
    }

    return jsonResponse(result);
  }

  // ── GET /api/edge/orders — active orders with items (for KDS) ──────────────
  if (url.pathname === "/api/edge/orders" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const status = url.searchParams.get("status") || undefined;
    const data = getActiveOrders(status);
    return jsonResponse(data, 200, { "Cache-Control": "no-store" });
  }

  // ── POST /api/edge/order/request-billing — mark order as billing requested ──
  if (url.pathname === "/api/edge/order/request-billing" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const result = await requestBillingEdge(restaurantId, body.orderId);
    if (!result.success) return errorResponse(result.error || "Request billing failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/order/print-bill — assign bill number + print bill ───────
  if (url.pathname === "/api/edge/order/print-bill" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const result = await printBillEdge({
      orderId: body.orderId,
      restaurantId,
      tableNumber: body.tableNumber,
      discountPercent: body.discountPercent,
      kotNumbers: body.kotNumbers,
      localPrinted: body.localPrinted,
      billEventId: body.billEventId,
    });
    if (!result.success) return errorResponse(result.error || "Print bill failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/order/settle — settle order + free table ─────────────────
  if (url.pathname === "/api/edge/order/settle" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);

    // Handle removed items before settling (edit-bill during settlement)
    if (body.removedItemIds && body.removedItemIds.length > 0) {
      await editBillEdge(restaurantId, body.orderId, {
        removedItemIds: body.removedItemIds,
        editedBy: body.removedBy || "Cashier",
      });
    }

    const result = await settleOrderEdge({
      orderId: body.orderId,
      restaurantId,
      paymentMethod: body.paymentMethod,
      cashAmount: body.cashAmount,
      cardAmount: body.cardAmount,
      tipAmount: body.tipAmount,
      cashTipAmount: body.cashTipAmount,
      cardTipAmount: body.cardTipAmount,
      discountPercent: body.discountPercent,
      subtotal: body.subtotal,
      discountAmount: body.discountAmount,
      cgst: body.cgst,
      sgst: body.sgst,
      grandTotal: body.grandTotal,
      roundOff: body.roundOff,
      localTxnId: body.localTxnId,
      requestId: body.requestId,
    });
    if (!result.success) return errorResponse(result.error || "Settle failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/order/swap-table — swap two tables ───────────────────────
  if (url.pathname === "/api/edge/order/swap-table" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const result = await swapTableEdge(restaurantId, body.sourceTableId, body.targetTableId, body.swappedBy || "Cashier");
    if (!result.success) return errorResponse(result.error || "Swap failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/order/transfer-items — transfer items between tables ─────
  if (url.pathname === "/api/edge/order/transfer-items" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const result = await transferItemsEdge(restaurantId, body.sourceTableId, body.targetTableId, body.orderItemIds || [], body.transferredBy || "Cashier");
    if (!result.success) return errorResponse(result.error || "Transfer failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/order/edit-bill — edit bill before settlement ────────────
  if (url.pathname === "/api/edge/order/edit-bill" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const result = await editBillEdge(restaurantId, body.orderId, {
      removedItemIds: body.removedItemIds,
      editQuantities: body.editQuantities,
      addedItems: body.addedItems,
      editedBy: body.editedBy,
    });
    if (!result.success) return errorResponse(result.error || "Edit bill failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/order/confirm-payment — confirm payment for order ────────
  if (url.pathname === "/api/edge/order/confirm-payment" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const result = await confirmPaymentEdge(restaurantId, body.transactionId, {
      paymentMethod: body.paymentMethod,
      cashAmount: body.cashAmount,
      cardAmount: body.cardAmount,
      tipAmount: body.tipAmount,
      cashTipAmount: body.cashTipAmount,
      cardTipAmount: body.cardTipAmount,
    });
    if (!result.success) return errorResponse(result.error || "Confirm payment failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/order/status — update order status ───────────────────────
  if (url.pathname === "/api/edge/order/status" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const result = await updateOrderStatusEdge(restaurantId, body.orderId, body.status);
    if (!result.success) return errorResponse(result.error || "Status update failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/order/pay — mark order as paid (simple status update) ────
  if (url.pathname === "/api/edge/order/pay" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const result = await markOrderPaidEdge(restaurantId, body.orderId, body.paymentMethod || "CASH");
    if (!result.success) return errorResponse(result.error || "Mark paid failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/transaction — save walk-in transaction (no order) ────────
  if (url.pathname === "/api/edge/transaction" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const result = await saveTransactionEdge(restaurantId, body);
    if (!result.success) return errorResponse(result.error || "Save transaction failed", 400);
    return jsonResponse(result);
  }

  // ── GET /api/edge/transactions — list settled orders + walk-in txns ────────
  // Used by edge-local (PIN) auth to populate Past Transactions from local SQLite.
  if (url.pathname === "/api/edge/transactions" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const date = url.searchParams.get("date");
    const month = url.searchParams.get("month");
    const limit = parseInt(url.searchParams.get("limit") || "2000", 10);
    const txns = await listTransactionsEdge(restaurantId, { date, month, limit });
    return jsonResponse(txns, 200, { "Cache-Control": "no-store" });
  }

  // ── GET /api/edge/tables — sections with nested tables + active orders ────
  if (url.pathname === "/api/edge/tables" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const data = getTablesForRestaurant();
    return jsonResponse(data, 200, { "Cache-Control": "no-store" });
  }

  // ── GET /api/edge/tables/flat — flat list of all tables ────────────────────
  if (url.pathname === "/api/edge/tables/flat" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const data = getTablesFlat();
    return jsonResponse(data, 200, { "Cache-Control": "no-store" });
  }

  // ── POST|PATCH /api/edge/table/:id/session — update table session (offline write) ─
  // Mirrors cloud PATCH /api/tables/:id/session and /api/bar/tables/:id/session.
  // Updates workflow_status, captain_id, guests, session_started_at, current_bill
  // in local SQLite and enqueues a sync record for cloud push.
  // Accepts both POST (legacy) and PATCH (aligned with cloud method).
  if (url.pathname.startsWith("/api/edge/table/") && url.pathname.endsWith("/session") && (req.method === "POST" || req.method === "PATCH")) {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const tableId = url.pathname.split("/")[4];
    if (!tableId) return errorResponse("Table ID is required", 400);

    let body: any;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON body", 400); }

    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);

    const db = getDb();
    const existing = db.query('SELECT * FROM "table" WHERE id = ? AND restaurant_id = ?').get(tableId, restaurantId) as any;
    if (!existing) return errorResponse("Table not found", 404);

    const workflowStatus = body.status ?? existing.workflow_status ?? "Free";
    const isFree = workflowStatus === "Free";

    // Cloud maps workflowStatus to table.status the same way it maps to backend status
    const backendStatus = (() => {
      switch (workflowStatus) {
        case "Occupied":
        case "Preparing":
        case "Ready":
          return "OCCUPIED";
        case "Waiting Bill":
          return "BILLING_REQUESTED";
        case "Reserved":
          return "RESERVED";
        case "Cleaning":
          return "CLEANING";
        case "Free":
        default:
          return "AVAILABLE";
      }
    })();

    // Parse sessionStartedAt — accept ISO string, numeric timestamp, or relative
    let sessionStartedAt: number | null = existing.session_started_at;
    if (isFree) {
      sessionStartedAt = null;
    } else if (body.time !== undefined && body.time !== null) {
      if (typeof body.time === "number") {
        sessionStartedAt = body.time;
      } else if (typeof body.time === "string") {
        if (/^\d+$/.test(body.time)) {
          sessionStartedAt = Number(body.time);
        } else {
          const d = new Date(body.time);
          sessionStartedAt = isNaN(d.getTime()) ? Date.now() : d.getTime();
        }
      }
    }

    const now = Date.now();
    db.query(`UPDATE "table" SET
      status = ?,
      workflow_status = ?,
      captain_id = ?,
      guests = ?,
      session_started_at = ?,
      current_bill = ?,
      kot_history = ?,
      updated_at = ?
      WHERE id = ? AND restaurant_id = ?
    `).run(
      backendStatus,
      workflowStatus,
      isFree ? null : (body.captainId ?? existing.captain_id ?? null),
      isFree ? 0 : (body.guests ?? existing.guests ?? 0),
      sessionStartedAt,
      isFree ? 0 : (body.currentBill ?? existing.current_bill ?? 0),
      isFree ? "[]" : existing.kot_history,
      now,
      tableId,
      restaurantId,
    );

    // Terminating a session clears live KOTs (same as cloud)
    if (isFree) {
      db.query("DELETE FROM kot WHERE table_id = ?").run(tableId);
    }

    enqueueSync("table", tableId, "update");
    return jsonResponse({ success: true, id: tableId });
  }

  // ── DELETE /api/edge/table/:id/session — terminate table session ───────────
  // Kill switch: completely resets the table to Free, cancels the active order,
  // deletes order items, clears KOTs, and enqueues sync.
  if (url.pathname.startsWith("/api/edge/table/") && url.pathname.endsWith("/session") && req.method === "DELETE") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const tableId = url.pathname.split("/")[4];
    if (!tableId) return errorResponse("Table ID is required", 400);

    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);

    const db = getDb();
    const existing = db.query('SELECT * FROM "table" WHERE id = ? AND restaurant_id = ?').get(tableId, restaurantId) as any;
    if (!existing) return errorResponse("Table not found", 404);

    const now = Date.now();

    // Find and cancel any active orders on this table
    const activeOrders = db.query(
      `SELECT id FROM order_record WHERE table_id = ? AND restaurant_id = ? AND status NOT IN ('SETTLED', 'CANCELLED') AND is_deleted = 0`
    ).all(tableId, restaurantId) as any[];

    const tx = db.transaction(() => {
      // 1. Cancel all active orders
      for (const order of activeOrders) {
        db.query("UPDATE order_record SET status = 'CANCELLED', updated_at = ? WHERE id = ?")
          .run(now, order.id);
        // Delete order items
        db.query("DELETE FROM order_item WHERE order_id = ?").run(order.id);
        // Enqueue sync for the cancelled order
        enqueueSync("order", order.id, "update");
      }

      // 2. Reset table to Free
      db.query(`UPDATE "table" SET
        status = 'AVAILABLE',
        workflow_status = 'Free',
        captain_id = NULL,
        guests = 0,
        session_started_at = NULL,
        current_bill = 0,
        kot_history = '[]',
        discount = NULL,
        updated_at = ?
        WHERE id = ? AND restaurant_id = ?
      `).run(now, tableId, restaurantId);

      // 3. Clear KOTs for this table
      db.query("DELETE FROM kot WHERE table_id = ?").run(tableId);

      // 4. Enqueue table sync
      enqueueSync("table", tableId, "update");
    });

    try {
      tx();
    } catch (err: any) {
      return errorResponse(`Terminate failed: ${err.message}`, 500);
    }

    return jsonResponse({ success: true, id: tableId, cancelledOrders: activeOrders.length });
  }

  // ── GET /api/edge/sections — sections with venue + floor info ──────────────
  if (url.pathname === "/api/edge/sections" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const data = getSections();
    return jsonResponse(data);
  }

  // ── GET /api/edge/menu — full menu with categories, items, variants ────────
  if (url.pathname === "/api/edge/menu" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const venueId = url.searchParams.get("venueId") || undefined;
    const data = getMenu(venueId);
    return jsonResponse(data);
  }

  // ── GET /api/edge/menu/items — lean flat list for POS ──────────────────────
  if (url.pathname === "/api/edge/menu/items" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const venueId = url.searchParams.get("venueId") || undefined;
    const data = getMenuItems(venueId);
    return jsonResponse(data);
  }

  // ── GET /api/edge/venues — venues with floors and sections ─────────────────
  if (url.pathname === "/api/edge/venues" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const data = getVenues();
    return jsonResponse(data);
  }

  // ── GET /api/edge/outlet — outlet settings ─────────────────────────────────
  if (url.pathname === "/api/edge/outlet" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const data = getOutletSettings();
    if (!data) return errorResponse("Outlet not found in local DB", 404);
    return jsonResponse(data);
  }

  // ── GET /api/edge/staff — list active staff for PIN login screen ───────────
  if (url.pathname === "/api/edge/staff" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const db = getDb();
    const restaurantId = getRestaurantId();
    const staff = db.query(
      "SELECT id, name, role FROM users WHERE outlet_id = ? AND is_active = 1 ORDER BY name ASC"
    ).all(restaurantId) as { id: string; name: string; role: string }[];
    return jsonResponse({ staff });
  }

  // ── POST /api/edge/auth/pin — verify staff PIN (offline device-unlock) ─────
  if (url.pathname === "/api/edge/auth/pin" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);

    let body: any;
    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }

    const { userId, pin } = body;
    if (!userId || !pin) {
      return errorResponse("userId and pin are required", 400);
    }

    const db = getDb();
    const user = db.query(
      "SELECT id, name, pin, role, is_active FROM users WHERE id = ? AND outlet_id = ?"
    ).get(userId, getRestaurantId()) as { id: string; name: string; pin: string | null; role: string; is_active: number } | null;

    if (!user) {
      return errorResponse("Invalid credentials", 401);
    }
    if (!user.is_active) {
      return errorResponse("Account is inactive", 403);
    }
    if (!user.pin) {
      return errorResponse("No PIN set for this account", 401);
    }

    // Verify PIN using bcrypt (same hash as cloud)
    const { compareSync } = await import("bcryptjs");
    const isValid = compareSync(String(pin), user.pin);
    if (!isValid) {
      return errorResponse("Invalid credentials", 401);
    }

    return jsonResponse({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        restaurantId: getRestaurantId(),
      },
    });
  }

  // ── GET /api/edge/sync/status — sync worker status ────────────────────────
  if (url.pathname === "/api/edge/sync/status" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    return jsonResponse(getSyncStatus());
  }

  // ── POST /api/edge/sync/push — manually trigger a sync push ────────────────
  if (url.pathname === "/api/edge/sync/push" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const result = await manualSyncPush();
    return jsonResponse(result);
  }

  // ── POST /api/edge/close-day — force sync + lock day's transactions ─────────
  // Forces a full sync push, waits for confirmation, returns day summary.
  // The frontend uses this to show a "Close Day" confirmation dialog.
  if (url.pathname === "/api/edge/close-day" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);

    const db = getDb();
    const restaurantId = getRestaurantId();

    // Force a sync push
    const syncResult = await manualSyncPush();

    // Get today's order summary from local SQLite
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startOfDayMs = startOfDay.getTime();

    const todayOrders = db.query(
      "SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total, COALESCE(SUM(CASE WHEN status = 'SETTLED' THEN 1 ELSE 0 END), 0) as settled FROM order_record WHERE restaurant_id = ? AND created_at >= ?"
    ).get(restaurantId, startOfDayMs) as any;

    // Check for pending sync records
    const pending = db.query(
      "SELECT COUNT(*) as count FROM sync_queue WHERE synced = 0 AND attempts < 5"
    ).get() as any;

    // Check for dead-lettered records
    const deadLetters = db.query(
      "SELECT COUNT(*) as count FROM sync_queue WHERE synced = 0 AND attempts >= 5"
    ).get() as any;

    const canClose = pending.count === 0 && deadLetters.count === 0;

    return jsonResponse({
      success: true,
      canClose,
      syncResult,
      daySummary: {
        date: startOfDay.toISOString().slice(0, 10),
        totalOrders: todayOrders.count,
        settledOrders: todayOrders.settled,
        totalRevenue: Number(todayOrders.total),
        pendingSync: pending.count,
        deadLetterRecords: deadLetters.count,
      },
      message: canClose
        ? "All records synced. Ready to close day."
        : `${pending.count} records still syncing. ${deadLetters.count} failed records need attention. Please wait for sync to complete or retry failed records.`,
    });
  }

  // ── POST /api/edge/sync/retry — retry dead-lettered records ────────────────
  if (url.pathname === "/api/edge/sync/retry" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const result = retryDeadLetters();
    return jsonResponse({ success: true, ...result });
  }

  // ── GET /api/edge/sync/dead-letter — list dead-lettered records ────────────
  if (url.pathname === "/api/edge/sync/dead-letter" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const records = getDeadLetterRecords();
    return jsonResponse({ records, count: records.length });
  }

  // ── POST /api/edge/sync/dead-letter/:id/retry — retry a single record ──────
  if (url.pathname.startsWith("/api/edge/sync/dead-letter/") && url.pathname.endsWith("/retry") && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const idStr = url.pathname.split("/")[5];
    const queueId = parseInt(idStr, 10);
    if (isNaN(queueId)) return errorResponse("Invalid record ID", 400);
    const result = retrySingleDeadLetter(queueId);
    if (!result.success) return errorResponse("Record not found or not dead-lettered", 404);
    return jsonResponse({ success: true });
  }

  // ── POST /api/edge/sync/dead-letter/:id/discard — discard a single record ─
  if (url.pathname.startsWith("/api/edge/sync/dead-letter/") && url.pathname.endsWith("/discard") && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const idStr = url.pathname.split("/")[5];
    const queueId = parseInt(idStr, 10);
    if (isNaN(queueId)) return errorResponse("Invalid record ID", 400);
    const result = discardDeadLetter(queueId);
    if (!result.success) return errorResponse("Record not found or not dead-lettered", 404);
    return jsonResponse({ success: true });
  }

  // ── GET /api/edge/sync/dead-letter/export — export dead-lettered records as JSON ─
  if (url.pathname === "/api/edge/sync/dead-letter/export" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const records = getDeadLetterRecords();
    return jsonResponse({
      exportedAt: new Date().toISOString(),
      restaurantId: getRestaurantId(),
      count: records.length,
      records,
    });
  }

  // ── GET /api/edge/instance/lock — check instance lock status ───────────────
  if (url.pathname === "/api/edge/instance/lock" && req.method === "GET") {
    return jsonResponse(getLockStatus());
  }

  // ── POST /api/edge/instance/force-release — force-release the lock ─────────
  if (url.pathname === "/api/edge/instance/force-release" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const result = forceReleaseLock();
    return jsonResponse({ ...result, message: "Lock released — restart the edge server to acquire it" });
  }

  // ── GET /api/edge/sync/socket — socket connection status ───────────────────
  if (url.pathname === "/api/edge/sync/socket" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    return jsonResponse(getSocketStatus());
  }

  // ── GET /api/edge/lan/status — LAN WebSocket client count (Bug 2) ─────────
  if (url.pathname === "/api/edge/lan/status" && req.method === "GET") {
    return jsonResponse({ connectedClients: getLanClientCount() });
  }

  // ── POST /api/edge/onboard — 4-step offline onboarding ─────────────────────
  // Creates the full local dataset from the QuickOnboarding wizard.
  // No session required — this is the initial setup flow.
  if (url.pathname === "/api/edge/onboard" && req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }

    const { restaurantName, restaurantType, owner, menuTemplate, tableCount, printerMapping } = body;
    if (!restaurantName || !owner?.name || !owner?.pin) {
      return errorResponse("restaurantName, owner.name, and owner.pin are required", 400);
    }

    try {
      const db = getDb();
      const restaurantId = crypto.randomUUID();
      const slug = restaurantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const restaurantCode = slug.slice(0, 8).toUpperCase();

      // 1. Create outlet (restaurant settings)
      const organizationId = crypto.randomUUID();
      db.query(`INSERT INTO outlet (id, name, slug, restaurant_code, restaurant_type, gst_category, gst_rate, gst_registered, prices_include_gst, organization_id)
                VALUES (?, ?, ?, ?, ?, 'NON_AC', 5.0, 1, 0, ?)`)
        .run(restaurantId, restaurantName, slug, restaurantCode, restaurantType || 'DINE_IN_VEG', organizationId);
      enqueueSync('outlet', restaurantId, 'create');

      // 2. Create default venue + floor + section
      const venueId = crypto.randomUUID();
      db.query(`INSERT INTO venue (id, restaurant_id, name, venue_type, is_active, sort_order)
                VALUES (?, ?, 'Main Hall', 'RESTAURANT', 1, 0)`)
        .run(venueId, restaurantId);
      enqueueSync('venue', venueId, 'create');

      const floorId = crypto.randomUUID();
      db.query(`INSERT INTO floor (id, venue_id, restaurant_id, name, sort_order)
                VALUES (?, ?, ?, 'Ground Floor', 0)`)
        .run(floorId, venueId, restaurantId);
      enqueueSync('floor', floorId, 'create');

      const sectionId = crypto.randomUUID();
      db.query(`INSERT INTO section (id, name, restaurant_id, floor_id, sort_order, is_active)
                VALUES (?, 'Main Section', ?, ?, 0, 1)`)
        .run(sectionId, restaurantId, floorId);
      enqueueSync('section', sectionId, 'create');

      // 3. Create tables
      const numTables = Math.max(1, Math.min(100, parseInt(tableCount) || 10));
      for (let i = 1; i <= numTables; i++) {
        const tableId = crypto.randomUUID();
        db.query(`INSERT INTO "table" (id, number, capacity, section_id, restaurant_id, status, workflow_status)
                  VALUES (?, ?, 4, ?, ?, 'AVAILABLE', 'Free')`)
          .run(tableId, i, sectionId, restaurantId);
        enqueueSync('table', tableId, 'create');
      }

      // 4. Create menu from template
      const template = menuTemplate || { categories: [] };
      for (const cat of template.categories || []) {
        const categoryId = crypto.randomUUID();
        db.query(`INSERT INTO category (id, name, restaurant_id, sort_order, is_active)
                  VALUES (?, ?, ?, ?, 1)`)
          .run(categoryId, cat.name, restaurantId, cat.sortOrder || 0);
        enqueueSync('category', categoryId, 'create');

        for (const item of cat.items || []) {
          const itemId = crypto.randomUUID();
          db.query(`INSERT INTO menu_item (id, name, description, is_veg, is_available, sort_order, category_id, restaurant_id,
                    base_price, unit, menu_type, gst_enabled, is_deleted)
                    VALUES (?, ?, NULL, ?, 1, 0, ?, ?, ?, ?, ?, 1, 0)`)
            .run(itemId, item.name, item.isVeg ? 1 : 0, categoryId, restaurantId,
                 item.basePrice || 0, item.unit || null, item.menuType || 'FOOD');
          enqueueSync('menu_item', itemId, 'create');

          // Create variants if present
          if (item.variants && Array.isArray(item.variants)) {
            for (const variant of item.variants) {
              const variantId = crypto.randomUUID();
              db.query(`INSERT INTO menu_item_variant (id, name, price, is_default, menu_item_id, is_available, restaurant_id)
                        VALUES (?, ?, ?, ?, ?, 1, ?)`)
                .run(variantId, variant.name, variant.price, variant.isDefault ? 1 : 0, itemId, restaurantId);
              enqueueSync('menu_item_variant', variantId, 'create');
            }
          }
        }
      }

      // 5. Create owner user with PIN
      const { hashSync } = await import("bcryptjs");
      const userId = crypto.randomUUID();
      const pinHash = hashSync(String(owner.pin), 10);
      db.query(`INSERT INTO users (id, name, pin, role, outlet_id, is_active, synced_at)
                VALUES (?, ?, ?, 'OWNER', ?, 1, unixepoch())`)
        .run(userId, owner.name, pinHash, restaurantId);
      enqueueSync('users', userId, 'create');

      // 6. Save printer config
      if (printerMapping) {
        setConfig('printer_config', JSON.stringify(printerMapping));
      }

      // 7. Save session so the edge server is "registered" locally
      saveSession({
        sessionToken: `local-onboard-${Date.now()}`,
        restaurantId,
        restaurantName,
        restaurantCode,
        backendUrl: getBackendUrl() || '',
        expiresAt: 0, // no expiry for local onboarding
      });

      // 8. Mark local config as complete so isLocalReady() returns true
      setSyncState("config_sync_completed", "true");

      console.log(`[Onboard] Created restaurant "${restaurantName}" (${restaurantId}) with ${numTables} tables, ${template.categories?.length || 0} categories, owner: ${owner.name}`);

      return jsonResponse({
        success: true,
        restaurantId,
        restaurantCode,
        ownerUserId: userId,
        tableCount: numTables,
        menuCategories: template.categories?.length || 0,
      });
    } catch (err: any) {
      console.error("[Onboard] Failed:", err);
      return errorResponse(`Onboarding failed: ${err.message}`, 500);
    }
  }

  // ── Admin operational write endpoints (local-first) ─────────────────────────
  // These endpoints handle admin writes that should work offline.
  // They write to local SQLite and enqueue sync_queue entries.
  // The sync worker pushes changes to cloud when connectivity is available.

  // ── PATCH /api/edge/admin/menu-item/:id — update menu item ──────────────────
  if (url.pathname.startsWith("/api/edge/admin/menu-item/") && req.method === "PATCH") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const itemId = url.pathname.split("/").pop()!;
    let body: any;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }

    const db = getDb();
    const restaurantId = getRestaurantId();
    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) { updates.push("name = ?"); values.push(body.name); }
    if (body.basePrice !== undefined) { updates.push("base_price = ?"); values.push(Number(body.basePrice)); }
    if (body.isVeg !== undefined) { updates.push("is_veg = ?"); values.push(body.isVeg ? 1 : 0); }
    if (body.isAvailable !== undefined) { updates.push("is_available = ?"); values.push(body.isAvailable ? 1 : 0); }
    if (body.menuType !== undefined) { updates.push("menu_type = ?"); values.push(body.menuType); }
    if (body.printerTarget !== undefined) { updates.push("printer_target = ?"); values.push(body.printerTarget); }
    if (body.isDeleted !== undefined) { updates.push("is_deleted = ?"); values.push(body.isDeleted ? 1 : 0); }
    if (body.description !== undefined) { updates.push("description = ?"); values.push(body.description); }
    // Persist GST flag; liquor/bar always forced off
    const edgeMenuType = body.menuType;
    if (edgeMenuType === "LIQUOR" || edgeMenuType === "BAR") {
      updates.push("gst_enabled = ?"); values.push(0);
    } else if (body.gstEnabled !== undefined) {
      updates.push("gst_enabled = ?"); values.push(body.gstEnabled ? 1 : 0);
    }

    if (updates.length === 0) return errorResponse("No fields to update", 400);

    values.push(itemId);
    db.query(`UPDATE menu_item SET ${updates.join(", ")} WHERE id = ? AND restaurant_id = ?`).run(...values, restaurantId);
    enqueueSync("menu_item", itemId, "update");

    return jsonResponse({ success: true, id: itemId });
  }

  // ── POST /api/edge/admin/menu-item — create menu item ───────────────────────
  if (url.pathname === "/api/edge/admin/menu-item" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    let body: any;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }

    const db = getDb();
    const restaurantId = getRestaurantId();
    const itemId = crypto.randomUUID();

    const createMenuType = body.menuType || "FOOD";
    const createGst = (createMenuType === "LIQUOR" || createMenuType === "BAR")
      ? 0
      : (body.gstEnabled === false ? 0 : 1);
    db.query(`INSERT INTO menu_item (id, name, description, is_veg, is_available, sort_order, category_id, restaurant_id,
              base_price, unit, menu_type, gst_enabled, is_deleted)
              VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, 0)`)
      .run(itemId, body.name, body.description || null, body.isVeg ? 1 : 0,
           body.categoryId, restaurantId, Number(body.basePrice || 0), body.unit || null, createMenuType, createGst);
    enqueueSync("menu_item", itemId, "create");

    return jsonResponse({ success: true, id: itemId });
  }

  // ── DELETE /api/edge/admin/menu-item/:id — soft delete menu item ─────────────
  if (url.pathname.startsWith("/api/edge/admin/menu-item/") && req.method === "DELETE") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const itemId = url.pathname.split("/").pop()!;

    const db = getDb();
    const restaurantId = getRestaurantId();
    db.query("UPDATE menu_item SET is_deleted = 1, deleted_at = ? WHERE id = ? AND restaurant_id = ?")
      .run(Date.now(), itemId, restaurantId);
    enqueueSync("menu_item", itemId, "update");

    return jsonResponse({ success: true, id: itemId });
  }

  // ── PATCH /api/edge/admin/table/:id — update table ──────────────────────────
  if (url.pathname.startsWith("/api/edge/admin/table/") && req.method === "PATCH") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const tableId = url.pathname.split("/").pop()!;
    let body: any;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }

    const db = getDb();
    const restaurantId = getRestaurantId();
    const updates: string[] = [];
    const values: any[] = [];

    if (body.number !== undefined) { updates.push("number = ?"); values.push(Number(body.number)); }
    if (body.capacity !== undefined) { updates.push("capacity = ?"); values.push(Number(body.capacity)); }
    if (body.sectionId !== undefined) { updates.push("section_id = ?"); values.push(body.sectionId); }

    // If a status is provided, also derive workflow_status and reset session fields
    // when status is AVAILABLE, matching cloud PATCH /api/tables/:id/status.
    const isAvailable = body.status === "AVAILABLE";
    if (body.status !== undefined) {
      updates.push("status = ?"); values.push(body.status);
      const workflowStatus = (() => {
        switch (body.status) {
          case "OCCUPIED":
          case "BILLING_REQUESTED":
          case "RESERVED":
          case "CLEANING":
            return "Occupied";
          case "AVAILABLE":
          default:
            return "Free";
        }
      })();
      updates.push("workflow_status = ?"); values.push(workflowStatus);
      if (isAvailable) {
        updates.push("captain_id = NULL");
        updates.push("guests = 0");
        updates.push("session_started_at = NULL");
        updates.push("current_bill = 0");
        updates.push("kot_history = '[]'");
      }
    }

    if (updates.length === 0) return errorResponse("No fields to update", 400);

    const now = Date.now();
    updates.push("updated_at = ?"); values.push(now);
    values.push(tableId);
    db.query(`UPDATE "table" SET ${updates.join(", ")} WHERE id = ? AND restaurant_id = ?`).run(...values, restaurantId);

    if (isAvailable) {
      db.query("DELETE FROM kot WHERE table_id = ?").run(tableId);
    }

    enqueueSync("table", tableId, "update");

    return jsonResponse({ success: true, id: tableId });
  }

  // ── POST /api/edge/admin/table — create table ───────────────────────────────
  if (url.pathname === "/api/edge/admin/table" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    let body: any;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }

    const db = getDb();
    const restaurantId = getRestaurantId();
    const tableId = crypto.randomUUID();

    db.query(`INSERT INTO "table" (id, number, capacity, section_id, restaurant_id, status, workflow_status)
              VALUES (?, ?, ?, ?, ?, 'AVAILABLE', 'Free')`)
      .run(tableId, Number(body.number), Number(body.capacity || 4), body.sectionId, restaurantId);
    enqueueSync("table", tableId, "create");

    return jsonResponse({ success: true, id: tableId });
  }

  // ── DELETE /api/edge/admin/table/:id — soft delete table ───────────────────
  if (url.pathname.startsWith("/api/edge/admin/table/") && req.method === "DELETE" && !url.pathname.endsWith("/session")) {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const tableId = url.pathname.split("/").pop()!;

    const db = getDb();
    const restaurantId = getRestaurantId();
    db.query("UPDATE \"table\" SET status = 'REMOVED', workflow_status = 'Removed' WHERE id = ? AND restaurant_id = ?")
      .run(tableId, restaurantId);
    enqueueSync("table", tableId, "update");

    return jsonResponse({ success: true, id: tableId });
  }

  // ── POST /api/edge/admin/tables/bulk — create multiple tables at once ───────
  if (url.pathname === "/api/edge/admin/tables/bulk" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    let body: any;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }

    const { sectionId, count, capacity, startNumber } = body;
    const parsedCount = Number(count);
    const parsedCapacity = capacity ?? 4;
    const parsedStart = startNumber ?? 1;

    if (!Number.isInteger(parsedCount) || parsedCount <= 0 || parsedCount > 100) {
      return errorResponse("count must be an integer between 1 and 100", 400);
    }
    if (!sectionId?.trim()) return errorResponse("sectionId is required", 400);

    const db = getDb();
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);

    const section = db.query("SELECT * FROM section WHERE id = ? AND restaurant_id = ?").get(sectionId, restaurantId) as any;
    if (!section) return errorResponse("Section not found", 404);

    // Find max table number to avoid collisions, mirroring cloud behavior
    const maxRow = db.query("SELECT MAX(number) as max_number FROM \"table\" WHERE restaurant_id = ?").get(restaurantId) as any;
    const baseNumber = Math.max(maxRow?.max_number ?? 0, parsedStart - 1);

    const createdTables: any[] = [];
    for (let i = 0; i < parsedCount; i++) {
      const tableId = crypto.randomUUID();
      const number = baseNumber + 1 + i;
      db.query(`INSERT INTO "table" (id, number, capacity, section_id, restaurant_id, status, workflow_status)
                VALUES (?, ?, ?, ?, ?, 'AVAILABLE', 'Free')`)
        .run(tableId, number, parsedCapacity, sectionId, restaurantId);
      enqueueSync("table", tableId, "create");
      createdTables.push({ id: tableId, number, capacity: parsedCapacity, sectionId, restaurantId, status: "AVAILABLE", workflowStatus: "Free" });
    }

    return jsonResponse({ created: createdTables.length, tables: createdTables }, 201);
  }

  // ── DELETE /api/edge/admin/tables/all — delete all tables (skip active orders) ─
  if (url.pathname === "/api/edge/admin/tables/all" && req.method === "DELETE") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);

    const db = getDb();
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);

    const activeOrderStatuses = ["PENDING", "CONFIRMED", "PREPARING", "READY", "BILLING_REQUESTED"];

    // Find tables with active orders — these will be skipped
    const occupiedTables = db.query(`
      SELECT DISTINCT t.id FROM "table" t
      JOIN order_record o ON o.table_id = t.id
      WHERE t.restaurant_id = ? AND o.status IN (${activeOrderStatuses.map(() => "?").join(", ")})
    `).all(restaurantId, ...activeOrderStatuses) as any[];
    const skipIds = new Set(occupiedTables.map((t) => t.id));

    // Find all tables to delete (not in skipIds)
    const allTables = db.query(`SELECT id FROM "table" WHERE restaurant_id = ? AND status != 'REMOVED'`).all(restaurantId) as any[];
    const toDelete = allTables.filter((t) => !skipIds.has(t.id));

    const now = Date.now();
    for (const t of toDelete) {
      db.query("UPDATE \"table\" SET status = 'REMOVED', workflow_status = 'Removed', updated_at = ? WHERE id = ?")
        .run(now, t.id);
      enqueueSync("table", t.id, "update");
    }

    return jsonResponse({ deleted: toDelete.length, skipped: skipIds.size });
  }

  // ── POST /api/edge/admin/category — create category ────────────────────────
  if (url.pathname === "/api/edge/admin/category" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    let body: any;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }

    if (!body.name) return errorResponse("name is required", 400);

    const db = getDb();
    const restaurantId = getRestaurantId();
    const categoryId = crypto.randomUUID();

    db.query("INSERT INTO category (id, name, restaurant_id, sort_order, is_active, printer_target) VALUES (?, ?, ?, 0, 1, ?)")
      .run(categoryId, body.name, restaurantId, body.printerTarget || null);
    enqueueSync("category", categoryId, "create");

    return jsonResponse({ success: true, id: categoryId });
  }

  // ── PATCH /api/edge/admin/category/:id — update category ───────────────────
  if (url.pathname.startsWith("/api/edge/admin/category/") && req.method === "PATCH") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const categoryId = url.pathname.split("/").pop()!;
    let body: any;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }

    const db = getDb();
    const restaurantId = getRestaurantId();
    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) { updates.push("name = ?"); values.push(body.name); }
    if (body.sortOrder !== undefined) { updates.push("sort_order = ?"); values.push(Number(body.sortOrder)); }
    if (body.printerTarget !== undefined) { updates.push("printer_target = ?"); values.push(body.printerTarget); }

    if (updates.length === 0) return errorResponse("No fields to update", 400);

    values.push(categoryId);
    db.query(`UPDATE category SET ${updates.join(", ")} WHERE id = ? AND restaurant_id = ?`).run(...values, restaurantId);
    enqueueSync("category", categoryId, "update");

    return jsonResponse({ success: true, id: categoryId });
  }

  // ── DELETE /api/edge/admin/category/:id — soft delete category ──────────────
  if (url.pathname.startsWith("/api/edge/admin/category/") && req.method === "DELETE") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const categoryId = url.pathname.split("/").pop()!;

    const db = getDb();
    const restaurantId = getRestaurantId();
    db.query("UPDATE category SET is_active = 0 WHERE id = ? AND restaurant_id = ?").run(categoryId, restaurantId);
    enqueueSync("category", categoryId, "update");

    return jsonResponse({ success: true, id: categoryId });
  }

  // ── POST /api/edge/admin/staff — create staff member ────────────────────────
  if (url.pathname === "/api/edge/admin/staff" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    let body: any;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }

    if (!body.name || !body.pin) return errorResponse("name and pin are required", 400);

    const db = getDb();
    const restaurantId = getRestaurantId();
    const userId = crypto.randomUUID();
    const { hashSync } = await import("bcryptjs");
    const pinHash = hashSync(String(body.pin), 10);

    db.query("INSERT INTO users (id, name, pin, role, outlet_id, is_active, synced_at) VALUES (?, ?, ?, ?, ?, 1, unixepoch())")
      .run(userId, body.name, pinHash, body.role || "CAPTAIN", restaurantId);
    enqueueSync("users", userId, "create");

    return jsonResponse({ success: true, id: userId });
  }

  // ── PATCH /api/edge/admin/staff/:id — update staff member ───────────────────
  if (url.pathname.startsWith("/api/edge/admin/staff/") && req.method === "PATCH") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const userId = url.pathname.split("/").pop()!;
    let body: any;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }

    const db = getDb();
    const restaurantId = getRestaurantId();
    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) { updates.push("name = ?"); values.push(body.name); }
    if (body.isActive !== undefined) { updates.push("is_active = ?"); values.push(body.isActive ? 1 : 0); }
    if (body.role !== undefined) { updates.push("role = ?"); values.push(body.role); }
    if (body.pin !== undefined) {
      const { hashSync } = await import("bcryptjs");
      updates.push("pin = ?"); values.push(hashSync(String(body.pin), 10));
    }

    if (updates.length === 0) return errorResponse("No fields to update", 400);

    values.push(userId);
    db.query(`UPDATE users SET ${updates.join(", ")} WHERE id = ? AND outlet_id = ?`).run(...values, restaurantId);
    enqueueSync("users", userId, "update");

    return jsonResponse({ success: true, id: userId });
  }

  // ── DELETE /api/edge/admin/staff/:id — deactivate staff member ──────────────
  if (url.pathname.startsWith("/api/edge/admin/staff/") && req.method === "DELETE") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const userId = url.pathname.split("/").pop()!;

    const db = getDb();
    const restaurantId = getRestaurantId();
    db.query("UPDATE users SET is_active = 0 WHERE id = ? AND outlet_id = ?").run(userId, restaurantId);
    enqueueSync("users", userId, "update");

    return jsonResponse({ success: true, id: userId });
  }

  // ── PATCH /api/edge/admin/outlet — update outlet settings ───────────────────
  if (url.pathname === "/api/edge/admin/outlet" && req.method === "PATCH") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    let body: any;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }

    const db = getDb();
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) { updates.push("name = ?"); values.push(body.name); }
    if (body.address !== undefined) { updates.push("address = ?"); values.push(body.address); }
    if (body.phone !== undefined) { updates.push("phone = ?"); values.push(body.phone); }
    if (body.email !== undefined) { updates.push("email = ?"); values.push(body.email); }
    if (body.gstin !== undefined) { updates.push("gstin = ?"); values.push(body.gstin); }
    if (body.gstCategory !== undefined) { updates.push("gst_category = ?"); values.push(body.gstCategory); }
    if (body.gstRate !== undefined) { updates.push("gst_rate = ?"); values.push(Number(body.gstRate)); }
    if (body.gstRegistered !== undefined) { updates.push("gst_registered = ?"); values.push(body.gstRegistered ? 1 : 0); }
    if (body.pricesIncludeGst !== undefined) { updates.push("prices_include_gst = ?"); values.push(body.pricesIncludeGst ? 1 : 0); }
    if (body.receiptHeader !== undefined) { updates.push("receipt_header = ?"); values.push(body.receiptHeader); }
    if (body.receiptSubHeader !== undefined) { updates.push("receipt_sub_header = ?"); values.push(body.receiptSubHeader); }
    if (body.themePrimary !== undefined) { updates.push("theme_primary = ?"); values.push(body.themePrimary); }
    if (body.serviceChargePercent !== undefined) { updates.push("service_charge_percent = ?"); values.push(Number(body.serviceChargePercent)); }

    if (updates.length === 0) return errorResponse("No fields to update", 400);

    values.push(restaurantId);
    db.query(`UPDATE outlet SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    enqueueSync("outlet", restaurantId, "update");

    return jsonResponse({ success: true, id: restaurantId });
  }

  // ── 404 ─────────────────────────────────────────────────────────────────────
  return errorResponse("Not found", 404);
}

// ── Global crash guards ──────────────────────────────────────────────────────
// Bun's default behavior is to exit on uncaught exceptions and unhandled promise
// rejections. In a long-running edge server, a transient error in the sync worker,
// socket reconnect, or maintenance interval must NOT kill the process — the cashier
// depends on it being alive. These handlers log and swallow the error so the HTTP
// server keeps serving requests. The Tauri-side watchdog (main.rs) handles the
// case where the process truly dies (segfault, OOM, etc.).

process.on("uncaughtException", (err: any) => {
  console.error("[EdgeServer] UNCAUGHT EXCEPTION (survived):", err?.stack || err);
});

process.on("unhandledRejection", (reason: any) => {
  console.error("[EdgeServer] UNHANDLED REJECTION (survived):", reason?.stack || reason);
});

// ── Start server ──────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0", // Listen on all interfaces for LAN access
  websocket: {
    open(ws) {
      registerClient(ws);
    },
    message(ws, message) {
      // We don't expect client messages — but acknowledge ping for keepalive
      try {
        const data = JSON.parse(message.toString());
        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        }
      } catch {
        // Ignore non-JSON messages
      }
    },
    close(ws) {
      unregisterClient(ws);
    },
    drain(ws) {
      // Backpressure relief — nothing to do for small event payloads
    },
  },
  async fetch(req, server) {
    const url = new URL(req.url);

    // ── WebSocket upgrade for LAN real-time events (Bug 2 fix) ────────────────
    if (url.pathname === "/ws" && req.method === "GET") {
      if (server.upgrade(req)) {
        return; // upgrade succeeded — Bun will call websocket.open
      }
      return errorResponse("WebSocket upgrade failed", 400);
    }

    try {
      return await handleRequest(req, url);
    } catch (err: any) {
      console.error(`[EdgeServer] Unhandled error on ${req.method} ${url.pathname}:`, err);
      return errorResponse("Internal server error", 500);
    }
  },
});

console.log(`[EdgeServer] SoftShape Edge Server running on http://0.0.0.0:${server.port}`);
console.log(`[EdgeServer] Health check: http://localhost:${server.port}/health`);
console.log(`[EdgeServer] WebSocket: ws://0.0.0.0:${server.port}/ws`);

// Initialize LAN broadcast layer
initLanBroadcast();

// ── Startup maintenance: backup + prune ──────────────────────────────────────
setTimeout(() => {
  try {
    runDailyMaintenance(getDb());
  } catch (err: any) {
    startupError = err?.message || String(err);
    console.error("[EdgeServer] Startup maintenance failed (non-fatal):", err);
  }

  const recovery = getRecoveryStatus();
  if (recovery.recovered) {
    console.warn("[EdgeServer] Database was recovered from corruption — attempting full config re-download...");
    const session = loadSession();
    if (session?.backendUrl && session?.sessionToken) {
      downloadFullConfig()
        .then(() => console.log("[EdgeServer] Config re-download complete"))
        .catch(err => console.warn("[EdgeServer] Config re-download failed (will retry on next sync):", err));
    } else {
      console.warn("[EdgeServer] No session — config will download after registration");
    }
  }

  startupState = "ready";
}, 0);

// Run maintenance every 24 hours
setInterval(() => {
  try { runDailyMaintenance(getDb()); } catch (err) { console.warn("[EdgeServer] Scheduled maintenance failed:", err); }
}, 24 * 60 * 60 * 1000);

// Run periodic backup every 30 minutes (reduces data loss window)
setInterval(() => {
  try { runPeriodicBackup(getDb()); } catch (err) { console.warn("[EdgeServer] Periodic backup failed:", err); }
}, 30 * 60 * 1000);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("[EdgeServer] Shutting down...");
  stopHeartbeat();
  stopSocketSync();
  stopSyncWorker();
  releaseInstanceLock();
  closeDb();
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[EdgeServer] SIGTERM received, shutting down...");
  stopHeartbeat();
  stopSocketSync();
  stopSyncWorker();
  releaseInstanceLock();
  closeDb();
  server.stop();
  process.exit(0);
});

// ── Auto-start incremental sync loop (every 60 seconds) ───────────────────────

if (isSessionValid()) {
  console.log("[EdgeServer] Session valid — starting background sync loop");

  // Acquire instance lock — ensures only one edge server instance is active
  const lockResult = acquireInstanceLock();
  if (!lockResult.acquired) {
    console.warn(`[EdgeServer] Another instance is active (${lockResult.holder?.instanceId}). Sync worker disabled.`);
    console.warn("[EdgeServer] Use POST /api/edge/instance/force-release to take over.");
  } else {
    startHeartbeatLoop();

    // Start edge → cloud push worker
    startSyncWorker();

    // Start cloud → edge socket sync (real-time config changes)
    startSocketSync();
    startHeartbeat();
  }

  // Dynamic poll interval: 15s when socket is in fallback mode, 60s otherwise
  let pollIntervalId: ReturnType<typeof setInterval> | null = null;
  function schedulePoll() {
    if (pollIntervalId) clearInterval(pollIntervalId);
    const intervalMs = isInFallbackMode() ? 15_000 : 60_000;
    pollIntervalId = setInterval(async () => {
      if (!isSessionValid()) return;
      if (!lockResult.acquired) return; // Don't poll if we don't have the lock
      try {
        const result = await pullIncrementalChanges();
        if (result.success && result.changesApplied && result.changesApplied > 0) {
          console.log(`[EdgeServer] Incremental sync: ${result.changesApplied} changes applied`);
        }
      } catch (err) {
        console.warn('[EdgeServer] Incremental sync failed:', err);
      }
      // Re-evaluate interval after each poll in case fallback mode changed
      const currentMs = isInFallbackMode() ? 15_000 : 60_000;
      if (currentMs !== intervalMs) {
        schedulePoll();
      }
    }, intervalMs);
  }
  if (lockResult.acquired) {
    schedulePoll();

    // Initial incremental pull on startup
    setTimeout(async () => {
      try {
        const result = await pullIncrementalChanges();
        if (result.success) {
          console.log(`[EdgeServer] Initial sync: ${result.changesApplied || 0} changes applied`);
        }
      } catch {
        // Will retry in the interval
      }
    }, 3_000);
  }
} else {
  console.log("[EdgeServer] No valid session — waiting for registration via POST /api/edge/register");
}
