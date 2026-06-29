/**
 * softshape-print-agent — Socket.IO communication layer
 *
 * Connects to the SoftShape backend, authenticates via agent session token,
 * and routes print_job events to the Tauri Rust core for raw printing.
 *
 * Authentication flow:
 *   1. User enters restaurant code + setup token in UI
 *   2. Calls /api/print/agent-register → receives sessionToken + missedJobs
 *   3. Stores sessionToken in localStorage
 *   4. On every start: connect socket → emit agent:join → receive print_job events
 */

import { io } from "socket.io-client";

// Backend URL — must be injected at build time via VITE_BACKEND_URL
const BACKEND_URL = typeof import.meta !== "undefined" && import.meta.env?.VITE_BACKEND_URL;
if (!BACKEND_URL) {
  throw new Error("VITE_BACKEND_URL is not set. The print agent cannot connect without a backend URL.");
}

// Resolve the Tauri invoke function regardless of API shape. Tauri v1 with
// withGlobalTauri exposes both window.__TAURI__.invoke and
// window.__TAURI__.tauri.invoke. Returns null outside the desktop webview.
function getTauriInvoke() {
  const t = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (!t) return null;
  if (typeof t.invoke === "function") return t.invoke.bind(t);
  if (t.tauri && typeof t.tauri.invoke === "function") return t.tauri.invoke.bind(t.tauri);
  return null;
}

/**
 * Typed fetch error used by fetchWithRetry so callers can distinguish
 * timeout, network, 4xx, 5xx, and parse failures without string parsing.
 */
class FetchError extends Error {
  constructor(message, type, statusCode = null) {
    super(message);
    this.name = "FetchError";
    this.type = type;
    this.statusCode = statusCode;
  }
}

/**
 * Fetch with per-attempt timeout and exponential backoff.
 *
 * Retry policy:
 *   - 4xx client errors are NOT retried (bad token, bad input, unauthorized)
 *   - 5xx server errors, network errors, and timeouts ARE retried
 *
 * @param {string} url
 * @param {object} options
 * @param {object} config
 * @param {number} config.retries - max attempts (default 3)
 * @param {number} config.timeoutMs - per attempt timeout (default 12000)
 * @param {number} config.baseDelayMs - first retry delay (default 1000)
 * @param {Function} config.onAttempt - (attempt, total) => void
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(
  url,
  options = {},
  { retries = 3, timeoutMs = 12000, baseDelayMs = 1000, onAttempt } = {},
) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    onAttempt?.(attempt, retries);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.ok) return res;

      if (res.status >= 400 && res.status < 500) {
        const body = await res.json().catch(() => ({}));
        throw new FetchError(
          body.error || `HTTP ${res.status}: ${res.statusText}`,
          "client",
          res.status,
        );
      }

      // 5xx: retry
      lastError = new FetchError(
        `HTTP ${res.status}: ${res.statusText}`,
        "server",
        res.status,
      );
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof FetchError) {
        lastError = err;
        // 4xx client errors should not be retried (bad token, bad input, unauthorized)
        if (err.type === "client") throw lastError;
      } else if (err.name === "AbortError") {
        lastError = new FetchError("Request timed out", "timeout");
      } else {
        lastError = new FetchError(
          err.message || "Network request failed",
          "network",
        );
      }
    }

    if (attempt < retries) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Lightweight pre-flight check to tell users whether the backend is reachable
 * before attempting a full registration.
 *
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: true }>}
 */
export async function checkBackendHealth(timeoutMs = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);

  try {
    const res = await fetch(`${BACKEND_URL}/api/health`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new FetchError(
        `Health check returned HTTP ${res.status}`,
        res.status >= 500 ? "server" : "client",
        res.status,
      );
    }

    return { ok: true };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof FetchError) throw err;
    if (err.name === "AbortError") {
      throw new FetchError(
        `Backend is not responding at ${BACKEND_URL}`,
        "timeout",
      );
    }
    throw new FetchError(
      `Cannot reach backend at ${BACKEND_URL}`,
      "network",
    );
  }
}

let socket = null;
let sessionToken = null;
let restaurantId = null;
let restaurantName = null;
let printerMapping = {};
let heartbeatInterval = null;
let onStatusChangeCb = null;
let onPrintJobCb = null;
let isOnline = false;

// ── EventId dedup ────────────────────────────────────────────────────────────
// Prevents double-printing when the agent reconnects: the backend re-delivers
// buffered PENDING jobs via socket while the agent's own offline localStorage
// queue may also hold the same job.  We track seen eventIds in a bounded Set
// so duplicates are skipped and a success ack is sent immediately.
const SEEN_EVENT_IDS_MAX = 500;
const seenEventIds = new Set();

function markEventIdSeen(id) {
  if (seenEventIds.size >= SEEN_EVENT_IDS_MAX) {
    // Evict oldest entry (first inserted) to keep the Set bounded
    const first = seenEventIds.values().next().value;
    if (first) seenEventIds.delete(first);
  }
  seenEventIds.add(id);
}

// ── Offline print queue (localStorage-based for the print agent) ─────────────
// The print agent runs in Tauri and may lose socket connection while the
// cashier app is still sending print requests via the OS. When offline,
// we queue jobs in localStorage and flush them when the socket reconnects.

const OFFLINE_QUEUE_KEY = "agent_offline_print_queue";

function getOfflineQueue() {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveOfflineQueue(queue) {
  try {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // localStorage might be full — drop oldest jobs
    const trimmed = queue.slice(-20);
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(trimmed));
  }
}

function addToOfflineQueue(envelope) {
  const queue = getOfflineQueue();
  queue.push({ ...envelope, queuedAt: Date.now() });
  saveOfflineQueue(queue);
  console.log(`[Agent] Queued offline print job: ${envelope.type} (queue: ${queue.length})`);
}

async function flushOfflineQueue() {
  const queue = getOfflineQueue();
  if (queue.length === 0) return;

  console.log(`[Agent] Flushing ${queue.length} queued offline print jobs...`);
  const remaining = [];

  for (const envelope of queue) {
    try {
      await handlePrintJob(envelope);
      console.log(`[Agent] Flushed queued job: ${envelope.type}`);
    } catch (err) {
      console.error(`[Agent] Failed to flush queued job:`, err);
      // Keep failed jobs in queue for next attempt
      remaining.push(envelope);
    }
  }

  saveOfflineQueue(remaining);
  if (remaining.length > 0) {
    console.log(`[Agent] ${remaining.length} jobs still in offline queue`);
  }
}

/**
 * Register agent for the first time using a setup token.
 * @param {{ setupToken: string, agentId: string, restaurantCode?: string, printerMapping?: object, onAttempt?: Function }} opts
 * @returns {Promise<object>} registration result
 */
export async function registerAgent({
  setupToken,
  agentId,
  restaurantCode,
  printerMapping: mapping,
  onAttempt,
}) {
  const body = { agentId, printerMapping: mapping || {} };
  if (restaurantCode) body.restaurantCode = restaurantCode;

  const res = await fetchWithRetry(
    `${BACKEND_URL}/api/print/agent-register`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${setupToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    { retries: 3, timeoutMs: 12000, onAttempt },
  );

  const data = await res.json().catch(() => {
    throw new FetchError("Failed to parse registration response", "parse");
  });
  sessionToken = data.sessionToken;
  restaurantId = data.restaurantId;
  restaurantName = data.restaurantName;
  printerMapping = mapping || {};

  // Persist for future starts
  localStorage.setItem("agent_session_token", sessionToken);
  localStorage.setItem("agent_restaurant_id", restaurantId);
  localStorage.setItem("agent_restaurant_name", restaurantName || "");
  localStorage.setItem("agent_printer_mapping", JSON.stringify(printerMapping));

  // Process any missed jobs immediately
  for (const job of data.missedJobs || []) {
    await handlePrintJob(job);
  }

  return data;
}

/**
 * Connect to the backend socket after registration.
 * Call this on every app start once sessionToken is loaded from storage.
 * @param {{ token: string, rid: string, mapping: object, onStatusChange?: Function, onPrintJob?: Function }} opts
 */
export function connectAgent({ token, rid, mapping, onStatusChange, onPrintJob, onAuthError }) {
  sessionToken = token;
  restaurantId = rid;
  printerMapping = mapping || {};
  onStatusChangeCb = onStatusChange || null;
  onPrintJobCb = onPrintJob || null;

  socket = io(BACKEND_URL, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: 50,
    reconnectionDelay: 5000,
    reconnectionDelayMax: 60000,
  });

  socket.on("connect", () => {
    isOnline = true;
    socket.emit("agent:join", { restaurantId, sessionToken });
    onStatusChangeCb?.("connected");
    // Flush any print jobs that were queued while offline
    flushOfflineQueue();
  });

  socket.on("agent:joined", ({ bufferedCount }) => {
    console.log(`[Agent] Joined print room. Buffered jobs: ${bufferedCount}`);
  });

  socket.on("print_job", async (envelope) => {
    console.log(`[Agent] Received print_job: ${envelope.type}`);
    onPrintJobCb?.(envelope);
    if (!isOnline) {
      // Should not happen via socket, but handle gracefully
      addToOfflineQueue(envelope);
      return;
    }
    await handlePrintJob(envelope);
  });

  socket.on("disconnect", () => {
    isOnline = false;
    onStatusChangeCb?.("disconnected");
  });

  socket.on("reconnect_failed", () => {
    console.error("[Agent] All reconnection attempts exhausted. Manual reconnect required.");
    onStatusChangeCb?.("connection_failed");
  });

  socket.on("auth:error", (err) => {
    console.error("[Agent] Auth error:", err.message);
    onStatusChangeCb?.("auth_error");
    onAuthError?.(err);
  });
}

/**
 * Route a print_job envelope to the correct physical printer.
 *
 * Job types: KOT | BAR_KOT | FINAL_BILL | CANCEL_KOT | CANCEL_ORDER | TABLE_SWAP
 * ESC/POS bytes are in envelope.data.escposData (pre-built by backend).
 */
export async function handlePrintJob(envelope) {
  const { type, data } = envelope;

  // ── Dedup: skip if we've already printed this eventId ──
  // On reconnect the backend re-delivers buffered PENDING jobs and the agent's
  // own offline queue may also contain the same job.  This guard ensures each
  // job is printed exactly once.
  if (envelope.eventId && seenEventIds.has(envelope.eventId)) {
    console.log(`[Agent] Duplicate eventId skipped: ${envelope.eventId}`);
    socket?.emit("print:ack", {
      restaurantId,
      eventId: envelope.eventId,
      requestId: data?.requestId,
      status: "success",
    });
    return;
  }
  if (envelope.eventId) markEventIdSeen(envelope.eventId);

  // Prefer explicit printerName from backend, then fall back to mapping by job type
  let targetPrinter = data?.printerName || null;
  if (!targetPrinter) {
    if (type === "KOT") targetPrinter = printerMapping.kitchen;
    else if (type === "BAR_KOT") targetPrinter = printerMapping.bar;
    else if (type === "FINAL_BILL" || type === "BILL") targetPrinter = printerMapping.bill;
    else if (type === "CANCEL_KOT" || type === "CANCEL_ORDER") {
      // Route cancel slips to the correct printer based on the cancelled item's type
      const cancelItem = data?.item || data?.items?.[0];
      const isLiquor = cancelItem?.menuType === "BAR" || cancelItem?.menuType === "LIQUOR";
      targetPrinter = isLiquor ? printerMapping.bar : printerMapping.kitchen;
    }
    else if (type === "TABLE_SWAP") targetPrinter = printerMapping.kitchen;
    else {
      console.warn(`[Agent] Unknown job type: ${type}`);
      socket?.emit("print:ack", {
        restaurantId,
        eventId: envelope.eventId,
        requestId: data?.requestId,
        status: "failed",
        error: `Unknown job type: ${type}`,
      });
      return;
    }
  }

  if (!targetPrinter) {
    console.warn(`[Agent] No printer mapped for job type: ${type}`, { printerName: data?.printerName });
    socket?.emit("print:ack", {
      restaurantId,
      eventId: envelope.eventId,
      requestId: data?.requestId,
      status: "failed",
      error: `No printer mapped for job type: ${type}`,
    });
    return;
  }

  const escposData = data?.escposData;
  if (!escposData || (Array.isArray(escposData) && escposData.length === 0)) {
    console.warn(`[Agent] No ESC/POS data in job: ${type}`);
    socket?.emit("print:ack", {
      restaurantId,
      eventId: envelope.eventId,
      requestId: data?.requestId,
      status: "failed",
      error: `No ESC/POS data in job: ${type}`,
    });
    return;
  }

  // Extract raw string from QZ-format array ([{ type:'raw', data: '...' }])
  const rawString = Array.isArray(escposData)
    ? escposData.map((d) => d.data || "").join("")
    : String(escposData);

  // Convert to Uint8Array for raw printing
  const encoder = new TextEncoder();
  const bytes = encoder.encode(rawString);

  try {
    // Invoke Tauri Rust command
    const invoke = getTauriInvoke();
    if (invoke) {
      await invoke("print_raw", {
        printerName: targetPrinter,
        bytes: Array.from(bytes),
      });
    } else {
      console.log(`[Agent] (dev mode) Would print [${type}] → ${targetPrinter} (${bytes.length} bytes)`);
    }
    console.log(`[Agent] Printed [${type}] → ${targetPrinter}`);

    // Acknowledge to backend
    socket?.emit("print:ack", {
      restaurantId,
      eventId: envelope.eventId,
      requestId: data?.requestId,
      status: "success",
    });
  } catch (err) {
    console.error(`[Agent] Print failed [${type}] → ${targetPrinter}:`, err);
    socket?.emit("print:ack", {
      restaurantId,
      eventId: envelope.eventId,
      requestId: data?.requestId,
      status: "failed",
      error: err?.message || String(err),
    });
  }
}

/**
 * Start sending heartbeat to backend every 30 seconds.
 * @param {Function} getPrinterStatus — returns { kitchen, bar, bill } status
 * @returns {number} interval ID
 */
export function startHeartbeat(getPrinterStatus) {
  if (heartbeatInterval) clearInterval(heartbeatInterval);

  heartbeatInterval = setInterval(async () => {
    if (!sessionToken) return;
    try {
      const printerStatus = getPrinterStatus ? await getPrinterStatus() : {};
      await fetch(`${BACKEND_URL}/api/print/agent-heartbeat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ printerStatus }),
      });
    } catch {
      /* ignore heartbeat failures */
    }
  }, 30_000);

  return heartbeatInterval;
}

/**
 * Disconnect and clean up.
 */
export function disconnectAgent() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  sessionToken = null;
  restaurantId = null;
  localStorage.removeItem("agent_session_token");
  localStorage.removeItem("agent_restaurant_id");
  localStorage.removeItem("agent_restaurant_name");
  localStorage.removeItem("agent_printer_mapping");
}

/**
 * Check if we have a stored session from a previous registration.
 * @returns {{ token: string, rid: string, name: string, mapping: object } | null}
 */
export function loadStoredSession() {
  try {
    const token = localStorage.getItem("agent_session_token");
    const rid = localStorage.getItem("agent_restaurant_id");
    const name = localStorage.getItem("agent_restaurant_name") || "";
    const mappingStr = localStorage.getItem("agent_printer_mapping");
    const mapping = mappingStr ? JSON.parse(mappingStr) : {};

    if (token && rid) {
      return { token, rid, name, mapping };
    }
  } catch (err) {
    console.error("[Agent] Failed to load stored session:", err);
    localStorage.removeItem("agent_session_token");
    localStorage.removeItem("agent_restaurant_id");
    localStorage.removeItem("agent_restaurant_name");
    localStorage.removeItem("agent_printer_mapping");
  }
  return null;
}

/**
 * Update printer mapping and persist to localStorage.
 * @param {{ kitchen?: string, bar?: string, bill?: string }} mapping
 */
export function updatePrinterMapping(mapping) {
  printerMapping = { ...printerMapping, ...mapping };
  localStorage.setItem("agent_printer_mapping", JSON.stringify(printerMapping));
}

/**
 * Get the backend URL.
 * @returns {string}
 */
export function getBackendUrl() {
  return BACKEND_URL;
}

/**
 * Check if the agent socket is currently connected.
 * @returns {boolean}
 */
export function isAgentOnline() {
  return isOnline;
}

/**
 * Submit a print job directly (bypassing socket). Used by the cashier app
 * when it detects the agent is offline but still wants to print locally.
 * The job is processed immediately if possible, otherwise queued.
 *
 * @param {{ type: string, data: object }} envelope
 */
export async function printDirect(envelope) {
  if (isOnline && socket?.connected) {
    // If online, just process normally
    await handlePrintJob(envelope);
  } else {
    // Queue for later processing
    addToOfflineQueue(envelope);
    // Attempt immediate local print anyway (Tauri can print without socket)
    try {
      await handlePrintJob(envelope);
    } catch (err) {
      console.warn(`[Agent] Direct print failed, job queued:`, err.message);
    }
  }
}

/**
 * Get the count of queued offline print jobs.
 * @returns {number}
 */
export function getOfflineQueueCount() {
  return getOfflineQueue().length;
}

export { FetchError };
