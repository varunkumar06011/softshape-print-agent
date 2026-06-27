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

let socket = null;
let sessionToken = null;
let restaurantId = null;
let restaurantName = null;
let printerMapping = {};
let heartbeatInterval = null;
let onStatusChangeCb = null;
let onPrintJobCb = null;
let isOnline = false;

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
 * @param {{ setupToken: string, agentId: string, printerMapping?: object }} opts
 * @returns {Promise<object>} registration result
 */
export async function registerAgent({ setupToken, agentId, printerMapping: mapping }) {
  const res = await fetch(`${BACKEND_URL}/api/print/agent-register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${setupToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agentId, printerMapping: mapping || {} }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Registration failed");
  }

  const data = await res.json();
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
    reconnectionAttempts: Infinity,
    reconnectionDelay: 5000,
    reconnectionDelayMax: 30000,
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
async function handlePrintJob(envelope) {
  const { type, data } = envelope;

  // Prefer explicit printerName from backend, then fall back to mapping by job type
  let targetPrinter = data?.printerName || null;
  if (!targetPrinter) {
    if (type === "KOT") targetPrinter = printerMapping.kitchen;
    else if (type === "BAR_KOT") targetPrinter = printerMapping.bar;
    else if (type === "FINAL_BILL" || type === "BILL") targetPrinter = printerMapping.bill;
    else if (type === "CANCEL_KOT" || type === "CANCEL_ORDER")
      targetPrinter = printerMapping.kitchen;
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
    if (window.__TAURI__) {
      await window.__TAURI__.invoke("print_raw", {
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
