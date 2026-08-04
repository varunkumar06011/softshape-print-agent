// ─────────────────────────────────────────────────────────────────────────────
// drivers/plugins/example-display.ts — Example Plugin (Phase 6)
// ─────────────────────────────────────────────────────────────────────────────
// A minimal example showing how to write an external driver plugin.
// This plugin simulates a customer-facing display (e.g., a secondary monitor
// showing order totals). It reports READY immediately.
//
// To activate: drop this file in drivers/plugins/ and call
//   POST /api/edge/drivers/reload
// ─────────────────────────────────────────────────────────────────────────────

import { BaseDriver } from "../types.ts";

export default class ExampleDisplay extends BaseDriver {
  readonly name = "example-display";
  readonly type = "display" as const;

  async initialize(): Promise<void> {
    this.setState("READY");
  }

  async shutdown(): Promise<void> {
    this.setState("STOPPING", "shutdown requested");
    this.setState("OFFLINE", "shut down");
  }
}
