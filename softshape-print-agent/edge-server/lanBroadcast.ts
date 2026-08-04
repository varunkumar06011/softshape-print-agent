// ─────────────────────────────────────────────────────────────────────────────
// lanBroadcast.ts — LAN WebSocket broadcast layer for edge server
// ─────────────────────────────────────────────────────────────────────────────
// Provides real-time event broadcast to captain/cashier apps on the LAN.
// Bun.serve has built-in WebSocket support — we upgrade requests to /ws
// and maintain a set of connected clients. When orderService calls
// lanBroadcast(), the event is pushed to all connected WebSocket clients.
//
// Clients register on connect via a "register" message.
// Note: print jobs are NO LONGER dispatched via WebSocket — the edge server
// print service on :3103 is the sole print transport (ADR-001).
// The register message is accepted but no longer tracked for print capability.
//
// Event format (JSON): { type: "order:created", data: { ... }, ts: <epoch_ms> }
//
// Events broadcasted:
//   order:created   — new order created (captain submitted KOT)
//   order:updated   — items added to existing order
//   order:settled   — order settled + table freed
//   table:updated   — table state changed (status, workflow, bill)
// ─────────────────────────────────────────────────────────────────────────────

type ClientWS = { readyState: number; send(data: string): void };

interface ClientInfo {
  ws: ClientWS;
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
export function registerClient(ws: ClientWS) {
  clients.set(ws, { ws, registered: false });
  console.log(`[LANBroadcast] Client connected (${clients.size} total)`);
}

// Mark a client as registered after they send a "register" message.
export function setClientRegistered(ws: ClientWS) {
  const info = clients.get(ws);
  if (info) {
    info.registered = true;
    console.log(`[LANBroadcast] Client registered (${clients.size} total)`);
  }
}

// Remove a disconnected client (called from server.ts websocket.close)
export function unregisterClient(ws: ClientWS) {
  clients.delete(ws);
  console.log(`[LANBroadcast] Client disconnected (${clients.size} total)`);
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

// Get the total number of connected clients (for status endpoint)
export function getLanClientCount(): number {
  return clients.size;
}
