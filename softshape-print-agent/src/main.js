/**
 * SoftShape Print Agent — Frontend entry point
 *
 * Handles the UI flow:
 *   1. Check for stored session → auto-connect if found
 *   2. If no session: show setup form (restaurant code + setup token)
 *   3. After registration: show printer mapping UI
 *   4. On connect: show live status, recent jobs
 */

import {
  registerAgent,
  connectAgent,
  disconnectAgent,
  startHeartbeat,
  loadStoredSession,
  updatePrinterMapping,
  getBackendUrl,
  checkBackendHealth,
} from "./agentSocket.js";

// ── Edge server WebSocket for LAN print fallback ─────────────────────────────
// The edge server (Bun, port 3101) runs as a separate process without
// window.__TAURI__. It broadcasts print_job events via WebSocket. This Tauri
// frontend (which HAS window.__TAURI__) connects to the edge server's /ws
// endpoint and prints any received print_job events to the physical printer.

let edgeWs = null;
let edgeWsReconnectTimer = null;
const EDGE_WS_URL = `ws://localhost:3101/ws`;

const seenPrintEventIds = new Set();
const SEEN_EVENT_IDS_MAX = 500;

function getTauriInvoke() {
  const t = window.__TAURI__;
  if (!t) return null;
  if (typeof t.invoke === "function") return t.invoke.bind(t);
  if (t.tauri && typeof t.tauri.invoke === "function") return t.tauri.invoke.bind(t.tauri);
  return null;
}

async function isEventIdSeenRust(eventId) {
  const invoke = getTauriInvoke();
  if (!invoke) return false;
  try {
    return await invoke("is_event_id_seen", { eventId });
  } catch {
    return false;
  }
}

async function markEventIdSeenRust(eventId) {
  const invoke = getTauriInvoke();
  if (!invoke) return;
  try {
    await invoke("mark_event_id_seen", { eventId });
  } catch {
    // Ignore — dedup is best-effort
  }
}

/// Atomic test-and-set: returns true if already seen (duplicate), false if
/// newly marked (first occurrence). Eliminates the check-then-mark race.
async function checkAndMarkEventIdRust(eventId) {
  const invoke = getTauriInvoke();
  if (!invoke) return false; // no Tauri — allow print, local Set still guards
  try {
    return await invoke("check_and_mark_event_id", { eventId });
  } catch {
    return false; // on error, allow print — dedup is best-effort
  }
}

function markEventSeen(eventId) {
  if (!eventId) return false;
  if (seenPrintEventIds.has(eventId)) return false;
  seenPrintEventIds.add(eventId);
  if (seenPrintEventIds.size > SEEN_EVENT_IDS_MAX) {
    const arr = Array.from(seenPrintEventIds);
    seenPrintEventIds.clear();
    arr.slice(-SEEN_EVENT_IDS_MAX).forEach((id) => seenPrintEventIds.add(id));
  }
  return true;
}

function connectEdgeWebSocket() {
  try {
    edgeWs = new WebSocket(EDGE_WS_URL);
  } catch {
    scheduleEdgeReconnect();
    return;
  }

  edgeWs.onopen = () => {
    console.log("[EdgeWS] Connected to edge server WebSocket");
    if (edgeWsReconnectTimer) {
      clearTimeout(edgeWsReconnectTimer);
      edgeWsReconnectTimer = null;
    }
    // Send initial ping to confirm connection
    edgeWs.send(JSON.stringify({ type: "ping" }));
  };

  edgeWs.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "print_job") {
        await handleEdgePrintJob(msg);
      } else if (msg.type === "pong") {
        // Keepalive response — ignore
      }
    } catch (err) {
      console.error("[EdgeWS] Failed to parse message:", err);
    }
  };

  edgeWs.onerror = (err) => {
    console.error("[EdgeWS] WebSocket error:", err);
  };

  edgeWs.onclose = () => {
    console.log("[EdgeWS] Disconnected from edge server");
    edgeWs = null;
    scheduleEdgeReconnect();
  };
}

function scheduleEdgeReconnect() {
  if (edgeWsReconnectTimer) return;
  edgeWsReconnectTimer = setTimeout(() => {
    edgeWsReconnectTimer = null;
    connectEdgeWebSocket();
  }, 5000);
}

// ── Print retry queue ─────────────────────────────────────────────────────────
// Failed print jobs are queued and retried up to 3 times with 2s delay.
// After exhausting retries, the ack is sent as failed so the edge server
// can trigger cloud fallback.

const printRetryQueue = [];
const MAX_PRINT_RETRIES = 3;
const PRINT_RETRY_DELAY_MS = 2000;

function sendPrintAck(eventId, ok, error) {
  if (edgeWs && edgeWs.readyState === WebSocket.OPEN) {
    edgeWs.send(JSON.stringify({ type: "print_ack", eventId, ok, error: error || null }));
  }
}

function queuePrintRetry(job) {
  printRetryQueue.push({ ...job, attempt: (job.attempt || 0) + 1 });
  setTimeout(() => processRetryQueue(), PRINT_RETRY_DELAY_MS);
}

async function processRetryQueue() {
  if (printRetryQueue.length === 0) return;
  const job = printRetryQueue.shift();
  console.log(`[EdgeWS] Retry #${job.attempt} for [${job.type}] → ${job.printerName}`);
  await doPrint(job);
}

async function doPrint(job) {
  const { type, printerName, bytes, eventId, attempt } = job;
  if (window.__TAURI__) {
    try {
      const netMatch = printerName.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/);
      if (netMatch) {
        await window.__TAURI__.invoke("print_network", {
          ip: netMatch[1],
          port: parseInt(netMatch[2], 10),
          bytes,
        });
      } else {
        await window.__TAURI__.invoke("print_raw", {
          printerName,
          bytes,
        });
      }
      console.log(`[EdgeWS] Printed [${type}] → ${printerName} (${bytes.length} bytes)${attempt ? ` (retry #${attempt})` : ""}`);
      addJobToList({ type, data: { tableNumber: job.tableNumber } });
      sendPrintAck(eventId, true);
      return true;
    } catch (err) {
      console.error(`[EdgeWS] Print failed [${type}] → ${printerName}:`, err);
      if (attempt < MAX_PRINT_RETRIES) {
        queuePrintRetry(job);
      } else {
        sendPrintAck(eventId, false, `Print failed after ${MAX_PRINT_RETRIES} retries: ${err?.message || err}`);
      }
      return false;
    }
  } else {
    console.warn(`[EdgeWS] No Tauri runtime — cannot print [${type}] → ${printerName}`);
    sendPrintAck(eventId, false, "No Tauri runtime available");
    return false;
  }
}

async function handleEdgePrintJob(envelope) {
  // lanBroadcast wraps as: { type: "print_job", data: { type, data, eventId, ts }, ts }
  // Unwrap the inner payload to get the actual print job fields.
  const payload = envelope.data || envelope;
  const { type, data, eventId } = payload;
  if (!eventId) {
    console.error(`[EdgeWS] print_job missing eventId — cannot track or ack`);
    sendPrintAck(null, false, "Missing eventId in print_job");
    return;
  }
  if (!markEventSeen(eventId)) {
    console.log(`[EdgeWS] Duplicate print_job skipped (local cache): ${eventId}`);
    return;
  }
  // Atomic cross-path dedup: test-and-set in a single Rust mutex lock.
  // Returns true if already seen (another path printed it), false if newly
  // marked (this path should print). Eliminates the race where two async
  // paths both pass the check before either marks.
  const alreadySeen = await checkAndMarkEventIdRust(eventId);
  if (alreadySeen) {
    console.log(`[EdgeWS] Duplicate print_job skipped (cross-path Rust dedup): ${eventId}`);
    sendPrintAck(eventId, true);
    return;
  }

  // Resolve printer: check local mapping first (this machine knows the physical printers),
  // then fall back to the printerName sent by the Captain/edge server.
  let targetPrinter = data?.printerName;
  if (!targetPrinter) {
    try {
      const stored = JSON.parse(localStorage.getItem("agent_printer_mapping") || "{}");
      if (type === "KOT" || type === "CANCEL_KOT") targetPrinter = stored.kitchen;
      else if (type === "BAR_KOT") targetPrinter = stored.bar;
      else if (type === "BILL" || type === "FINAL_BILL") targetPrinter = stored.bill;
      else if (type === "TABLE_SWAP") targetPrinter = stored.kitchen;
      if (targetPrinter) {
        console.log(`[EdgeWS] Resolved printer from local mapping: ${type} → ${targetPrinter}`);
      }
    } catch { /* ignore */ }
  }

  // Also check the DOM dropdowns as a fallback (they reflect the current UI selection)
  if (!targetPrinter) {
    if (type === "KOT" || type === "CANCEL_KOT") targetPrinter = kitchenSelect?.value || null;
    else if (type === "BAR_KOT") targetPrinter = barSelect?.value || null;
    else if (type === "BILL" || type === "FINAL_BILL") targetPrinter = billSelect?.value || null;
    else if (type === "TABLE_SWAP") targetPrinter = kitchenSelect?.value || null;
    if (targetPrinter) {
      console.log(`[EdgeWS] Resolved printer from DOM dropdown: ${type} → ${targetPrinter}`);
    }
  }

  if (!targetPrinter) {
    console.error(`[EdgeWS] No printer resolved for ${type} — no local mapping and no printerName in print_job`);
    sendPrintAck(eventId, false, `No printer resolved for ${type}`);
    return;
  }

  const escposData = data?.escposData;
  if (!escposData || (Array.isArray(escposData) && escposData.length === 0)) {
    console.error(`[EdgeWS] No ESC/POS data in print_job: ${type}`);
    sendPrintAck(eventId, false, "No ESC/POS data in print_job");
    return;
  }

  // Convert ESC/POS data to bytes
  const rawString = Array.isArray(escposData)
    ? escposData.map((d) => d.data || "").join("")
    : String(escposData);
  const bytes = Array.from(new TextEncoder().encode(rawString));

  await doPrint({ type, printerName: targetPrinter, bytes, eventId, tableNumber: data?.tableNumber, attempt: 0 });
}

// Start periodic ping to keep WebSocket alive
let pingInterval = null;
function startEdgePing() {
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    if (edgeWs && edgeWs.readyState === WebSocket.OPEN) {
      edgeWs.send(JSON.stringify({ type: "ping" }));
    }
  }, 30000);
}

// DOM elements
const setupSection = document.getElementById("setupSection");
const connectedSection = document.getElementById("connectedSection");
const connectionStatus = document.getElementById("connectionStatus");
const restaurantCodeInput = document.getElementById("restaurantCode");
const setupTokenInput = document.getElementById("setupToken");
const connectBtn = document.getElementById("connectBtn");
const setupError = document.getElementById("setupError");
const retryBtn = document.getElementById("retryBtn");
const restaurantNameEl = document.getElementById("restaurantName");
const agentIdEl = document.getElementById("agentIdDisplay");
const kitchenSelect = document.getElementById("kitchenPrinter");
const barSelect = document.getElementById("barPrinter");
const billSelect = document.getElementById("billPrinter");
const saveMappingBtn = document.getElementById("saveMappingBtn");
const mappingMsg = document.getElementById("mappingMsg");
const printerStatusGrid = document.getElementById("printerStatusGrid");
const recentJobs = document.getElementById("recentJobs");
const disconnectBtn = document.getElementById("disconnectBtn");

// Generate a stable agent ID per machine
const AGENT_ID = getOrCreateAgentId();

// Recent jobs tracker
const recentJobsList = [];
const MAX_JOBS_DISPLAY = 20;

function getOrCreateAgentId() {
  let id = localStorage.getItem("agent_id");
  if (!id) {
    id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem("agent_id", id);
  }
  return id;
}

function setStatus(text, connected) {
  connectionStatus.textContent = text;
  connectionStatus.className = "header-status" + (connected ? " connected" : "");
}

function showSetup() {
  setupSection.classList.remove("hidden");
  connectedSection.classList.add("hidden");
  setStatus("Disconnected", false);
}

function showConnected(name) {
  setupSection.classList.add("hidden");
  connectedSection.classList.remove("hidden");
  restaurantNameEl.textContent = name || "Connected";
  agentIdEl.textContent = AGENT_ID.slice(0, 12) + "…";
  setStatus("Connected", true);
}

function addJobToList(envelope) {
  recentJobsList.unshift({
    type: envelope.type,
    time: new Date().toLocaleTimeString("en-IN"),
    target: envelope.data?.tableNumber || "—",
  });
  if (recentJobsList.length > MAX_JOBS_DISPLAY) recentJobsList.pop();
  renderJobs();
}

function renderJobs() {
  if (recentJobsList.length === 0) {
    recentJobs.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:12px;">No jobs yet</div>';
    return;
  }
  recentJobs.innerHTML = recentJobsList
    .map(
      (j) =>
        `<div class="job-item"><span class="job-type">${j.type}</span><span style="color:#6b7280">${j.target}</span><span class="job-time">${j.time}</span></div>`
    )
    .join("");
}

function renderPrinterStatus(status) {
  const printers = [
    { key: "kitchen", label: "Kitchen", icon: "🍳" },
    { key: "bar", label: "Bar", icon: "🍺" },
    { key: "bill", label: "Bill", icon: "🧾" },
  ];
  printerStatusGrid.innerHTML = printers
    .map((p) => {
      const st = status?.[p.key] || "unknown";
      return `<div class="status-card">
        <div class="icon">${p.icon}</div>
        <div class="name">${p.label}</div>
        <span class="badge ${st}">${st}</span>
      </div>`;
    })
    .join("");
}

// Populate printer dropdowns (in dev mode, use stub list; in Tauri, call Rust command)
async function populatePrinterDropdowns() {
  let printers = [];
  if (window.__TAURI__) {
    try {
      printers = await window.__TAURI__.invoke("list_printers");
    } catch (err) {
      console.error("Failed to list printers:", err);
      printers = [];
    }
  } else {
    printers = ["(dev mode — no real printers)"];
  }

  for (const select of [kitchenSelect, barSelect, billSelect]) {
    select.innerHTML = '<option value="">— Select —</option>';
    for (const name of printers) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
  }
}

// ─── Event Handlers ─────────────────────────────────────────────────────

connectBtn.addEventListener("click", () => attemptConnect());
retryBtn?.addEventListener("click", () => attemptConnect());

async function attemptConnect() {
  const code = restaurantCodeInput.value.trim();
  const token = setupTokenInput.value.trim();

  if (!token) {
    setupError.textContent = "Please enter the setup token from the dashboard.";
    retryBtn?.classList.add("hidden");
    return;
  }

  connectBtn.disabled = true;
  retryBtn?.classList.add("hidden");
  setupError.textContent = "Checking backend…";

  try {
    await checkBackendHealth(5000);
  } catch (err) {
    setupError.innerHTML = formatSetupError(err);
    connectBtn.disabled = false;
    retryBtn?.classList.remove("hidden");
    return;
  }

  try {
    setupError.textContent = "Registering…";
    const data = await registerAgent({
      setupToken: token,
      restaurantCode: code,
      agentId: AGENT_ID,
      printerMapping: {},
      onAttempt: (attempt, total) => {
        if (attempt > 1) {
          setupError.textContent = `Retrying… (${attempt}/${total})`;
        }
      },
    });

    // Load any previously saved mapping from localStorage so jobs route correctly
    const stored = loadStoredSession();
    const initialMapping = (stored && stored.mapping) ? stored.mapping : {};

    // Connect socket with the persisted mapping (not empty {})
    connectAgent({
      token: data.sessionToken,
      rid: data.restaurantId,
      mapping: initialMapping,
      onStatusChange: (status) => {
        if (status === "connected") setStatus("Connected", true);
        else if (status === "disconnected") setStatus("Reconnecting…", false);
        else if (status === "auth_error") {
          setStatus("Auth Error", false);
          disconnectAgent();
          showSetup();
          setupError.textContent = "Session expired. Generate a new setup token and reconnect.";
          connectBtn.disabled = false;
        }
      },
      onPrintJob: (envelope) => addJobToList(envelope),
    });

    // Start heartbeat
    startHeartbeat(() => ({
      kitchen: kitchenSelect.value ? "online" : "offline",
      bar: barSelect.value ? "online" : "offline",
      bill: billSelect.value ? "online" : "offline",
    }));

    showConnected(data.restaurantName);
    await populatePrinterDropdowns();
    renderPrinterStatus({});
    renderJobs();
  } catch (err) {
    setupError.innerHTML = formatSetupError(err);
    retryBtn?.classList.remove("hidden");
  } finally {
    connectBtn.disabled = false;
  }
}

function formatSetupError(err) {
  const url = getBackendUrl();
  const message = err.message || "Connection failed";

  let detail = "";
  if (err.type === "timeout") {
    detail = "The backend did not respond in time. It may be waking up — try again.";
  } else if (err.type === "network") {
    detail = "Could not reach the network. Check your internet connection.";
  } else if (err.type === "client") {
    detail = "The server rejected the request. Check your restaurant code and setup token.";
  } else if (err.type === "server") {
    detail = "The server had an error. Please wait a moment and try again.";
  } else if (err.type === "parse") {
    detail = "The server response was unreadable. Please try again.";
  } else {
    detail = "Check your token and try again.";
  }

  return (
    `<div>${escapeHtml(message)}</div>` +
    `<div style="font-size:0.85em;color:#6b7280;margin-top:4px;">URL: ${escapeHtml(url)}</div>` +
    `<div style="font-size:0.85em;color:#6b7280;">${escapeHtml(detail)}</div>`
  );
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

saveMappingBtn.addEventListener("click", async () => {
  const availablePrinters = Array.from(kitchenSelect.options).map((o) => o.value).filter(Boolean);
  const mapping = {
    kitchen: kitchenSelect.value,
    bar: barSelect.value,
    bill: billSelect.value,
  };

  const invalid = Object.entries(mapping).filter(([, name]) => name && !availablePrinters.includes(name));
  if (invalid.length > 0) {
    mappingMsg.textContent = "Error: selected printer not in system list.";
    return;
  }

  updatePrinterMapping(mapping);
  mappingMsg.textContent = "Saved! Sending test print…";

  // Send a test print via Tauri
  if (window.__TAURI__) {
    for (const [type, printerName] of Object.entries(mapping)) {
      if (!printerName) continue;
      try {
        const testStr = "\x1B\x40Test Print — " + type.toUpperCase() + "\n\n\n\x1D\x56\x42\x00";
        const encoder = new TextEncoder();
        const bytes = encoder.encode(testStr);
        await window.__TAURI__.invoke("print_raw", {
          printerName,
          bytes: Array.from(bytes),
        });
      } catch (err) {
        console.error(`Test print failed for ${type}:`, err);
      }
    }
  }

  setTimeout(() => {
    mappingMsg.textContent = "";
  }, 3000);
});

disconnectBtn.addEventListener("click", () => {
  disconnectAgent();
  showSetup();
  restaurantCodeInput.value = "";
  setupTokenInput.value = "";
  connectBtn.disabled = false;
});

// ─── Auto-connect on startup ────────────────────────────────────────────

const stored = loadStoredSession();
if (stored) {
  connectAgent({
    token: stored.token,
    rid: stored.rid,
    mapping: stored.mapping,
    onStatusChange: (status) => {
      if (status === "connected") setStatus("Connected", true);
      else if (status === "disconnected") setStatus("Reconnecting…", false);
      else if (status === "auth_error") {
        setStatus("Auth Error", false);
        disconnectAgent();
        showSetup();
        setupError.textContent = "Session expired. Generate a new setup token and reconnect.";
        connectBtn.disabled = false;
      }
    },
    onPrintJob: (envelope) => addJobToList(envelope),
  });

  startHeartbeat(() => ({
    kitchen: kitchenSelect.value ? "online" : "offline",
    bar: barSelect.value ? "online" : "offline",
    bill: billSelect.value ? "online" : "offline",
  }));

  showConnected(stored.name);
  populatePrinterDropdowns().then(() => {
    // Restore saved mapping selections
    if (stored.mapping.kitchen) kitchenSelect.value = stored.mapping.kitchen;
    if (stored.mapping.bar) barSelect.value = stored.mapping.bar;
    if (stored.mapping.bill) billSelect.value = stored.mapping.bill;
  });
  renderPrinterStatus({});
  renderJobs();
} else {
  showSetup();
}

// ── Edge server WebSocket print path removed ─────────────────────────────────
// Print jobs are now dispatched via HTTP POST to the print bridge (port 3102)
// inside the cashier-desktop Tauri app, not via WebSocket broadcast. The
// print-agent's own HTTP server (http_server.rs) can also receive print jobs
// via POST /print. Cloud relay is the emergency fallback if the bridge is down.
