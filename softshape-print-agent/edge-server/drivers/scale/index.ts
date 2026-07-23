// ─────────────────────────────────────────────────────────────────────────────
// drivers/scale/index.ts — Scale Driver (v1 stub)
// ─────────────────────────────────────────────────────────────────────────────
// Reserved for future weighing scale integration.
// Returns OFFLINE until a real implementation is provided.
// ─────────────────────────────────────────────────────────────────────────────

import { BaseDriver } from "../types.ts";

export class ScaleDriver extends BaseDriver {
  readonly name = "scale";
  readonly type = "scale" as const;

  async initialize(): Promise<void> {
    this.setState("OFFLINE", "scale driver not yet implemented");
  }

  async shutdown(): Promise<void> {
    this.setState("STOPPING", "shutdown requested");
    this.setState("OFFLINE", "shut down");
  }
}
