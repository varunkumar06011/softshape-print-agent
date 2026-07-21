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
  setPrinterStatus,
  getBackendUrl,
  checkBackendHealth,
  forceReconnect,
  refetchPrinterMapping,
} from "./agentSocket.js";

// ── Edge server WebSocket for LAN print path ─────────────────────────────────
// The edge server (Bun, port 3101) runs as a separate process without
// window.__TAURI__. It broadcasts print_job events via WebSocket. This Tauri
// frontend (which HAS window.__TAURI__) connects to the edge server's /ws
// endpoint and prints any received print_job events to the physical printer.
// This is the LAN fast path — print-agent is the SOLE canonical print receiver
// for both cloud (Socket.IO) and LAN (edge-WS) paths.

let edgeWs = null;
let edgeWsReconnectTimer = null;
let pingInterval = null;
const EDGE_WS_URL = `ws://localhost:3101/ws`;

const seenPrintEventIds = new Set();
const SEEN_EVENT_IDS_MAX = 500;

// ── Print retry queue ─────────────────────────────────────────────────────────
// Failed print jobs are queued and retried up to 3 times with 2s delay.
// After exhausting retries, the ack is sent as failed so the edge server
// can trigger cloud fallback.
const printRetryQueue = [];
const MAX_PRINT_RETRIES = 3;
const PRINT_RETRY_DELAY_MS = 2000;

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

// Full list of system printers from Tauri list_printers — sent to backend
// so the admin panel can show all available printer names for KOT destination.
let systemPrinterList = [];

function getOrCreateAgentId() {
  let id = localStorage.getItem("agent_id");
  if (!id) {
    id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem("agent_id", id);
  }
  return id;
}

// ── Edge-WS dedup helpers ────────────────────────────────────────────────────
// Atomic test-and-set: returns true if already seen (duplicate), false if
// newly marked (first occurrence). Eliminates the check-then-mark race that
// can occur when both the cloud socket path and the edge-WS path receive the
// same print job concurrently.
async function checkAndMarkEventIdRust(eventId) {
  const invoke = getTauriInvoke();
  if (!invoke) return false;
  try {
    return await invoke("check_and_mark_event_id", { eventId });
  } catch {
    return false;
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

function sendPrintAck(eventId, ok, error) {
  if (edgeWs && edgeWs.readyState === WebSocket.OPEN) {
    edgeWs.send(JSON.stringify({ type: "print_ack", eventId, ok, error: error || null }));
  }
}

// ── Edge-WS connection management ────────────────────────────────────────────

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
    edgeWs.send(JSON.stringify({ type: "ping" }));
  };

  edgeWs.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      // Print Agent does NOT handle print_job from edge WebSocket.
      // The cashier app is the sole print authority on edge WS.
      // Print Agent only handles print jobs via cloud Socket.IO fallback.
      if (msg.type === "pong") {
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

function startEdgePing() {
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    if (edgeWs && edgeWs.readyState === WebSocket.OPEN) {
      edgeWs.send(JSON.stringify({ type: "ping" }));
    }
  }, 30000);
}

// ── Edge-WS print execution ──────────────────────────────────────────────────

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
  const invoke = getTauriInvoke();
  if (!invoke) {
    console.warn(`[EdgeWS] No Tauri runtime — cannot print [${type}] → ${printerName}`);
    sendPrintAck(eventId, false, "No Tauri runtime available");
    return false;
  }
  try {
    const netMatch = printerName.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/);
    if (netMatch) {
      await invoke("print_network", {
        ip: netMatch[1],
        port: parseInt(netMatch[2], 10),
        bytes,
      });
    } else {
      await invoke("print_raw", { printerName, bytes });
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
}

async function handleEdgePrintJob(envelope) {
  // lanBroadcast wraps as: { type: "print_job", data: { type, data, eventId, ts }, ts }
  const payload = envelope.data || envelope;
  const { type, data, eventId } = payload;
  if (!eventId) {
    console.error(`[EdgeWS] print_job missing eventId — cannot track or ack`);
    sendPrintAck(null, false, "Missing eventId in print_job");
    return;
  }
  // Local fast-path dedup (in-process Set)
  if (!markEventSeen(eventId)) {
    console.log(`[EdgeWS] Duplicate print_job skipped (local cache): ${eventId}`);
    return;
  }
  // Atomic cross-path dedup: test-and-set in a single Rust mutex lock.
  // Returns true if the cloud socket path already printed this eventId.
  const alreadySeen = await checkAndMarkEventIdRust(eventId);
  if (alreadySeen) {
    console.log(`[EdgeWS] Duplicate print_job skipped (cross-path Rust dedup): ${eventId}`);
    sendPrintAck(eventId, true);
    return;
  }

  // Resolve printer: check local mapping first, then DOM dropdowns, then
  // fall back to the printerName sent by the Captain/edge server.
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

  const rawString = Array.isArray(escposData)
    ? escposData.map((d) => d.data || "").join("")
    : String(escposData);
  const bytes = Array.from(new TextEncoder().encode(rawString));

  await doPrint({ type, printerName: targetPrinter, bytes, eventId, tableNumber: data?.tableNumber, attempt: 0 });
}

function setStatus(text, connected) {
  connectionStatus.textContent = text;
  connectionStatus.className = "header-status" + (connected ? " connected" : "");
  // Update tray tooltip so a cashier can see connection status without opening the window
  if (window.__TAURI__) {
    window.__TAURI__.invoke("update_connection_status", { status: text })
      .catch(() => {});
  }
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

// Resolve the Tauri invoke function regardless of API shape (v1 exposes both
// window.__TAURI__.invoke and window.__TAURI__.tauri.invoke when withGlobalTauri
// is enabled). Returns null when not running inside the Tauri webview.
function getTauriInvoke() {
  const t = window.__TAURI__;
  if (!t) return null;
  if (typeof t.invoke === "function") return t.invoke.bind(t);
  if (t.tauri && typeof t.tauri.invoke === "function") return t.tauri.invoke.bind(t.tauri);
  return null;
}

// Populate printer dropdowns from the Rust list_printers command.
// Failures are surfaced in the dropdown text so the user is never left guessing.
async function populatePrinterDropdowns() {
  let printers = [];
  let placeholder = "— Select —";
  const invoke = getTauriInvoke();

  if (!invoke) {
    placeholder = "⚠ Tauri unavailable (run as desktop app)";
    console.error("window.__TAURI__ not available — withGlobalTauri may be off.");
  } else {
    try {
      printers = await invoke("list_printers");
      if (!Array.isArray(printers) || printers.length === 0) {
        placeholder = "⚠ No printers found on this PC";
        console.warn("list_printers returned no printers.");
      }
    } catch (err) {
      placeholder = "⚠ Failed to read printers";
      console.error("Failed to list printers:", err);
      printers = [];
    }
  }

  // Store the full printer list globally so it can be sent to the backend
  systemPrinterList = printers.map(p => (typeof p === "string" ? p : p.name)).filter(Boolean);

  for (const select of [kitchenSelect, barSelect, billSelect]) {
    select.innerHTML = `<option value="">${placeholder}</option>`;
    for (const printer of printers) {
      const opt = document.createElement("option");
      const printerName = typeof printer === "string" ? printer : printer.name;
      const isDefault = typeof printer === "object" && printer.isDefault;
      opt.value = printerName;
      opt.textContent = isDefault ? `${printerName} (Default)` : printerName;
      select.appendChild(opt);
    }
  }
}

// ─── Event Handlers ─────────────────────────────────────────────────────

// Update printer status when dropdowns change
[kitchenSelect, barSelect, billSelect].forEach((sel) => {
  sel.addEventListener("change", () => {
    setPrinterStatus({
      kitchen: kitchenSelect.value ? "online" : "offline",
      bar: barSelect.value ? "online" : "offline",
      bill: billSelect.value ? "online" : "offline",
    });
  });
});

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
    // Load any previously saved mapping from localStorage so we pass it to register AND connect
    const stored = loadStoredSession();
    const initialMapping = (stored && stored.mapping) ? stored.mapping : {};

    const data = await registerAgent({
      setupToken: token,
      restaurantCode: code,
      agentId: AGENT_ID,
      printerMapping: initialMapping,
      availablePrinters: systemPrinterList,
      onAttempt: (attempt, total) => {
        if (attempt > 1) {
          setupError.textContent = `Retrying… (${attempt}/${total})`;
        }
      },
    });

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
      availablePrinters: systemPrinterList,
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

  await updatePrinterMapping(mapping);
  // Push mapping to the local HTTP server so it can resolve empty printerName
  const invoke = getTauriInvoke();
  if (invoke) {
    try {
      await invoke("save_printer_mapping", { mapping });
    } catch (err) {
      console.warn("[Agent] Failed to push mapping to HTTP server:", err);
    }
  }
  setPrinterStatus({
    kitchen: mapping.kitchen ? "online" : "offline",
    bar: mapping.bar ? "online" : "offline",
    bill: mapping.bill ? "online" : "offline",
  });
  mappingMsg.textContent = "Saved! Sending test print…";

  // Send a test print via Tauri
  if (invoke) {
    for (const [type, printerName] of Object.entries(mapping)) {
      if (!printerName) continue;
      try {
        const testStr = "\x1B\x40Test Print — " + type.toUpperCase() + "\n\n\n\x1D\x56\x42\x00";
        const encoder = new TextEncoder();
        const bytes = encoder.encode(testStr);
        await invoke("print_raw", {
          printerName,
          bytes: Array.from(bytes),
        });
      } catch (err) {
        console.error(`Test print failed for ${type}:`, err);
        mappingMsg.textContent = `Test print failed for ${type}: ${err?.message || err}`;
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
  // Push stored mapping to the HTTP server so offline jobs can resolve it
  if (stored.mapping && Object.keys(stored.mapping).length > 0) {
    const invoke = getTauriInvoke();
    if (invoke) {
      invoke("save_printer_mapping", { mapping: stored.mapping }).catch(err => {
        console.warn("[Agent] Failed to push stored mapping to HTTP server:", err);
      });
    }
  }
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
    availablePrinters: systemPrinterList,
  }));

  showConnected(stored.name);
  populatePrinterDropdowns().then(() => {
    // Restore saved mapping selections
    if (stored.mapping.kitchen) kitchenSelect.value = stored.mapping.kitchen;
    if (stored.mapping.bar) barSelect.value = stored.mapping.bar;
    if (stored.mapping.bill) billSelect.value = stored.mapping.bill;
    // Set initial printer status from restored mapping
    setPrinterStatus({
      kitchen: kitchenSelect.value ? "online" : "offline",
      bar: barSelect.value ? "online" : "offline",
      bill: billSelect.value ? "online" : "offline",
    });
  });
  renderPrinterStatus({});
  renderJobs();
} else {
  showSetup();
}

// ─── OS resume/wake reconnect ──────────────────────────────────────────────
// After a Windows sleep/wake cycle, the socket may appear "connected" but
// the underlying TCP connection is dead. Socket.IO's reconnection logic
// will eventually detect this, but it can take 30+ seconds (reconnectionDelayMax).
// These listeners force an immediate reconnect attempt on wake/resume.

let lastVisibilityHidden = false;

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    lastVisibilityHidden = true;
  } else if (document.visibilityState === "visible" && lastVisibilityHidden) {
    lastVisibilityHidden = false;
    // Window became visible again — likely a wake/resume
    forceReconnect();
  }
});

window.addEventListener("online", () => {
  // Network adapter came back online (e.g. after sleep/wake or Wi-Fi reconnect)
  forceReconnect();
});

// ─── Autostart toggle UI ───────────────────────────────────────────────────
// Initialize the autostart checkbox state from the Tauri command and wire
// the change handler. This lets a cashier or IT person disable autostart
// if they replace the PC's role.

async function initAutostartToggle() {
  const checkbox = document.getElementById("autostartToggle");
  if (!checkbox || !window.__TAURI__) return;
  try {
    const enabled = await window.__TAURI__.invoke("is_autostart_enabled");
    checkbox.checked = enabled;
  } catch {
    checkbox.checked = true; // default to checked if command fails
  }
  checkbox.addEventListener("change", async () => {
    try {
      if (checkbox.checked) {
        await window.__TAURI__.invoke("enable_autostart");
      } else {
        await window.__TAURI__.invoke("disable_autostart");
      }
    } catch (err) {
      console.error("[Autostart] Toggle failed:", err);
      // Revert checkbox state on error
      try {
        const enabled = await window.__TAURI__.invoke("is_autostart_enabled");
        checkbox.checked = enabled;
      } catch {}
    }
  });
}

initAutostartToggle();

// ── Start edge server WebSocket for LAN print path ───────────────────────────
// This runs on every startup — the edge server is local (same machine) and
// broadcasts print jobs via WebSocket. Print-agent is the sole canonical print
// receiver: it handles both the cloud Socket.IO path and this LAN edge-WS path.
connectEdgeWebSocket();
startEdgePing();
