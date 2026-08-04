// ─────────────────────────────────────────────────────────────────────────────
// drivers/display/index.ts — Customer Display Driver (v1 stub)
// ─────────────────────────────────────────────────────────────────────────────
// Reserved for future customer-facing display integration (LCD, secondary screen).
// Returns OFFLINE until a real implementation is provided.
// ─────────────────────────────────────────────────────────────────────────────

import { BaseDriver } from "../types.ts";

export class DisplayDriver extends BaseDriver {
  readonly name = "display";
  readonly type = "display" as const;

  async initialize(): Promise<void> {
    this.setState("OFFLINE", "display driver not yet implemented");
  }

  async shutdown(): Promise<void> {
    this.setState("STOPPING", "shutdown requested");
    this.setState("OFFLINE", "shut down");
  }
}
