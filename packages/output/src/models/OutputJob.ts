import type { OutputPriority, OutputIntentType } from "./OutputIntent";

export type RendererFormat = "escpos";

export interface Destination {
  printerName: string | null;
  printerTarget: string | null;
}

export interface OutputJob {
  jobId: string;
  intentId: string;
  renderer: RendererFormat;
  destination: Destination;
  copies: number;
  priority: OutputPriority;
  intent: OutputIntentType;
  payload: Record<string, unknown>;
}
