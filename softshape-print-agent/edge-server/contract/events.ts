// ─────────────────────────────────────────────────────────────────────────────
// contract/events.ts — SoftShape Runtime Event Bus (v1)
// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — event names and payload field names are stable.
// New fields may be added to payloads (clients must ignore unknown fields).
// Existing fields cannot be removed or renamed without a new major version.
//
// Transport: WebSocket
// Endpoint:  ws://localhost:3101/events
// Auth:      { "type": "auth", "token": "<runtime-token>" } on connect
// ─────────────────────────────────────────────────────────────────────────────

import type { SyncState, DriverState, RuntimeState, ConfigSyncState, ConnectionState } from "./states.ts";

// ── Event names ──────────────────────────────────────────────────────────────

export const EVENT_NAMES = {
  ORDER_CREATED: "order.created",
  ORDER_SETTLED: "order.settled",
  TABLE_UPDATED: "table.updated",
  PRINT_COMPLETED: "print.completed",
  PRINT_FAILED: "print.failed",
  SYNC_STATUS: "sync.status",
  DEVICE_STATE_CHANGED: "device.state_changed",
  RUNTIME_STATE_CHANGED: "runtime.state_changed",
  CONFIG_SYNC_STATE_CHANGED: "config_sync.state_changed",
  CONNECTION_STATE_CHANGED: "connection.state_changed",
  CONFIG_SYNC_PROGRESS: "config_sync.progress",
  CONFIG_CHANGED: "config.changed",
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

// ── Event payloads ───────────────────────────────────────────────────────────

export interface OrderCreatedEvent {
  orderId: string;
  tableId: string;
  kotNumber: number;
}

export interface OrderSettledEvent {
  orderId: string;
  tableId: string;
  billNumber: number;
}

export interface TableUpdatedEvent {
  tableId: string;
  status: string;
}

export interface PrintCompletedEvent {
  jobId: number;
  printerName: string;
  ok: true;
}

export interface PrintFailedEvent {
  jobId: number;
  printerName: string;
  ok: false;
  error: string;
}

export interface SyncStatusEvent {
  state: SyncState;
  pendingQueue: number;
}

export interface DeviceStateChangedEvent {
  deviceName: string;
  type: string;
  oldState: DriverState;
  newState: DriverState;
  reason: string;
}

export interface RuntimeStateChangedEvent {
  oldState: RuntimeState;
  newState: RuntimeState;
  isOperational: boolean;
  reason: string;
}

export interface ConfigSyncStateChangedEvent {
  oldState: ConfigSyncState;
  newState: ConfigSyncState;
  reason: string;
  attempt?: number;
  error?: string;
}

export interface ConnectionStateChangedEvent {
  oldState: ConnectionState;
  newState: ConnectionState;
  reason: string;
}

export interface ConfigSyncProgressEvent {
  stage: string;
  entity: string;
  current: number;
  total: number;
  percent: number;
}

// Emitted when a config change (menu item, category, venue price, etc.) is
// applied to local SQLite via socket sync or incremental polling. Frontend
// clients use this to refresh their menu cache without waiting for the next
// poll cycle. `tables` lists the affected SQLite table names.
export interface ConfigChangedEvent {
  tables: string[];
  source: "socket" | "poll";
}

// ── Event union type ─────────────────────────────────────────────────────────

export type RuntimeEvent =
  | { event: typeof EVENT_NAMES.ORDER_CREATED; data: OrderCreatedEvent }
  | { event: typeof EVENT_NAMES.ORDER_SETTLED; data: OrderSettledEvent }
  | { event: typeof EVENT_NAMES.TABLE_UPDATED; data: TableUpdatedEvent }
  | { event: typeof EVENT_NAMES.PRINT_COMPLETED; data: PrintCompletedEvent }
  | { event: typeof EVENT_NAMES.PRINT_FAILED; data: PrintFailedEvent }
  | { event: typeof EVENT_NAMES.SYNC_STATUS; data: SyncStatusEvent }
  | { event: typeof EVENT_NAMES.DEVICE_STATE_CHANGED; data: DeviceStateChangedEvent }
  | { event: typeof EVENT_NAMES.RUNTIME_STATE_CHANGED; data: RuntimeStateChangedEvent }
  | { event: typeof EVENT_NAMES.CONFIG_SYNC_STATE_CHANGED; data: ConfigSyncStateChangedEvent }
  | { event: typeof EVENT_NAMES.CONNECTION_STATE_CHANGED; data: ConnectionStateChangedEvent }
  | { event: typeof EVENT_NAMES.CONFIG_SYNC_PROGRESS; data: ConfigSyncProgressEvent }
  | { event: typeof EVENT_NAMES.CONFIG_CHANGED; data: ConfigChangedEvent };

// ── WebSocket auth message ───────────────────────────────────────────────────

export interface WsAuthMessage {
  type: "auth";
  token: string;
}

// ── Event emitter interface (for internal use) ───────────────────────────────
// The Runtime implements this to broadcast events to connected WebSocket clients.
// Phase 0 defines the interface; actual WebSocket server comes in a later phase.

export interface EventEmitter {
  emit(event: RuntimeEvent): void;
  clientCount(): number;
}
