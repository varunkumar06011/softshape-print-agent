// ─────────────────────────────────────────────────────────────────────────────
// reads.ts — Local read endpoints for captain/cashier apps
// ─────────────────────────────────────────────────────────────────────────────
// Reads from local SQLite — zero network round-trips.
// Response shapes match the cloud backend's Prisma responses so the captain
// app can swap between edge and cloud seamlessly.
//
// Endpoints:
//   GET /api/edge/tables    — sections with nested tables + active orders + KOTs
//   GET /api/edge/tables/flat — flat list of all tables
//   GET /api/edge/sections  — sections with venue + floor info
//   GET /api/edge/menu      — menu items with categories, variants, venue prices
//   GET /api/edge/menu/items — lean flat list for POS
//   GET /api/edge/venues    — venues with floors and sections
//   GET /api/edge/outlet    — outlet settings (receipt header, GST, etc.)
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from "./db.ts";
import { getRestaurantId } from "./auth.ts";
import { runtimeLog } from "./contract/logger.ts";

const ACTIVE_ORDER_STATUSES = ["PENDING", "CONFIRMED", "PREPARING", "READY", "BILLING_REQUESTED"];

// ── In-memory cache for static config reads ──────────────────────────────────
// These tables only change on config sync, so we cache the query results
// and invalidate them when a config sync completes. This eliminates redundant
// SQLite queries on every /api/edge/menu, /api/edge/sections, etc. call.

interface CacheEntry {
  data: any;
  timestamp: number;
}

const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes fallback TTL

function getCached<T>(key: string): T | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCached(key: string, data: any): void {
  if (Array.isArray(data) && data.length === 0) return;
  _cache.set(key, { data, timestamp: Date.now() });
}

// Invalidate all cached config data. Called after config sync completes.
export function invalidateReadCache(): void {
  const count = _cache.size;
  _cache.clear();
  if (count > 0) {
    runtimeLog.info("[reads] Cache invalidated", { entries: count });
  }
}

// Warm the cache by pre-fetching the most common reads. Called after config
// sync commits so the first UI request gets an instant response.
export function warmReadCache(): void {
  try {
    const restaurantId = getRestaurantId();
    if (!restaurantId) return;

    const start = Date.now();
    getSections();
    getMenu();
    getMenuItems();
    getVenues();
    getOutletSettings();

    runtimeLog.info("[reads] Cache warmed", {
      entries: _cache.size,
      durationMs: Date.now() - start,
      restaurantId,
    });
  } catch (err) {
    runtimeLog.warn("[reads] Cache warming failed (non-fatal)", { error: String(err) });
  }
}

// ─── GET /api/edge/orders — active orders with items (for KDS) ────────────────

export function getActiveOrders(statusFilter?: string): any[] {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return [];

  const db = getDb();
  const statuses = statusFilter
    ? [statusFilter.toUpperCase()]
    : ACTIVE_ORDER_STATUSES;

  const orders = db.query(`
    SELECT o.* FROM order_record o
    WHERE o.restaurant_id = ? AND o.status IN (${statuses.map(() => "?").join(",")}) AND o.is_deleted = 0
    ORDER BY o.updated_at DESC
  `).all(restaurantId, ...statuses) as any[];

  return orders.map((order) => {
    const items = db.query(`
      SELECT oi.*, m.gst_enabled, m.menu_type as mi_menu_type
      FROM order_item oi
      LEFT JOIN menu_item m ON oi.menu_item_id = m.id
      WHERE oi.order_id = ? AND oi.removed_from_bill = 0 AND oi.quantity > 0
      ORDER BY oi.id ASC
    `).all(order.id) as any[];

    return {
      id: order.id,
      tableId: order.table_id,
      restaurantId: order.restaurant_id,
      status: order.status,
      totalAmount: Number(order.total_amount),
      captainId: order.captain_id,
      platform: order.platform,
      revision: order.revision ?? 1,
      lastCommandId: order.last_command_id ?? null,
      isExtraTable: !!order.is_extra_table,
      createdAt: new Date(order.created_at).toISOString(),
      updatedAt: new Date(order.updated_at).toISOString(),
      items: items.map((i) => ({
        id: i.id,
        orderId: i.order_id,
        menuItemId: i.menu_item_id,
        name: i.name,
        price: Number(i.price),
        quantity: i.quantity,
        notes: i.notes,
        menuType: i.menu_type,
        cancelledQuantity: i.cancelled_quantity || 0,
        removedFromBill: !!i.removed_from_bill,
        menuItem: {
          gstEnabled: !!i.gst_enabled,
          menuType: i.mi_menu_type || i.menu_type,
        },
      })),
    };
  });
}

// ─── GET /api/edge/tables — sections with nested tables (matches cloud shape) ─

export function getTablesForRestaurant(): any[] {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return [];

  const db = getDb();

  // Get sections
  const sections = db.query(`
    SELECT s.*, v.name as venue_name, v.venue_type, v.kot_enabled,
           f.name as floor_name
    FROM section s
    LEFT JOIN venue v ON s.venue_id = v.id
    LEFT JOIN floor f ON s.floor_id = f.id
    WHERE s.restaurant_id = ?
    ORDER BY s.sort_order ASC, s.name ASC
  `).all(restaurantId) as any[];

  return sections.map((section) => {
    // Get tables for this section
    const tables = db.query(`
      SELECT t.*,
             (SELECT COUNT(*) FROM order_record o WHERE o.table_id = t.id AND o.status IN (${ACTIVE_ORDER_STATUSES.map(() => "?").join(",")}) AND o.is_deleted = 0) as active_order_count
      FROM "table" t
      WHERE t.section_id = ? AND t.restaurant_id = ?
      ORDER BY t.number ASC
    `).all(...ACTIVE_ORDER_STATUSES, section.id, restaurantId) as any[];

    const sectionInfo = {
      id: section.id,
      name: section.name,
      restaurantId: section.restaurant_id,
      venueId: section.venue_id,
      venue: section.venue_id ? {
        id: section.venue_id,
        name: section.venue_name,
        venueType: section.venue_type,
        kotEnabled: !!section.kot_enabled,
      } : undefined,
    };

    const mappedTables = tables.map((t) => {
      const mapped = mapTableRow(t);
      // Ensure section info is populated — the table query in getTablesForRestaurant
      // doesn't join section_name, so mapTableRow leaves section undefined.
      // VenueSectionView filters by table.section?.name, so without this, no tables match.
      if (!mapped.section) {
        mapped.section = sectionInfo;
      }
      mapped.sectionName = section.name;
      return mapped;
    });

    return {
      id: section.id,
      name: section.name,
      restaurantId: section.restaurant_id,
      floorId: section.floor_id,
      venueId: section.venue_id,
      sortOrder: section.sort_order,
      venue: section.venue_id ? {
        id: section.venue_id,
        name: section.venue_name,
        venueType: section.venue_type,
        kotEnabled: !!section.kot_enabled,
      } : undefined,
      floor: section.floor_id ? {
        id: section.floor_id,
        name: section.floor_name,
      } : undefined,
      tables: mappedTables,
    };
  });
}

// ─── GET /api/edge/tables/flat — flat list of all tables ─────────────────────

export function getTablesFlat(): any[] {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return [];

  const db = getDb();

  const tables = db.query(`
    SELECT t.*, s.name as section_name, s.venue_id,
           v.name as venue_name, v.venue_type, v.kot_enabled
    FROM "table" t
    LEFT JOIN section s ON t.section_id = s.id
    LEFT JOIN venue v ON s.venue_id = v.id
    WHERE t.restaurant_id = ?
    ORDER BY s.name ASC, t.number ASC
  `).all(restaurantId) as any[];

  return tables.map((t) => {
    const mapped = mapTableRow(t);
    if (t.section_name) mapped.sectionName = t.section_name;
    return mapped;
  });
}

// ─── Helper: Map a SQLite table row to the cloud response shape ───────────────

function mapTableRow(t: any): any {
  const db = getDb();

  // Get ALL active orders for this table (parent first: is_extra_table=0 first)
  const activeOrders = db.query(`
    SELECT o.* FROM order_record o
    WHERE o.table_id = ? AND o.status IN (${ACTIVE_ORDER_STATUSES.map(() => "?").join(",")}) AND o.is_deleted = 0
    ORDER BY o.is_extra_table ASC, o.updated_at DESC
  `).all(t.id, ...ACTIVE_ORDER_STATUSES) as any[];

  let orders: any[] = [];
  for (const order of activeOrders) {
    const items = db.query(`
      SELECT oi.*, m.gst_enabled, m.menu_type as mi_menu_type
      FROM order_item oi
      LEFT JOIN menu_item m ON oi.menu_item_id = m.id
      WHERE oi.order_id = ? AND oi.removed_from_bill = 0 AND oi.quantity > 0
      ORDER BY oi.id ASC
    `).all(order.id) as any[];

    orders.push({
      id: order.id,
      tableId: order.table_id,
      restaurantId: order.restaurant_id,
      status: order.status,
      totalAmount: Number(order.total_amount),
      captainId: order.captain_id,
      platform: order.platform,
      revision: order.revision ?? 1,
      lastCommandId: order.last_command_id ?? null,
      isExtraTable: !!order.is_extra_table,
      createdAt: new Date(order.created_at).toISOString(),
      updatedAt: new Date(order.updated_at).toISOString(),
      items: items.map((i) => ({
        id: i.id,
        orderId: i.order_id,
        menuItemId: i.menu_item_id,
        name: i.name,
        price: Number(i.price),
        quantity: i.quantity,
        notes: i.notes,
        menuType: i.menu_type,
        cancelledQuantity: i.cancelled_quantity || 0,
        removedFromBill: !!i.removed_from_bill,
        menuItem: {
          gstEnabled: !!i.gst_enabled,
          menuType: i.mi_menu_type || i.menu_type,
        },
      })),
    });
  }

  // Get KOTs for this table — filter to active parent table orders only (is_extra_table = 0)
  // Layer 14.1: join order_record to scope KOTs by is_extra_table and active status
  const kots = db.query(`
    SELECT k.*, ki.id as ki_id, ki.order_item_id, ki.menu_item_id as ki_menu_item_id,
           ki.name as ki_name, ki.quantity as ki_quantity, ki.price as ki_price,
           ki.notes as ki_notes, ki.status as ki_status
    FROM kot k
    LEFT JOIN kot_item ki ON k.id = ki.kot_id
    LEFT JOIN order_record o ON k.order_id = o.id
    WHERE k.table_id = ? AND (o.is_extra_table = 0 OR o.is_extra_table IS NULL) AND o.status IN (${ACTIVE_ORDER_STATUSES.map(() => "?").join(",")})
    ORDER BY k.created_at ASC, ki.id ASC
  `).all(t.id, ...ACTIVE_ORDER_STATUSES) as any[];

  // Group KOT items by KOT
  const kotsMap = new Map<string, any>();
  for (const row of kots) {
    if (!kotsMap.has(row.id)) {
      kotsMap.set(row.id, {
        id: row.id,
        restaurantId: row.restaurant_id,
        tableId: row.table_id,
        orderId: row.order_id,
        kotNumber: row.kot_number,
        createdAt: new Date(row.created_at).toISOString(),
        items: [],
      });
    }
    if (row.ki_id) {
      kotsMap.get(row.id)!.items.push({
        id: row.ki_id,
        kotId: row.id,
        orderItemId: row.order_item_id,
        menuItemId: row.ki_menu_item_id,
        name: row.ki_name,
        quantity: row.ki_quantity,
        price: Number(row.ki_price),
        notes: row.ki_notes,
        status: row.ki_status,
      });
    }
  }

  return {
    id: t.id,
    number: t.number,
    capacity: t.capacity,
    status: (t.status === 'AVAILABLE' || t.workflow_status === 'Free') ? 'AVAILABLE' : (orders.length > 0 ? "OCCUPIED" : t.status),
    sectionId: t.section_id,
    restaurantId: t.restaurant_id,
    workflowStatus: t.workflow_status,
    captainId: t.captain_id,
    guests: t.guests,
    sessionStartedAt: t.session_started_at ? new Date(t.session_started_at).toISOString() : null,
    currentBill: Number(t.current_bill),
    kotHistory: typeof t.kot_history === "string" ? JSON.parse(t.kot_history) : (t.kot_history || []),
    discount: t.discount ? Number(t.discount) : null,
    sectionTag: t.section_tag,
    lastWaiterCallAt: t.last_waiter_call_at ? new Date(t.last_waiter_call_at).toISOString() : null,
    revision: t.revision ?? 1,
    lastCommandId: t.last_command_id ?? null,
    section: t.section_name ? {
      id: t.section_id,
      name: t.section_name,
      venueId: t.venue_id,
      venue: t.venue_id ? {
        id: t.venue_id,
        name: t.venue_name,
        venueType: t.venue_type,
        kotEnabled: !!t.kot_enabled,
      } : undefined,
    } : undefined,
    orders: orders.length > 0 ? orders : [],
    kots: Array.from(kotsMap.values()),
  };
}

// ─── GET /api/edge/sections — sections with venue + floor info ───────────────

export function getSections(): any[] {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return [];

  const cacheKey = `sections:${restaurantId}`;
  const cached = getCached<any[]>(cacheKey);
  if (cached) return cached;

  const db = getDb();

  const sections = db.query(`
    SELECT s.*, v.name as venue_name, v.venue_type, v.kot_enabled,
           f.name as floor_name
    FROM section s
    LEFT JOIN venue v ON s.venue_id = v.id
    LEFT JOIN floor f ON s.floor_id = f.id
    WHERE s.restaurant_id = ?
    ORDER BY s.sort_order ASC, s.name ASC
  `).all(restaurantId) as any[];

  const result = sections.map((s) => {
    const tables = db.query(`
      SELECT * FROM "table" WHERE section_id = ? AND restaurant_id = ?
      ORDER BY number ASC
    `).all(s.id, restaurantId) as any[];

    return {
      id: s.id,
      name: s.name,
      restaurantId: s.restaurant_id,
      floorId: s.floor_id,
      venueId: s.venue_id,
      sortOrder: s.sort_order,
      venue: s.venue_id ? {
        id: s.venue_id,
        name: s.venue_name,
        venueType: s.venue_type,
        kotEnabled: !!s.kot_enabled,
      } : undefined,
      floor: s.floor_id ? {
        id: s.floor_id,
        name: s.floor_name,
      } : undefined,
      tables: tables.map((t) => ({
        id: t.id,
        number: t.number,
        capacity: t.capacity,
        status: t.status,
        sectionId: t.section_id,
        restaurantId: t.restaurant_id,
        workflowStatus: t.workflow_status,
        captainId: t.captain_id,
        guests: t.guests,
        currentBill: Number(t.current_bill),
        sectionTag: t.section_tag,
        sectionName: s.name,
        revision: t.revision ?? 1,
        lastCommandId: t.last_command_id ?? null,
        section: {
          id: s.id,
          name: s.name,
          restaurantId: s.restaurant_id,
          venueId: s.venue_id,
          venue: s.venue_id ? {
            id: s.venue_id,
            name: s.venue_name,
            venueType: s.venue_type,
            kotEnabled: !!s.kot_enabled,
          } : undefined,
        },
      })),
    };
  });

  setCached(cacheKey, result);
  return result;
}

// ─── GET /api/edge/menu — full menu with categories, items, variants ─────────

export function getMenu(venueId?: string): any[] {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return [];

  const cacheKey = `menu:${restaurantId}:${venueId || "all"}`;
  const cached = getCached<any[]>(cacheKey);
  if (cached) return cached;

  const db = getDb();

  // Get categories
  const categories = db.query(`
    SELECT * FROM category
    WHERE restaurant_id = ? AND is_active = 1
    ORDER BY sort_order ASC, name ASC
  `).all(restaurantId) as any[];

  // Get venue price map from PriceProfile (same source as buildEdgePriceMap in orderService.ts)
  let venuePriceMap: Map<string, number> = new Map();
  if (venueId) {
    const venue = db.query("SELECT price_profile_id FROM venue WHERE id = ?").get(venueId) as any;
    if (venue?.price_profile_id) {
      const profileItems = db.query("SELECT menu_item_id, price FROM price_profile_item WHERE price_profile_id = ?").all(venue.price_profile_id) as any[];
      for (const pi of profileItems) {
        venuePriceMap.set(pi.menu_item_id, Number(pi.price));
      }
    }
  }

  // Get all venue prices grouped by item (for client-side resolution)
  const allVenuePrices = db.query(`
    SELECT v.id as venue_id, ppi.menu_item_id, ppi.price
    FROM venue v
    JOIN price_profile_item ppi ON v.price_profile_id = ppi.price_profile_id
    WHERE v.is_deleted = 0 AND v.restaurant_id = ?
  `).all(restaurantId) as any[];

  const allVenuePricesByItem: Record<string, Record<string, number>> = {};
  for (const vp of allVenuePrices) {
    if (!allVenuePricesByItem[vp.menu_item_id]) allVenuePricesByItem[vp.menu_item_id] = {};
    allVenuePricesByItem[vp.menu_item_id][vp.venue_id] = Number(vp.price);
  }

  const result = categories.map((cat) => {
    const items = db.query(`
      SELECT * FROM menu_item
      WHERE category_id = ? AND restaurant_id = ? AND is_available = 1 AND is_deleted = 0
      ORDER BY sort_order ASC, name ASC
    `).all(cat.id, restaurantId) as any[];

    const mappedItems = items.map((m) => {
      // Get default variant price if exists
      const defaultVariant = db.query("SELECT price FROM menu_item_variant WHERE menu_item_id = ? AND is_default = 1 LIMIT 1").get(m.id) as any;

      const basePrice = venuePriceMap.get(m.id) ?? Number(m.base_price);
      const variantPrice = defaultVariant ? Number(defaultVariant.price) : null;
      const effectivePrice = variantPrice ?? basePrice;

      // Get all variants
      const variants = db.query("SELECT id, name, price, is_default, is_available FROM menu_item_variant WHERE menu_item_id = ? AND is_available = 1").all(m.id) as any[];

      // Get addons
      const addons = db.query("SELECT id, name, price, is_available FROM menu_item_addon WHERE menu_item_id = ? AND is_available = 1").all(m.id) as any[];

      return {
        id: m.id,
        name: m.name,
        description: m.description,
        imageUrl: m.image_url,
        isVeg: !!m.is_veg,
        isAvailable: !!m.is_available,
        sortOrder: m.sort_order,
        categoryId: m.category_id,
        restaurantId: m.restaurant_id,
        basePrice: Number(m.base_price),
        unit: m.unit,
        menuType: m.menu_type,
        gstEnabled: !!m.gst_enabled,
        isSpecial: !!m.is_special,
        specialChannel: m.special_channel,
        specialActive: !!m.special_active,
        specialExpiresAt: m.special_expires_at ? new Date(m.special_expires_at).toISOString() : null,
        printerTarget: m.printer_target,
        printerName: m.printer_name,
        effectivePrice,
        variants: variants.map((v) => ({
          id: v.id,
          name: v.name,
          price: Number(v.price),
          isDefault: !!v.is_default,
          isAvailable: !!v.is_available,
        })),
        addons: addons.map((a) => ({
          id: a.id,
          name: a.name,
          price: Number(a.price),
          isAvailable: !!a.is_available,
        })),
        venuePrices: allVenuePricesByItem[m.id] || {},
      };
    });

    return {
      id: cat.id,
      name: cat.name,
      sortOrder: cat.sort_order,
      isActive: !!cat.is_active,
      restaurantId: cat.restaurant_id,
      printerTarget: cat.printer_target,
      items: mappedItems,
    };
  });

  setCached(cacheKey, result);
  return result;
}

// ─── GET /api/edge/menu/items — lean flat list for POS ───────────────────────

export function getMenuItems(venueId?: string): any[] {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return [];

  const cacheKey = `menuItems:${restaurantId}:${venueId || "all"}`;
  const cached = getCached<any[]>(cacheKey);
  if (cached) return cached;

  const db = getDb();

  // Get venue price map from PriceProfile (same source as buildEdgePriceMap in orderService.ts)
  let venuePriceMap: Map<string, number> = new Map();
  if (venueId) {
    const venue = db.query("SELECT price_profile_id FROM venue WHERE id = ?").get(venueId) as any;
    if (venue?.price_profile_id) {
      const profileItems = db.query("SELECT menu_item_id, price FROM price_profile_item WHERE price_profile_id = ?").all(venue.price_profile_id) as any[];
      for (const pi of profileItems) {
        venuePriceMap.set(pi.menu_item_id, Number(pi.price));
      }
    }
  }

  // Build all venue prices by item (for client-side venue price resolution)
  const allVenuePrices = db.query(`
    SELECT v.id as venue_id, ppi.menu_item_id, ppi.price
    FROM venue v
    JOIN price_profile_item ppi ON v.price_profile_id = ppi.price_profile_id
    WHERE v.is_deleted = 0 AND v.restaurant_id = ?
  `).all(restaurantId) as any[];
  const allVenuePricesByItem: Record<string, Record<string, number>> = {};
  for (const vp of allVenuePrices) {
    if (!allVenuePricesByItem[vp.menu_item_id]) allVenuePricesByItem[vp.menu_item_id] = {};
    allVenuePricesByItem[vp.menu_item_id][vp.venue_id] = Number(vp.price);
  }

  // Build venue availability by item
  const venueAvailRecords = db.query(`
    SELECT venue_id, menu_item_id, is_available FROM venue_menu_item_availability WHERE restaurant_id = ?
  `).all(restaurantId) as any[];
  const venueAvailByItem: Record<string, Record<string, boolean>> = {};
  for (const rec of venueAvailRecords) {
    if (!venueAvailByItem[rec.menu_item_id]) venueAvailByItem[rec.menu_item_id] = {};
    venueAvailByItem[rec.menu_item_id][rec.venue_id] = !!rec.is_available;
  }

  const items = db.query(`
    SELECT m.*, c.name as category_name, c.sort_order as category_sort_order
    FROM menu_item m
    LEFT JOIN category c ON m.category_id = c.id
    WHERE m.restaurant_id = ? AND m.is_available = 1 AND m.is_deleted = 0
    ORDER BY c.sort_order ASC, m.sort_order ASC
  `).all(restaurantId) as any[];

  const now = Date.now();

  const result = items
    .filter((m) => {
      if (!m.is_special) return true;
      if (!m.special_active) return false;
      if (m.special_expires_at && m.special_expires_at < now) return false;
      return true;
    })
    .map((m) => {
      const defaultVariant = db.query("SELECT price FROM menu_item_variant WHERE menu_item_id = ? AND is_default = 1 LIMIT 1").get(m.id) as any;
      const basePrice = venuePriceMap.get(m.id) ?? Number(m.base_price);
      const variantPrice = defaultVariant ? Number(defaultVariant.price) : null;
      const price = variantPrice ?? basePrice;

      // Get all variants for this item (for POS portion size selection)
      const variants = db.query("SELECT id, name, price, is_default, is_available FROM menu_item_variant WHERE menu_item_id = ? AND is_available = 1").all(m.id) as any[];

      return {
        id: m.id,
        name: m.name,
        description: m.description,
        imageUrl: m.image_url,
        isVeg: !!m.is_veg,
        isAvailable: !!m.is_available,
        gstEnabled: !!m.gst_enabled,
        menuType: m.menu_type,
        isSpecial: !!m.is_special,
        specialChannel: m.special_channel,
        specialActive: !!m.special_active,
        specialExpiresAt: m.special_expires_at ? new Date(m.special_expires_at).toISOString() : null,
        unit: m.unit,
        category: m.category_name,
        price,
        variants: variants.map((v) => ({
          id: v.id,
          name: v.name,
          price: Number(v.price),
          isDefault: !!v.is_default,
          isAvailable: !!v.is_available,
        })),
        printerTarget: m.printer_target || null,
        printerName: m.printer_name || null,
        venuePrices: venueId ? (venuePriceMap.has(m.id) ? { [venueId]: venuePriceMap.get(m.id)! } : {}) : (allVenuePricesByItem[m.id] ?? {}),
        venueAvailabilities: venueAvailByItem[m.id] ?? {},
      };
    });

  setCached(cacheKey, result);
  return result;
}

// ─── GET /api/edge/venues — venues with floors and sections ──────────────────

export function getVenues(): any[] {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return [];

  const cacheKey = `venues:${restaurantId}`;
  const cached = getCached<any[]>(cacheKey);
  if (cached) return cached;

  const db = getDb();

  const venues = db.query(`
    SELECT * FROM venue
    WHERE restaurant_id = ? AND is_deleted = 0
    ORDER BY sort_order ASC, name ASC
  `).all(restaurantId) as any[];

  const result = venues.map((v) => {
    const floors = db.query(`
      SELECT * FROM floor
      WHERE venue_id = ? AND is_active = 1
      ORDER BY sort_order ASC
    `).all(v.id) as any[];

    const sections = db.query(`
      SELECT * FROM section
      WHERE venue_id = ? AND restaurant_id = ?
      ORDER BY sort_order ASC
    `).all(v.id, restaurantId) as any[];

    return {
      id: v.id,
      restaurantId: v.restaurant_id,
      name: v.name,
      venueType: v.venue_type,
      sortOrder: v.sort_order,
      isActive: !!v.is_active,
      priceProfileId: v.price_profile_id,
      taxProfileId: v.tax_profile_id,
      kotPrinterName: v.kot_printer_name,
      billPrinterName: v.bill_printer_name,
      kotEnabled: !!v.kot_enabled,
      floors: floors.map((f) => ({
        id: f.id,
        venueId: f.venue_id,
        restaurantId: f.restaurant_id,
        name: f.name,
        sortOrder: f.sort_order,
        isActive: !!f.is_active,
      })),
      sections: sections.map((s) => ({
        id: s.id,
        name: s.name,
        restaurantId: s.restaurant_id,
        floorId: s.floor_id,
        venueId: s.venue_id,
        sortOrder: s.sort_order,
      })),
    };
  });

  setCached(cacheKey, result);
  return result;
}

// ─── GET /api/edge/outlet — outlet settings ──────────────────────────────────

export function getOutletSettings(): any | null {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return null;

  const cacheKey = `outlet:${restaurantId}`;
  const cached = getCached<any>(cacheKey);
  if (cached) return cached;

  const db = getDb();

  const outlet = db.query("SELECT * FROM outlet WHERE id = ?").get(restaurantId) as any;
  if (!outlet) return null;

  const result = {
    id: outlet.id,
    name: outlet.name,
    slug: outlet.slug,
    restaurantCode: outlet.restaurant_code,
    restaurantType: outlet.restaurant_type,
    address: outlet.address,
    phone: outlet.phone,
    email: outlet.email,
    gstin: outlet.gstin,
    logoUrl: outlet.logo_url,
    receiptHeader: outlet.receipt_header,
    receiptSubHeader: outlet.receipt_sub_header,
    themePrimary: outlet.theme_primary,
    themeSecondary: outlet.theme_secondary,
    printerConfig: outlet.printer_config ? JSON.parse(outlet.printer_config) : {},
    barUnitMl: outlet.bar_unit_ml,
    fullBottleMl: outlet.full_bottle_ml,
    halfBottleMl: outlet.half_bottle_ml,
    fssai: outlet.fssai,
    pricesIncludeGst: !!outlet.prices_include_gst,
    gstCategory: outlet.gst_category,
    gstRate: outlet.gst_rate,
    gstRegistered: !!outlet.gst_registered,
    serviceChargePercent: outlet.service_charge_percent,
    enabledModules: outlet.enabled_modules ? JSON.parse(outlet.enabled_modules) : {},
    organizationId: outlet.organization_id,
    isActive: !!outlet.is_active,
  };

  setCached(cacheKey, result);
  return result;
}
