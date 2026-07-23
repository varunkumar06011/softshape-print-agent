// ─────────────────────────────────────────────────────────────────────────────
// drivers/types.ts — SoftShape Driver Interface (v1)
// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — the Driver interface is stable.
// Every hardware device implements this contract.
// The Runtime's Device Manager loads drivers, calls initialize() on startup,
// polls health(), and calls shutdown() on exit.
//
// A plugin (Phase 6) is just an external module that implements Driver.
// ─────────────────────────────────────────────────────────────────────────────

import type { DriverState } from "../contract/states.ts";

export type DriverType = "printer" | "payment" | "barcode" | "scale" | "display";

// ── Driver health ────────────────────────────────────────────────────────────

export interface DriverHealth {
  state: DriverState;
  lastError: string | null;
  lastCheckedAt: number; // unix epoch seconds
  details?: Record<string, unknown>;
}

// ── Driver contract ──────────────────────────────────────────────────────────

export interface Driver {
  readonly name: string;
  readonly type: DriverType;

  initialize(): Promise<void>;
  health(): DriverHealth;
  shutdown(): Promise<void>;
}

// ── Base driver class for common functionality ───────────────────────────────
// Reduces boilerplate in stubs and real drivers alike.

export abstract class BaseDriver implements Driver {
  abstract readonly name: string;
  abstract readonly type: DriverType;

  protected _state: DriverState = "OFFLINE";
  protected _lastError: string | null = null;
  protected _lastCheckedAt: number = 0;

  abstract initialize(): Promise<void>;
  abstract shutdown(): Promise<void>;

  health(): DriverHealth {
    return {
      state: this._state,
      lastError: this._lastError,
      lastCheckedAt: this._lastCheckedAt,
    };
  }

  protected setState(state: DriverState, reason?: string): void {
    const oldState = this._state;
    this._state = state;
    this._lastCheckedAt = Math.floor(Date.now() / 1000);
    if (state === "READY") {
      this._lastError = null;
    }
    // State transitions are logged by the Device Manager, not here,
    // so the manager can emit device.state_changed events.
  }

  protected setError(error: string): void {
    this._lastError = error;
    this._lastCheckedAt = Math.floor(Date.now() / 1000);
  }
}
