// ─────────────────────────────────────────────────────────────────────────────
// eventBus.ts — Runtime Event Bus (Phase 0 contract, wired in Phase 6+)
// ─────────────────────────────────────────────────────────────────────────────
// Broadcasts RuntimeEvent messages to all connected WebSocket clients.
// Events are emitted from orderService, printService, sync, and deviceManager.
//
// WebSocket endpoint: ws://localhost:3101/events
// Auth: { "type": "auth", "token": "<runtime-token>" } on connect
// ─────────────────────────────────────────────────────────────────────────────

import type { RuntimeEvent } from "./contract/events.ts";
import { validateRuntimeToken } from "./contract/auth.ts";
import { runtimeLog } from "./contract/logger.ts";

// ── Authenticated WebSocket client set ───────────────────────────────────────

interface EventClient {
  ws: import("bun").ServerWebSocket<unknown>;
  authenticated: boolean;
}

const clients: Set<EventClient> = new Set();

// ── Register a new WebSocket client (unauthenticated until auth message) ─────

export function registerEventClient(ws: import("bun").ServerWebSocket<unknown>): EventClient {
  const client: EventClient = { ws, authenticated: false };
  clients.add(client);
  return client;
}

// ── Handle incoming message from a WebSocket client ──────────────────────────

export function handleEventMessage(client: EventClient, message: string): void {
  try {
    const data = JSON.parse(message);
    if (data.type === "auth" && data.token) {
      if (validateRuntimeToken(`Bearer ${data.token}`)) {
        client.authenticated = true;
        client.ws.send(JSON.stringify({ type: "auth_ok" }));
        runtimeLog.info("WebSocket client authenticated", { clientCount: clients.size });
      } else {
        client.ws.send(JSON.stringify({ type: "auth_failed", error: "Invalid token" }));
        client.ws.close();
      }
    } else if (data.type === "ping") {
      client.ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
    }
  } catch {
    // Ignore non-JSON messages
  }
}

// ── Unregister a WebSocket client ────────────────────────────────────────────

export function unregisterEventClient(client: EventClient): void {
  clients.delete(client);
}

// ── Broadcast an event to all authenticated clients ──────────────────────────

export function emitEvent(event: RuntimeEvent): void {
  const payload = JSON.stringify(event);
  let sent = 0;
  for (const client of clients) {
    if (client.authenticated) {
      try {
        client.ws.send(payload);
        sent++;
      } catch {
        // Client may have disconnected — will be cleaned up by close handler
      }
    }
  }
  if (sent > 0) {
    runtimeLog.debug("Event emitted", { event: event.event, clients: sent });
  }
}

// ── Get connected client count ───────────────────────────────────────────────

export function getEventClientCount(): number {
  return clients.size;
}

export function getAuthenticatedClientCount(): number {
  let count = 0;
  for (const client of clients) {
    if (client.authenticated) count++;
  }
  return count;
}
