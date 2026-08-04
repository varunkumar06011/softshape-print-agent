// ─────────────────────────────────────────────────────────────────────────────
// drivers/barcode/index.ts — Barcode Driver (v1 stub)
// ─────────────────────────────────────────────────────────────────────────────
// Reserved for future barcode scanner integration.
// Returns OFFLINE until a real implementation is provided.
// ─────────────────────────────────────────────────────────────────────────────

import { BaseDriver } from "../types.ts";

export class BarcodeDriver extends BaseDriver {
  readonly name = "barcode";
  readonly type = "barcode" as const;

  async initialize(): Promise<void> {
    this.setState("OFFLINE", "barcode driver not yet implemented");
  }

  async shutdown(): Promise<void> {
    this.setState("STOPPING", "shutdown requested");
    this.setState("OFFLINE", "shut down");
  }
}
