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
//   POST /api/edge/sync/backfill — re-enqueue missing transaction syncs
//   GET  /api/edge/sync/socket  — socket connection status
//   GET  /api/edge/update-check — Runtime update status (Host polls this)
//   GET  /api/edge/drivers      — list all drivers and their health
//   POST /api/edge/drivers/reload — hot-reload external plugins
//   GET  /runtime/status        — Runtime status (§1.1)
//   POST /runtime/restart       — restart Runtime (admin-only, §1.1)
//   POST /runtime/rotate-token  — rotate runtime token (admin-only, §5.3)
//   GET  /devices               — list all devices (§1.6)
//   GET  /devices/printers      — list available printers (§1.6)
//   WS   /events                — Runtime event bus (§3)
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, closeDb, getConfig, setConfig, getSyncState, setSyncState, enqueueSync, getRecoveryStatus, updatePrintJobStatus, getPendingPrintJobs, getOrderSyncStatus, getPrintJobByEventId, cancelPrintJob, reprintPrintJob, getPrintJobsByOrder, insertSyncAudit, getSyncAuditRecords, createPrintJob, claimPrintJob, getKolkataDateString } from "./db.ts";
import os from "os";
import { loadSession, saveSession, clearSession, isSessionValid, isLocalReady, getBackendUrl, getSessionToken, getRestaurantId, getDeviceId, getEdgeApiKey, saveEdgeApiKey } from "./auth.ts";
import { pullIncrementalChanges } from "./config.ts";
import { createOrder, updateOrderItems, cancelKotItem, reprintKot, requestBillingEdge, printBillEdge, settleOrderEdge, swapTableEdge, transferItemsEdge, editBillEdge, confirmPaymentEdge, updateOrderStatusEdge, markOrderPaidEdge, saveTransactionEdge, listTransactionsEdge, dispatchPendingPrintJobs } from "./orderService.ts";
import { getTablesForRestaurant, getTablesFlat, getSections, getMenu, getMenuItems, getVenues, getOutletSettings, getActiveOrders } from "./reads.ts";
import { startSyncWorker, getSyncStatus, manualSyncPush, retryDeadLetters, getDeadLetterRecords, discardDeadLetter, retrySingleDeadLetter } from "./sync.ts";
import { startSocketSync, getSocketStatus, startHeartbeat } from "./socketSync.ts";
import { acquireInstanceLock, startHeartbeatLoop, forceReleaseLock, getLockStatus } from "./instanceLock.ts";
import { cloudFetch } from "./cloudFetch.ts";
import { initLanBroadcast, registerClient, unregisterClient, getLanClientCount, setClientRegistered, lanBroadcast } from "./lanBroadcast.ts";
import { printToPrinter, resolvePrinterName } from "./printer.ts";
import { buildXReport, buildExpenditure } from "./escpos.ts";
import { isPrintServiceReady, getPrintServiceStatus, getPrintServiceExeDiagnostics, sendToPrintService, listPrintersViaService, startPrintService, stopPrintService } from "./printServiceManager.ts";
import { deviceManager } from "./drivers/manager.ts";
import { PrinterDriver } from "./drivers/printer/index.ts";
import { PaymentDriver } from "./drivers/payment/index.ts";
import { BarcodeDriver } from "./drivers/barcode/index.ts";
import { ScaleDriver } from "./drivers/scale/index.ts";
import { DisplayDriver } from "./drivers/display/index.ts";
import { loadPlugins, reloadPlugins, getLoadedPlugins } from "./drivers/pluginLoader.ts";
import { getOrCreateRuntimeToken, validateRuntimeToken, rotateRuntimeToken, PUBLIC_PATHS } from "./contract/auth.ts";
import { registerEventClient, handleEventMessage, unregisterEventClient, emitEvent, getEventClientCount, getAuthenticatedClientCount } from "./eventBus.ts";
import { EVENT_NAMES } from "./contract/events.ts";
import { runtimeLog } from "./contract/logger.ts";
import { hashSync, compareSync } from "bcryptjs";
import { runtimeManager } from "./runtimeManager.ts";

const PORT = parseInt(process.env.EDGE_PORT || "3101", 10);

// Rate limiting for /health endpoint — 1 request per 5s per IP
const _healthRateLimit = new Map<string, number>();
// Cache for print_job summary on /health — refreshed every 5s
let _printJobSummaryCache: any = null;
let _printJobSummaryCacheAt = 0;
// Cache for full /health response — used to serve rate-limited callers
let _healthCache: any = null;

// ── Edge role verification (S4 offline) ──────────────────────────────────────
// Verifies that the caller's userId + pin match a local user with an allowed role.
// Returns null on success, or an error response on failure.
// Financial endpoints (settle, print-bill, swap-table, transfer-items, edit-bill,
// confirm-payment) must call this to enforce role-based access control offline.
const ROLE_HIERARCHY: Record<string, number> = {
  CAPTAIN: 1,
  CASHIER: 2,
  MANAGER: 3,
  ADMIN: 4,
  OWNER: 5,
};

// ── PIN brute-force protection (H2) ──────────────────────────────────────────
// Tracks failed PIN attempts per userId. After MAX_PIN_ATTEMPTS failures within
// the LOCKOUT_WINDOW, the account is locked for LOCKOUT_DURATION seconds.
const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 60_000;   // 60s rolling window for counting attempts
const LOCKOUT_DURATION_MS = 60_000; // 60s lockout after exceeding max attempts

const pinFailures = new Map<string, number[]>();

function recordPinFailure(userId: string): void {
  const now = Date.now();
  const cutoff = now - LOCKOUT_WINDOW_MS;
  const attempts = (pinFailures.get(userId) || []).filter(t => t > cutoff);
  attempts.push(now);
  pinFailures.set(userId, attempts);
}

function isPinLocked(userId: string): boolean {
  const attempts = pinFailures.get(userId);
  if (!attempts || attempts.length < MAX_PIN_ATTEMPTS) return false;
  const now = Date.now();
  const cutoff = now - LOCKOUT_WINDOW_MS;
  const recent = attempts.filter(t => t > cutoff);
  if (recent.length >= MAX_PIN_ATTEMPTS) {
    const oldestRelevant = recent[0];
    if (now - oldestRelevant < LOCKOUT_DURATION_MS) return true;
    // Lockout expired — reset
    pinFailures.delete(userId);
  }
  return false;
}

function clearPinFailures(userId: string): void {
  pinFailures.delete(userId);
}

async function verifyEdgeRole(
  body: any,
  allowedRoles: string[],
): Promise<Response | null> {
  const userId = body?.userId || body?.cashierId;
  const pin = body?.pin || body?.cashierPin;
  if (!userId || !pin) {
    return errorResponse("userId and pin are required for this operation", 401);
  }

  // Check brute-force lockout before hitting the database
  if (isPinLocked(userId)) {
    return errorResponse("Too many failed attempts. Please try again later.", 429);
  }

  const db = getDb();
  const restaurantId = getRestaurantId();
  if (!restaurantId) return errorResponse("No restaurant ID in session", 500);

  const user = db.query(
    "SELECT id, name, pin, role, is_active FROM users WHERE id = ? AND outlet_id = ?"
  ).get(userId, restaurantId) as { id: string; name: string; pin: string | null; role: string; is_active: number } | null;

  if (!user) return errorResponse("Invalid credentials", 401);
  if (!user.is_active) return errorResponse("Account is inactive", 403);
  if (!user.pin) return errorResponse("No PIN set for this account", 401);

  const isValid = compareSync(String(pin), user.pin);
  if (!isValid) {
    recordPinFailure(userId);
    return errorResponse("Invalid credentials", 401);
  }

  // Successful auth — clear any prior failure history
  clearPinFailures(userId);

  const userRoleLevel = ROLE_HIERARCHY[(user.role || "").toUpperCase()] ?? 0;
  const minRequiredLevel = Math.min(
    ...allowedRoles.map(r => ROLE_HIERARCHY[r.toUpperCase()] ?? 0)
  );

  if (userRoleLevel < minRequiredLevel) {
    return errorResponse(`Role '${user.role}' is not permitted for this operation`, 403);
  }

  return null;
}

// ── Input validation (S8) ────────────────────────────────────────────────────
// Lightweight validation for edge server POST endpoints. Avoids adding zod
// as a dependency to keep the edge server bundle minimal.
// Schema entries can be a simple type string ("string" | "number" | "array" | "boolean")
// or an object { type, maxLength?, allowEmpty? } for additional constraints.
type FieldType = "string" | "number" | "array" | "boolean";
type FieldSchema = FieldType | { type: FieldType; maxLength?: number; allowEmpty?: boolean };
const MAX_STRING_LENGTH = 10_000;
const MAX_ARRAY_LENGTH = 500;

function validateFields(body: any, schema: Record<string, FieldSchema>): string | null {
  for (const [field, spec] of Object.entries(schema)) {
    const type: FieldType = typeof spec === "string" ? spec : spec.type;
    const maxLength = typeof spec === "object" ? spec.maxLength : undefined;
    const allowEmpty = typeof spec === "object" ? spec.allowEmpty : undefined;

    const val = body?.[field];
    if (val === undefined || val === null) {
      return `${field} is required`;
    }
    switch (type) {
      case "string": {
        if (typeof val !== "string" || !val.trim()) return `${field} must be a non-empty string`;
        const limit = maxLength ?? MAX_STRING_LENGTH;
        if (val.length > limit) return `${field} exceeds maximum length of ${limit}`;
        break;
      }
      case "number":
        if (typeof val !== "number" || isNaN(val)) return `${field} must be a valid number`;
        break;
      case "array": {
        if (!Array.isArray(val)) return `${field} must be an array`;
        if (!allowEmpty && val.length === 0) return `${field} must not be empty`;
        if (val.length > MAX_ARRAY_LENGTH) return `${field} exceeds maximum of ${MAX_ARRAY_LENGTH} items`;
        break;
      }
      case "boolean":
        if (typeof val !== "boolean") return `${field} must be a boolean`;
        break;
    }
  }
  return null;
}

// ── Per-IP rate limiting (SC5) ───────────────────────────────────────────────
// Simple in-memory token bucket: 120 requests per minute per IP.
// POS operations are bursty but low-volume; this prevents LAN abuse.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const ipRequestCounts = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(clientIp: string): boolean {
  const now = Date.now();
  const entry = ipRequestCounts.get(clientIp);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    ipRequestCounts.set(clientIp, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// Clean up stale entries every 5 minutes to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipRequestCounts) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      ipRequestCounts.delete(ip);
    }
  }
}, 5 * 60_000);

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

// ── One-time setup nonce for onboarding protection ───────────────────────────
// Prevents unauthorized LAN devices from calling /api/edge/onboard during the
// setup window. The nonce is generated on first boot, exposed via /health only
// before onboarding completes, and invalidated after successful onboarding.

function getSetupNonce(): string | null {
  const existing = getConfig("setup_nonce");
  if (existing) return existing;
  // Generate a new nonce on first boot
  const nonce = crypto.randomUUID();
  setConfig("setup_nonce", nonce);
  return nonce;
}

function invalidateSetupNonce(): void {
  const db = getDb();
  db.query("DELETE FROM edge_config WHERE key = ?").run("setup_nonce");
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleRequest(req: Request, url: URL, server: any): Promise<Response> {
  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── Per-IP rate limiting (SC5) ──────────────────────────────────────────────
  // Use the actual socket remote address from Bun instead of the spoofable
  // X-Forwarded-For header. On a LAN there is no reverse proxy, so the socket
  // address is the only trustworthy client identifier.
  let clientIp = "unknown";
  try {
    const addr = server.requestIP(req);
    if (addr && typeof addr === 'object' && 'address' in addr) {
      clientIp = addr.address;
    } else if (typeof addr === 'string') {
      clientIp = addr;
    }
  } catch {
    // requestIP may fail for some request types — fall back to unknown
  }
  if (!checkRateLimit(clientIp)) {
    return errorResponse("Rate limit exceeded. Please slow down.", 429);
  }

  // ── LAN API key auth (staged rollout) ────────────────────────────────────────
  // Routes that never require the edge API key. Only truly public routes
  // (health check, cloud registration with setup token) belong here.
  // All POS operation routes require the X-Edge-Key header when a key is
  // configured on the edge server. This prevents unauthorized LAN devices
  // from creating orders, settling bills, or triggering prints.
  const PUBLIC_LAN_PATHS = new Set([
    "/health",
    "/api/edge/register",
    "/api/edge/auth/pin",
    "/api/edge/staff",
  ]);

  // /api/edge/onboard is only accessible before initial setup is complete.
  // After onboarding, it is blocked entirely to prevent re-initialization.
  // /print is a legacy LAN relay path that requires the edge key when configured.
  const isOnboarded = isLocalReady();
  const configuredKey = getEdgeApiKey();
  const provided = req.headers.get("X-Edge-Key");

  if (!PUBLIC_LAN_PATHS.has(url.pathname)) {
    // Block onboarding after initial setup
    if (url.pathname === "/api/edge/onboard") {
      if (isOnboarded) {
        return errorResponse("Onboarding already complete — device is registered", 403);
      }
      // Before onboarding completes, allow without key (initial setup flow)
    } else if (url.pathname === "/print") {
      // /print requires the edge API key unconditionally once onboarded.
      // Before onboarding, allow without key (initial setup / test print).
      if (isOnboarded) {
        if (!configuredKey) {
          return errorResponse("Edge API key not configured — run agent-register first", 401);
        }
        if (!provided || provided !== configuredKey) {
          return errorResponse("Missing or invalid edge API key", 401);
        }
      }
    } else {
      // All other routes: require key when configured.
      // EDGE_REQUIRE_KEY=true makes the key mandatory even if not yet configured.
      const requireKey = process.env.EDGE_REQUIRE_KEY === "true";
      if (configuredKey) {
        if (!provided || provided !== configuredKey) {
          return errorResponse("Missing or invalid edge API key", 401);
        }
      } else if (requireKey) {
        return errorResponse("Edge API key required but not configured", 401);
      }
    }
  }

  // ── Runtime token auth (§5 of platform contract) ────────────────────────────
  // Every non-public request must carry a valid Bearer token.
  // The token is generated on first boot and stored in edge_config.
  // During onboarding (before setup completes), token enforcement is relaxed
  // so the initial pairing flow can proceed.
  if (!PUBLIC_PATHS.has(url.pathname) && isLocalReady()) {
    const authHeader = req.headers.get("Authorization");
    if (!validateRuntimeToken(authHeader)) {
      return errorResponse("Missing or invalid runtime token", 401);
    }
  }

  // ── GET /health ─────────────────────────────────────────────────────────────
  // Rate-limited to 1 request per 5s per IP to reduce SQLite contention from
  // multiple captain/cashier devices polling simultaneously.
  // Returns 200 with cached data on rate-limited calls so callers like
  // waitForEdgeReady (which polls every 1s during startup) don't break.
  if (url.pathname === "/health" && req.method === "GET") {
    const clientIp = (req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown").split(",")[0].trim();
    const now = Date.now();
    const lastHit = _healthRateLimit.get(clientIp) || 0;
    if (now - lastHit < 5000) {
      // Return cached health snapshot instead of 429 — the full query runs
      // at most once per 5s, but callers still get a valid response.
      const cached = _healthCache || { status: "ok", isOperational: false };
      return jsonResponse({ ...cached, rateLimited: true, retryAfterMs: 5000 - (now - lastHit) }, 200, { "Cache-Control": "no-store" });
    }
    _healthRateLimit.set(clientIp, now);

    const rmHealth = runtimeManager.getHealth();
    if (!rmHealth.isOperational) {
      const healthResp = {
        status: rmHealth.status,
        service: "softshape-edge-server",
        version: "23.7.8",
        uptime: process.uptime(),
        runtimeState: rmHealth.runtimeState,
        configSyncState: rmHealth.configSyncState,
        connectionState: rmHealth.connectionState,
        isOperational: false,
        error: rmHealth.startupError,
      };
      _healthCache = healthResp;
      return jsonResponse(healthResp);
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
    } catch (e) { console.warn('[health] network interface enumeration failed:', (e as Error).message); }

    // Operational metrics for monitoring
    let syncMetrics: any = null;
    try {
      syncMetrics = getSyncStatus();
    } catch { /* ignore */ }

    let printMetrics: any = null;
    try {
      const now2 = Date.now();
      if (_printJobSummaryCache && (now2 - _printJobSummaryCacheAt) < 5000) {
        printMetrics = _printJobSummaryCache;
      } else {
        const db = getDb();
        const summary = db.query(`
          SELECT
            SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
            SUM(CASE WHEN status = 'printing' THEN 1 ELSE 0 END) as printing,
            SUM(CASE WHEN status = 'printed' THEN 1 ELSE 0 END) as printed,
            SUM(CASE WHEN status = 'retrying' THEN 1 ELSE 0 END) as retrying,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
            SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) as dead_letter,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
          FROM print_job
        `).get() as any;
        _printJobSummaryCache = summary;
        _printJobSummaryCacheAt = now2;
        printMetrics = summary;
      }
    } catch { /* ignore */ }

    const healthResp = {
      status: "ok",
      service: "softshape-edge-server",
      version: "23.7.8",
      sessionValid: isSessionValid(),
      restaurantId: session?.restaurantId || null,
      restaurantName: session?.restaurantName || null,
      onboarded: isLocalReady(),
      isOperational: true,
      runtimeState: rmHealth.runtimeState,
      configSyncState: rmHealth.configSyncState,
      connectionState: rmHealth.connectionState,
      setupNonce: isLocalReady() ? null : getSetupNonce(),
      uptime: process.uptime(),
      databaseRecovered: recovery.recovered,
      recoveryMessage: recovery.message || null,
      lanIp,
      edgePort: PORT,
      maintenanceError: rmHealth.startupError,
      sync: syncMetrics ? {
        workerRunning: syncMetrics.workerRunning,
        pendingCount: syncMetrics.pendingCount,
        deadLetterCount: syncMetrics.deadLetterCount,
        consecutiveFailures: syncMetrics.consecutiveFailures,
        lastSyncAt: syncMetrics.lastSyncAt,
      } : null,
      printQueue: printMetrics,
      printService: getPrintServiceStatus(),
      drivers: deviceManager.getDeviceHealths(),
    };
    _healthCache = healthResp;
    return jsonResponse(healthResp);
  }

  // ── GET /runtime/status — Runtime status (§1.1) ─────────────────────────────
  if (url.pathname === "/runtime/status" && req.method === "GET") {
    const printStatus = getPrintServiceStatus();
    const syncStatus = getSocketStatus();
    const rmStatus = runtimeManager.getStatus();
    return jsonResponse({
      running: true,
      ready: rmStatus.isOperational,
      state: rmStatus.runtimeState,
      configSyncState: rmStatus.configSyncState,
      connectionState: rmStatus.connectionState,
      isOperational: rmStatus.isOperational,
      services: {
        printService: { pid: printStatus.pid, state: printStatus.state },
        sync: { state: syncStatus.connected ? "CONNECTED" : "DISCONNECTED" },
      },
      lastError: rmStatus.startupError,
    });
  }

  // ── POST /runtime/restart — Restart the Runtime (§1.1, admin-only) ──────────
  if (url.pathname === "/runtime/restart" && req.method === "POST") {
    runtimeLog.info("Runtime restart requested via API");
    runtimeManager.restart();
    return jsonResponse({ ok: true });
  }

  // ── POST /api/edge/admin/restart-print-service — Restart just the print service ──
  if (url.pathname === "/api/edge/admin/restart-print-service" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    runtimeLog.info("Print service restart requested via API");
    stopPrintService();
    // Allow OS to release the port and clean up the process before restarting
    await new Promise(resolve => setTimeout(resolve, 500));
    const started = startPrintService();
    if (!started) {
      return jsonResponse({ ok: false, error: "Print service executable not found", exe: getPrintServiceExeDiagnostics() }, 500);
    }
    return jsonResponse({ ok: true, status: getPrintServiceStatus() });
  }

  // ── POST /runtime/shutdown — Shutdown all Runtime services ──────────────────
  // Called by the Cashier tray "Shutdown Runtime" action.
  // Stops print service, sync workers, socket sync, releases lock, then exits.
  // The Runtime Host will NOT respawn (it detects graceful shutdown).
  if (url.pathname === "/runtime/shutdown" && req.method === "POST") {
    runtimeLog.info("Runtime shutdown requested via API");
    runtimeManager.shutdown().then(() => {
      try { closeDb(); } catch {}
      try { server.stop(); } catch {}
      process.exit(0);
    });
    return jsonResponse({ ok: true });
  }

  // ── POST /runtime/rotate-token — Rotate the runtime token (§1.1, §5.3) ──────
  if (url.pathname === "/runtime/rotate-token" && req.method === "POST") {
    const newToken = rotateRuntimeToken();
    runtimeLog.info("Runtime token rotated via API");
    return jsonResponse({ ok: true, token: newToken });
  }

  // ── GET /devices — list all devices and their health (§1.6) ─────────────────
  if (url.pathname === "/devices" && req.method === "GET") {
    return jsonResponse({ devices: deviceManager.getDeviceHealths() });
  }

  // ── GET /devices/printers — list available printers (§1.6) ──────────────────
  if (url.pathname === "/devices/printers" && req.method === "GET") {
    const printers = await listPrintersViaService();
    return jsonResponse({ printers });
  }

  // ── POST /print — relay print job to print service with durable queue ──────
  // This path is used by captain's local-print fallback (printLocal() →
  // tryPrintAgentUrls()) and previously had no durable queue — if the print
  // service was down, the job was lost with no SQLite row, no retry, no
  // dead-letter. It now persists to print_job before printing (see below).
  //
  // Failure-path behavior differs from the primary order flow (createOrder →
  // persistPrintIntentsInTx), which already has retry/dead-letter via SQLite.
  // Both paths now converge on the same print_job table and dispatch loop, but
  // the relay path uses orderId="relay" and has no KOT/order association.
  //
  // No auth required — this is a LAN-only endpoint (edge server binds to 0.0.0.0
  // but is typically behind a firewall/router on the local network).
  if (url.pathname === "/print" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const { type, jobType, printerName, escposData, bytes, text, data, eventId } = body || {};
    const effectiveType = type || jobType;

    if (!effectiveType) {
      return jsonResponse({ ok: false, error: "Missing jobType or type" }, 400);
    }

    const targetPrinter = printerName || data?.printerName || null;

    // Normalize ESC/POS data to the format the print bridge expects
    let normalizedEscpos = escposData;
    if (!normalizedEscpos && bytes) {
      // Legacy format: convert raw bytes to escposData structure
      normalizedEscpos = [{ type: effectiveType, format: "escpos", data: String.fromCharCode(...bytes) }];
    } else if (!normalizedEscpos && text) {
      normalizedEscpos = [{ type: effectiveType, format: "text", data: text }];
    }

    if (!normalizedEscpos || (Array.isArray(normalizedEscpos) && normalizedEscpos.length === 0)) {
      return jsonResponse({ ok: false, error: "Missing print payload (escposData, bytes, or text required)" }, 400);
    }

    const printEventId = eventId || `${effectiveType}-${Date.now()}`;

    // ── Durable queue: persist before attempting print ──────────────────────
    // Without this, a print-service crash mid-request would silently lose the
    // job — no SQLite row, no retry, no visibility. By persisting first, the
    // background dispatch loop (every 5s) will retry any job that fails here.
    const rid = getRestaurantId() || "relay";

    // Dedup: if this eventId already printed, return success immediately
    const existingJob = getPrintJobByEventId(printEventId);
    if (existingJob?.status === "printed") {
      return jsonResponse({ ok: true, queued: false, method: "dedup", eventId: printEventId });
    }

    // Persist (idempotent via ON CONFLICT(event_id) DO NOTHING).
    // If this fails, we genuinely cannot recover — return 503 so the caller
    // knows the job was not accepted. This is the ONLY 503 case; print-service
    // failures are recoverable via the retry loop.
    const jobId = createPrintJob({
      eventId: printEventId,
      restaurantId: rid,
      orderId: data?.orderId || "relay",
      printerName: targetPrinter,
      jobType: effectiveType,
      escposData: normalizedEscpos,
      itemSummary: [],
      captainName: data?.captainName || null,
    });
    if (jobId === null) {
      return jsonResponse({ ok: false, error: "Failed to persist print job to queue", queued: false }, 503);
    }

    // Attempt immediate print for low latency. Claim first to prevent a race
    // with the background dispatch loop (which also calls claimPrintJob).
    if (targetPrinter && claimPrintJob(printEventId)) {
      const result = await printToPrinter(targetPrinter, normalizedEscpos, printEventId, effectiveType);
      if (result.ok) {
        updatePrintJobStatus(printEventId, "printed", null, "local");
        console.log(`[Print] Relay /print → ${effectiveType} → ${targetPrinter} ✓ (print service)`);
        return jsonResponse({ ok: true, queued: false, method: "print_service", eventId: printEventId });
      }
      console.warn(`[Print] Relay /print → ${effectiveType} → ${targetPrinter} print service failed: ${result.error} — job queued for retry`);
      updatePrintJobStatus(printEventId, "retrying", result.error || "Print service failed");
    }

    // Job is durably queued — background dispatch loop will retry every 5s
    return jsonResponse({ ok: true, queued: true, method: "durable_queued", eventId: printEventId });
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
    const configSyncCompleted = getSyncState("config_sync_completed") === "true";

    // Count local rows for this outlet only
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
      configSyncCompleted,
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
    } catch (e) { console.warn('[register] network interface enumeration failed:', (e as Error).message); }

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
        timeout: 30_000,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        return errorResponse(errBody.error || `Registration failed: HTTP ${res.status}`);
      }

      const data = await res.json();

      // Save session immediately so the cloud key fallback and background
      // config download both have a valid agent-session token.
      const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
      let edgeApiKey = data.edgeApiKey || null;
      saveSession({
        sessionToken: data.sessionToken,
        restaurantId: data.restaurantId,
        restaurantName: data.restaurantName || "",
        restaurantCode: data.restaurantCode || restaurantCode || "",
        backendUrl,
        expiresAt,
        edgeApiKey: edgeApiKey || undefined,
      });

      // Older backend builds do not include edgeApiKey in agent-register.
      // Fetch it with the newly issued agent session token before returning.
      if (!edgeApiKey && data.sessionToken) {
        try {
          const keyRes = await cloudFetch(`${backendUrl}/api/edge/key`, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${data.sessionToken}`,
              "Content-Type": "application/json",
            },
            timeout: 15_000,
          });
          if (keyRes.ok) {
            const keyBody = await keyRes.json();
            edgeApiKey = keyBody.edgeApiKey || null;
          }
        } catch (keyErr: any) {
          console.warn(`[register] Could not fetch edge API key fallback: ${keyErr.message}`);
        }
      }
      if (edgeApiKey) saveEdgeApiKey(edgeApiKey);

      // Start background sync services now that we have a valid session.
      // On first boot (no prior session), these don't start at process init.
      // Without this, the edge server has no heartbeat to cloud and no
      // incremental sync until the process restarts.
      try {
        const lockResult = acquireInstanceLock();
        if (lockResult.acquired) {
          startHeartbeatLoop();
          startSyncWorker();
          startSocketSync();
          startHeartbeat();
          console.log("[register] Background sync services started");
        } else {
          console.warn(`[register] Could not start sync services — instance lock held by ${lockResult.holder?.instanceId}`);
        }
      } catch (syncStartErr: any) {
        console.warn("[register] Failed to start background sync services:", syncStartErr.message);
      }

      // Config sync is triggered explicitly by the frontend via
      // /api/edge/config/sync after registration succeeds. Do NOT kick it
      // off here — that creates a race condition where the frontend's call
      // hits the sync mutex and gets rejected.

      return jsonResponse({
        success: true,
        restaurantId: data.restaurantId,
        restaurantName: data.restaurantName,
        configDownloaded: false,
        configPending: true,
        tablesLoaded: 0,
        edgeApiKey,
        runtimeToken: getOrCreateRuntimeToken(),
      });
    } catch (err: any) {
      return errorResponse(err.message || "Failed to connect to backend");
    }
  }

  // ── POST /api/edge/config/sync — trigger full config re-download ───────────
  if (url.pathname === "/api/edge/config/sync" && req.method === "POST") {
    if (!isSessionValid()) {
      console.warn("[config/sync] Session invalid or expired");
      return errorResponse("No valid session — register first", 401);
    }

    console.log("[config/sync] Starting runtimeManager.runConfigSync()...");
    const result = await runtimeManager.runConfigSync();
    console.log(`[config/sync] runConfigSync() returned: success=${result.success}, tablesLoaded=${result.tablesLoaded || 0}, error=${result.error || 'none'}`);
    if (!result.success) {
      return errorResponse(result.error || "Config sync failed", 500);
    }

    return jsonResponse({
      success: true,
      tablesLoaded: result.tablesLoaded,
      syncedAt: new Date().toISOString(),
      verified: result.verified !== false,
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      ...(result.mismatches?.length ? { mismatches: result.mismatches } : {}),
      ...(result.localCounts ? { localCounts: result.localCounts } : {}),
      ...(result.cloudCounts ? { cloudCounts: result.cloudCounts } : {}),
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
      preReservedKotNumber: body.preReservedKotNumber ?? null,
      kotEventIds: body.kotEventIds || null,
      deviceId: body.deviceId,
      expectedRevision: body.expectedRevision,
      isExtraTable: body.isExtraTable,
      tableNumber: body.tableNumber,
    });

    if (!result.success) {
      return jsonResponse(result, result.statusCode || 400);
    }

    return jsonResponse(result);
  }

  // ── POST /api/edge/order/update — add items to existing order + print new KOT ──
  if (url.pathname === "/api/edge/order/update" && req.method === "POST") {
    if (!isLocalReady()) {
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
      preReservedKotNumber: body.preReservedKotNumber ?? null,
      kotEventIds: body.kotEventIds || null,
      deviceId: body.deviceId,
      expectedRevision: body.expectedRevision,
      isExtraTable: body.isExtraTable,
      tableNumber: body.tableNumber,
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
      deviceId: body.deviceId,
      expectedRevision: body.expectedRevision,
      isExtraTable: body.isExtraTable,
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

    // Pre-validate all items before cancelling any to prevent partial state.
    // If any item is invalid (order/item not found), reject the entire batch
    // so the caller can correct and retry without inconsistent DB state.
    const db = getDb();
    const order = db.query("SELECT id FROM order_record WHERE id = ? AND restaurant_id = ?").get(body.orderId, restaurantId) as any;
    if (!order) return errorResponse("Order not found", 404);

    for (const item of items) {
      const orderItem = db.query("SELECT id, quantity, cancelled_quantity FROM order_item WHERE id = ? AND order_id = ?").get(item.orderItemId, body.orderId) as any;
      if (!orderItem) {
        return errorResponse(`Order item ${item.orderItemId} not found — no items were cancelled`, 404);
      }
      const qtyToCancel = item.cancelQuantity || 1;
      const newCancelledQty = (orderItem.cancelled_quantity || 0) + qtyToCancel;
      if (newCancelledQty > orderItem.quantity) {
        return errorResponse(`Cannot cancel ${qtyToCancel} of item ${item.orderItemId} — exceeds remaining quantity. No items were cancelled.`, 400);
      }
    }

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
        deviceId: body.deviceId,
        expectedRevision: body.expectedRevision,
        isExtraTable: body.isExtraTable,
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
    const result = await requestBillingEdge(restaurantId, body.orderId, {
      requestId: body.requestId,
      deviceId: body.deviceId,
      expectedRevision: body.expectedRevision,
      isExtraTable: body.isExtraTable,
    });
    if (!result.success) return errorResponse(result.error || "Request billing failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/order/print-bill — assign bill number + print bill ───────
  if (url.pathname === "/api/edge/order/print-bill" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const validationError = validateFields(body, { orderId: "string" });
    if (validationError) return errorResponse(validationError, 400);
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
      requestId: body.requestId,
      deviceId: body.deviceId,
      expectedRevision: body.expectedRevision,
    });
    if (!result.success) return errorResponse(result.error || "Print bill failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/order/settle — settle order + free table ─────────────────
  if (url.pathname === "/api/edge/order/settle" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const validationError = validateFields(body, { orderId: "string", paymentMethod: "string" });
    if (validationError) return errorResponse(validationError, 400);
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);

    // Handle removed items before settling (edit-bill during settlement)
    if (body.removedItemIds && body.removedItemIds.length > 0) {
      await editBillEdge(restaurantId, body.orderId, {
        removedItemIds: body.removedItemIds,
        editedBy: body.removedBy || "Cashier",
        meta: { requestId: body.requestId, deviceId: body.deviceId, expectedRevision: body.expectedRevision, isExtraTable: body.isExtraTable, tableNumber: body.tableNumber },
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
      serviceChargeAmount: body.serviceChargeAmount,
      items: body.items,
      localTxnId: body.localTxnId,
      requestId: body.requestId,
      deviceId: body.deviceId,
      expectedRevision: body.expectedRevision,
      isExtraTable: body.isExtraTable,
    });
    if (!result.success) return errorResponse(result.error || "Settle failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/order/swap-table — swap two tables ───────────────────────
  if (url.pathname === "/api/edge/order/swap-table" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const validationError = validateFields(body, { sourceTableId: "string", targetTableId: "string" });
    if (validationError) return errorResponse(validationError, 400);
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const result = await swapTableEdge(restaurantId, body.sourceTableId, body.targetTableId, body.swappedBy || "Cashier", {
      requestId: body.requestId,
      deviceId: body.deviceId,
      expectedRevision: body.expectedRevision,
    });
    if (!result.success) return errorResponse(result.error || "Swap failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/order/transfer-items — transfer items between tables ─────
  if (url.pathname === "/api/edge/order/transfer-items" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const validationError = validateFields(body, { sourceTableId: "string", targetTableId: "string", orderItemIds: "array" });
    if (validationError) return errorResponse(validationError, 400);
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const result = await transferItemsEdge(restaurantId, body.sourceTableId, body.targetTableId, body.orderItemIds || [], body.transferredBy || "Cashier", {
      requestId: body.requestId,
      deviceId: body.deviceId,
      expectedRevision: body.expectedRevision,
    });
    if (!result.success) return errorResponse(result.error || "Transfer failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/order/edit-bill — edit bill before settlement ────────────
  if (url.pathname === "/api/edge/order/edit-bill" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const validationError = validateFields(body, { orderId: "string" });
    if (validationError) return errorResponse(validationError, 400);
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const result = await editBillEdge(restaurantId, body.orderId, {
      removedItemIds: body.removedItemIds,
      editQuantities: body.editQuantities,
      addedItems: body.addedItems,
      editedBy: body.editedBy,
      meta: { requestId: body.requestId, deviceId: body.deviceId, expectedRevision: body.expectedRevision, isExtraTable: body.isExtraTable, tableNumber: body.tableNumber },
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
    }, {
      requestId: body.requestId,
      deviceId: body.deviceId,
      expectedRevision: body.expectedRevision,
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
    const result = await updateOrderStatusEdge(restaurantId, body.orderId, body.status, {
      requestId: body.requestId,
      deviceId: body.deviceId,
      expectedRevision: body.expectedRevision,
    });
    if (!result.success) return errorResponse(result.error || "Status update failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/order/pay — mark order as paid (simple status update) ────
  if (url.pathname === "/api/edge/order/pay" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const result = await markOrderPaidEdge(restaurantId, body.orderId, body.paymentMethod || "CASH", {
      requestId: body.requestId,
      deviceId: body.deviceId,
      expectedRevision: body.expectedRevision,
    });
    if (!result.success) return errorResponse(result.error || "Mark paid failed", 400);
    return jsonResponse(result);
  }

  // ── POST /api/edge/transaction — save walk-in transaction (no order) ────────
  if (url.pathname === "/api/edge/transaction" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("No valid session", 401);
    const body = await req.json().catch(() => ({}));
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const result = await saveTransactionEdge(restaurantId, body, {
      requestId: body.requestId,
      deviceId: body.deviceId,
      expectedRevision: body.expectedRevision,
    });
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

  // ── GET /api/edge/analytics/items-sold — item analytics from local SQLite ──
  // Used by edge-local (PIN) auth to populate ItemAnalytics from local settled orders.
  // Mirrors cloud /api/analytics/items-sold response format.
  if (url.pathname === "/api/edge/analytics/items-sold" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);

    const startDate = url.searchParams.get("startDate") || new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate = url.searchParams.get("endDate") || startDate;
    const sectionName = url.searchParams.get("sectionName");

    // IST date range
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const [sy, sm, sd] = startDate.split("-").map(Number);
    const [ey, em, ed] = endDate.split("-").map(Number);
    const startTs = Date.UTC(sy, sm - 1, sd, 0, 0, 0, 0) - IST_OFFSET_MS;
    const endTs = Date.UTC(ey, em - 1, ed, 23, 59, 59, 999) - IST_OFFSET_MS;

    const db = getDb();

    // Resolve section filter to table IDs
    let sectionTableIds: string[] = [];
    if (sectionName) {
      const sections = db.query("SELECT id FROM section WHERE restaurant_id = ? AND LOWER(name) = LOWER(?)").all(restaurantId, sectionName) as any[];
      const sectionIds = sections.map(s => s.id);
      if (sectionIds.length > 0) {
        const tables = db.query("SELECT id FROM \"table\" WHERE section_id IN (" + sectionIds.map(() => "?").join(",") + ")").all(...sectionIds) as any[];
        sectionTableIds = tables.map(t => t.id);
      }
    }

    // 1. Settled orders from order_record + order_item
    let orderQuery = `SELECT o.id, o.paid_at FROM order_record o WHERE o.restaurant_id = ? AND o.status = 'SETTLED' AND o.paid_at >= ? AND o.paid_at <= ?`;
    const orderParams: any[] = [restaurantId, startTs, endTs];
    if (sectionTableIds.length > 0) {
      orderQuery += ` AND o.table_id IN (${sectionTableIds.map(() => "?").join(",")})`;
      orderParams.push(...sectionTableIds);
    }
    const settledOrders = db.query(orderQuery).all(...orderParams) as any[];

    // 2. Walk-in transactions from edge_config
    let walkinRows: any[] = [];
    try {
      const walkinQuery = `SELECT key, value FROM edge_config WHERE key LIKE 'walkin_txn:%'`;
      const allWalkinRows = db.query(walkinQuery).all() as any[];
      for (const row of allWalkinRows) {
        try {
          const data = JSON.parse(row.value);
          if (data.restaurantId === restaurantId && data.createdAt >= startTs && data.createdAt <= endTs) {
            walkinRows.push(data);
          }
        } catch { /* ignore parse errors */ }
      }
    } catch { /* ignore */ }

    // Aggregate items
    const itemMap = new Map<string, { name: string; quantity: number; revenue: number; type: string; orderCount: number }>();

    // Process settled orders
    for (const order of settledOrders) {
      const items = db.query("SELECT name, price, quantity, menu_type FROM order_item WHERE order_id = ? AND removed_from_bill = 0").all(order.id) as any[];
      // Get discount from settle record
      const settleRow = db.query("SELECT value FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = ?").get(order.id) as any;
      let discountPercent = 0;
      if (settleRow?.value) {
        try { discountPercent = Number(JSON.parse(settleRow.value).discountPercent || 0); } catch {}
      }
      const discountFactor = discountPercent > 0 ? (1 - discountPercent / 100) : 1;

      for (const item of items) {
        const name = (item.name || "Unknown").trim();
        const key = name.toLowerCase().replace(/\s+/g, " ").trim();
        const quantity = Number(item.quantity || 0);
        const price = Number(item.price || 0);
        const revenue = Math.round(price * quantity * discountFactor * 100) / 100;
        const rawType = String(item.menu_type || "FOOD").toUpperCase();
        const type = rawType === "LIQUOR" || rawType === "BAR" ? "liquor" : "food";

        if (itemMap.has(key)) {
          const existing = itemMap.get(key)!;
          existing.quantity += quantity;
          existing.revenue += revenue;
          existing.orderCount += 1;
        } else {
          itemMap.set(key, { name, quantity, revenue, type, orderCount: 1 });
        }
      }
    }

    // Process walk-in transactions
    for (const txn of walkinRows) {
      const items = Array.isArray(txn.items) ? txn.items : [];
      const discountPercent = Number(txn.discountPercent || 0);
      const discountFactor = discountPercent > 0 ? (1 - discountPercent / 100) : 1;

      for (const item of items) {
        const name = (item.name || item.n || "Unknown").trim();
        const key = name.toLowerCase().replace(/\s+/g, " ").trim();
        const quantity = Number(item.quantity || item.q || 0);
        const price = Number(item.price || item.p || 0);
        const revenue = Math.round(price * quantity * discountFactor * 100) / 100;
        const rawType = String(item.menuType || "FOOD").toUpperCase();
        const type = rawType === "LIQUOR" || rawType === "BAR" ? "liquor" : "food";

        if (itemMap.has(key)) {
          const existing = itemMap.get(key)!;
          existing.quantity += quantity;
          existing.revenue += revenue;
          existing.orderCount += 1;
        } else {
          itemMap.set(key, { name, quantity, revenue, type, orderCount: 1 });
        }
      }
    }

    const itemsData = Array.from(itemMap.entries())
      .map(([_, data]) => ({
        name: data.name,
        quantity: data.quantity,
        revenue: Math.round(data.revenue * 100) / 100,
        type: data.type,
        orderCount: data.orderCount,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    const totalQuantity = itemsData.reduce((sum, item) => sum + item.quantity, 0);
    const totalRevenue = itemsData.reduce((sum, item) => sum + item.revenue, 0);

    return jsonResponse({
      items: itemsData,
      summary: {
        totalItems: itemsData.length,
        totalQuantity,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
      },
      dateRange: { startDate, endDate },
    }, 200, { "Cache-Control": "no-store" });
  }

  // ── GET /api/edge/analytics/captain-performance — captain performance from local SQLite ──
  // Used by edge-local (PIN) auth to populate CaptainPerformanceDashboard.
  // Mirrors cloud /api/reports/captain-performance response format.
  if (url.pathname === "/api/edge/analytics/captain-performance" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);

    const startDate = url.searchParams.get("startDate") || new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate = url.searchParams.get("endDate") || startDate;

    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const [sy, sm, sd] = startDate.split("-").map(Number);
    const [ey, em, ed] = endDate.split("-").map(Number);
    const startTs = Date.UTC(sy, sm - 1, sd, 0, 0, 0, 0) - IST_OFFSET_MS;
    const endTs = Date.UTC(ey, em - 1, ed, 23, 59, 59, 999) - IST_OFFSET_MS;

    const db = getDb();

    // Get all captains from users table
    const captains = db.query("SELECT id, name FROM users WHERE outlet_id = ? AND role = 'CAPTAIN' AND is_active = 1").all(restaurantId) as any[];
    const byCaptain = new Map<string, { id: string; name: string; totalSales: number; orderCount: number; itemCount: number; items: any[] }>();
    for (const c of captains) {
      byCaptain.set(c.id, { id: c.id, name: c.name, totalSales: 0, orderCount: 0, itemCount: 0, items: [] });
    }

    // Get settled orders with captain_id in date range
    const orders = db.query(
      "SELECT id, captain_id, paid_at FROM order_record WHERE restaurant_id = ? AND status = 'SETTLED' AND paid_at >= ? AND paid_at <= ? AND captain_id IS NOT NULL"
    ).all(restaurantId, startTs, endTs) as any[];

    for (const order of orders) {
      const cid = order.captain_id;
      if (!byCaptain.has(cid)) {
        byCaptain.set(cid, { id: cid, name: cid, totalSales: 0, orderCount: 0, itemCount: 0, items: [] });
      }
      const entry = byCaptain.get(cid)!;
      entry.orderCount += 1;

      // Get payment details from settle record
      const settleRow = db.query("SELECT value FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = ?").get(order.id) as any;
      if (settleRow?.value) {
        try {
          const pd = JSON.parse(settleRow.value);
          entry.totalSales += Number(pd.grandTotal || 0);
        } catch {}
      }

      // Get items for highest-selling item calculation
      const items = db.query("SELECT name, quantity FROM order_item WHERE order_id = ? AND removed_from_bill = 0").all(order.id) as any[];
      entry.itemCount += items.length;
      for (const item of items) {
        entry.items.push({ name: item.name, quantity: item.quantity });
      }
    }

    // Compute highest selling item per captain
    const result = Array.from(byCaptain.values()).map(c => {
      const itemMap = new Map<string, number>();
      for (const item of c.items) {
        itemMap.set(item.name, (itemMap.get(item.name) || 0) + Number(item.quantity || 0));
      }
      let highestItem = null;
      let maxQty = 0;
      for (const [name, qty] of itemMap.entries()) {
        if (qty > maxQty) { maxQty = qty; highestItem = { name, quantity: qty }; }
      }
      return {
        id: c.id,
        name: c.name,
        sales: Math.round(c.totalSales * 100) / 100,
        orders: c.orderCount,
        items: c.itemCount,
        highestSellingItem: highestItem,
        trends: [],
      };
    }).sort((a, b) => b.sales - a.sales);

    return jsonResponse({ startDate, endDate, captains: result }, 200, { "Cache-Control": "no-store" });
  }

  // ── Helper: round to 2 decimal places ──────────────────────────────────────
  function round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  // ── Helper: get printer config + resolve bill printer name ──────────────────
  function getBillPrinterName(): string | null {
    try {
      const outlet = getOutletSettings();
      const pc = outlet?.printerConfig || {};
      return resolvePrinterName(null, "BILL_PRINTER", null, pc) || null;
    } catch { return null; }
  }

  // ── GET /api/edge/x-report?date=YYYY-MM-DD ──────────────────────────────────
  // X Report data from local SQLite — aggregates settled orders + expenditures.
  if (url.pathname === "/api/edge/x-report" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const date = url.searchParams.get("date") || getKolkataDateString();

    const db = getDb();
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const [dy, dm, dd] = date.split("-").map(Number);
    const startTs = Date.UTC(dy, dm - 1, dd, 0, 0, 0, 0) - IST_OFFSET_MS;
    const endTs = Date.UTC(dy, dm - 1, dd, 23, 59, 59, 999) - IST_OFFSET_MS;

    // Settled orders for the date
    const orders = db.query(
      "SELECT id FROM order_record WHERE restaurant_id = ? AND status = 'SETTLED' AND paid_at >= ? AND paid_at <= ?"
    ).all(restaurantId, startTs, endTs) as any[];

    let totalSales = 0, cashAmount = 0, cardAmount = 0, upiAmount = 0, otherAmount = 0, tipsAmount = 0;

    for (const order of orders) {
      const settleRow = db.query("SELECT value FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = ?").get(order.id) as any;
      if (!settleRow?.value) continue;
      try {
        const pd = JSON.parse(settleRow.value);
        const grand = Number(pd.grandTotal || 0);
        totalSales += grand;
        tipsAmount += Number(pd.tipAmount || 0);
        const method = (pd.paymentMethod || "CASH").toUpperCase();
        if (method === "CASH") cashAmount += Number(pd.cashAmount || grand);
        else if (method === "CARD") cardAmount += Number(pd.cardAmount || grand);
        else if (method === "UPI") upiAmount += Number(pd.cashAmount || grand);
        else if (method === "MIXED") {
          cashAmount += Number(pd.cashAmount || 0);
          cardAmount += Number(pd.cardAmount || 0);
          otherAmount += Math.max(0, grand - Number(pd.cashAmount || 0) - Number(pd.cardAmount || 0));
        } else otherAmount += grand;
      } catch {}
    }

    // Expenditures for the date
    const expenditures = db.query(
      "SELECT * FROM expenditure WHERE restaurant_id = ? AND date = ? AND voided = 0 ORDER BY created_at DESC"
    ).all(restaurantId, date) as any[];
    const expenditureAmount = expenditures.reduce((sum, e) => sum + Number(e.amount || 0), 0);

    return jsonResponse({
      reportDate: date,
      totalSales: round2(totalSales),
      cashAmount: round2(cashAmount),
      cardAmount: round2(cardAmount),
      upiAmount: round2(upiAmount),
      otherAmount: round2(otherAmount),
      tipsAmount: round2(tipsAmount),
      expenditureAmount: round2(expenditureAmount),
      expenditures: expenditures.map(e => ({
        id: e.id, amount: Number(e.amount), paidToType: e.paid_to_type,
        paidToName: e.paid_to_name, category: e.category, narration: e.narration,
        approver: e.approver, expenditureNo: e.expenditure_no,
      })),
    }, 200, { "Cache-Control": "no-store" });
  }

  // ── POST /api/edge/x-report/print ───────────────────────────────────────────
  // Build ESC/POS and create print job for X Report — instant printing via durable queue.
  if (url.pathname === "/api/edge/x-report/print" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    let body: any; try { body = JSON.parse(await req.text()); } catch { return errorResponse("Invalid JSON", 400); }

    const outlet = getOutletSettings();
    const printerName = getBillPrinterName();
    const escposData = buildXReport({
      restaurantName: outlet?.name || "",
      reportDate: body.reportDate || getKolkataDateString(),
      cashierName: body.cashierName || "",
      totalSales: Number(body.totalSales) || 0,
      cardAmount: Number(body.cardAmount) || 0,
      cashAmount: Number(body.cashAmount) || 0,
      upiAmount: Number(body.upiAmount) || 0,
      otherAmount: Number(body.otherAmount) || 0,
      tipsAmount: Number(body.tipsAmount) || 0,
      expenditureAmount: Number(body.expenditureAmount) || 0,
      finalAmount: round2((Number(body.totalSales) || 0) - (Number(body.cardAmount) || 0) - (Number(body.expenditureAmount) || 0)),
      expenditures: body.expenditures || [],
      denominations: body.denominations || [],
      cashFromNotes: Number(body.cashFromNotes) || 0,
    });

    const eventId = `xreport-${restaurantId}-${body.reportDate || "today"}-${Date.now()}`;
    createPrintJob({
      eventId, restaurantId,
      orderId: `xreport-${body.reportDate || "today"}`,
      printerName, jobType: "X_REPORT", escposData,
    });

    // Await print dispatch to return actual print status
    const { awaitDispatchBounded } = await import("./orderService.ts");
    const printResult = await awaitDispatchBounded(eventId, { printerName, escposData, type: "X_REPORT" });
    const printed = printResult?.ok === true;
    const pending = printResult?.ok === null || printResult?.pending === true;
    return jsonResponse({ success: true, eventId, printed, pending, printError: printResult?.error || null });
  }

  // ── GET /api/edge/expenditures?date=YYYY-MM-DD ──────────────────────────────
  if (url.pathname === "/api/edge/expenditures" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const date = url.searchParams.get("date") || getKolkataDateString();
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);

    const db = getDb();
    const rows = db.query(
      "SELECT * FROM expenditure WHERE restaurant_id = ? AND date = ? ORDER BY created_at DESC LIMIT ?"
    ).all(restaurantId, date, limit) as any[];

    return jsonResponse(rows.map(e => ({
      id: e.id, amount: Number(e.amount), paidToType: e.paid_to_type,
      paidToName: e.paid_to_name, category: e.category, narration: e.narration,
      approver: e.approver, createdBy: e.created_by,
      expenditureNo: e.expenditure_no, date: e.date,
      voided: !!e.voided, createdAt: e.created_at,
    })), 200, { "Cache-Control": "no-store" });
  }

  // ── POST /api/edge/expenditures ─────────────────────────────────────────────
  // Create expenditure + enqueue sync + instant print via durable queue.
  if (url.pathname === "/api/edge/expenditures" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    let body: any; try { body = JSON.parse(await req.text()); } catch { return errorResponse("Invalid JSON", 400); }

    const db = getDb();
    const id = `edge-exp-${restaurantId}-${Date.now()}`;
    const date = body.date || getKolkataDateString();
    const now = Date.now();

    // Get next expenditure number for this restaurant+date
    const counter = db.query(
      "SELECT COALESCE(MAX(expenditure_no), 0) + 1 as next_no FROM expenditure WHERE restaurant_id = ? AND date = ?"
    ).get(restaurantId, date) as any;

    db.query(
      "INSERT INTO expenditure (id, restaurant_id, amount, paid_to_type, paid_to_name, category, narration, approver, created_by, expenditure_no, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, restaurantId, Number(body.amount), body.paidToType, body.paidToName,
          body.category, body.narration, body.approver, body.createdBy,
          counter.next_no, date, now);

    enqueueSync("expenditure", id, "insert");

    // Instant print
    const outlet = getOutletSettings();
    const printerName = getBillPrinterName();
    const escposData = buildExpenditure({
      expenditureNo: counter.next_no,
      expenditureDate: date,
      paidToType: body.paidToType || "",
      paidToName: body.paidToName || "",
      amount: Number(body.amount) || 0,
      narration: body.narration || null,
      approvedByName: body.approver || null,
      createdByName: body.createdBy || null,
      status: "ACTIVE",
      restaurant: { name: outlet?.name || "" },
    });

    const eventId = `exp-${id}-${now}`;
    createPrintJob({
      eventId, restaurantId,
      orderId: `expenditure-${id}`,
      printerName, jobType: "EXPENDITURE", escposData,
    });

    // Await print dispatch to return actual print status
    const { awaitDispatchBounded } = await import("./orderService.ts");
    const printResult = await awaitDispatchBounded(eventId, { printerName, escposData, type: "EXPENDITURE" });
    const printed = printResult?.ok === true;
    const pending = printResult?.ok === null || printResult?.pending === true;
    return jsonResponse({ success: true, id, expenditureNo: counter.next_no, eventId, printed, pending, printError: printResult?.error || null });
  }

  // ── GET /api/edge/expenditures/today-summary?date=YYYY-MM-DD ────────────────
  if (url.pathname === "/api/edge/expenditures/today-summary" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const date = url.searchParams.get("date") || getKolkataDateString();

    const db = getDb();
    const rows = db.query(
      "SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as totalAmount FROM expenditure WHERE restaurant_id = ? AND date = ? AND voided = 0"
    ).all(restaurantId, date) as any[];

    return jsonResponse(rows[0] || { count: 0, totalAmount: 0 }, 200, { "Cache-Control": "no-store" });
  }

  // ── GET /api/edge/expenditures/paid-to-options ──────────────────────────────
  if (url.pathname === "/api/edge/expenditures/paid-to-options" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);

    const db = getDb();
    const staff = db.query(
      "SELECT id, name, role FROM users WHERE outlet_id = ? AND is_active = 1 ORDER BY name"
    ).all(restaurantId) as any[];

    return jsonResponse({ staff }, 200, { "Cache-Control": "no-store" });
  }

  // ── POST /api/edge/expenditures/print ───────────────────────────────────────
  // Reprint an expenditure receipt.
  if (url.pathname === "/api/edge/expenditures/print" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    let body: any; try { body = JSON.parse(await req.text()); } catch { return errorResponse("Invalid JSON", 400); }

    const db = getDb();
    const row = db.query("SELECT * FROM expenditure WHERE id = ?").get(body.expenditureId) as any;
    if (!row) return errorResponse("Expenditure not found", 404);

    const outlet = getOutletSettings();
    const printerName = getBillPrinterName();
    const escposData = buildExpenditure({
      expenditureNo: row.expenditure_no,
      expenditureDate: row.date,
      paidToType: row.paid_to_type || "",
      paidToName: row.paid_to_name || "",
      amount: Number(row.amount),
      narration: row.narration || null,
      approvedByName: row.approver || null,
      createdByName: row.created_by || null,
      status: row.voided ? "VOIDED" : "ACTIVE",
      restaurant: { name: outlet?.name || "" },
    });

    const eventId = `exp-reprint-${body.expenditureId}-${Date.now()}`;
    createPrintJob({
      eventId, restaurantId,
      orderId: `expenditure-${body.expenditureId}`,
      printerName, jobType: "EXPENDITURE", escposData,
    });

    // Await print dispatch to return actual print status
    const { awaitDispatchBounded } = await import("./orderService.ts");
    const printResult = await awaitDispatchBounded(eventId, { printerName, escposData, type: "EXPENDITURE" });
    const printed = printResult?.ok === true;
    const pending = printResult?.ok === null || printResult?.pending === true;
    return jsonResponse({ success: true, eventId, printed, pending, printError: printResult?.error || null });
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

    // Phase 0 data-loss hotfix: a client-supplied Free state must not destroy live
    // KOTs. Only allow the Free transition when the table is server-authoritatively
    // terminal (no active orders). If active orders exist, the caller must use the
    // explicit DELETE /api/edge/table/:id/session route (which cancels orders
    // transactionally) or settle the order first. This prevents stale client UI
    // state from wiping kot_history and KOT rows.
    if (isFree) {
      const activeOrders = db.query(
        `SELECT id FROM order_record WHERE table_id = ? AND restaurant_id = ? AND status NOT IN ('SETTLED', 'CANCELLED') AND is_deleted = 0`
      ).all(tableId, restaurantId) as any[];
      if (activeOrders.length > 0) {
        return errorResponse(
          `Cannot free table with ${activeOrders.length} active order(s); use DELETE /api/edge/table/:id/session or settle first`,
          409,
        );
      }
    }

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
    let newTableRev = existing.revision ?? 1;
    const applySessionUpdate = db.transaction(() => {
      newTableRev = ((db.query('SELECT revision FROM "table" WHERE id = ?').get(tableId) as { revision?: number } | null)?.revision ?? 0) + 1;
      db.query(`UPDATE "table" SET
        status = ?,
        workflow_status = ?,
        captain_id = ?,
        guests = ?,
        session_started_at = ?,
        current_bill = ?,
        kot_history = ?,
        revision = ?,
        last_command_id = ?,
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
        newTableRev,
        body.requestId ?? null,
        now,
        tableId,
        restaurantId,
      );

      // Terminating a session clears live KOTs (same as cloud). Safe because the
      // Phase 0 guard above already rejected Free when active orders exist.
      if (isFree) {
        db.query("DELETE FROM kot WHERE table_id = ?").run(tableId);
      }
    });
    applySessionUpdate();

    enqueueSync("table", tableId, "update");
    return jsonResponse({ success: true, id: tableId, revision: newTableRev });
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
      // 1. Cancel all active orders + increment order revisions
      for (const order of activeOrders) {
        const orderRev = ((db.query("SELECT revision FROM order_record WHERE id = ?").get(order.id) as { revision?: number } | null)?.revision ?? 0) + 1;
        db.query("UPDATE order_record SET status = 'CANCELLED', updated_at = ?, revision = ? WHERE id = ?")
          .run(now, orderRev, order.id);
        // Delete order items
        db.query("DELETE FROM order_item WHERE order_id = ?").run(order.id);
        // Enqueue sync for the cancelled order
        enqueueSync("order", order.id, "update");
      }

      // 2. Reset table to Free + increment table revision
      const tableRev = ((db.query('SELECT revision FROM "table" WHERE id = ?').get(tableId) as { revision?: number } | null)?.revision ?? 0) + 1;
      db.query(`UPDATE "table" SET
        status = 'AVAILABLE',
        workflow_status = 'Free',
        captain_id = NULL,
        guests = 0,
        session_started_at = NULL,
        current_bill = 0,
        kot_history = '[]',
        discount = NULL,
        revision = ?,
        last_command_id = ?,
        updated_at = ?
        WHERE id = ? AND restaurant_id = ?
      `).run(tableRev, null, now, tableId, restaurantId);

      // 3. Clear KOTs for this table
      db.query("DELETE FROM kot WHERE table_id = ?").run(tableId);

      // 4. Enqueue table sync
      enqueueSync("table", tableId, "update");

      return { tableRev };
    });

    let tableRev = existing.revision ?? 1;
    try {
      const txResult = tx();
      tableRev = (txResult as any)?.tableRev ?? tableRev;
    } catch (err: any) {
      return errorResponse(`Terminate failed: ${err.message}`, 500);
    }

    return jsonResponse({ success: true, id: tableId, revision: tableRev, cancelledOrders: activeOrders.length });
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

  // ── GET /api/edge/menu/debug — diagnostic: raw SQLite menu state ───────────
  if (url.pathname === "/api/edge/menu/debug" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const db = getDb();
    const rid = getRestaurantId();
    const totalItems = (db.query("SELECT COUNT(*) as c FROM menu_item WHERE restaurant_id = ?").get(rid) as any)?.c || 0;
    const availableItems = (db.query("SELECT COUNT(*) as c FROM menu_item WHERE restaurant_id = ? AND is_available = 1 AND is_deleted = 0").get(rid) as any)?.c || 0;
    const deletedItems = (db.query("SELECT COUNT(*) as c FROM menu_item WHERE restaurant_id = ? AND is_deleted = 1").get(rid) as any)?.c || 0;
    const unavailableItems = (db.query("SELECT COUNT(*) as c FROM menu_item WHERE restaurant_id = ? AND is_available = 0 AND is_deleted = 0").get(rid) as any)?.c || 0;
    const totalCategories = (db.query("SELECT COUNT(*) as c FROM category WHERE restaurant_id = ?").get(rid) as any)?.c || 0;
    const activeCategories = (db.query("SELECT COUNT(*) as c FROM category WHERE restaurant_id = ? AND is_active = 1").get(rid) as any)?.c || 0;
    const itemsWithoutCategory = (db.query("SELECT COUNT(*) as c FROM menu_item m LEFT JOIN category c ON m.category_id = c.id WHERE m.restaurant_id = ? AND c.id IS NULL AND m.is_deleted = 0").get(rid) as any)?.c || 0;
    const sampleItems = db.query("SELECT id, name, is_available, is_deleted, category_id FROM menu_item WHERE restaurant_id = ? LIMIT 5").all(rid);
    const sampleCategories = db.query("SELECT id, name, is_active FROM category WHERE restaurant_id = ? LIMIT 5").all(rid);
    return jsonResponse({
      restaurantId: rid,
      menuItems: { total: totalItems, available: availableItems, deleted: deletedItems, unavailable: unavailableItems, withoutCategory: itemsWithoutCategory },
      categories: { total: totalCategories, active: activeCategories },
      sampleItems,
      sampleCategories,
    });
  }

  // ── GET /api/edge/config/version — config version metadata for cache validation
  if (url.pathname === "/api/edge/config/version" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const lastFullSync = getSyncState("last_full_config_sync") || null;
    const lastIncrementalSync = getSyncState("last_incremental_sync") || null;
    const db = getDb();
    const rid = getRestaurantId();
    const categoryCount = (db.query("SELECT COUNT(*) as c FROM category WHERE restaurant_id = ? AND is_active = 1").get(rid) as any)?.c || 0;
    const menuItemCount = (db.query("SELECT COUNT(*) as c FROM menu_item WHERE is_deleted = 0 AND restaurant_id = ?").get(rid) as any)?.c || 0;
    const tableCount = (db.query("SELECT COUNT(*) as c FROM \"table\" WHERE restaurant_id = ?").get(rid) as any)?.c || 0;
    const venueCount = (db.query("SELECT COUNT(*) as c FROM venue WHERE restaurant_id = ? AND is_deleted = 0").get(rid) as any)?.c || 0;
    return jsonResponse({
      lastFullConfigSync: lastFullSync,
      lastIncrementalSync: lastIncrementalSync,
      restaurantId: rid,
      stats: {
        categories: categoryCount,
        menuItems: menuItemCount,
        tables: tableCount,
        venues: venueCount,
      },
    });
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
      runtimeToken: getOrCreateRuntimeToken(),
      edgeApiKey: getEdgeApiKey(),
    });
  }

  // ── GET /api/edge/runtime-token — exchange edge API key for runtime token ──
  // Allows captains that logged in via cloud (and thus never obtained a runtime
  // token from PIN login) to fetch one using their edge API key. The edge API
  // key check (PUBLIC_LAN_PATHS gate above) already enforced authentication;
  // this endpoint is in PUBLIC_PATHS so the runtime token check is skipped.
  if (url.pathname === "/api/edge/runtime-token" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    return jsonResponse({
      success: true,
      runtimeToken: getOrCreateRuntimeToken(),
    });
  }

  // ── GET /api/edge/sync/status — sync worker status ────────────────────────
  if (url.pathname === "/api/edge/sync/status" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    return jsonResponse(getSyncStatus());
  }

  // ── GET /api/edge/sync/audit — permanent rejection/conflict audit log ──────
  if (url.pathname === "/api/edge/sync/audit" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);
    return jsonResponse({ records: getSyncAuditRecords(limit) });
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

  // ── POST /api/edge/sync/backfill — re-enqueue missing transaction syncs ────
  // Scans all settled orders and re-enqueues transaction sync records that are
  // missing from sync_queue (dequeued as rejected/conflict, dead-lettered, or
  // never enqueued). Also handles walk-in transactions.
  //
  // Query params:
  //   ?dry-run=1 — return what would be re-enqueued without making changes
  if (url.pathname === "/api/edge/sync/backfill" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const dryRun = url.searchParams.get("dry-run") === "1";
    const db = getDb();

    const settledOrders = db.query(
      `SELECT id, restaurant_id, paid_at, bill_number
       FROM order_record
       WHERE status = 'SETTLED'
       AND NOT EXISTS (SELECT 1 FROM edge_config WHERE key = 'txn_deleted:' || order_record.id)
       ORDER BY paid_at DESC`
    ).all() as any[];

    let enqueued = 0;
    let skippedQueued = 0;
    let skippedSynced = 0;
    let skippedNoSettle = 0;
    const details: any[] = [];

    for (const order of settledOrders) {
      const settleRow = db.query(
        `SELECT value FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = ?`
      ).get(order.id) as { value: string } | null;

      if (!settleRow) {
        skippedNoSettle++;
        continue;
      }

      let settleData: any;
      try { settleData = JSON.parse(settleRow.value); } catch { skippedNoSettle++; continue; }
      const localTxnId = settleData.localTxnId;
      if (!localTxnId) { skippedNoSettle++; continue; }

      const pendingRow = db.query(
        `SELECT id, synced, attempts FROM sync_queue WHERE table_name = 'transaction' AND record_id = ? ORDER BY id DESC LIMIT 1`
      ).get(localTxnId) as any;

      if (pendingRow) {
        if (pendingRow.synced === 1) {
          const auditRow = db.query(
            `SELECT outcome FROM sync_audit WHERE queue_id = ? AND table_name = 'transaction' ORDER BY audited_at DESC LIMIT 1`
          ).get(pendingRow.id) as any;

          if (auditRow && ["rejected", "conflict", "duplicate"].includes(auditRow.outcome)) {
            if (!dryRun) {
              enqueueSync("transaction", localTxnId, "insert");
            }
            enqueued++;
            details.push({ orderId: order.id, localTxnId, grandTotal: settleData.grandTotal, reason: `was ${auditRow.outcome}` });
          } else {
            skippedSynced++;
          }
        } else {
          skippedQueued++;
        }
      } else {
        if (!dryRun) {
          enqueueSync("transaction", localTxnId, "insert");
        }
        enqueued++;
        details.push({ orderId: order.id, localTxnId, grandTotal: settleData.grandTotal, reason: "missing from queue" });
      }
    }

    // Walk-in transactions
    const walkinRows = db.query(`SELECT key, value FROM edge_config WHERE key LIKE 'walkin_txn:%'`).all() as any[];
    let walkinEnqueued = 0;

    for (const row of walkinRows) {
      const localId = row.key.replace("walkin_txn:", "");
      const pendingRow = db.query(
        `SELECT id, synced FROM sync_queue WHERE table_name = 'walkin_transaction' AND record_id = ? ORDER BY id DESC LIMIT 1`
      ).get(localId) as any;

      if (pendingRow) {
        if (pendingRow.synced === 0) skippedQueued++;
        else skippedSynced++;
        continue;
      }

      if (!dryRun) {
        enqueueSync("walkin_transaction", localId, "insert");
      }
      walkinEnqueued++;
      details.push({ localTxnId: localId, reason: "walk-in missing from queue" });
    }

    return jsonResponse({
      success: true,
      dryRun,
      summary: {
        settledOrdersScanned: settledOrders.length,
        transactionsReEnqueued: enqueued,
        walkinReEnqueued: walkinEnqueued,
        skippedAlreadyQueued: skippedQueued,
        skippedAlreadySynced: skippedSynced,
        skippedNoSettleRecord: skippedNoSettle,
      },
      details: details.slice(0, 50),
    });
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

  // ── GET /api/edge/drivers — list all drivers and their health (Phase 6) ────
  if (url.pathname === "/api/edge/drivers" && req.method === "GET") {
    return jsonResponse({
      drivers: deviceManager.getDeviceHealths(),
      plugins: getLoadedPlugins(),
      initialized: deviceManager.isInitialized(),
    });
  }

  // ── POST /api/edge/drivers/reload — hot-reload plugins (Phase 6) ──────────
  if (url.pathname === "/api/edge/drivers/reload" && req.method === "POST") {
    try {
      const result = await reloadPlugins();
      return jsonResponse({
        ok: true,
        loaded: result.loaded,
        errors: result.errors,
        removed: result.removed,
        drivers: deviceManager.getDeviceHealths(),
      });
    } catch (err: any) {
      return errorResponse(`Plugin reload failed: ${err?.message || err}`, 500);
    }
  }

  // ── GET /api/edge/update-check — Runtime update status (Phase 5) ───────────
  // The Runtime Host polls this endpoint hourly to check if a new Runtime
  // binary is available. The Runtime checks the cloud's update manifest and
  // returns the download URL if an update exists. The Host handles the
  // download, binary swap, and restart.
  if (url.pathname === "/api/edge/update-check" && req.method === "GET") {
    const currentVersion = "23.7.8";
    const backendUrl = getBackendUrl();
    const sessionToken = getSessionToken();

    if (!backendUrl || !sessionToken) {
      return jsonResponse({
        version: currentVersion,
        updateAvailable: false,
      });
    }

    try {
      const resp = await cloudFetch(
        `${backendUrl}/api/edge/runtime-update-check?currentVersion=${encodeURIComponent(currentVersion)}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`,
          },
        },
      );
      const data = await resp.json();
      return jsonResponse({
        version: currentVersion,
        updateAvailable: !!data.updateAvailable,
        downloadUrl: data.downloadUrl || null,
        latestVersion: data.version || null,
      });
    } catch (err) {
      return jsonResponse({
        version: currentVersion,
        updateAvailable: false,
        error: "Failed to check for updates",
      });
    }
  }

  // ── GET /api/edge/order/:id/sync-status — per-order cloud sync status ──────
  // Returns whether the order's sync_queue entries have been pushed to cloud.
  // The captain uses this to decide when it's safe to remove the action from
  // its local pending queue — keeping it until cloud sync is confirmed.
  if (url.pathname.startsWith("/api/edge/order/") && url.pathname.endsWith("/sync-status") && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const parts = url.pathname.split("/");
    const orderId = parts[parts.length - 2];
    if (!orderId) return errorResponse("Missing order ID", 400);
    return jsonResponse(getOrderSyncStatus(orderId));
  }

  // ── GET /api/edge/lan/status — LAN WebSocket client count (Bug 2) ─────────
  if (url.pathname === "/api/edge/lan/status" && req.method === "GET") {
    return jsonResponse({ connectedClients: getLanClientCount() });
  }

  // ── GET /api/edge/print-jobs — print job queue status (diagnostics) ────────
  if (url.pathname === "/api/edge/print-jobs" && req.method === "GET") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const db = getDb();
    const status = url.searchParams.get("status");
    const orderId = url.searchParams.get("orderId");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);

    let rows: any[];
    if (orderId) {
      rows = db.query("SELECT id, event_id, order_id, kot_number, printer_name, job_type, status, attempts, last_error, created_at, printed_at, acked_via FROM print_job WHERE order_id = ? ORDER BY id DESC LIMIT ?")
        .all(orderId, limit) as any[];
    } else if (status) {
      rows = db.query("SELECT id, event_id, order_id, kot_number, printer_name, job_type, status, attempts, last_error, created_at, printed_at, acked_via FROM print_job WHERE status = ? ORDER BY id DESC LIMIT ?")
        .all(status, limit) as any[];
    } else {
      rows = db.query("SELECT id, event_id, order_id, kot_number, printer_name, job_type, status, attempts, last_error, created_at, printed_at, acked_via FROM print_job ORDER BY id DESC LIMIT ?")
        .all(limit) as any[];
    }

    const summary = {
      queued: (db.query("SELECT COUNT(*) as c FROM print_job WHERE status = 'queued'").get() as any)?.c || 0,
      retrying: (db.query("SELECT COUNT(*) as c FROM print_job WHERE status = 'retrying'").get() as any)?.c || 0,
      printed: (db.query("SELECT COUNT(*) as c FROM print_job WHERE status = 'printed'").get() as any)?.c || 0,
      failed: (db.query("SELECT COUNT(*) as c FROM print_job WHERE status = 'failed'").get() as any)?.c || 0,
      dead_letter: (db.query("SELECT COUNT(*) as c FROM print_job WHERE status = 'dead_letter'").get() as any)?.c || 0,
      cancelled: (db.query("SELECT COUNT(*) as c FROM print_job WHERE status = 'cancelled'").get() as any)?.c || 0,
    };

    // Diagnostic fields: print service status + printer resolution (RC-5/RC-6 diagnostics)
    const restaurantId = getRestaurantId();
    let printerConfig: Record<string, any> = {};
    let resolvedPrinters: Record<string, string | undefined> = {};
    if (restaurantId) {
      const outletRow = db.query("SELECT printer_config FROM outlet WHERE id = ?").get(restaurantId) as { printer_config: string } | undefined;
      if (outletRow?.printer_config) {
        try { printerConfig = JSON.parse(outletRow.printer_config); } catch { /* ignore */ }
        resolvedPrinters = {
          kitchen: resolvePrinterName(null, "KOT_PRINTER", null, printerConfig),
          bar: resolvePrinterName(null, "BAR_PRINTER", null, printerConfig),
          bill: resolvePrinterName(null, "BILL_PRINTER", null, printerConfig),
        };
      }
    }

    // Diagnostic: venue kot_enabled settings
    let venueDiagnostics: any[] = [];
    if (restaurantId) {
      const venues = db.query(`
        SELECT v.id, v.name, v.kot_enabled, v.kot_printer_name, v.bill_printer_name,
               (SELECT COUNT(*) FROM section s WHERE s.venue_id = v.id AND s.restaurant_id = ?) as section_count
        FROM venue v WHERE v.restaurant_id = ?
      `).all(restaurantId, restaurantId) as any[];
      venueDiagnostics = venues.map(v => ({
        id: v.id,
        name: v.name,
        kot_enabled: v.kot_enabled,
        kotEnabledInterpreted: v.kot_enabled !== 0 ? "ENABLED" : "DISABLED",
        kotPrinterName: v.kot_printer_name,
        billPrinterName: v.bill_printer_name,
        sectionCount: v.section_count,
      }));
    }

    return jsonResponse({
      jobs: rows,
      summary,
      printServiceReady: isPrintServiceReady(),
      printServiceStatus: getPrintServiceStatus(),
      printServiceExe: getPrintServiceExeDiagnostics(),
      resolvedPrinters,
      printerConfig,
      venueDiagnostics,
    }, 200, { "Cache-Control": "no-store" });
  }

  // ── POST /api/edge/print-jobs/retry — manually trigger pending print dispatch ──
  if (url.pathname === "/api/edge/print-jobs/retry" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const result = await dispatchPendingPrintJobs();
    return jsonResponse({ success: true, ...result });
  }

  // ── POST /api/output/intent — generic output intent endpoint (R2) ──────────
  if (url.pathname === "/api/output/intent" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const body = await req.json().catch(() => ({}));
    if (!body || body.type !== "OUTPUT" || !body.intent) {
      return errorResponse("Invalid output intent", 400);
    }
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const { processOutputIntent } = await import("./outputOrchestrator.ts");
    const result = await processOutputIntent(body, restaurantId);
    return jsonResponse(result);
  }

  // ── POST /api/edge/print-jobs/cancel — cancel a pending or retryable print job ──
  if (url.pathname === "/api/edge/print-jobs/cancel" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const body = await req.json().catch(() => ({}));
    const { eventId } = body;
    if (!eventId) return errorResponse("eventId is required", 400);
    const cancelled = cancelPrintJob(eventId);
    if (!cancelled) return errorResponse("Job not found or not in a cancellable state", 404);
    return jsonResponse({ success: true, eventId, status: "cancelled" });
  }

  // ── POST /api/edge/print-jobs/reprint — reprint a print job with a new event ID ──
  if (url.pathname === "/api/edge/print-jobs/reprint" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const body = await req.json().catch(() => ({}));
    const { eventId, newEventId } = body;
    if (!eventId) return errorResponse("eventId is required", 400);
    const result = reprintPrintJob(eventId, newEventId);
    if (!result) return errorResponse("Original print job not found", 404);
    // Dispatch the new reprint immediately (bounded-wait, 3s timeout)
    const { awaitDispatchBounded } = await import("./orderService.ts");
    const job = getPrintJobByEventId(result.eventId);
    if (job) {
      try {
        const escposData = JSON.parse(job.escpos_data);
        await awaitDispatchBounded(result.eventId, { printerName: job.printer_name, escposData, type: job.job_type }, undefined);
      } catch (e) {
        console.warn("[Reprint] Failed to dispatch reprint job:", e);
      }
    }
    return jsonResponse({ success: true, ...result });
  }

  // ── POST /api/edge/print-jobs/test — send a test print to a specific printer ──
  if (url.pathname === "/api/edge/print-jobs/test" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const body = await req.json().catch(() => ({}));
    const { printerName } = body;
    const restaurantId = getRestaurantId();
    if (!restaurantId) return errorResponse("No restaurant ID in session", 500);
    const eventId = `test-print-${Date.now()}`;
    const testEscpos = [
      { type: "text", format: "plain", data: "=== TEST PRINT ===" },
      { type: "text", format: "plain", data: `Printer: ${printerName || "(auto)"}` },
      { type: "text", format: "plain", data: `Time: ${new Date().toISOString()}` },
      { type: "text", format: "plain", data: "=================" },
      { type: "cut", format: "command", data: "partial" },
    ];
    const { createPrintJob } = await import("./db.ts");
    createPrintJob({
      eventId,
      restaurantId,
      orderId: "test-print",
      printerName: printerName || null,
      jobType: "TEST",
      escposData: testEscpos,
      itemSummary: [],
      captainName: "system",
    });
    const { dispatchSinglePrintJob } = await import("./orderService.ts");
    dispatchSinglePrintJob(eventId, { printerName: printerName || null, escposData: testEscpos, type: "TEST" });
    return jsonResponse({ success: true, eventId, message: "Test print dispatched" });
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

    const { restaurantName, restaurantType, owner, menuTemplate, tableCount, printerMapping, setupNonce } = body;
    if (!restaurantName || !owner?.name || !owner?.pin) {
      return errorResponse("restaurantName, owner.name, and owner.pin are required", 400);
    }

    // Validate one-time setup nonce to prevent unauthorized onboarding from LAN
    const expectedNonce = getSetupNonce();
    if (expectedNonce && setupNonce !== expectedNonce) {
      return errorResponse("Invalid or missing setup nonce — fetch from /health before onboarding", 403);
    }

    try {
      const db = getDb();
      const restaurantId = crypto.randomUUID();
      const slug = restaurantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const restaurantCode = slug.slice(0, 8).toUpperCase();

      // ── Atomic onboarding transaction ────────────────────────────────────────
      // All DB writes (outlet, venue, floor, section, tables, menu, user, session,
      // sync_state, nonce invalidation) are wrapped in a single transaction.
      // If any step fails, the entire onboarding is rolled back — no partial
      // restaurant setup, and the nonce remains valid for retry.
      const tx = db.transaction(() => {
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
        const userId = crypto.randomUUID();
        const pinHash = hashSync(String(owner.pin), 10);
        db.query(`INSERT INTO users (id, name, pin, role, outlet_id, is_active, synced_at)
                  VALUES (?, ?, ?, 'OWNER', ?, 1, unixepoch())`)
          .run(userId, owner.name, pinHash, restaurantId);
        enqueueSync('users', userId, 'create');

        // 6. Save printer config — normalize QuickOnboarding's { kitchen, bill, bar }
        //    into the { printers: [{ name, type }], availablePrinters: [...] } format
        //    that resolvePrinterName() expects.
        if (printerMapping) {
          const printers: { name: string; type: string }[] = [];
          const availablePrinters: string[] = [];
          const roleToType: Record<string, string> = { kitchen: 'KITCHEN', bill: 'BILL', bar: 'BAR' };
          for (const [role, name] of Object.entries(printerMapping)) {
            if (name && typeof name === 'string') {
              printers.push({ name, type: roleToType[role] || role.toUpperCase() });
              if (!availablePrinters.includes(name)) availablePrinters.push(name);
            }
          }
          setConfig('printer_config', JSON.stringify({ printers, availablePrinters }));
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

        // 9. Invalidate the setup nonce inside the transaction so it can't
        //    be reused. If the transaction rolls back, the nonce is restored.
        invalidateSetupNonce();

        return { userId, numTables, template };
      });

      const result = tx();

      console.log(`[Onboard] Created restaurant "${restaurantName}" (${restaurantId}) with ${result.numTables} tables, ${result.template.categories?.length || 0} categories, owner: ${owner.name}`);

      return jsonResponse({
        success: true,
        restaurantId,
        restaurantCode,
        ownerUserId: result.userId,
        tableCount: result.numTables,
        menuCategories: result.template.categories?.length || 0,
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
    // Increment revision for optimistic concurrency tracking
    updates.push("revision = (SELECT revision FROM \"table\" WHERE id = ?) + 1"); values.push(tableId);
    values.push(tableId);
    db.query(`UPDATE "table" SET ${updates.join(", ")} WHERE id = ? AND restaurant_id = ?`).run(...values, restaurantId);

    if (isAvailable) {
      db.query("DELETE FROM kot WHERE table_id = ?").run(tableId);
    }

    const updatedRow = db.query('SELECT revision FROM "table" WHERE id = ?').get(tableId) as { revision?: number } | null;
    enqueueSync("table", tableId, "update");

    return jsonResponse({ success: true, id: tableId, revision: updatedRow?.revision ?? 1 });
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
    db.query("UPDATE \"table\" SET status = 'REMOVED', workflow_status = 'Removed', revision = (SELECT revision FROM \"table\" WHERE id = ?) + 1 WHERE id = ? AND restaurant_id = ?")
      .run(tableId, tableId, restaurantId);
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
      db.query("UPDATE \"table\" SET status = 'REMOVED', workflow_status = 'Removed', revision = revision + 1, updated_at = ? WHERE id = ?")
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

  // ── POST /api/edge/admin/rotate-key — rotate the edge API key ───────────────
  if (url.pathname === "/api/edge/admin/rotate-key" && req.method === "POST") {
    if (!isLocalReady()) return errorResponse("Restaurant is not linked locally", 401);
    const body = await req.json().catch(() => ({}));
    const roleError = await verifyEdgeRole(body, ["OWNER"]);
    if (roleError) return roleError;

    const newKey = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    saveEdgeApiKey(newKey);
    console.log("[EdgeServer] Edge API key rotated by user", body?.userId);

    // ── Sync the new key to the cloud backend (H5) ───────────────────────────
    // Best-effort: if the cloud is unreachable, the local key is still valid.
    // The cloud backend uses this key to authenticate edge server polling.
    const backendUrl = getBackendUrl();
    const sessionToken = getSessionToken();
    const restaurantId = getRestaurantId();
    if (backendUrl && sessionToken && restaurantId) {
      (async () => {
        try {
          const res = await fetch(`${backendUrl}/api/edge/update-key`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${sessionToken}`,
            },
            body: JSON.stringify({ restaurantId, edgeApiKey: newKey }),
          });
          if (!res.ok) {
            console.warn(`[EdgeServer] Cloud key sync failed: HTTP ${res.status}`);
          } else {
            console.log("[EdgeServer] Edge API key synced to cloud backend");
          }
        } catch (syncErr: any) {
          console.warn(`[EdgeServer] Cloud key sync error: ${syncErr.message}`);
        }
      })();
    }

    return jsonResponse({ success: true, key: newKey });
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

const server = Bun.serve<{ eventBus?: boolean }>({
  port: PORT,
  hostname: "0.0.0.0", // Listen on all interfaces for LAN access
  websocket: {
    open(ws) {
      if (ws.data?.eventBus) {
        registerEventClient(ws);
      } else {
        registerClient(ws);
      }
    },
    message(ws, message) {
      if (ws.data?.eventBus) {
        handleEventMessage(ws as any, message.toString());
        return;
      }
      try {
        const data = JSON.parse(message.toString());
        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        } else if (data.type === "register") {
          setClientRegistered(ws);
        }
      } catch {
        // Ignore non-JSON messages
      }
    },
    close(ws) {
      if (ws.data?.eventBus) {
        unregisterEventClient(ws as any);
      } else {
        unregisterClient(ws);
      }
    },
    drain(ws) {
      // Backpressure relief — nothing to do for small event payloads
    },
  },
  async fetch(req, server) {
    const url = new URL(req.url);

    // ── WebSocket upgrade for LAN real-time events (Bug 2 fix) ────────────────
    if (url.pathname === "/ws" && req.method === "GET") {
      if (server.upgrade(req, { data: { eventBus: false } })) {
        return; // upgrade succeeded — Bun will call websocket.open
      }
      return errorResponse("WebSocket upgrade failed", 400);
    }

    // ── WebSocket upgrade for Runtime event bus (§3 of platform contract) ─────
    // Clients connect to ws://localhost:3101/events and send an auth message:
    // { "type": "auth", "token": "<runtime-token>" }
    // After auth, they receive all RuntimeEvent broadcasts.
    if (url.pathname === "/events" && req.method === "GET") {
      if (server.upgrade(req, { data: { eventBus: true } })) {
        return;
      }
      return errorResponse("WebSocket upgrade failed", 400);
    }

    try {
      return await handleRequest(req, url, server);
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

// ── Register built-in drivers with the Device Manager (Phase 6) ──────────────
// The printer driver delegates to the print service on :3103.
// Other drivers are stubs that return OFFLINE until real implementations exist.
deviceManager.register(new PrinterDriver());
deviceManager.register(new PaymentDriver());
deviceManager.register(new BarcodeDriver());
deviceManager.register(new ScaleDriver());
deviceManager.register(new DisplayDriver());

// Initialize all drivers (async, non-blocking)
deviceManager.initializeAll().catch(err => {
  console.warn("[Drivers] Driver initialization failed (non-fatal):", err);
});

// ── Load external plugins (Phase 6) ──────────────────────────────────────────
// Scans drivers/plugins/ for external .ts/.js files implementing the Driver
// interface. Plugins are registered alongside built-in drivers.
loadPlugins().catch(err => {
  console.warn("[Plugins] Plugin loading failed (non-fatal):", err);
});

// ── Background print dispatch loop ────────────────────────────────────────────
// Every 2 seconds, pick up print_job rows in 'queued' or 'retrying' status
// and re-dispatch them. This handles:
//   - Jobs created while the print bridge was unreachable (cashier was closed)
//   - Jobs that failed print (printer offline, paper jam) — retried when fixed
//   - Jobs from crashed edge server sessions (recovered from SQLite on restart)
// Per-printer serialization is enforced inside dispatchPendingPrintJobs.
setInterval(async () => {
  if (!isLocalReady()) return;
  try {
    const result = await dispatchPendingPrintJobs();
    if (result.dispatched > 0) {
      console.log(`[PrintDispatch] Dispatched ${result.dispatched} pending print job(s), ${result.remaining} remaining`);
    }
  } catch (err) {
    console.warn("[PrintDispatch] Background dispatch failed:", err);
  }
}, 2_000);

// ── Periodic driver health check (Phase 6) ───────────────────────────────────
// Every 10 seconds, check all drivers for state transitions. Logs transitions
// to runtime.log and emits device.state_changed events via WebSocket (§3).
setInterval(() => {
  try {
    const transitions = deviceManager.checkTransitions();
    for (const t of transitions) {
      console.log(`[Drivers] ${t.name} (${t.type}): ${t.oldState} → ${t.newState} — ${t.reason}`);
      emitEvent({
        event: EVENT_NAMES.DEVICE_STATE_CHANGED,
        data: {
          deviceName: t.name,
          type: t.type,
          oldState: t.oldState,
          newState: t.newState,
          reason: t.reason,
        },
      });
    }
  } catch {
    // Non-fatal — driver health check errors shouldn't crash the server
  }
}, 10_000);

// ── Startup: delegated to RuntimeManager ──────────────────────────────────────
// RuntimeManager owns the entire lifecycle: maintenance, session check,
// background services, config sync, state transitions, timers.
// This replaces the scattered setTimeout(0) + conditional startSyncWorker()
// blocks that were previously here.

// Generate runtime token on first boot (must happen before any request
// validation can work, so we do it synchronously before startup).
const _token = getOrCreateRuntimeToken();
console.log(`[EdgeServer] Runtime token: ${_token.substring(0, 8)}... (use Authorization: Bearer <token>)`);

// Kick off the startup sequence.
// RuntimeManager.startup() is async but we don't await it — the HTTP server
// is already listening (Bun.serve above), so /health returns "initializing"
// until startup completes and runtimeState transitions to READY.
runtimeManager.startup().catch((err: any) => {
  runtimeLog.error("RuntimeManager startup failed", { error: err?.stack || err });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Delegated to RuntimeManager — the single owner of all service lifecycle.

process.on("SIGINT", () => {
  console.log("[EdgeServer] SIGINT received — shutting down via RuntimeManager...");
  runtimeManager.shutdown().then(() => {
    try { closeDb(); } catch {}
    try { server.stop(); } catch {}
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  console.log("[EdgeServer] SIGTERM received — shutting down via RuntimeManager...");
  runtimeManager.shutdown().then(() => {
    try { closeDb(); } catch {}
    try { server.stop(); } catch {}
    process.exit(0);
  });
});

