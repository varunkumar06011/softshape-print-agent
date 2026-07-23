// ─────────────────────────────────────────────────────────────────────────────
// drivers/printer/index.ts — Printer Driver (v1)
// ─────────────────────────────────────────────────────────────────────────────
// Delegates to the headless Rust print service on :3103.
// The printer driver is the bridge between the Runtime's print queue
// and the isolated print service process. It does NOT call Win32 directly.
//
// Health is derived from the print service's readiness:
//   - Print service ready → READY
//   - Print service started but not ready → STARTING
//   - Print service not started → OFFLINE
//   - Print service errors → DEGRADED
// ─────────────────────────────────────────────────────────────────────────────

import { BaseDriver } from "../types.ts";
import { isPrintServiceReady, getPrintServiceStatus, startPrintService } from "../../printServiceManager.ts";

export class PrinterDriver extends BaseDriver {
  readonly name = "printer";
  readonly type = "printer" as const;

  async initialize(): Promise<void> {
    const started = await startPrintService();
    if (!started) {
      this.setState("OFFLINE", "print service could not be started");
      return;
    }

    if (isPrintServiceReady()) {
      this.setState("READY");
    } else {
      this.setState("STARTING", "print service starting up");
    }
  }

  health() {
    const status = getPrintServiceStatus();
    if (status.state === "ready") {
      if (this._state !== "READY") {
        this.setState("READY");
      }
    } else if (status.state === "starting") {
      if (this._state !== "STARTING") {
        this.setState("STARTING", "print service starting");
      }
    } else if (status.state === "error" || status.state === "crashed") {
      if (this._state !== "DEGRADED") {
        this.setState("DEGRADED", status.lastError || "print service error");
      }
    } else if (status.state === "offline" || status.state === "unknown") {
      if (this._state !== "OFFLINE") {
        this.setState("OFFLINE", "print service not running");
      }
    }

    return super.health();
  }

  async shutdown(): Promise<void> {
    this.setState("STOPPING", "shutdown requested");
    this.setState("OFFLINE", "shut down");
  }
}
