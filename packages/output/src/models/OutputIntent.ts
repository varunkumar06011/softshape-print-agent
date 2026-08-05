export type OutputIntentType =
  | "PRINT_KOT" | "PRINT_LIQUOR_KOT" | "PRINT_BILL"
  | "PRINT_CANCEL_KOT" | "PRINT_TABLE_SWAP" | "PRINT_X_REPORT"
  | "PRINT_EXPENDITURE" | "PRINT_RECEIPT" | "REPRINT_KOT";

export type OutputPriority = "BACKGROUND" | "NORMAL" | "HIGH" | "CRITICAL";

export interface OutputIntent {
  type: "OUTPUT";
  intentId: string;
  intent: OutputIntentType;
  payload: Record<string, unknown>;
  priority: OutputPriority;
}
