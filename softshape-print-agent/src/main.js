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
    for (const printer of printers) {
      const opt = document.createElement("option");
      const printerName = typeof printer === "string" ? printer : printer.name;
      opt.value = printerName;
      opt.textContent = printer.isDefault ? `${printerName} (Default)` : printerName;
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
