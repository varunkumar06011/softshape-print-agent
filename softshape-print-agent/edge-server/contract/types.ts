// ─────────────────────────────────────────────────────────────────────────────
// contract/types.ts — SoftShape Runtime API types (v1)
// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — breaking changes require a new major version.
// Every client (Cashier, Captain, Admin, plugins) depends on these types.
//
// Base URL: http://localhost:3101
// Auth:     Authorization: Bearer <runtime-token>
// Version:  X-Runtime-Version: 1
// ─────────────────────────────────────────────────────────────────────────────

import type { RuntimeState, SyncState, DriverState, PrintJobState } from "./states.ts";

// ── API version ──────────────────────────────────────────────────────────────

export const RUNTIME_API_VERSION = 1 as const;
export const RUNTIME_API_VERSION_HEADER = "X-Runtime-Version";

// ── Health & Runtime ─────────────────────────────────────────────────────────

export interface HealthResponse {
  runtime: {
    state: RuntimeState;
    uptime: number;
    version: string;
  };
  database: {
    state: DriverState;
    sizeBytes: number;
    walCheckpoints: number;
  };
  printService: {
    state: DriverState;
    lastJobAt: number | null;
    consecutiveFailures: number;
  };
  sync: {
    state: SyncState;
    lastPush: number | null;
    pendingQueue: number;
    deadLetters: number;
  };
  devices: DeviceHealth[];
}

export interface DeviceHealth {
  name: string;
  type: DriverType;
  state: DriverState;
  lastError: string | null;
  lastCheckedAt: number;
  details?: Record<string, unknown>;
}

export interface RuntimeStatusResponse {
  running: boolean;
  ready: boolean;
  state: RuntimeState;
  services: {
    printService: { pid: number | null; state: DriverState };
    sync: { state: SyncState };
  };
  lastError: string | null;
}

export interface RuntimeRestartResponse {
  ok: boolean;
}

export interface RuntimeRotateTokenResponse {
  ok: boolean;
  token: string;
}

// ── Orders (hot path) ────────────────────────────────────────────────────────

export interface CreateOrderRequest {
  tableId: string;
  items: OrderItemInput[];
  venueType: string;
  captainId: string;
  notes?: string;
}

export interface OrderItemInput {
  menuItemId: string;
  quantity: number;
  variantId?: string;
  addonIds?: string[];
  notes?: string;
}

export interface CreateOrderResponse {
  ok: boolean;
  orderId: string;
  kotNumber: number;
  printJobIds: number[];
}

export interface UpdateOrderRequest {
  orderId: string;
  items: OrderItemInput[];
}

export interface UpdateOrderResponse {
  ok: boolean;
  kotNumber: number;
  printJobIds: number[];
}

export interface CancelOrderRequest {
  orderId: string;
  kotItemId: string;
  reason?: string;
}

export interface CancelOrderResponse {
  ok: boolean;
  printJobIds: number[];
}

export interface ReprintKotRequest {
  orderId: string;
}

export interface ReprintKotResponse {
  ok: boolean;
  printJobIds: number[];
}

export interface PrintBillRequest {
  orderId: string;
  discountPercent: number;
}

export interface PrintBillResponse {
  ok: boolean;
  billNumber: number;
  printJobIds: number[];
}

export interface SettleOrderRequest {
  orderId: string;
  paymentMethod: string;
  tipAmount?: number;
  cashAmount?: number;
  cardAmount?: number;
}

export interface SettleOrderResponse {
  ok: boolean;
  transactionId: string;
  printJobIds: number[];
}

export interface SwapTableRequest {
  fromTableId: string;
  toTableId: string;
}

export interface SwapTableResponse {
  ok: boolean;
}

export interface TransferItemsRequest {
  fromOrderId: string;
  toOrderId: string;
  items: OrderItemInput[];
}

export interface TransferItemsResponse {
  ok: boolean;
}

export interface UpdateOrderStatusRequest {
  orderId: string;
  status: string;
}

export interface UpdateOrderStatusResponse {
  ok: boolean;
}

export interface GetOrdersResponse {
  orders: ActiveOrder[];
}

export interface ActiveOrder {
  id: string;
  tableId: string;
  status: string;
  items: ActiveOrderItem[];
  kotNumber: number;
  createdAt: number;
}

export interface ActiveOrderItem {
  id: string;
  menuItemId: string;
  name: string;
  quantity: number;
  variantId?: string;
  addonIds?: string[];
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface GetTablesResponse {
  sections: Section[];
}

export interface Section {
  id: string;
  name: string;
  floorId: string;
  venueId: string;
  tables: Table[];
}

export interface Table {
  id: string;
  number: number;
  capacity: number;
  status: string;
  activeOrderId: string | null;
}

export interface GetTablesFlatResponse {
  tables: Table[];
}

export interface GetSectionsResponse {
  sections: Section[];
}

export interface GetMenuResponse {
  categories: MenuCategory[];
}

export interface MenuCategory {
  id: string;
  name: string;
  sortOrder: number;
  items: MenuItem[];
}

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  price: number;
  isAvailable: boolean;
  printerTarget: string | null;
  variants: MenuItemVariant[];
  addons: MenuItemAddon[];
}

export interface MenuItemVariant {
  id: string;
  name: string;
  price: number;
}

export interface MenuItemAddon {
  id: string;
  name: string;
  price: number;
}

export interface GetMenuItemsResponse {
  items: FlatMenuItem[];
}

export interface FlatMenuItem {
  id: string;
  name: string;
  price: number;
  isAvailable: boolean;
  categoryId: string;
}

export interface GetVenuesResponse {
  venues: Venue[];
}

export interface Venue {
  id: string;
  name: string;
  type: string;
  floors: Floor[];
}

export interface Floor {
  id: string;
  name: string;
  sectionCount: number;
}

export interface GetOutletResponse {
  outlet: Outlet;
}

export interface Outlet {
  id: string;
  name: string;
  currency: string;
  taxEnabled: boolean;
  serviceChargeEnabled: boolean;
}

export interface GetStaffResponse {
  staff: StaffMember[];
  outletId: string | null;
}

export interface StaffMember {
  id: string;
  name: string;
  role: string;
}

// ── Auth (local) ─────────────────────────────────────────────────────────────

export interface PinLoginRequest {
  pin: string;
}

export interface PinLoginResponse {
  ok: boolean;
  staffId: string;
  name: string;
  role: string;
}

// ── Sync ─────────────────────────────────────────────────────────────────────

export interface SyncStatusResponse {
  socket: SyncState;
  lastPush: number | null;
  pendingQueue: number;
  deadLetters: number;
}

export interface SyncPushResponse {
  ok: boolean;
  pushed: number;
}

export interface SyncRetryResponse {
  ok: boolean;
  retried: number;
}

// ── Devices ──────────────────────────────────────────────────────────────────

export interface GetDevicesResponse {
  devices: DeviceInfo[];
}

export interface DeviceInfo {
  name: string;
  type: DriverType;
  state: DriverState;
  lastError: string | null;
  lastCheckedAt: number;
}

export interface GetPrintersResponse {
  printers: PrinterInfo[];
}

export interface PrinterInfo {
  name: string;
  isDefault: boolean;
}

// ── Shared types ─────────────────────────────────────────────────────────────

export type DriverType = "printer" | "payment" | "barcode" | "scale" | "display";

// ── Error response (all endpoints) ───────────────────────────────────────────

export interface ErrorResponse {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}
