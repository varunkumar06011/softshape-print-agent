// ─────────────────────────────────────────────────────────────────────────────
// orderService.ts — Local order creation + KOT printing (the hot path)
// ─────────────────────────────────────────────────────────────────────────────
// This is the Petpooja-style fast path:
//   1. Write to local SQLite (1 transaction, 4-5 queries, ~2ms)
//   2. Build ESC/POS bytes (pure string ops, ~1ms)
//   3. Print directly via Tauri USB (~10-30ms)
//   4. Return HTTP response to captain (~1ms over LAN)
//   5. Sync to cloud in background (fire-and-forget)
//
// Total: 15-40ms from button press to printer starting.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, getNextKotNumber, enqueueSync, getKolkataDateString } from "./db.ts";
import { buildFoodKOT, buildLiquorKOT, buildCancelKOT, buildBill, type PrintItem, type OrderData } from "./escpos.ts";
import { printToPrinter, printGrouped, resolvePrinterName } from "./printer.ts";
import { lanBroadcast } from "./lanBroadcast.ts";

// ─── Shared KOT print group builder ─────────────────────────────────────────
// Consolidates the KOT grouping logic used by both createOrder and updateOrderItems.
// Groups items by resolved printer name, with legacy menuType fallback.

interface EdgeKotItem {
  name: string;
  quantity: number;
  price: number | string;
  notes?: string | null;
  menuType?: string;
  printerName?: string | null;
  printerTarget?: string | null;
}

function buildKotPrintGroups(
  mappedItems: EdgeKotItem[],
  kotOrderData: OrderData,
  table: any,
  printerConfig: Record<string, any>,
): Array<{ printerName: string; escposData: any[] }> {
  const groupedByPrinter = new Map<string | undefined, EdgeKotItem[]>();
  for (const item of mappedItems) {
    const key = item.printerName;
    if (!groupedByPrinter.has(key)) groupedByPrinter.set(key, []);
    groupedByPrinter.get(key)!.push(item);
  }

  const printGroups: Array<{ printerName: string; escposData: any[] }> = [];

  for (const [printerName, groupItems] of groupedByPrinter) {
    if (!printerName) {
      // Legacy fallback: split by menuType
      const kitchenItems = groupItems.filter((i) => i.printerTarget !== "BAR_PRINTER" && i.menuType !== "LIQUOR");
      const barItems = groupItems.filter((i) => i.printerTarget === "BAR_PRINTER" || i.menuType === "LIQUOR");

      if (kitchenItems.length > 0) {
        const kitchenPrintItems = kitchenItems.map((i) => ({
          name: i.name, quantity: i.quantity, price: Number(i.price), notes: i.notes ?? null, type: "food" as const,
        }));
        const escpos = buildFoodKOT({ ...kotOrderData, items: kitchenPrintItems });
        if (escpos.length > 0) {
          const fallbackPrinter = table.kot_printer_name || resolvePrinterName(null, "KOT_PRINTER", null, printerConfig);
          if (fallbackPrinter) {
            printGroups.push({ printerName: fallbackPrinter, escposData: escpos });
          } else {
            console.error(`[KOT] SILENT DROP: ${kitchenItems.length} kitchen items for table ${kotOrderData.tableNumber} — no KOT printer resolved (no item override, no category target, no KITCHEN-type printer in config)`);
          }
        }
      }
      if (barItems.length > 0) {
        const barPrintItems = barItems.map((i) => ({
          name: i.name, quantity: i.quantity, price: Number(i.price), notes: i.notes ?? null, type: "liquor" as const,
        }));
        const escpos = buildLiquorKOT({ ...kotOrderData, items: barPrintItems });
        if (escpos.length > 0) {
          const fallbackPrinter = resolvePrinterName(null, "BAR_PRINTER", null, printerConfig);
          if (fallbackPrinter) {
            printGroups.push({ printerName: fallbackPrinter, escposData: escpos });
          } else {
            console.error(`[KOT] SILENT DROP: ${barItems.length} bar items for table ${kotOrderData.tableNumber} — no BAR printer resolved (no item override, no category target, no BAR-type printer in config)`);
          }
        }
      }
    } else {
      // Precise printer routing
      const isAllLiquor = groupItems.every((i) => i.menuType === "LIQUOR");
      const builder = isAllLiquor ? buildLiquorKOT : buildFoodKOT;
      const printItems = groupItems.map((i) => ({
        name: i.name, quantity: i.quantity, price: Number(i.price), notes: i.notes ?? null,
        type: (i.menuType === "LIQUOR" ? "liquor" : "food") as "food" | "liquor",
      }));
      const escpos = builder({ ...kotOrderData, items: printItems });
      if (escpos.length > 0) {
        printGroups.push({ printerName, escposData: escpos });
      }
    }
  }

  return printGroups;
}

// ─── Active order statuses ───────────────────────────────────────────────────

const ACTIVE_ORDER_STATUSES = ["PENDING", "CONFIRMED", "PREPARING", "READY", "BILLING_REQUESTED"];

// ─── Server-side price resolution (Bug 1 fix) ───────────────────────────────
// Mirrors the cloud buildVenuePriceMap: resolves the venue's price profile
// from local SQLite and returns a map of menuItemId → resolved price.
// Falls back to menu_item.base_price, then default variant price.

function buildEdgePriceMap(venueId: string | null | undefined, restaurantId: string): Map<string, number> {
  const db = getDb();
  const priceMap = new Map<string, number>();

  if (!venueId) return priceMap;

  // 1. Look up venue → priceProfileId
  const venue = db.query("SELECT price_profile_id FROM venue WHERE id = ?").get(venueId) as any;
  if (!venue?.price_profile_id) return priceMap;

  // 2. Load all price profile items for this profile
  const profileItems = db.query("SELECT menu_item_id, price FROM price_profile_item WHERE price_profile_id = ?").all(venue.price_profile_id) as any[];
  for (const pi of profileItems) {
    priceMap.set(pi.menu_item_id, Number(pi.price));
  }

  return priceMap;
}

// Resolve a single item's price: priceMap → base_price → default variant price → client fallback
function resolveItemPrice(
  menuItemId: string,
  priceMap: Map<string, number>,
  menuItemMap: Map<string, any>,
  clientPrice: number,
): number {
  const resolved = priceMap.get(menuItemId);
  if (resolved != null && resolved > 0) return resolved;

  const mi = menuItemMap.get(menuItemId);
  if (mi) {
    const base = Number(mi.base_price ?? 0);
    if (base > 0) return base;
  }

  // Try default variant
  if (mi) {
    const db = getDb();
    const variant = db.query("SELECT price FROM menu_item_variant WHERE menu_item_id = ? AND is_default = 1 LIMIT 1").get(menuItemId) as any;
    if (variant && Number(variant.price) > 0) return Number(variant.price);
  }

  // Last resort: client-sent price (already validated as >= 0)
  return Number(clientPrice);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CreateOrderInput {
  tableId: string;
  items: Array<{
    menuItemId: string;
    name: string;
    price: number;
    quantity: number;
    notes?: string | null;
    menuType?: string;
  }>;
  captainId?: string;
  captainName?: string;
  createdByUserId?: string;
  platform?: string;
  requestId?: string;
  orderByRole?: string;
  localPrinted?: boolean;
  kotEventIds?: string[] | null;
}

export interface CreateOrderResult {
  success: boolean;
  orderId?: string;
  kotNumber?: number;
  kotId?: string;
  table?: any;
  order?: any;
  printResults?: any[];
  error?: string;
  statusCode?: number;
}

// ─── Helper: Safe JSON parse ──────────────────────────────────────────────────

function safeParseJson<T>(raw: any, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ─── Helper: Get outlet settings from local DB ───────────────────────────────

function getOutlet(restaurantId: string): any | null {
  const db = getDb();
  const row = db.query("SELECT * FROM outlet WHERE id = ?").get(restaurantId) as any | null;
  if (!row) return null;
  return {
    ...row,
    printerConfig: safeParseJson(row.printer_config, {}),
    enabledModules: safeParseJson(row.enabled_modules, {}),
    pricesIncludeGst: !!row.prices_include_gst,
    gstRegistered: !!row.gst_registered,
  };
}

// ─── Helper: Get table with section info ─────────────────────────────────────

function getTableWithSection(tableId: string): any | null {
  const db = getDb();
  const row = db.query(`
    SELECT t.*, s.name as section_name, s.venue_id, s.floor_id,
           v.name as venue_name, v.venue_type, v.kot_enabled, v.kot_printer_name, v.bill_printer_name,
           v.price_profile_id, v.tax_profile_id
    FROM "table" t
    LEFT JOIN section s ON t.section_id = s.id
    LEFT JOIN venue v ON s.venue_id = v.id
    WHERE t.id = ?
  `).get(tableId) as any | null;
  return row;
}

// ─── Helper: Get menu item with category for printer routing ─────────────────

function getMenuItemsWithCategories(menuItemIds: string[]): Map<string, any> {
  const db = getDb();
  const map = new Map<string, any>();

  if (menuItemIds.length === 0) return map;

  const placeholders = menuItemIds.map(() => "?").join(",");
  const rows = db.query(`
    SELECT m.*, c.name as category_name, c.printer_target as category_printer_target
    FROM menu_item m
    LEFT JOIN category c ON m.category_id = c.id
    WHERE m.id IN (${placeholders})
  `).all(...menuItemIds) as any[];

  for (const row of rows) {
    map.set(row.id, {
      ...row,
      is_veg: !!row.is_veg,
      is_available: !!row.is_available,
      is_deleted: !!row.is_deleted,
      gst_enabled: !!row.gst_enabled,
    });
  }

  return map;
}

// ─── Helper: Format table number for display ─────────────────────────────────

function formatTableNumber(table: any): string {
  const sectionTag = table?.section_tag;
  const sectionName = table?.section_name;
  const venueType = table?.venue_type;

  if (sectionTag && sectionTag.startsWith("venue-")) {
    return table.label || String(table.number);
  }

  // Bar outlet: B prefix, Restaurant: T prefix
  if (venueType === "BAR" || (sectionTag && sectionTag.includes("bar"))) {
    return `B${table.number}`;
  }
  return `T${table.number}`;
}

// ─── Helper: Build KOT history entry ─────────────────────────────────────────

function buildKotHistoryEntry(kotNumber: number, items: any[]): any {
  return {
    id: String(kotNumber),
    time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }),
    items: items.map((i) => ({
      id: i.menuItemId,
      n: i.name,
      p: Number(i.price),
      q: i.quantity,
      s: "KOT Sent",
      orderItemId: i.orderItemId,
      notes: i.notes,
    })),
  };
}

// ─── Create Order (the hot path) ─────────────────────────────────────────────

export async function createOrder(
  restaurantId: string,
  input: CreateOrderInput
): Promise<CreateOrderResult> {
  const { tableId, items, captainId, captainName, createdByUserId, platform, requestId, orderByRole, localPrinted } = input;

  if (!items || items.length === 0) {
    return { success: false, error: "No items in order", statusCode: 400 };
  }

  const db = getDb();

  // ── Idempotency check: if requestId already exists, return existing order ──
  if (requestId) {
    const existing = db.query("SELECT * FROM order_record WHERE last_request_id = ?").get(requestId) as any;
    if (existing) {
      // Return the existing order — duplicate request
      const existingItems = db.query("SELECT * FROM order_item WHERE order_id = ?").all(existing.id) as any[];
      return {
        success: true,
        orderId: existing.id,
        kotNumber: 0, // Already created before
        order: { ...existing, items: existingItems },
        error: "Duplicate request — returning existing order",
      };
    }
  }

  // ── Check for active order on table ────────────────────────────────────────
  const activeOrder = db.query(
    `SELECT * FROM order_record WHERE table_id = ? AND restaurant_id = ? AND status IN (${ACTIVE_ORDER_STATUSES.map(() => "?").join(",")}) AND is_deleted = 0`
  ).get(tableId, restaurantId, ...ACTIVE_ORDER_STATUSES) as any;

  if (activeOrder) {
    return {
      success: false,
      error: "Table already has an active order — use update items instead",
      statusCode: 409,
      orderId: activeOrder.id,
    };
  }

  // ── Get table + outlet info ────────────────────────────────────────────────
  const table = getTableWithSection(tableId);
  if (!table) {
    return { success: false, error: "Table not found", statusCode: 404 };
  }

  const outlet = getOutlet(restaurantId);
  if (!outlet) {
    return { success: false, error: "Outlet not found in local DB", statusCode: 404 };
  }

  // ── Get menu items with categories for printer routing ─────────────────────
  const menuItemIds = items.map((i) => i.menuItemId).filter(Boolean);
  const menuItemMap = getMenuItemsWithCategories(menuItemIds);

  // ── Server-side price resolution (Bug 1 fix) ──────────────────────────────
  // Never trust client-sent prices — resolve from local SQLite price profiles.
  const venueId = table.venue_id ?? null;
  const priceMap = buildEdgePriceMap(venueId, restaurantId);
  const resolvedItems = items.map((i) => ({
    ...i,
    price: resolveItemPrice(i.menuItemId, priceMap, menuItemMap, Number(i.price)),
  }));

  // ── Calculate total using resolved prices ───────────────────────────────────
  const totalAmount = resolvedItems.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);

  // ── Generate IDs ───────────────────────────────────────────────────────────
  const orderId = crypto.randomUUID();
  const kotId = crypto.randomUUID();
  const kotNumber = getNextKotNumber(restaurantId);

  // ── Transaction: create order + items + KOT + update table ──────────────────
  const tx = db.transaction(() => {
    const now = Date.now();

    // 1. Create order
    db.query(`INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, captain_id, platform, created_by_user_id, last_request_id, created_at, updated_at, cloud_synced)
      VALUES (?, ?, ?, 'PREPARING', ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(orderId, tableId, restaurantId, totalAmount, captainId || null, platform || "DINE_IN", createdByUserId || null, requestId || null, now, now);

    // 2. Create order items (using resolved prices)
    for (const item of resolvedItems) {
      const orderItemId = crypto.randomUUID();
      db.query(`INSERT INTO order_item (id, order_id, menu_item_id, name, price, quantity, notes, menu_type, cloud_synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(orderItemId, orderId, item.menuItemId, item.name, Number(item.price), item.quantity, item.notes || null, item.menuType || "FOOD");
    }

    // 3. Create KOT
    db.query(`INSERT INTO kot (id, restaurant_id, table_id, order_id, kot_number, created_at, cloud_synced)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(kotId, restaurantId, tableId, orderId, kotNumber, now);

    // 4. Create KOT items
    const orderItems = db.query("SELECT * FROM order_item WHERE order_id = ?").all(orderId) as any[];
    for (const oi of orderItems) {
      const kotItemId = crypto.randomUUID();
      db.query(`INSERT INTO kot_item (id, kot_id, order_item_id, menu_item_id, name, quantity, price, notes, status, created_at, cloud_synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, 0)
      `).run(kotItemId, kotId, oi.id, oi.menu_item_id, oi.name, oi.quantity, oi.price, oi.notes, now);
    }

    // 5. Update table status
    db.query(`UPDATE "table" SET status = 'OCCUPIED', workflow_status = 'Preparing', current_bill = current_bill + ?, updated_at = ? WHERE id = ?`)
      .run(totalAmount, now, tableId);

    // 6. Update KOT history on table (safe parse — corrupted JSON should not crash the transaction)
    let currentHistory: any[] = [];
    try {
      currentHistory = JSON.parse(table.kot_history || "[]") as any[];
      if (!Array.isArray(currentHistory)) currentHistory = [];
    } catch {
      currentHistory = [];
    }
    // Map by index to handle duplicate menuItemIds correctly
    const kotEntry = buildKotHistoryEntry(kotNumber, resolvedItems.map((i, idx) => ({ ...i, orderItemId: orderItems[idx]?.id })));
    currentHistory.push(kotEntry);
    db.query(`UPDATE "table" SET kot_history = ? WHERE id = ?`).run(JSON.stringify(currentHistory), tableId);

    // 7. Enqueue sync records for cloud push
    enqueueSync("order", orderId, "insert");
    enqueueSync("kot", kotId, "insert");
    enqueueSync("table", tableId, "update");
  });

  try {
    tx();
  } catch (err: any) {
    // UNIQUE constraint violation on last_request_id — duplicate request
    if (err.message && err.message.includes("UNIQUE")) {
      return { success: false, error: "Duplicate request — order already exists", statusCode: 409 };
    }
    throw err;
  }

  // ── Build ESC/POS and print ────────────────────────────────────────────────
  const formattedTableNumber = formatTableNumber(table);
  const restaurantName = outlet.receipt_header || outlet.name;
  const sectionName = table.section_name || "Main Hall";
  const sectionTag = table.section_tag;

  // Resolve printer for each item (using resolved prices)
  const printerConfig = outlet.printerConfig || {};
  const mappedItems = resolvedItems.map((i) => {
    const cat = menuItemMap.get(i.menuItemId) || {};
    const resolvedPrinterName = resolvePrinterName(
      cat.printer_name || null,
      cat.printer_target || null,
      cat.category_printer_target || null,
      printerConfig
    );
    return {
      ...i,
      printerName: resolvedPrinterName,
      printerTarget: cat.printer_target || cat.category_printer_target,
    };
  });

  const kotOrderData: OrderData = {
    tableNumber: formattedTableNumber,
    orderId,
    items: mappedItems.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      price: Number(i.price),
      notes: i.notes ?? null,
      type: (i.menuType === "LIQUOR" ? "liquor" : "food") as "food" | "liquor",
    })),
    restaurantName,
    kotId: String(kotNumber),
    sectionName,
    captainName: captainName || "Captain",
    orderByRole: orderByRole || "CAPTAIN",
    sectionTag: sectionTag || undefined,
  };

  // Group items by printer and build print groups (shared logic)
  const printGroups = buildKotPrintGroups(mappedItems, kotOrderData, table, printerConfig);

  // ── Print all groups (synchronous — before HTTP response returns) ──────────
  // Skip if the captain already printed locally (localPrinted flag from frontend)
  const printResults = localPrinted ? [] : await printGrouped(printGroups);

  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("order:created", { order: { id: orderId, tableId, kotNumber, totalAmount }, tableId, requestId });
  lanBroadcast("table:updated", { table: { id: tableId, status: "OCCUPIED", workflowStatus: "Preparing" }, tableId, requestId });

  // ── Return result ──────────────────────────────────────────────────────────
  const updatedTable = db.query(`
    SELECT t.*, s.name as section_name
    FROM "table" t LEFT JOIN section s ON t.section_id = s.id WHERE t.id = ?
  `).get(tableId) as any;

  const orderItems = db.query("SELECT * FROM order_item WHERE order_id = ?").all(orderId) as any[];

  return {
    success: true,
    orderId,
    kotNumber,
    kotId: kotId,
    order: {
      id: orderId,
      tableId,
      status: "PREPARING",
      totalAmount,
      items: orderItems,
      captainId,
      platform: platform || "DINE_IN",
    },
    table: {
      ...updatedTable,
      kot_history: safeParseKotHistory(updatedTable.kot_history),
    },
    printResults,
  };
}

// ─── Helper: safe-parse kot_history JSON ─────────────────────────────────────

function safeParseKotHistory(raw: any): any[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─── Update Order Items (add items to existing order) ────────────────────────

export interface UpdateOrderItemsInput {
  orderId: string;
  tableId: string;
  items: Array<{
    menuItemId: string;
    name: string;
    price: number;
    quantity: number;
    notes?: string | null;
    menuType?: string;
  }>;
  captainId?: string;
  captainName?: string;
  createdByUserId?: string;
  platform?: string;
  requestId?: string;
  orderByRole?: string;
  localPrinted?: boolean;
  kotEventIds?: string[] | null;
}

export interface UpdateOrderItemsResult {
  success: boolean;
  orderId?: string;
  kotNumber?: number;
  kotId?: string;
  table?: any;
  order?: any;
  printResults?: any[];
  error?: string;
  statusCode?: number;
}

export async function updateOrderItems(
  restaurantId: string,
  input: UpdateOrderItemsInput
): Promise<UpdateOrderItemsResult> {
  const { orderId, tableId, items, captainId, captainName, createdByUserId, platform, requestId, orderByRole, localPrinted } = input;

  if (!items || items.length === 0) {
    return { success: false, error: "No items to add", statusCode: 400 };
  }

  // Validate item data — reject negative prices or quantities
  for (const item of items) {
    if (!item.menuItemId || !item.name) {
      return { success: false, error: "Each item must have menuItemId and name", statusCode: 400 };
    }
    if (Number(item.price) < 0 || Number(item.quantity) <= 0) {
      return { success: false, error: `Invalid price/quantity for item: ${item.name}`, statusCode: 400 };
    }
  }

  const db = getDb();

  // ── Idempotency check — scoped to the target order to avoid matching other orders ──
  if (requestId) {
    const existing = db.query("SELECT * FROM order_record WHERE id = ? AND last_request_id = ?").get(orderId, requestId) as any;
    if (existing) {
      const existingItems = db.query("SELECT * FROM order_item WHERE order_id = ?").all(existing.id) as any[];
      return {
        success: true,
        orderId: existing.id,
        kotNumber: 0,
        order: { ...existing, items: existingItems },
        error: "Duplicate request — returning existing order",
      };
    }
  }

  // ── Look up existing order ──────────────────────────────────────────────────
  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    return { success: false, error: "Order not found", statusCode: 404 };
  }

  // ── Get table + outlet info ────────────────────────────────────────────────
  const table = getTableWithSection(tableId);
  if (!table) {
    return { success: false, error: "Table not found", statusCode: 404 };
  }

  const outlet = getOutlet(restaurantId);
  if (!outlet) {
    return { success: false, error: "Outlet not found in local DB", statusCode: 404 };
  }

  // ── Get menu items with categories for printer routing ─────────────────────
  const menuItemIds = items.map((i) => i.menuItemId).filter(Boolean);
  const menuItemMap = getMenuItemsWithCategories(menuItemIds);

  // ── Server-side price resolution (Bug 1 fix) ──────────────────────────────
  const venueId = table.venue_id ?? null;
  const priceMap = buildEdgePriceMap(venueId, restaurantId);
  const resolvedItems = items.map((i) => ({
    ...i,
    price: resolveItemPrice(i.menuItemId, priceMap, menuItemMap, Number(i.price)),
  }));

  // ── Calculate additional total using resolved prices ──────────────────────────
  const additionalAmount = resolvedItems.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);

  // ── Generate new KOT for just the new items ─────────────────────────────────
  const kotId = crypto.randomUUID();
  const kotNumber = getNextKotNumber(restaurantId);

  // ── Transaction: insert new items + new KOT + update order total ───────────
  const tx = db.transaction(() => {
    const now = Date.now();

    const newOrderItemIds: string[] = [];

    // 1. Insert new order items (using resolved prices)
    for (const item of resolvedItems) {
      const orderItemId = crypto.randomUUID();
      newOrderItemIds.push(orderItemId);
      db.query(`INSERT INTO order_item (id, order_id, menu_item_id, name, price, quantity, notes, menu_type, cloud_synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(orderItemId, orderId, item.menuItemId, item.name, Number(item.price), item.quantity, item.notes || null, item.menuType || "FOOD");
    }

    // 2. Create new KOT for the new items
    db.query(`INSERT INTO kot (id, restaurant_id, table_id, order_id, kot_number, created_at, cloud_synced)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(kotId, restaurantId, tableId, orderId, kotNumber, now);

    // 3. Create KOT items for just the new items (using resolved prices)
    for (let i = 0; i < resolvedItems.length; i++) {
      const kotItemId = crypto.randomUUID();
      db.query(`INSERT INTO kot_item (id, kot_id, order_item_id, menu_item_id, name, quantity, price, notes, status, created_at, cloud_synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, 0)
      `).run(kotItemId, kotId, newOrderItemIds[i], resolvedItems[i].menuItemId, resolvedItems[i].name, resolvedItems[i].quantity, Number(resolvedItems[i].price), resolvedItems[i].notes || null, now);
    }

    // 4. Bump order total + update timestamp
    const newTotal = Number(order.total_amount) + additionalAmount;
    db.query("UPDATE order_record SET total_amount = ?, updated_at = ?, last_request_id = ? WHERE id = ?")
      .run(newTotal, now, requestId || null, orderId);

    // 5. Update table current_bill
    db.query(`UPDATE "table" SET current_bill = current_bill + ?, updated_at = ? WHERE id = ?`)
      .run(additionalAmount, now, tableId);

    // 6. Update KOT history on table (safe parse — corrupted JSON should not crash the transaction)
    let currentHistory: any[] = [];
    try {
      currentHistory = JSON.parse(table.kot_history || "[]") as any[];
      if (!Array.isArray(currentHistory)) currentHistory = [];
    } catch {
      currentHistory = [];
    }
    const kotEntry = buildKotHistoryEntry(kotNumber, resolvedItems.map((i, idx) => ({ ...i, orderItemId: newOrderItemIds[idx] })));
    currentHistory.push(kotEntry);
    db.query(`UPDATE "table" SET kot_history = ? WHERE id = ?`).run(JSON.stringify(currentHistory), tableId);

    // 7. Enqueue sync records
    enqueueSync("order", orderId, "update");
    enqueueSync("kot", kotId, "insert");
    enqueueSync("table", tableId, "update");
    for (const oiId of newOrderItemIds) {
      enqueueSync("order_item", oiId, "insert");
    }
  });

  try {
    tx();
  } catch (err: any) {
    if (err.message && err.message.includes("UNIQUE")) {
      return { success: false, error: "Duplicate request — order already updated", statusCode: 409 };
    }
    throw err;
  }

  // ── Build ESC/POS and print (same logic as createOrder) ────────────────────
  const formattedTableNumber = formatTableNumber(table);
  const restaurantName = outlet.receipt_header || outlet.name;
  const sectionName = table.section_name || "Main Hall";
  const sectionTag = table.section_tag;
  const printerConfig = outlet.printerConfig || {};

  const mappedItems = resolvedItems.map((i) => {
    const cat = menuItemMap.get(i.menuItemId) || {};
    const resolvedPrinterName = resolvePrinterName(
      cat.printer_name || null,
      cat.printer_target || null,
      cat.category_printer_target || null,
      printerConfig
    );
    return {
      ...i,
      printerName: resolvedPrinterName,
      printerTarget: cat.printer_target || cat.category_printer_target,
    };
  });

  const kotOrderData: OrderData = {
    tableNumber: formattedTableNumber,
    orderId,
    items: mappedItems.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      price: Number(i.price),
      notes: i.notes ?? null,
      type: (i.menuType === "LIQUOR" ? "liquor" : "food") as "food" | "liquor",
    })),
    restaurantName,
    kotId: String(kotNumber),
    sectionName,
    captainName: captainName || "Captain",
    orderByRole: orderByRole || "CASHIER",
    sectionTag: sectionTag || undefined,
  };

  // Group items by printer and build print groups (shared logic)
  const printGroups = buildKotPrintGroups(mappedItems, kotOrderData, table, printerConfig);

  // ── Print all groups ────────────────────────────────────────────────────────
  // Skip if the captain already printed locally (localPrinted flag from frontend)
  const printResults = localPrinted ? [] : await printGrouped(printGroups);

  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("order:updated", { orderId, tableId, kotNumber, requestId });
  lanBroadcast("table:updated", { table: { id: tableId }, tableId, requestId });

  // ── Return result ──────────────────────────────────────────────────────────
  const updatedTable = db.query(`
    SELECT t.*, s.name as section_name
    FROM "table" t LEFT JOIN section s ON t.section_id = s.id WHERE t.id = ?
  `).get(tableId) as any;

  const orderItems = db.query("SELECT * FROM order_item WHERE order_id = ?").all(orderId) as any[];
  const updatedOrder = db.query("SELECT * FROM order_record WHERE id = ?").get(orderId) as any;

  return {
    success: true,
    orderId,
    kotNumber,
    kotId,
    order: {
      id: orderId,
      tableId,
      status: updatedOrder.status,
      totalAmount: Number(updatedOrder.total_amount),
      items: orderItems,
      captainId,
      platform: platform || "DINE_IN",
    },
    table: {
      ...updatedTable,
      kot_history: safeParseKotHistory(updatedTable.kot_history),
    },
    printResults,
  };
}

// ─── Cancel KOT Item ─────────────────────────────────────────────────────────

export interface CancelItemInput {
  orderId: string;
  restaurantId: string;
  orderItemId: string;
  cancelQuantity?: number;
  cancelledBy: string;
  tableNumber?: string | number;
  requestId?: string;
  localPrinted?: boolean;
}

export async function cancelKotItem(input: CancelItemInput): Promise<{ success: boolean; error?: string; printResult?: any }> {
  const db = getDb();
  const { orderId, restaurantId, orderItemId, cancelQuantity, cancelledBy, localPrinted } = input;

  // Scope by restaurantId to prevent cross-tenant access
  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    return { success: false, error: "Order not found" };
  }

  const orderItem = db.query("SELECT * FROM order_item WHERE id = ? AND order_id = ?").get(orderItemId, orderId) as any;
  if (!orderItem) {
    return { success: false, error: "Order item not found" };
  }

  const qtyToCancel = cancelQuantity || orderItem.quantity;
  const newCancelledQty = (orderItem.cancelled_quantity || 0) + qtyToCancel;
  const cancelAmount = Number(orderItem.price) * qtyToCancel;
  const now = Date.now();

  const isFullCancel = newCancelledQty >= orderItem.quantity;

  // Wrap all DB updates in a transaction so order total, table bill, KOT item
  // status, and table status are atomic. If any step fails, none are applied.
  const tx = db.transaction(() => {
    // 1. Update cancelled_quantity on the order item
    db.query("UPDATE order_item SET cancelled_quantity = ? WHERE id = ?")
      .run(newCancelledQty, orderItem.id);

    // 2. Mark the KOT item as CANCELLED so KDS stops showing it as active
    if (isFullCancel) {
      db.query("UPDATE kot_item SET status = 'CANCELLED' WHERE order_item_id = ?")
        .run(orderItem.id);
    }

    // 3. Reduce order total_amount
    db.query("UPDATE order_record SET total_amount = MAX(0, total_amount - ?), updated_at = ? WHERE id = ?")
      .run(cancelAmount, now, orderId);

    // 4. Check if all items on this order are now fully cancelled
    const remainingItems = db.query(
      "SELECT COUNT(*) as cnt FROM order_item WHERE order_id = ? AND (cancelled_quantity IS NULL OR cancelled_quantity < quantity)"
    ).get(orderId) as { cnt: number };

    const allCancelled = remainingItems.cnt === 0;

    // 5. Reduce table current_bill; free the table if everything is cancelled
    if (allCancelled) {
      db.query(`UPDATE "table" SET status = 'AVAILABLE', workflow_status = 'Free', current_bill = 0, captain_id = NULL, guests = 0, session_started_at = NULL, kot_history = '[]', discount = NULL, updated_at = ? WHERE id = ?`)
        .run(now, order.table_id);
    } else {
      db.query(`UPDATE "table" SET current_bill = MAX(0, current_bill - ?), updated_at = ? WHERE id = ?`)
        .run(cancelAmount, now, order.table_id);
    }

    // 6. Enqueue sync records
    enqueueSync("order_item", orderItemId, "update");
    enqueueSync("order", orderId, "update");
    enqueueSync("table", order.table_id, "update");
  });

  tx();

  // Get table + outlet for print context
  const table = getTableWithSection(order.table_id);
  const outlet = getOutlet(restaurantId);

  if (!table || !outlet) {
    return { success: true }; // Cancelled in DB but can't print
  }

  // Build cancel KOT
  const formattedTableNumber = formatTableNumber(table);
  const cancelItem = {
    name: orderItem.name,
    quantity: qtyToCancel,
    menuType: orderItem.menu_type === "LIQUOR" ? "BAR" : "FOOD",
  };

  const escposData = buildCancelKOT({
    tableNumber: formattedTableNumber,
    cancelledBy,
    timestamp: new Date().toISOString(),
    items: [cancelItem],
    sectionName: table.section_name || "Main Hall",
    sectionTag: table.section_tag,
    restaurant: {
      name: outlet.name,
      receiptHeader: outlet.receipt_header,
      receiptSubHeader: outlet.receipt_sub_header,
      address: outlet.address,
      phone: outlet.phone,
      gstin: outlet.gstin,
    },
  });

  // Resolve printer for the cancelled item
  const menuItem = db.query("SELECT * FROM menu_item WHERE id = ?").get(orderItem.menu_item_id) as any;
  const category = menuItem ? db.query("SELECT * FROM category WHERE id = ?").get(menuItem.category_id) as any : null;
  const printerConfig = outlet.printerConfig || {};
  const printerName = resolvePrinterName(
    menuItem?.printer_name || null,
    menuItem?.printer_target || null,
    category?.printer_target || null,
    printerConfig
  );

  let printResult: any = null;
  if (printerName && !localPrinted) {
    printResult = await printToPrinter(printerName, escposData);
  }

  return { success: true, printResult };
}

// ─── Reprint KOT ─────────────────────────────────────────────────────────────

export interface ReprintKotInput {
  orderId: string;
  restaurantId: string;
  kotNumber?: number;
}

export async function reprintKot(input: ReprintKotInput): Promise<{ success: boolean; error?: string; printResults?: any[] }> {
  const db = getDb();
  const { orderId, restaurantId } = input;

  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    return { success: false, error: "Order not found" };
  }

  const table = getTableWithSection(order.table_id);
  const outlet = getOutlet(restaurantId);
  if (!table || !outlet) {
    return { success: false, error: "Table or outlet not found" };
  }

  // Get all KOT items for this order
  const kots = db.query("SELECT * FROM kot WHERE order_id = ? ORDER BY kot_number").all(orderId) as any[];
  if (kots.length === 0) {
    return { success: false, error: "No KOTs found for this order" };
  }

  // Get all order items
  const orderItems = db.query("SELECT * FROM order_item WHERE order_id = ? AND (cancelled_quantity IS NULL OR cancelled_quantity < quantity)").all(orderId) as any[];

  const formattedTableNumber = formatTableNumber(table);
  const restaurantName = outlet.receipt_header || outlet.name;
  const sectionName = table.section_name || "Main Hall";
  const sectionTag = table.section_tag;
  const printerConfig = outlet.printerConfig || {};

  // Build print items from order items
  const printItems = orderItems.map((oi) => {
    const menuItem = db.query("SELECT * FROM menu_item WHERE id = ?").get(oi.menu_item_id) as any;
    const category = menuItem ? db.query("SELECT * FROM category WHERE id = ?").get(menuItem.category_id) as any : null;
    const printerName = resolvePrinterName(
      menuItem?.printer_name || null,
      menuItem?.printer_target || null,
      category?.printer_target || null,
      printerConfig
    );
    return {
      name: oi.name,
      quantity: oi.quantity - (oi.cancelled_quantity || 0),
      price: Number(oi.price),
      notes: oi.notes,
      menuType: oi.menu_type,
      printerName,
      printerTarget: menuItem?.printer_target || category?.printer_target,
    };
  });

  // Group by printer and print (same logic as createOrder)
  const groupedByPrinter = new Map<string | undefined, typeof printItems>();
  for (const item of printItems) {
    const key = item.printerName;
    if (!groupedByPrinter.has(key)) groupedByPrinter.set(key, []);
    groupedByPrinter.get(key)!.push(item);
  }

  const kotOrderData: OrderData = {
    tableNumber: formattedTableNumber,
    orderId,
    items: printItems.map((i) => ({
      name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null,
      type: (i.menuType === "LIQUOR" ? "liquor" : "food") as "food" | "liquor",
    })),
    restaurantName,
    kotId: String(kots[kots.length - 1].kot_number),
    sectionName,
    sectionTag: sectionTag || undefined,
  };

  const printGroups: Array<{ printerName: string; escposData: any[] }> = [];

  for (const [printerName, groupItems] of groupedByPrinter) {
    if (!printerName) {
      const kitchenItems = groupItems.filter((i) => i.menuType !== "LIQUOR");
      const barItems = groupItems.filter((i) => i.menuType === "LIQUOR");

      if (kitchenItems.length > 0) {
        const escpos = buildFoodKOT({ ...kotOrderData, items: kitchenItems.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null, type: "food" as const })) });
        const fallback = table.kot_printer_name || resolvePrinterName(null, "KOT_PRINTER", null, printerConfig);
        if (escpos.length > 0 && fallback) {
          printGroups.push({ printerName: fallback, escposData: escpos });
        } else if (escpos.length > 0 && !fallback) {
          console.error(`[KOT reprint] SILENT DROP: ${kitchenItems.length} kitchen items for table ${kotOrderData.tableNumber} — no KOT printer resolved`);
        }
      }
      if (barItems.length > 0) {
        const escpos = buildLiquorKOT({ ...kotOrderData, items: barItems.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null, type: "liquor" as const })) });
        const fallback = resolvePrinterName(null, "BAR_PRINTER", null, printerConfig);
        if (escpos.length > 0 && fallback) {
          printGroups.push({ printerName: fallback, escposData: escpos });
        } else if (escpos.length > 0 && !fallback) {
          console.error(`[KOT reprint] SILENT DROP: ${barItems.length} bar items for table ${kotOrderData.tableNumber} — no BAR printer resolved`);
        }
      }
    } else {
      const isAllLiquor = groupItems.every((i) => i.menuType === "LIQUOR");
      const builder = isAllLiquor ? buildLiquorKOT : buildFoodKOT;
      const escpos = builder({
        ...kotOrderData,
        items: groupItems.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null, type: (i.menuType === "LIQUOR" ? "liquor" : "food") as "food" | "liquor" })),
      });
      if (escpos.length > 0) printGroups.push({ printerName, escposData: escpos });
    }
  }

  const printResults = await printGrouped(printGroups);
  return { success: true, printResults };
}

// ─── Get next bill number (local counter, atomic) ─────────────────────────────

function getNextBillNumber(restaurantId: string): string {
  const db = getDb();
  const today = getKolkataDateString();

  db.query("INSERT INTO daily_counter (id, restaurant_id, counter_date, bill_count) VALUES (?, ?, ?, 0) ON CONFLICT(restaurant_id, counter_date) DO NOTHING")
    .run(crypto.randomUUID(), restaurantId, today);

  const row = db.query("UPDATE daily_counter SET bill_count = bill_count + 1 WHERE restaurant_id = ? AND counter_date = ? RETURNING bill_count")
    .get(restaurantId, today) as { bill_count: number };

  const dateStr = today.replace(/-/g, "");
  return `B${dateStr}${String(row.bill_count).padStart(4, "0")}`;
}

// ─── Request Billing (mark order as billing requested) ────────────────────────

export async function requestBillingEdge(
  restaurantId: string,
  orderId: string,
): Promise<{ success: boolean; error?: string; order?: any }> {
  const db = getDb();
  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    return { success: false, error: "Order not found" };
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    db.query("UPDATE order_record SET billing_requested = 1, billing_requested_at = ?, updated_at = ?, status = 'BILLING_REQUESTED' WHERE id = ?")
      .run(now, now, orderId);

    db.query(`UPDATE "table" SET workflow_status = 'Waiting Bill', updated_at = ? WHERE id = ?`)
      .run(now, order.table_id);

    enqueueSync("order", orderId, "update");
    enqueueSync("table", order.table_id, "update");
  });

  tx();

  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("order:updated", { orderId, status: "BILLING_REQUESTED" });
  lanBroadcast("table:updated", { table: { id: order.table_id, workflowStatus: "Waiting Bill" }, tableId: order.table_id });

  return { success: true, order: { id: orderId, status: "BILLING_REQUESTED" } };
}

// ─── Print Bill (assign bill number + print) ──────────────────────────────────

export interface PrintBillInput {
  orderId: string;
  restaurantId: string;
  tableNumber?: number;
  discountPercent?: number;
  kotNumbers?: string;
  localPrinted?: boolean;
  billEventId?: string;
}

export async function printBillEdge(input: PrintBillInput): Promise<{ success: boolean; error?: string; billNumber?: string; printResults?: any[] }> {
  const db = getDb();
  const { orderId, restaurantId, discountPercent, localPrinted } = input;

  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    return { success: false, error: "Order not found" };
  }

  // Assign bill number if not already assigned
  let billNumber = order.bill_number;
  if (!billNumber) {
    billNumber = getNextBillNumber(restaurantId);
    db.query("UPDATE order_record SET bill_number = ?, updated_at = ? WHERE id = ?")
      .run(billNumber, Date.now(), orderId);
  }
  // Always enqueue sync after bill print so the cloud receives the bill_number,
  // even if a prior sync cycle pushed the order before the number was assigned.
  enqueueSync("order", orderId, "update");

  // If the frontend already printed locally, skip edge printing — just assign bill number + sync
  if (localPrinted) {
    return { success: true, billNumber, printResults: [] };
  }

  // Get table + outlet for print context
  const table = getTableWithSection(order.table_id);
  const outlet = getOutlet(restaurantId);
  if (!table || !outlet) {
    console.error(`[printBillEdge] Cannot print bill for order ${orderId} — table or outlet not found in local DB`);
    return { success: false, error: "Table or outlet not found — cannot print bill", billNumber };
  }

  // Get order items with gst_enabled from menu_item (excluding fully cancelled and removed from bill)
  const orderItems = db.query(
    `SELECT oi.*, mi.gst_enabled as menu_gst_enabled
     FROM order_item oi
     LEFT JOIN menu_item mi ON oi.menu_item_id = mi.id
     WHERE oi.order_id = ?
       AND (oi.cancelled_quantity IS NULL OR oi.cancelled_quantity < oi.quantity)
       AND (oi.removed_from_bill IS NULL OR oi.removed_from_bill = 0)`
  ).all(orderId) as any[];

  const formattedTableNumber = formatTableNumber(table);
  const sectionTag = table.section_tag;
  const serviceChargePercent = outlet.service_charge_percent || 0;

  // Build bill ESC/POS
  const billItems = orderItems.map(oi => ({
    name: oi.name,
    quantity: oi.quantity - (oi.cancelled_quantity || 0),
    price: Number(oi.price),
    menuType: oi.menu_type === "LIQUOR" ? "LIQUOR" as const : "FOOD" as const,
    gstEnabled: oi.menu_gst_enabled !== 0,
  }));

  const escposData = buildBill({
    tableNumber: formattedTableNumber,
    items: billItems,
    totalAmount: 0,
    restaurant: {
      name: outlet.name,
      receiptHeader: outlet.receipt_header,
      receiptSubHeader: outlet.receipt_sub_header,
      address: outlet.address,
      phone: outlet.phone,
      gstin: outlet.gstin,
    },
    sectionTag,
    gstCategory: outlet.gst_category,
    gstRate: outlet.gst_rate,
    gstRegistered: outlet.gst_registered,
    pricesIncludeGst: outlet.prices_include_gst,
    discountPercent: discountPercent || 0,
    serviceChargePercent,
  });

  // Resolve bill printer — use per-venue override from table if available (same pattern as KOT path)
  const printerConfig = outlet.printerConfig || {};
  const billPrinterName = table.bill_printer_name || resolvePrinterName(null, "BILL_PRINTER", null, printerConfig);

  let printResults: any[] = [];
  if (billPrinterName) {
    printResults = await printGrouped([{ printerName: billPrinterName, escposData }]);
  } else {
    console.error(`[printBillEdge] SILENT DROP: Bill for order ${orderId} (table ${formattedTableNumber}) — no BILL printer resolved (no table.bill_printer_name, no BILL-type printer in config)`);
    return { success: false, error: "No bill printer configured — cannot print bill", billNumber };
  }

  return { success: true, billNumber, printResults };
}

// ─── Settle Order (mark as settled, free the table) ───────────────────────────

export interface SettleOrderInput {
  orderId: string;
  restaurantId: string;
  paymentMethod?: string;
  cashAmount?: number;
  cardAmount?: number;
  tipAmount?: number;
  cashTipAmount?: number;
  cardTipAmount?: number;
  discountPercent?: number;
  subtotal?: number;
  discountAmount?: number;
  cgst?: number;
  sgst?: number;
  grandTotal?: number;
  roundOff?: number;
  localTxnId?: string;
  requestId?: string;
}

export async function settleOrderEdge(input: SettleOrderInput): Promise<{ success: boolean; error?: string; order?: any; table?: any; statusCode?: number }> {
  const db = getDb();
  const { orderId, restaurantId, paymentMethod, localTxnId, requestId } = input;

  // Idempotency check — scoped to the target order to avoid matching other orders
  if (requestId) {
    const existing = db.query("SELECT * FROM order_record WHERE id = ? AND last_request_id = ?").get(orderId, requestId) as any;
    if (existing && existing.status === "SETTLED") {
      return { success: true, order: existing, error: "Duplicate request — already settled" };
    }
  }

  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    return { success: false, error: "Order not found" };
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    // Mark order as settled
    db.query("UPDATE order_record SET status = 'SETTLED', paid_at = ?, updated_at = ?, last_request_id = ? WHERE id = ?")
      .run(now, now, requestId || null, orderId);

    // Free the table
    db.query(`UPDATE "table" SET status = 'AVAILABLE', workflow_status = 'Free', captain_id = NULL, guests = 0, session_started_at = NULL, current_bill = 0, kot_history = '[]', discount = NULL, updated_at = ? WHERE id = ?`)
      .run(now, order.table_id);

    // Store payment details for sync worker to create cloud transaction
    if (localTxnId || paymentMethod) {
      const paymentKey = `settle:${localTxnId || orderId}`;
      const paymentData = JSON.stringify({
        orderId,
        restaurantId,
        paymentMethod: paymentMethod || "CASH",
        cashAmount: input.cashAmount,
        cardAmount: input.cardAmount,
        tipAmount: input.tipAmount,
        cashTipAmount: input.cashTipAmount,
        cardTipAmount: input.cardTipAmount,
        discountPercent: input.discountPercent,
        subtotal: input.subtotal,
        discountAmount: input.discountAmount,
        cgst: input.cgst,
        sgst: input.sgst,
        grandTotal: input.grandTotal,
        roundOff: input.roundOff,
        localTxnId,
        requestId,
        settledAt: now,
      });
      db.query("INSERT INTO edge_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?")
        .run(paymentKey, paymentData, now, paymentData, now);
    }

    // Enqueue sync
    enqueueSync("order", orderId, "update");
    enqueueSync("table", order.table_id, "update");
    if (localTxnId) enqueueSync("transaction", localTxnId, "insert");
  });

  try {
    tx();
  } catch (err: any) {
    if (err.message && err.message.includes("UNIQUE")) {
      return { success: false, error: "Duplicate settle request", statusCode: 409 };
    }
    throw err;
  }

  const updatedOrder = db.query("SELECT * FROM order_record WHERE id = ?").get(orderId) as any;
  const updatedTable = db.query(`SELECT t.*, s.name as section_name FROM "table" t LEFT JOIN section s ON t.section_id = s.id WHERE t.id = ?`).get(order.table_id) as any;

  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("order:settled", { orderId, tableId: order.table_id, requestId });
  lanBroadcast("table:updated", { table: { id: order.table_id, status: "AVAILABLE", workflowStatus: "Free" }, tableId: order.table_id });

  return {
    success: true,
    order: updatedOrder,
    table: { ...updatedTable, kot_history: safeParseKotHistory(updatedTable.kot_history) },
  };
}

// ─── Swap Table (move order from one table to another) ────────────────────────

export async function swapTableEdge(
  restaurantId: string,
  sourceTableId: string,
  targetTableId: string,
  swappedBy: string,
): Promise<{ success: boolean; error?: string; sourceTable?: any; targetTable?: any }> {
  const db = getDb();

  const sourceTable = db.query(`SELECT * FROM "table" WHERE id = ? AND restaurant_id = ?`).get(sourceTableId, restaurantId) as any;
  const targetTable = db.query(`SELECT * FROM "table" WHERE id = ? AND restaurant_id = ?`).get(targetTableId, restaurantId) as any;

  if (!sourceTable || !targetTable) {
    return { success: false, error: "Source or target table not found" };
  }

  // Find active order on source table — use the full active status list
  const activeOrder = db.query(
    `SELECT * FROM order_record WHERE table_id = ? AND restaurant_id = ? AND status IN (${ACTIVE_ORDER_STATUSES.map(() => "?").join(",")}) AND is_deleted = 0`
  ).get(sourceTableId, restaurantId, ...ACTIVE_ORDER_STATUSES) as any;

  const now = Date.now();
  const tx = db.transaction(() => {
    if (activeOrder) {
      // Move order to target table
      db.query("UPDATE order_record SET table_id = ?, updated_at = ? WHERE id = ?")
        .run(targetTableId, now, activeOrder.id);
      enqueueSync("order", activeOrder.id, "update");
    }

    // Swap table statuses, captain, guests, kot history, current bill
    db.query(`UPDATE "table" SET status = ?, workflow_status = ?, captain_id = ?, guests = ?, session_started_at = ?, current_bill = ?, kot_history = ?, discount = ?, updated_at = ? WHERE id = ?`)
      .run(targetTable.status, targetTable.workflow_status, targetTable.captain_id, targetTable.guests, targetTable.session_started_at, targetTable.current_bill, targetTable.kot_history, targetTable.discount, now, sourceTableId);
    db.query(`UPDATE "table" SET status = ?, workflow_status = ?, captain_id = ?, guests = ?, session_started_at = ?, current_bill = ?, kot_history = ?, discount = ?, updated_at = ? WHERE id = ?`)
      .run(sourceTable.status, sourceTable.workflow_status, sourceTable.captain_id, sourceTable.guests, sourceTable.session_started_at, sourceTable.current_bill, sourceTable.kot_history, sourceTable.discount, now, targetTableId);

    enqueueSync("table", sourceTableId, "update");
    enqueueSync("table", targetTableId, "update");
  });

  tx();

  const updatedSource = db.query(`SELECT t.*, s.name as section_name FROM "table" t LEFT JOIN section s ON t.section_id = s.id WHERE t.id = ?`).get(sourceTableId) as any;
  const updatedTarget = db.query(`SELECT t.*, s.name as section_name FROM "table" t LEFT JOIN section s ON t.section_id = s.id WHERE t.id = ?`).get(targetTableId) as any;

  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("table:updated", { table: { id: sourceTableId }, tableId: sourceTableId });
  lanBroadcast("table:updated", { table: { id: targetTableId }, tableId: targetTableId });

  return {
    success: true,
    sourceTable: { ...updatedSource, kot_history: safeParseKotHistory(updatedSource.kot_history) },
    targetTable: { ...updatedTarget, kot_history: safeParseKotHistory(updatedTarget.kot_history) },
  };
}

// ─── Transfer Items (move items between tables) ───────────────────────────────

export async function transferItemsEdge(
  restaurantId: string,
  sourceTableId: string,
  targetTableId: string,
  orderItemIds: string[],
  transferredBy: string,
): Promise<{ success: boolean; error?: string; sourceTable?: any; targetTable?: any }> {
  const db = getDb();

  if (!orderItemIds || orderItemIds.length === 0) {
    return { success: false, error: "No items to transfer" };
  }

  // Find active orders on both tables — use the full active status list
  const sourceOrder = db.query(
    `SELECT * FROM order_record WHERE table_id = ? AND restaurant_id = ? AND status IN (${ACTIVE_ORDER_STATUSES.map(() => "?").join(",")}) AND is_deleted = 0`
  ).get(sourceTableId, restaurantId, ...ACTIVE_ORDER_STATUSES) as any;
  if (!sourceOrder) {
    return { success: false, error: "No active order on source table" };
  }

  let targetOrder = db.query(
    `SELECT * FROM order_record WHERE table_id = ? AND restaurant_id = ? AND status IN (${ACTIVE_ORDER_STATUSES.map(() => "?").join(",")}) AND is_deleted = 0`
  ).get(targetTableId, restaurantId, ...ACTIVE_ORDER_STATUSES) as any;

  const now = Date.now();
  const tx = db.transaction(() => {
    // Create target order if it doesn't exist
    if (!targetOrder) {
      const newOrderId = crypto.randomUUID();
      db.query("INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, created_at, updated_at, cloud_synced) VALUES (?, ?, ?, 'PREPARING', 0, ?, ?, 0)")
        .run(newOrderId, targetTableId, restaurantId, now, now);
      enqueueSync("order", newOrderId, "insert");
      targetOrder = { id: newOrderId, table_id: targetTableId, total_amount: 0 };
    }

    // Move items
    let transferredAmount = 0;
    for (const itemId of orderItemIds) {
      const item = db.query("SELECT * FROM order_item WHERE id = ? AND order_id = ?").get(itemId, sourceOrder.id) as any;
      if (!item) continue;

      const effectiveQty = item.quantity - (item.cancelled_quantity || 0);
      if (effectiveQty <= 0) continue;

      // Create new order item on target order with the effective quantity
      const newItemId = crypto.randomUUID();
      db.query("INSERT INTO order_item (id, order_id, menu_item_id, name, price, quantity, notes, menu_type, cloud_synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)")
        .run(newItemId, targetOrder.id, item.menu_item_id, item.name, item.price, effectiveQty, item.notes, item.menu_type);

      // Mark original item as removed
      db.query("UPDATE order_item SET removed_from_bill = 1, removed_by = ?, removed_at = ? WHERE id = ?")
        .run(transferredBy, now, itemId);

      transferredAmount += Number(item.price) * effectiveQty;
      enqueueSync("order_item", newItemId, "insert");
      enqueueSync("order_item", itemId, "update");
    }

    // Update order totals
    db.query("UPDATE order_record SET total_amount = total_amount - ?, updated_at = ? WHERE id = ?")
      .run(transferredAmount, now, sourceOrder.id);
    db.query("UPDATE order_record SET total_amount = total_amount + ?, updated_at = ? WHERE id = ?")
      .run(transferredAmount, now, targetOrder.id);

    // Update table current bills
    db.query(`UPDATE "table" SET current_bill = MAX(0, current_bill - ?), updated_at = ? WHERE id = ?`)
      .run(transferredAmount, now, sourceTableId);
    db.query(`UPDATE "table" SET current_bill = current_bill + ?, updated_at = ? WHERE id = ?`)
      .run(transferredAmount, now, targetTableId);

    enqueueSync("order", sourceOrder.id, "update");
    enqueueSync("order", targetOrder.id, "update");
    enqueueSync("table", sourceTableId, "update");
    enqueueSync("table", targetTableId, "update");
  });

  tx();

  const updatedSource = db.query(`SELECT t.*, s.name as section_name FROM "table" t LEFT JOIN section s ON t.section_id = s.id WHERE t.id = ?`).get(sourceTableId) as any;
  const updatedTarget = db.query(`SELECT t.*, s.name as section_name FROM "table" t LEFT JOIN section s ON t.section_id = s.id WHERE t.id = ?`).get(targetTableId) as any;

  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("table:updated", { table: { id: sourceTableId }, tableId: sourceTableId });
  lanBroadcast("table:updated", { table: { id: targetTableId }, tableId: targetTableId });

  return {
    success: true,
    sourceTable: { ...updatedSource, kot_history: safeParseKotHistory(updatedSource.kot_history) },
    targetTable: { ...updatedTarget, kot_history: safeParseKotHistory(updatedTarget.kot_history) },
  };
}

// ─── Edit Bill (remove items, edit quantities before settlement) ──────────────

export async function editBillEdge(
  restaurantId: string,
  orderId: string,
  edits: { removedItemIds?: string[]; editQuantities?: Record<string, number>; addedItems?: any[]; editedBy?: string },
): Promise<{ success: boolean; error?: string; order?: any; printResults?: any[] }> {
  const db = getDb();
  const { removedItemIds, editQuantities, addedItems, editedBy } = edits;

  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    return { success: false, error: "Order not found" };
  }

  // ── Bug 1: Resolve prices for added items server-side ──────────────────────
  let resolvedAddedItems: any[] = [];
  let addedMenuItemMap = new Map<string, any>();
  if (addedItems && addedItems.length > 0) {
    const table = getTableWithSection(order.table_id);
    const addedMenuItemIds = addedItems.map((i) => i.menuItemId || i.id).filter(Boolean);
    addedMenuItemMap = getMenuItemsWithCategories(addedMenuItemIds);
    const venueId = table?.venue_id ?? null;
    const priceMap = buildEdgePriceMap(venueId, restaurantId);
    resolvedAddedItems = addedItems.map((i) => {
      const miId = i.menuItemId || i.id;
      return {
        ...i,
        menuItemId: miId,
        price: resolveItemPrice(miId, priceMap, addedMenuItemMap, Number(i.price)),
      };
    });
  }

  // Track new order item IDs for post-tx KOT printing (Bug 3)
  const addedOrderItemIds: string[] = [];
  let addedKotId: string | null = null;
  let addedKotNumber: number | null = null;

  const now = Date.now();
  const tx = db.transaction(() => {
    let billDelta = 0;

    // Remove items
    if (removedItemIds && removedItemIds.length > 0) {
      for (const itemId of removedItemIds) {
        const item = db.query("SELECT * FROM order_item WHERE id = ? AND order_id = ?").get(itemId, orderId) as any;
        if (!item) continue;
        const effectiveQty = item.quantity - (item.cancelled_quantity || 0);
        billDelta -= Number(item.price) * effectiveQty;
        db.query("UPDATE order_item SET removed_from_bill = 1, removed_by = ?, removed_at = ? WHERE id = ? AND order_id = ?")
          .run(editedBy || "Cashier", now, itemId, orderId);
        enqueueSync("order_item", itemId, "update");
      }
    }

    // Edit quantities
    if (editQuantities) {
      for (const [itemId, newQty] of Object.entries(editQuantities)) {
        const item = db.query("SELECT * FROM order_item WHERE id = ? AND order_id = ?").get(itemId, orderId) as any;
        if (!item) continue;
        const oldQty = item.quantity;
        const qtyDiff = newQty - oldQty;
        billDelta += Number(item.price) * qtyDiff;
        db.query("UPDATE order_item SET quantity = ?, edited_quantity = ? WHERE id = ?")
          .run(newQty, newQty, itemId);
        // Adjust order total
        db.query("UPDATE order_record SET total_amount = total_amount + ?, updated_at = ? WHERE id = ?")
          .run(Number(item.price) * qtyDiff, now, orderId);
        enqueueSync("order_item", itemId, "update");
      }
    }

    // Add new items (Bug 1: using resolved prices; Bug 3: create KOT + KOT items)
    if (resolvedAddedItems.length > 0) {
      // Bug 3: Generate a new KOT for the cashier-added items
      addedKotId = crypto.randomUUID();
      addedKotNumber = getNextKotNumber(restaurantId);
      db.query(`INSERT INTO kot (id, restaurant_id, table_id, order_id, kot_number, created_at, cloud_synced)
        VALUES (?, ?, ?, ?, ?, ?, 0)
      `).run(addedKotId, restaurantId, order.table_id, orderId, addedKotNumber, now);

      for (const item of resolvedAddedItems) {
        const newItemId = crypto.randomUUID();
        addedOrderItemIds.push(newItemId);
        const itemTotal = Number(item.price) * (item.quantity || 1);
        billDelta += itemTotal;
        db.query("INSERT INTO order_item (id, order_id, menu_item_id, name, price, quantity, notes, menu_type, added_by_cashier, cloud_synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)")
          .run(newItemId, orderId, item.menuItemId || item.id || null, item.name, Number(item.price), item.quantity || 1, item.notes || null, item.menuType || "FOOD");

        // Bug 3: Create KOT item for this added item
        const kotItemId = crypto.randomUUID();
        db.query(`INSERT INTO kot_item (id, kot_id, order_item_id, menu_item_id, name, quantity, price, notes, status, created_at, cloud_synced)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, 0)
        `).run(kotItemId, addedKotId, newItemId, item.menuItemId || item.id || null, item.name, item.quantity || 1, Number(item.price), item.notes || null, now);

        db.query("UPDATE order_record SET total_amount = total_amount + ?, updated_at = ? WHERE id = ?")
          .run(itemTotal, now, orderId);
        enqueueSync("order_item", newItemId, "insert");
      }

      // Bug 3: Update KOT history on table
      const tableRow = db.query(`SELECT kot_history FROM "table" WHERE id = ?`).get(order.table_id) as any;
      let currentHistory: any[] = [];
      try {
        currentHistory = JSON.parse(tableRow?.kot_history || "[]") as any[];
        if (!Array.isArray(currentHistory)) currentHistory = [];
      } catch { currentHistory = []; }
      const kotEntry = buildKotHistoryEntry(addedKotNumber, resolvedAddedItems.map((i, idx) => ({ ...i, orderItemId: addedOrderItemIds[idx] })));
      currentHistory.push(kotEntry);
      db.query(`UPDATE "table" SET kot_history = ? WHERE id = ?`).run(JSON.stringify(currentHistory), order.table_id);

      enqueueSync("kot", addedKotId, "insert");
    }

    // Sync table current_bill with the net bill delta
    if (billDelta !== 0) {
      db.query(`UPDATE "table" SET current_bill = MAX(0, current_bill + ?), updated_at = ? WHERE id = ?`)
        .run(billDelta, now, order.table_id);
      enqueueSync("table", order.table_id, "update");
    }

    db.query("UPDATE order_record SET updated_at = ? WHERE id = ?").run(now, orderId);
    enqueueSync("order", orderId, "update");
  });

  tx();

  // ── Bug 3: Print KOT for cashier-added items ────────────────────────────────
  let printResults: any[] = [];
  if (resolvedAddedItems.length > 0 && addedKotId && addedKotNumber != null) {
    const table = getTableWithSection(order.table_id);
    const outlet = getOutlet(restaurantId);
    if (table && outlet) {
      const printerConfig = outlet.printerConfig || {};
      const mappedAddedItems = resolvedAddedItems.map((i) => {
        const cat = addedMenuItemMap.get(i.menuItemId || i.id) || {};
        const resolvedPrinterName = resolvePrinterName(
          cat.printer_name || null,
          cat.printer_target || null,
          cat.category_printer_target || null,
          printerConfig
        );
        return {
          name: i.name,
          quantity: i.quantity || 1,
          price: Number(i.price),
          notes: i.notes ?? null,
          menuType: i.menuType || "FOOD",
          printerName: resolvedPrinterName,
          printerTarget: cat.printer_target || cat.category_printer_target,
        } as EdgeKotItem;
      });

      const formattedTableNumber = formatTableNumber(table);
      const kotOrderData: OrderData = {
        tableNumber: formattedTableNumber,
        orderId,
        items: mappedAddedItems.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          price: Number(i.price),
          notes: i.notes ?? null,
          type: (i.menuType === "LIQUOR" ? "liquor" : "food") as "food" | "liquor",
        })),
        restaurantName: outlet.receipt_header || outlet.name,
        kotId: String(addedKotNumber),
        sectionName: table.section_name || "Main Hall",
        captainName: editedBy || "Cashier",
        orderByRole: "CASHIER",
        sectionTag: table.section_tag || undefined,
      };

      const printGroups = buildKotPrintGroups(mappedAddedItems, kotOrderData, table, printerConfig);
      printResults = await printGrouped(printGroups);
    }
  }

  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("order:updated", { orderId, tableId: order.table_id, addedItems: resolvedAddedItems.length });
  lanBroadcast("table:updated", { table: { id: order.table_id }, tableId: order.table_id });

  const updatedOrder = db.query("SELECT * FROM order_record WHERE id = ?").get(orderId) as any;
  return { success: true, order: updatedOrder, printResults };
}

// ─── Confirm Payment (record payment for a settled order) ─────────────────────

export async function confirmPaymentEdge(
  restaurantId: string,
  transactionId: string,
  paymentDetails: { paymentMethod?: string; cashAmount?: number; cardAmount?: number; tipAmount?: number; cashTipAmount?: number; cardTipAmount?: number },
): Promise<{ success: boolean; error?: string }> {
  const db = getDb();

  // Store payment details in edge_config for sync to cloud
  const paymentKey = `payment:${transactionId}`;
  const paymentData = JSON.stringify({ ...paymentDetails, restaurantId, confirmedAt: Date.now() });
  db.query("INSERT INTO edge_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?")
    .run(paymentKey, paymentData, Date.now(), paymentData, Date.now());

  // Enqueue sync for the payment confirmation
  enqueueSync("transaction", transactionId, "update");

  return { success: true };
}

// ─── Update Order Status ──────────────────────────────────────────────────────

export async function updateOrderStatusEdge(
  restaurantId: string,
  orderId: string,
  status: string,
): Promise<{ success: boolean; error?: string; order?: any }> {
  const db = getDb();

  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    return { success: false, error: "Order not found" };
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    db.query("UPDATE order_record SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, orderId);

    // Update table workflow status to match
    const workflowMap: Record<string, string> = {
      "PREPARING": "Preparing",
      "READY": "Prepared",
      "BILLING_REQUESTED": "Waiting Bill",
      "SETTLED": "Free",
    };
    const workflowStatus = workflowMap[status];
    if (workflowStatus) {
      db.query(`UPDATE "table" SET workflow_status = ?, updated_at = ? WHERE id = ?`)
        .run(workflowStatus, now, order.table_id);
      enqueueSync("table", order.table_id, "update");
    }

    enqueueSync("order", orderId, "update");
  });

  tx();

  const updatedOrder = db.query("SELECT * FROM order_record WHERE id = ?").get(orderId) as any;
  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("order:updated", { orderId, status: updatedOrder?.status });
  lanBroadcast("table:updated", { table: { id: order.table_id }, tableId: order.table_id });
  return { success: true, order: updatedOrder };
}

// ─── Mark Order Paid (simple status update, no settlement) ───────────────────

export async function markOrderPaidEdge(
  restaurantId: string,
  orderId: string,
  paymentMethod: string = "CASH",
): Promise<{ success: boolean; error?: string; order?: any }> {
  const db = getDb();

  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    return { success: false, error: "Order not found" };
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    db.query("UPDATE order_record SET status = 'PAID', paid_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, orderId);
    enqueueSync("order", orderId, "update");
  });

  tx();

  const updatedOrder = db.query("SELECT * FROM order_record WHERE id = ?").get(orderId) as any;
  return { success: true, order: updatedOrder };
}

// ─── Save Walk-in Transaction (no order, no table) ───────────────────────────

export async function saveTransactionEdge(
  restaurantId: string,
  txnData: {
    orderId?: string | null;
    tableNumber?: number | null;
    captainId?: string | null;
    amount?: number;
    method?: string;
    itemCount?: number;
    items?: any[];
    subtotal?: number;
    discountPercent?: number;
    discountAmount?: number;
    cgst?: number;
    sgst?: number;
    grandTotal?: number;
    roundOff?: number;
    tipAmount?: number;
    sectionId?: string | null;
    sectionTag?: string | null;
    billNumber?: string | null;
    platform?: string;
  },
): Promise<{ success: boolean; transaction?: any; error?: string }> {
  const db = getDb();

  const localId = `edge-txn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const txnDate = getKolkataDateString();

  const fullTxnData = {
    localId,
    restaurantId,
    orderId: txnData.orderId || null,
    tableNumber: txnData.tableNumber || null,
    captainId: txnData.captainId || null,
    amount: Number(txnData.amount || 0),
    method: (txnData.method || "CASH").toUpperCase(),
    itemCount: Number(txnData.itemCount || 0),
    items: txnData.items || [],
    subtotal: Number(txnData.subtotal || 0),
    discountPercent: Number(txnData.discountPercent || 0),
    discountAmount: Number(txnData.discountAmount || 0),
    cgst: Number(txnData.cgst || 0),
    sgst: Number(txnData.sgst || 0),
    grandTotal: Number(txnData.grandTotal || 0),
    roundOff: Number(txnData.roundOff || 0),
    tipAmount: Number(txnData.tipAmount || 0),
    sectionId: txnData.sectionId || null,
    sectionTag: txnData.sectionTag || null,
    billNumber: txnData.billNumber || null,
    platform: txnData.platform || "CASHIER",
    txnDate,
    createdAt: now,
  };

  const txnKey = `walkin_txn:${localId}`;
  db.query("INSERT INTO edge_config (key, value, updated_at) VALUES (?, ?, ?)")
    .run(txnKey, JSON.stringify(fullTxnData), now);

  enqueueSync("walkin_transaction", localId, "insert");

  return {
    success: true,
    transaction: {
      id: localId,
      ...fullTxnData,
      paidAt: new Date(now).toISOString(),
    },
  };
}

// ─── List Transactions (for edge-local Past Transactions) ───────────────────
// Returns settled orders + walk-in transactions from local SQLite.
// Mirrors the cloud /api/transactions response shape so the frontend
// can use the same mapping logic.

export async function listTransactionsEdge(
  restaurantId: string,
  opts: { date?: string | null; month?: string | null; limit?: number } = {},
): Promise<any[]> {
  const db = getDb();
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 2000;
  const txns: any[] = [];

  // 1. Settled orders with payment details from edge_config
  let orderQuery = `SELECT o.*, t.number as table_number, t.section_tag, s.name as section_name
    FROM order_record o
    LEFT JOIN "table" t ON o.table_id = t.id
    LEFT JOIN section s ON t.section_id = s.id
    WHERE o.restaurant_id = ? AND o.status = 'SETTLED'`;
  const orderParams: any[] = [restaurantId];

  if (opts.date) {
    // Filter by IST date: paid_at is epoch ms
    const dayStart = new Date(opts.date + "T00:00:00+05:30").getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    orderQuery += ` AND o.paid_at >= ? AND o.paid_at < ?`;
    orderParams.push(dayStart, dayEnd);
  } else if (opts.month) {
    // Filter by IST month
    const monthStart = new Date(opts.month + "-01T00:00:00+05:30").getTime();
    const monthEnd = new Date(opts.month + "-31T23:59:59+05:30").getTime();
    orderQuery += ` AND o.paid_at >= ? AND o.paid_at <= ?`;
    orderParams.push(monthStart, monthEnd);
  }

  orderQuery += ` ORDER BY o.paid_at DESC LIMIT ?`;
  orderParams.push(limit);

  const settledOrders = db.query(orderQuery).all(...orderParams) as any[];

  for (const order of settledOrders) {
    // Look up payment details from edge_config
    const paymentRow = db.query("SELECT value FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = ?").get(order.id) as any;
    let paymentData: any = {};
    if (paymentRow?.value) {
      try { paymentData = JSON.parse(paymentRow.value); } catch {}
    }

    // Get items for this order
    const items = db.query("SELECT name, quantity, price, menu_type FROM order_item WHERE order_id = ?").all(order.id) as any[];

    txns.push({
      id: `edge-txn-${order.id}`,
      orderId: order.id,
      txnNumber: null,
      billNumber: order.bill_number || null,
      paidAt: order.paid_at ? new Date(order.paid_at).toISOString() : new Date(order.created_at).toISOString(),
      amount: Number(paymentData.grandTotal ?? order.total_amount ?? 0),
      grandTotal: Number(paymentData.grandTotal ?? order.total_amount ?? 0),
      subtotal: Number(paymentData.subtotal ?? order.total_amount ?? 0),
      discountPercent: Number(paymentData.discountPercent ?? 0),
      discountAmount: Number(paymentData.discountAmount ?? 0),
      cgst: Number(paymentData.cgst ?? 0),
      sgst: Number(paymentData.sgst ?? 0),
      roundOff: Number(paymentData.roundOff ?? 0),
      tipAmount: Number(paymentData.tipAmount ?? 0),
      itemCount: items.length,
      items: items.map(i => ({ name: i.name, quantity: i.quantity, price: i.price })),
      captainId: order.captain_id || "CASHIER",
      captainName: "Head Cashier",
      method: paymentData.paymentMethod || "CASH",
      tableNumber: order.table_number || null,
      sectionTag: order.section_tag || null,
      sectionId: null,
      status: "COMPLETED",
    });
  }

  // 2. Walk-in transactions from edge_config
  let walkinQuery = `SELECT key, value FROM edge_config WHERE key LIKE 'walkin_txn:%'`;
  const walkinRows = db.query(walkinQuery).all() as any[];

  for (const row of walkinRows) {
    try {
      const txn = JSON.parse(row.value);
      if (txn.restaurantId !== restaurantId) continue;

      if (opts.date) {
        const txnDate = new Date(txn.paidAt || txn.createdAt).toISOString().slice(0, 10);
        if (txnDate !== opts.date) continue;
      } else if (opts.month) {
        const txnMonth = String(txn.paidAt || txn.createdAt || "").slice(0, 7);
        if (txnMonth !== opts.month) continue;
      }

      txns.push({
        id: txn.id || row.key,
        orderId: txn.orderId || null,
        txnNumber: txn.txnNumber || null,
        billNumber: txn.billNumber || null,
        paidAt: txn.paidAt ? new Date(txn.paidAt).toISOString() : new Date(txn.createdAt).toISOString(),
        amount: Number(txn.grandTotal ?? txn.amount ?? 0),
        grandTotal: Number(txn.grandTotal ?? txn.amount ?? 0),
        subtotal: Number(txn.subtotal ?? 0),
        discountPercent: Number(txn.discountPercent ?? 0),
        discountAmount: Number(txn.discountAmount ?? 0),
        cgst: Number(txn.cgst ?? 0),
        sgst: Number(txn.sgst ?? 0),
        roundOff: Number(txn.roundOff ?? 0),
        tipAmount: Number(txn.tipAmount ?? 0),
        itemCount: txn.itemCount || (Array.isArray(txn.items) ? txn.items.length : 0),
        items: txn.items || [],
        captainId: txn.captainId || "CASHIER",
        captainName: "Head Cashier",
        method: txn.method || "OTHER",
        tableNumber: null,
        sectionTag: txn.sectionTag || null,
        sectionId: txn.sectionId || null,
        status: "COMPLETED",
      });
    } catch {}
  }

  // Sort by paidAt descending
  txns.sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime());

  // Apply limit
  return txns.slice(0, limit);
}
