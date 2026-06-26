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

// Backend URL — injected at build time via VITE_BACKEND_URL, or fallback
const BACKEND_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_BACKEND_URL) ||
  "https://softshape-backend.onrender.com";

let socket = null;
let sessionToken = null;
let restaurantId = null;
let restaurantName = null;
let printerMapping = {};
let heartbeatInterval = null;
let onStatusChangeCb = null;
let onPrintJobCb = null;

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
export function connectAgent({ token, rid, mapping, onStatusChange, onPrintJob }) {
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
    socket.emit("agent:join", { restaurantId, sessionToken });
    onStatusChangeCb?.("connected");
  });

  socket.on("agent:joined", ({ bufferedCount }) => {
    console.log(`[Agent] Joined print room. Buffered jobs: ${bufferedCount}`);
  });

  socket.on("print_job", async (envelope) => {
    console.log(`[Agent] Received print_job: ${envelope.type}`);
    onPrintJobCb?.(envelope);
    await handlePrintJob(envelope);
  });

  socket.on("disconnect", () => {
    onStatusChangeCb?.("disconnected");
  });

  socket.on("auth:error", (err) => {
    console.error("[Agent] Auth error:", err.message);
    onStatusChangeCb?.("auth_error");
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

  let targetPrinter = null;
  if (type === "KOT") targetPrinter = printerMapping.kitchen;
  else if (type === "BAR_KOT") targetPrinter = printerMapping.bar;
  else if (type === "FINAL_BILL" || type === "BILL") targetPrinter = printerMapping.bill;
  else if (type === "CANCEL_KOT" || type === "CANCEL_ORDER")
    targetPrinter = printerMapping.kitchen;
  else if (type === "TABLE_SWAP") targetPrinter = printerMapping.kitchen;
  else {
    console.warn(`[Agent] Unknown job type: ${type}`);
    return;
  }

  if (!targetPrinter) {
    console.warn(`[Agent] No printer mapped for job type: ${type}`);
    return;
  }

  const escposData = data?.escposData;
  if (!escposData || (Array.isArray(escposData) && escposData.length === 0)) {
    console.warn(`[Agent] No ESC/POS data in job: ${type}`);
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
  const token = localStorage.getItem("agent_session_token");
  const rid = localStorage.getItem("agent_restaurant_id");
  const name = localStorage.getItem("agent_restaurant_name") || "";
  const mappingStr = localStorage.getItem("agent_printer_mapping");
  const mapping = mappingStr ? JSON.parse(mappingStr) : {};

  if (token && rid) {
    return { token, rid, name, mapping };
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
