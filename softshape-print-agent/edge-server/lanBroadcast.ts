// ─────────────────────────────────────────────────────────────────────────────
// lanBroadcast.ts — LAN WebSocket broadcast layer for edge server
// ─────────────────────────────────────────────────────────────────────────────
// Provides real-time event broadcast to captain/cashier apps on the LAN.
// Bun.serve has built-in WebSocket support — we upgrade requests to /ws
// and maintain a set of connected clients. When orderService calls
// lanBroadcast(), the event is pushed to all connected WebSocket clients.
//
// Clients register their capabilities on connect via a "register" message:
//   { type: "register", canPrint: true }  — Tauri desktop with physical printers
//   { type: "register", canPrint: false } — Captain web/APK (no local printers)
// This allows the edge server to distinguish printing clients from non-printing
// ones, so print_job events are only sent to clients that can actually print.
//
// Event format (JSON): { type: "order:created", data: { ... }, ts: <epoch_ms> }
//
// Events broadcasted:
//   order:created   — new order created (captain submitted KOT)
//   order:updated   — items added to existing order
//   order:settled   — order settled + table freed
//   table:updated   — table state changed (status, workflow, bill)
//   print_job       — print job dispatched to printing clients only
// ─────────────────────────────────────────────────────────────────────────────

type ClientWS = { readyState: number; send(data: string): void };

interface ClientInfo {
  ws: ClientWS;
  canPrint: boolean;
  registered: boolean;
}

// All connected clients, keyed by the WebSocket object.
const clients = new Map<ClientWS, ClientInfo>();

// WebSocket readyState constants (standard)
const WS_OPEN = 1;

let isInitialized = false;

// Called by server.ts to register the WebSocket handler on Bun.serve.
// The server's websocket option is set once; this just marks that it's ready.
export function initLanBroadcast() {
  isInitialized = true;
}

// Register a new WebSocket client (called from server.ts websocket.open).
// New clients default to canPrint=false until they send a "register" message
// declaring their capabilities. This prevents non-Tauri clients (captain web/APK)
// from being counted as printing clients.
export function registerClient(ws: ClientWS) {
  clients.set(ws, { ws, canPrint: false, registered: false });
  console.log(`[LANBroadcast] Client connected (${clients.size} total, ${getPrintingClientCount()} printing)`);
}

// Update a client's capabilities after they send a "register" message.
export function setClientCapability(ws: ClientWS, canPrint: boolean) {
  const info = clients.get(ws);
  if (info) {
    info.canPrint = canPrint;
    info.registered = true;
    console.log(`[LANBroadcast] Client registered (canPrint=${canPrint}, ${clients.size} total, ${getPrintingClientCount()} printing)`);
  }
}

// Remove a disconnected client (called from server.ts websocket.close)
export function unregisterClient(ws: ClientWS) {
  clients.delete(ws);
  console.log(`[LANBroadcast] Client disconnected (${clients.size} total, ${getPrintingClientCount()} printing)`);
}

// Broadcast an event to ALL connected LAN clients (order/table events).
// Silently skips if no clients are connected (no-op, no error).
export function lanBroadcast(type: string, data: any) {
  if (clients.size === 0) return;

  const message = JSON.stringify({
    type,
    data,
    ts: Date.now(),
  });

  for (const [ws, info] of clients) {
    try {
      if (ws.readyState === WS_OPEN) {
        ws.send(message);
      }
    } catch {
      // Client may have disconnected — remove it
      clients.delete(ws);
    }
  }
}

// Broadcast a print_job event ONLY to printing-capable clients (Tauri desktops).
// Returns true if at least one printing client received the message.
export function broadcastPrintJob(type: string, data: any): boolean {
  const message = JSON.stringify({
    type,
    data,
    ts: Date.now(),
  });

  let sent = false;
  for (const [ws, info] of clients) {
    if (!info.canPrint) continue;
    try {
      if (ws.readyState === WS_OPEN) {
        ws.send(message);
        sent = true;
      }
    } catch {
      clients.delete(ws);
    }
  }
  return sent;
}

// Get the total number of connected clients (for status endpoint)
export function getLanClientCount(): number {
  return clients.size;
}

// Get the number of printing-capable clients (Tauri desktops with printers).
// Used by the print dispatch logic to decide whether to broadcast via LAN WS
// or fall back to cloud relay.
export function getPrintingClientCount(): number {
  let count = 0;
  for (const info of clients.values()) {
    if (info.canPrint) count++;
  }
  return count;
}

// ── Print ack registry ───────────────────────────────────────────────────────
// When the edge server broadcasts a print_job via WebSocket, it waits for the
// Tauri frontend to send back a print_ack confirming the print succeeded (or
// failed). This provides end-to-end print confirmation instead of fire-and-forget.

const pendingPrintAcks = new Map<string, { resolve: (result: { ok: boolean; error?: string }) => void; timeout: any }>();

export function waitForPrintAck(eventId: string, timeoutMs: number = 20000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (pendingPrintAcks.delete(eventId)) {
        resolve({ ok: false, error: "Print ack timeout" });
      }
    }, timeoutMs);
    pendingPrintAcks.set(eventId, { resolve, timeout });
  });
}

export function resolvePrintAck(eventId: string, ok: boolean, error?: string) {
  const pending = pendingPrintAcks.get(eventId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingPrintAcks.delete(eventId);
    pending.resolve({ ok, error });
  }
}
