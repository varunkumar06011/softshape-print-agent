// ─────────────────────────────────────────────────────────────────────────────
// contract/states.ts — SoftShape Runtime state machines (v1)
// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — state names and transitions are stable.
// Every service has a defined state machine. The Cashier UI reads these states
// and renders them directly — no guessing, no inference from side effects.
// ─────────────────────────────────────────────────────────────────────────────

// ── Runtime states ───────────────────────────────────────────────────────────
//
// BOOTING → STARTING → READY → DEGRADED → STOPPING → STOPPED
//                      ↘
//                       → CRASH_LOOP

export type RuntimeState =
  | "BOOTING"
  | "STARTING"
  | "READY"
  | "DEGRADED"
  | "CRASH_LOOP"
  | "STOPPING"
  | "STOPPED";

export const RUNTIME_STATE_TRANSITIONS: Record<RuntimeState, RuntimeState[]> = {
  BOOTING: ["STARTING"],
  STARTING: ["READY", "DEGRADED", "CRASH_LOOP"],
  READY: ["DEGRADED", "STOPPING"],
  DEGRADED: ["READY", "STOPPING"],
  CRASH_LOOP: ["STARTING", "STOPPING"],
  STOPPING: ["STOPPED"],
  STOPPED: [],
};

// ── Sync states ──────────────────────────────────────────────────────────────
//
// DISCONNECTED → CONNECTING → CONNECTED → POLLING (fallback) → DISCONNECTED

export type SyncState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "POLLING";

export const SYNC_STATE_TRANSITIONS: Record<SyncState, SyncState[]> = {
  DISCONNECTED: ["CONNECTING"],
  CONNECTING: ["CONNECTED", "DISCONNECTED"],
  CONNECTED: ["POLLING", "DISCONNECTED"],
  POLLING: ["CONNECTED", "DISCONNECTED"],
};

// ── Driver states (shared by all drivers) ────────────────────────────────────
//
// STARTING → READY → DEGRADED → OFFLINE
//                 ↘            ↗
//                  → STOPPING →

export type DriverState =
  | "STARTING"
  | "READY"
  | "DEGRADED"
  | "OFFLINE"
  | "STOPPING";

export const DRIVER_STATE_TRANSITIONS: Record<DriverState, DriverState[]> = {
  STARTING: ["READY", "OFFLINE"],
  READY: ["DEGRADED", "STOPPING"],
  DEGRADED: ["READY", "OFFLINE", "STOPPING"],
  OFFLINE: ["STARTING", "STOPPING"],
  STOPPING: ["OFFLINE"],
};

// ── Print job states ─────────────────────────────────────────────────────────
//
// QUEUED → PRINTING → PRINTED
//                   ↘
//                     FAILED → RETRYING → PRINTED (or FAILED)
//
// Note: The existing print_job table uses these column values:
//   accepted  → maps to QUEUED
//   printing  → maps to PRINTING
//   printed   → maps to PRINTED
//   failed    → maps to FAILED
//   needs_retry → maps to RETRYING
//   dead_letter → maps to FAILED (terminal, no more retries)
//   cancelled → terminal state (not in the contract state machine)
//
// The contract state names are the canonical names exposed via the API.
// The existing column values are internal storage details.

export type PrintJobState =
  | "QUEUED"
  | "PRINTING"
  | "PRINTED"
  | "FAILED"
  | "RETRYING";

export const PRINT_JOB_STATE_TRANSITIONS: Record<PrintJobState, PrintJobState[]> = {
  QUEUED: ["PRINTING"],
  PRINTING: ["PRINTED", "FAILED"],
  PRINTED: [],
  FAILED: ["RETRYING"],
  RETRYING: ["PRINTING", "FAILED"],
};

// ── State transition logging ─────────────────────────────────────────────────
// Every state transition is logged with oldState, newState, and reason.
// This is how support diagnoses intermittent failures.

export interface StateTransition {
  service: string;
  oldState: RuntimeState | SyncState | DriverState | PrintJobState;
  newState: RuntimeState | SyncState | DriverState | PrintJobState;
  reason: string;
  timestamp: number;
}

// ── Validation helper ────────────────────────────────────────────────────────

export function isValidTransition<S extends string>(
  transitions: Record<S, S[]>,
  from: S,
  to: S,
): boolean {
  return transitions[from]?.includes(to) ?? false;
}
