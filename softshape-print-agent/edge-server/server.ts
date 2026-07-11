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
//   GET  /api/edge/tables       — sections with nested tables + active orders
//   GET  /api/edge/tables/flat  — flat list of all tables
//   GET  /api/edge/sections     — sections with venue + floor info
//   GET  /api/edge/menu         — full menu with categories, items, variants
//   GET  /api/edge/menu/items   — lean flat list for POS
//   GET  /api/edge/venues       — venues with floors and sections
//   GET  /api/edge/outlet       — outlet settings
//   GET  /api/edge/sync/status  — sync worker status
//   POST /api/edge/sync/push    — manually trigger sync push
//   POST /api/edge/sync/retry   — retry dead-lettered records
//   GET  /api/edge/sync/socket  — socket connection status
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, closeDb, getConfig, setConfig, getSyncState } from "./db.ts";
import { loadSession, saveSession, clearSession, isSessionValid, getBackendUrl, getRestaurantId } from "./auth.ts";
import { downloadFullConfig, pullIncrementalChanges } from "./config.ts";
import { createOrder, cancelKotItem, reprintKot } from "./orderService.ts";
import { getTablesForRestaurant, getTablesFlat, getSections, getMenu, getMenuItems, getVenues, getOutletSettings } from "./reads.ts";
import { startSyncWorker, stopSyncWorker, getSyncStatus, manualSyncPush, retryDeadLetters } from "./sync.ts";
import { startSocketSync, stopSocketSync, getSocketStatus, startHeartbeat, stopHeartbeat } from "./socketSync.ts";

const PORT = parseInt(process.env.EDGE_PORT || "3100", 10);

// ── CORS headers for LAN access (captain/cashier apps on other devices) ──────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

  // ── GET /health ─────────────────────────────────────────────────────────────
  if (url.pathname === "/health" && req.method === "GET") {
    const session = loadSession();
    return jsonResponse({
      status: "ok",
      service: "softshape-edge-server",
      version: "10.0.0",
      sessionValid: isSessionValid(),
      restaurantId: session?.restaurantId || null,
      restaurantName: session?.restaurantName || null,
      uptime: process.uptime(),
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

    // Count local rows for status
    const db = getDb();
    const tableCount = (db.query("SELECT COUNT(*) as c FROM table").get() as any)?.c || 0;
    const menuItemCount = (db.query("SELECT COUNT(*) as c FROM menu_item WHERE is_deleted = 0").get() as any)?.c || 0;
    const orderCount = (db.query("SELECT COUNT(*) as c FROM order_record WHERE is_deleted = 0").get() as any)?.c || 0;
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

    // Call cloud backend to register the agent
    try {
      const res = await fetch(`${backendUrl}/api/print/agent-register`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${setupToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentId: `edge-${crypto.randomUUID()}`,
          printerMapping: {},
          ...(restaurantCode ? { restaurantCode } : {}),
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
      });

      // Trigger initial config download
      const configResult = await downloadFullConfig();

      return jsonResponse({
        success: true,
        restaurantId: data.restaurantId,
        restaurantName: data.restaurantName,
        configDownloaded: configResult.success,
        tablesLoaded: configResult.tablesLoaded || 0,
        configError: configResult.error,
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
    if (!isSessionValid()) {
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
    });

    if (!result.success) {
      return jsonResponse(result, result.statusCode || 400);
    }

    return jsonResponse(result);
  }

  // ── POST /api/edge/order/cancel — cancel KOT item ──────────────────────────
  if (url.pathname === "/api/edge/order/cancel" && req.method === "POST") {
    if (!isSessionValid()) {
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
    });

    if (!result.success) {
      return errorResponse(result.error || "Cancel failed", 400);
    }

    return jsonResponse(result);
  }

  // ── POST /api/edge/kot/reprint — reprint KOT for an order ──────────────────
  if (url.pathname === "/api/edge/kot/reprint" && req.method === "POST") {
    if (!isSessionValid()) {
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

  // ── GET /api/edge/tables — sections with nested tables + active orders ────
  if (url.pathname === "/api/edge/tables" && req.method === "GET") {
    if (!isSessionValid()) return errorResponse("No valid session", 401);
    const data = getTablesForRestaurant();
    return jsonResponse(data, 200, { "Cache-Control": "no-store" });
  }

  // ── GET /api/edge/tables/flat — flat list of all tables ────────────────────
  if (url.pathname === "/api/edge/tables/flat" && req.method === "GET") {
    if (!isSessionValid()) return errorResponse("No valid session", 401);
    const data = getTablesFlat();
    return jsonResponse(data, 200, { "Cache-Control": "no-store" });
  }

  // ── GET /api/edge/sections — sections with venue + floor info ──────────────
  if (url.pathname === "/api/edge/sections" && req.method === "GET") {
    if (!isSessionValid()) return errorResponse("No valid session", 401);
    const data = getSections();
    return jsonResponse(data);
  }

  // ── GET /api/edge/menu — full menu with categories, items, variants ────────
  if (url.pathname === "/api/edge/menu" && req.method === "GET") {
    if (!isSessionValid()) return errorResponse("No valid session", 401);
    const venueId = url.searchParams.get("venueId") || undefined;
    const data = getMenu(venueId);
    return jsonResponse(data);
  }

  // ── GET /api/edge/menu/items — lean flat list for POS ──────────────────────
  if (url.pathname === "/api/edge/menu/items" && req.method === "GET") {
    if (!isSessionValid()) return errorResponse("No valid session", 401);
    const venueId = url.searchParams.get("venueId") || undefined;
    const data = getMenuItems(venueId);
    return jsonResponse(data);
  }

  // ── GET /api/edge/venues — venues with floors and sections ─────────────────
  if (url.pathname === "/api/edge/venues" && req.method === "GET") {
    if (!isSessionValid()) return errorResponse("No valid session", 401);
    const data = getVenues();
    return jsonResponse(data);
  }

  // ── GET /api/edge/outlet — outlet settings ─────────────────────────────────
  if (url.pathname === "/api/edge/outlet" && req.method === "GET") {
    if (!isSessionValid()) return errorResponse("No valid session", 401);
    const data = getOutletSettings();
    if (!data) return errorResponse("Outlet not found in local DB", 404);
    return jsonResponse(data);
  }

  // ── GET /api/edge/sync/status — sync worker status ────────────────────────
  if (url.pathname === "/api/edge/sync/status" && req.method === "GET") {
    if (!isSessionValid()) return errorResponse("No valid session", 401);
    return jsonResponse(getSyncStatus());
  }

  // ── POST /api/edge/sync/push — manually trigger a sync push ────────────────
  if (url.pathname === "/api/edge/sync/push" && req.method === "POST") {
    if (!isSessionValid()) return errorResponse("No valid session", 401);
    const result = await manualSyncPush();
    return jsonResponse(result);
  }

  // ── POST /api/edge/sync/retry — retry dead-lettered records ────────────────
  if (url.pathname === "/api/edge/sync/retry" && req.method === "POST") {
    if (!isSessionValid()) return errorResponse("No valid session", 401);
    const result = retryDeadLetters();
    return jsonResponse({ success: true, ...result });
  }

  // ── GET /api/edge/sync/socket — socket connection status ───────────────────
  if (url.pathname === "/api/edge/sync/socket" && req.method === "GET") {
    if (!isSessionValid()) return errorResponse("No valid session", 401);
    return jsonResponse(getSocketStatus());
  }

  // ── 404 ─────────────────────────────────────────────────────────────────────
  return errorResponse("Not found", 404);
}

// ── Start server ──────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0", // Listen on all interfaces for LAN access
  async fetch(req) {
    const url = new URL(req.url);
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

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("[EdgeServer] Shutting down...");
  stopHeartbeat();
  stopSocketSync();
  stopSyncWorker();
  closeDb();
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[EdgeServer] SIGTERM received, shutting down...");
  stopHeartbeat();
  stopSocketSync();
  stopSyncWorker();
  closeDb();
  server.stop();
  process.exit(0);
});

// ── Auto-start incremental sync loop (every 60 seconds) ───────────────────────

if (isSessionValid()) {
  console.log("[EdgeServer] Session valid — starting background sync loop");

  // Start edge → cloud push worker
  startSyncWorker();

  // Start cloud → edge socket sync (real-time config changes)
  startSocketSync();
  startHeartbeat();

  setInterval(async () => {
    if (!isSessionValid()) return;
    try {
      const result = await pullIncrementalChanges();
      if (result.success && result.changesApplied && result.changesApplied > 0) {
        console.log(`[EdgeServer] Incremental sync: ${result.changesApplied} changes applied`);
      }
    } catch (err) {
      // Silent fail — will retry next cycle
    }
  }, 60_000);

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
} else {
  console.log("[EdgeServer] No valid session — waiting for registration via POST /api/edge/register");
}
