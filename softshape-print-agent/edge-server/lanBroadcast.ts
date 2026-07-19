// ─────────────────────────────────────────────────────────────────────────────
// lanBroadcast.ts — LAN WebSocket broadcast layer for edge server
// ─────────────────────────────────────────────────────────────────────────────
// Provides real-time event broadcast to captain/cashier apps on the LAN.
// Bun.serve has built-in WebSocket support — we upgrade requests to /ws
// and maintain a set of connected clients. When orderService calls
// lanBroadcast(), the event is pushed to all connected WebSocket clients.
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

const clients = new Set<ClientWS>();

// WebSocket readyState constants (standard)
const WS_OPEN = 1;

let isInitialized = false;

// Called by server.ts to register the WebSocket handler on Bun.serve.
// The server's websocket option is set once; this just marks that it's ready.
export function initLanBroadcast() {
  isInitialized = true;
}

// Register a new WebSocket client (called from server.ts websocket.open)
export function registerClient(ws: ClientWS) {
  clients.add(ws);
  console.log(`[LANBroadcast] Client connected (${clients.size} total)`);
}

// Remove a disconnected client (called from server.ts websocket.close)
export function unregisterClient(ws: ClientWS) {
  clients.delete(ws);
  console.log(`[LANBroadcast] Client disconnected (${clients.size} total)`);
}

// Broadcast an event to all connected LAN clients.
// Silently skips if no clients are connected (no-op, no error).
export function lanBroadcast(type: string, data: any) {
  if (clients.size === 0) return;

  const message = JSON.stringify({
    type,
    data,
    ts: Date.now(),
  });

  for (const ws of clients) {
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

// Get the current number of connected clients (for status endpoint)
export function getLanClientCount(): number {
  return clients.size;
}

// ── Print ack registry ───────────────────────────────────────────────────────
// When the edge server broadcasts a print_job via WebSocket, it waits for the
// Tauri frontend to send back a print_ack confirming the print succeeded (or
// failed). This provides end-to-end print confirmation instead of fire-and-forget.

const pendingPrintAcks = new Map<string, { resolve: (result: { ok: boolean; error?: string }) => void; timeout: any }>();

export function waitForPrintAck(eventId: string, timeoutMs: number = 10000): Promise<{ ok: boolean; error?: string }> {
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
