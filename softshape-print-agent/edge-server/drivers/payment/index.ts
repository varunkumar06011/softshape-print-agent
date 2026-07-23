// ─────────────────────────────────────────────────────────────────────────────
// drivers/payment/index.ts — Payment Driver (v1 stub)
// ─────────────────────────────────────────────────────────────────────────────
// Reserved for future payment terminal integration (UPI, card, QR payments).
// Returns OFFLINE until a real implementation is provided.
// ─────────────────────────────────────────────────────────────────────────────

import { BaseDriver } from "../types.ts";

export class PaymentDriver extends BaseDriver {
  readonly name = "payment";
  readonly type = "payment" as const;

  async initialize(): Promise<void> {
    this.setState("OFFLINE", "payment driver not yet implemented");
  }

  async shutdown(): Promise<void> {
    this.setState("STOPPING", "shutdown requested");
    this.setState("OFFLINE", "shut down");
  }
}
