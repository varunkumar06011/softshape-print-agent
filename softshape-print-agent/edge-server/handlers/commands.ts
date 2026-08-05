// ─────────────────────────────────────────────────────────────────────────────
// handlers/commands.ts — Command type constants and input DTOs
// ─────────────────────────────────────────────────────────────────────────────
// Command types are string constants. Each command defines its input shape
// inline in the registration. This file collects the type constants so the
// route table, tests, and frontend can reference them without importing
// handler internals.
// ─────────────────────────────────────────────────────────────────────────────

export const COMMAND_TYPES = {
  // Orders
  CREATE_ORDER: "CREATE_ORDER",
  ADD_ORDER_ITEMS: "ADD_ORDER_ITEMS",
  CANCEL_ORDER_ITEM: "CANCEL_ORDER_ITEM",
  VOID_ORDER: "VOID_ORDER",

  // KOTs
  SEND_KOT: "SEND_KOT",
  CANCEL_KOT: "CANCEL_KOT",

  // Bills
  GENERATE_BILL: "GENERATE_BILL",
} as const;

export type CommandType = (typeof COMMAND_TYPES)[keyof typeof COMMAND_TYPES];

// ── Input DTOs ───────────────────────────────────────────────────────────────

export interface CreateOrderInput {
  orderId: string;
  tableId: string;
  captainId?: string | null;
  platform?: string;
}

export interface AddOrderItemsInput {
  orderId: string;
  items: Array<{
    id: string;
    menuItemId: string;
    name: string;
    price: number;
    quantity: number;
    notes?: string | null;
  }>;
}

export interface CancelOrderItemInput {
  orderId: string;
  orderItemId: string;
}

export interface VoidOrderInput {
  orderId: string;
}

export interface SendKotInput {
  kotId: string;
  orderId: string;
  tableId: string;
}

export interface CancelKotInput {
  kotId: string;
  orderId: string;
}

export interface GenerateBillInput {
  billId: string;
  orderId: string;
  taxRate?: number;
  serviceChargePercent?: number;
}

// ── Result DTOs ──────────────────────────────────────────────────────────────

export interface CreateOrderResult {
  orderId: string;
  status: string;
}

export interface AddOrderItemsResult {
  orderId: string;
  itemsAdded: number;
}

export interface CancelOrderItemResult {
  orderId: string;
  orderItemId: string;
}

export interface VoidOrderResult {
  orderId: string;
  status: string;
}

export interface SendKotResult {
  kotId: string;
  kotNumber: number;
  counterDate: string;
  itemCount: number;
}

export interface CancelKotResult {
  kotId: string;
  status: string;
}

export interface GenerateBillResult {
  billId: string;
  billNumber: number;
  counterDate: string;
  subtotal: number;
  taxAmount: number;
  serviceCharge: number;
  totalAmount: number;
}
