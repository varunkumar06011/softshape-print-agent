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

import { getDb, getNextKotNumber, enqueueSync } from "./db.ts";
import { buildFoodKOT, buildLiquorKOT, buildCancelKOT, type PrintItem, type OrderData } from "./escpos.ts";
import { printToPrinter, printGrouped, resolvePrinterName } from "./printer.ts";

// ─── Active order statuses ───────────────────────────────────────────────────

const ACTIVE_ORDER_STATUSES = ["PENDING", "CONFIRMED", "PREPARING", "READY", "BILLING_REQUESTED"];

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
  const { tableId, items, captainId, captainName, createdByUserId, platform, requestId, orderByRole } = input;

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

  // ── Calculate total ────────────────────────────────────────────────────────
  const totalAmount = items.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);

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

    // 2. Create order items
    for (const item of items) {
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
    const kotEntry = buildKotHistoryEntry(kotNumber, items.map((i, idx) => ({ ...i, orderItemId: orderItems[idx]?.id })));
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

  // Resolve printer for each item
  const printerConfig = outlet.printerConfig || {};
  const mappedItems = items.map((i) => {
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

  // Group items by printer (same logic as backend)
  const groupedByPrinter = new Map<string | undefined, typeof mappedItems>();
  for (const item of mappedItems) {
    const key = item.printerName;
    if (!groupedByPrinter.has(key)) groupedByPrinter.set(key, []);
    groupedByPrinter.get(key)!.push(item);
  }

  // Build print groups
  const printGroups: Array<{ printerName: string; escposData: any[] }> = [];
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
          // Use venue KOT printer or first available kitchen printer
          const fallbackPrinter = table.kot_printer_name || resolvePrinterName(null, "KOT_PRINTER", null, printerConfig);
          if (fallbackPrinter) printGroups.push({ printerName: fallbackPrinter, escposData: escpos });
        }
      }
      if (barItems.length > 0) {
        const barPrintItems = barItems.map((i) => ({
          name: i.name, quantity: i.quantity, price: Number(i.price), notes: i.notes ?? null, type: "liquor" as const,
        }));
        const escpos = buildLiquorKOT({ ...kotOrderData, items: barPrintItems });
        if (escpos.length > 0) {
          const fallbackPrinter = resolvePrinterName(null, "BAR_PRINTER", null, printerConfig);
          if (fallbackPrinter) printGroups.push({ printerName: fallbackPrinter, escposData: escpos });
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

  // ── Print all groups (synchronous — before HTTP response returns) ──────────
  const printResults = await printGrouped(printGroups);

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
  const { orderId, tableId, items, captainId, captainName, createdByUserId, platform, requestId, orderByRole } = input;

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

  // ── Idempotency check ──────────────────────────────────────────────────────
  if (requestId) {
    const existing = db.query("SELECT * FROM order_record WHERE last_request_id = ?").get(requestId) as any;
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

  // ── Calculate additional total ──────────────────────────────────────────────
  const additionalAmount = items.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);

  // ── Generate new KOT for just the new items ─────────────────────────────────
  const kotId = crypto.randomUUID();
  const kotNumber = getNextKotNumber(restaurantId);

  // ── Transaction: insert new items + new KOT + update order total ───────────
  const tx = db.transaction(() => {
    const now = Date.now();

    const newOrderItemIds: string[] = [];

    // 1. Insert new order items
    for (const item of items) {
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

    // 3. Create KOT items for just the new items
    for (let i = 0; i < items.length; i++) {
      const kotItemId = crypto.randomUUID();
      db.query(`INSERT INTO kot_item (id, kot_id, order_item_id, menu_item_id, name, quantity, price, notes, status, created_at, cloud_synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, 0)
      `).run(kotItemId, kotId, newOrderItemIds[i], items[i].menuItemId, items[i].name, items[i].quantity, Number(items[i].price), items[i].notes || null, now);
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
    const kotEntry = buildKotHistoryEntry(kotNumber, items.map((i, idx) => ({ ...i, orderItemId: newOrderItemIds[idx] })));
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

  const mappedItems = items.map((i) => {
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

  // Group items by printer
  const groupedByPrinter = new Map<string | undefined, typeof mappedItems>();
  for (const item of mappedItems) {
    const key = item.printerName;
    if (!groupedByPrinter.has(key)) groupedByPrinter.set(key, []);
    groupedByPrinter.get(key)!.push(item);
  }

  const printGroups: Array<{ printerName: string; escposData: any[] }> = [];
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

  for (const [printerName, groupItems] of groupedByPrinter) {
    if (!printerName) {
      const kitchenItems = groupItems.filter((i) => i.printerTarget !== "BAR_PRINTER" && i.menuType !== "LIQUOR");
      const barItems = groupItems.filter((i) => i.printerTarget === "BAR_PRINTER" || i.menuType === "LIQUOR");

      if (kitchenItems.length > 0) {
        const kitchenPrintItems = kitchenItems.map((i) => ({
          name: i.name, quantity: i.quantity, price: Number(i.price), notes: i.notes ?? null, type: "food" as const,
        }));
        const escpos = buildFoodKOT({ ...kotOrderData, items: kitchenPrintItems });
        if (escpos.length > 0) {
          const fallbackPrinter = table.kot_printer_name || resolvePrinterName(null, "KOT_PRINTER", null, printerConfig);
          if (fallbackPrinter) printGroups.push({ printerName: fallbackPrinter, escposData: escpos });
        }
      }
      if (barItems.length > 0) {
        const barPrintItems = barItems.map((i) => ({
          name: i.name, quantity: i.quantity, price: Number(i.price), notes: i.notes ?? null, type: "liquor" as const,
        }));
        const escpos = buildLiquorKOT({ ...kotOrderData, items: barPrintItems });
        if (escpos.length > 0) {
          const fallbackPrinter = resolvePrinterName(null, "BAR_PRINTER", null, printerConfig);
          if (fallbackPrinter) printGroups.push({ printerName: fallbackPrinter, escposData: escpos });
        }
      }
    } else {
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

  // ── Print all groups ────────────────────────────────────────────────────────
  const printResults = await printGrouped(printGroups);

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
}

export async function cancelKotItem(input: CancelItemInput): Promise<{ success: boolean; error?: string; printResult?: any }> {
  const db = getDb();
  const { orderId, restaurantId, orderItemId, cancelQuantity, cancelledBy } = input;

  const orderItem = db.query("SELECT * FROM order_item WHERE id = ? AND order_id = ?").get(orderItemId, orderId) as any;
  if (!orderItem) {
    return { success: false, error: "Order item not found" };
  }

  const qtyToCancel = cancelQuantity || orderItem.quantity;
  const newCancelledQty = (orderItem.cancelled_quantity || 0) + qtyToCancel;

  // Update order item
  db.query("UPDATE order_item SET cancelled_quantity = ? WHERE id = ?").run(newCancelledQty, orderItem.id);

  // Get table + outlet for print context
  const order = db.query("SELECT * FROM order_record WHERE id = ?").get(orderId) as any;
  const table = order ? getTableWithSection(order.table_id) : null;
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
  if (printerName) {
    printResult = await printToPrinter(printerName, escposData);
  }

  // Update order's updated_at timestamp
  db.query("UPDATE order_record SET updated_at = ? WHERE id = ?").run(Date.now(), orderId);

  // Enqueue sync for both order_item and order (so cloud gets updated timestamp)
  enqueueSync("order_item", orderItemId, "update");
  enqueueSync("order", orderId, "update");

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
        if (escpos.length > 0 && fallback) printGroups.push({ printerName: fallback, escposData: escpos });
      }
      if (barItems.length > 0) {
        const escpos = buildLiquorKOT({ ...kotOrderData, items: barItems.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null, type: "liquor" as const })) });
        const fallback = resolvePrinterName(null, "BAR_PRINTER", null, printerConfig);
        if (escpos.length > 0 && fallback) printGroups.push({ printerName: fallback, escposData: escpos });
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
