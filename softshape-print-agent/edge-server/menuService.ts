// ─────────────────────────────────────────────────────────────────────────────
// menuService.ts — Local menu item writes (cashier/captain edge edits)
// ─────────────────────────────────────────────────────────────────────────────
// Handles cashier-initiated menu edits against the local SQLite edge DB.
// Mirrors the cloud's /api/menu/admin/items CRUD surface but writes locally
// first, enqueues a cloud sync, invalidates the read cache, and emits a
// config.changed event so all LAN clients (captain/cashier) refresh instantly.
//
// Flow:
//   1. Validate + write to menu_item (and venue_price / venue_menu_item_availability)
//   2. enqueueSync("menu_item", id, "update"|"create"|"delete")
//   3. invalidateReadCache()
//   4. emitEvent(CONFIG_CHANGED, { tables: ["menu_item"], source: "socket" })
//
// The sync worker (sync.ts) pushes the change to the cloud via
// POST /api/edge/sync, where upsertMenuItem applies it to PostgreSQL.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, enqueueSync } from "./db.ts";
import { getRestaurantId } from "./auth.ts";
import { invalidateReadCache } from "./reads.ts";
import { emitEvent } from "./eventBus.ts";
import { EVENT_NAMES } from "./contract/events.ts";
import { runtimeLog } from "./contract/logger.ts";

export interface MenuEditResult {
  success: boolean;
  id?: string;
  error?: string;
  statusCode?: number;
  isAvailable?: boolean;
  venueId?: string;
  menuType?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function emitMenuChanged(): void {
  try {
    emitEvent({
      event: EVENT_NAMES.CONFIG_CHANGED,
      data: { tables: ["menu_item", "venue_price", "venue_menu_item_availability"], source: "socket" },
    });
  } catch (err) {
    runtimeLog.warn("[menuService] emitEvent failed (non-fatal)", { error: String(err) });
  }
}

// Coerce a price-like value to a finite, non-negative number. Returns 0 for
// missing/invalid input so we never store NaN or negative prices.
function sanitizePrice(value: any): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

// Resolve a category by name (create if missing) → returns category id.
// Cashier edits often pass a category name string; the edge schema is id-keyed.
function resolveCategoryId(restaurantId: string, category: string): string | null {
  const db = getDb();
  if (!category) return null;
  // Trim + cap length so a stray control chars / huge string can't pollute the
  // category table.
  const name = String(category).trim().slice(0, 120);
  if (!name) return null;

  // If it looks like an id (cuid/uuid), use it directly.
  const existingById = db.query("SELECT id FROM category WHERE id = ? AND restaurant_id = ?").get(name, restaurantId) as any;
  if (existingById) return existingById.id;

  const existing = db.query("SELECT id FROM category WHERE name = ? AND restaurant_id = ?").get(name, restaurantId) as any;
  if (existing) return existing.id;

  // Create a new category row. Use a generated id so it syncs to cloud.
  const newId = `cat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.query("INSERT INTO category (id, name, restaurant_id, sort_order, is_active, synced_at) VALUES (?, ?, ?, 0, 1, unixepoch())")
    .run(newId, name, restaurantId);
  enqueueSync("category", newId, "create");
  return newId;
}

// Upsert venue_price rows for an item. Runs all upserts inside a single
// transaction so a multi-venue edit is atomic and avoids N separate implicit
// transactions (one per INSERT).
function upsertVenuePrices(restaurantId: string, itemId: string, venuePrices: Record<string, any>): void {
  const db = getDb();
  if (!venuePrices || typeof venuePrices !== "object") return;
  const entries = Object.entries(venuePrices).filter(([, price]) => price !== undefined && price !== null && price !== "");
  if (entries.length === 0) return;

  const stmt = db.query(`
    INSERT INTO venue_price (id, venue_id, menu_item_id, price, is_active, restaurant_id)
    VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(venue_id, menu_item_id) DO UPDATE SET price = excluded.price, is_active = 1
  `);
  db.exec("BEGIN");
  try {
    for (const [venueId, price] of entries) {
      const id = `vp-${venueId}-${itemId}`;
      stmt.run(id, venueId, itemId, sanitizePrice(price), restaurantId);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Upsert venue_menu_item_availability rows for an item. Same transaction
// wrapping as upsertVenuePrices for atomicity + throughput.
function upsertVenueAvailability(restaurantId: string, itemId: string, venueAvail: Record<string, any>): void {
  const db = getDb();
  if (!venueAvail || typeof venueAvail !== "object") return;
  const entries = Object.entries(venueAvail);
  if (entries.length === 0) return;

  const stmt = db.query(`
    INSERT INTO venue_menu_item_availability (id, venue_id, menu_item_id, restaurant_id, is_available)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(venue_id, menu_item_id) DO UPDATE SET is_available = excluded.is_available
  `);
  db.exec("BEGIN");
  try {
    for (const [venueId, isAvailable] of entries) {
      const id = `vmaa-${venueId}-${itemId}`;
      stmt.run(id, venueId, itemId, restaurantId, isAvailable ? 1 : 0);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ── Create ───────────────────────────────────────────────────────────────────

export function createMenuItemEdge(data: any): MenuEditResult {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return { success: false, error: "No restaurant ID in session", statusCode: 500 };

  if (!data?.name) return { success: false, error: "name is required", statusCode: 400 };
  if (!data?.category) return { success: false, error: "category is required", statusCode: 400 };

  const db = getDb();
  const categoryId = resolveCategoryId(restaurantId, data.category);
  if (!categoryId) return { success: false, error: "Could not resolve category", statusCode: 400 };

  const id = data.id || `mi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const menuType = (data.menuType || "FOOD").toUpperCase();
  const isLiquor = menuType === "LIQUOR";
  const gstEnabled = isLiquor ? 0 : (data.gstEnabled === false ? 0 : 1);

  db.query(`
    INSERT INTO menu_item (
      id, name, description, image_url, is_veg, is_available, sort_order,
      category_id, restaurant_id, base_price, unit, is_deleted,
      printer_target, printer_name, menu_type, gst_enabled,
      is_special, special_channel, special_active, special_expires_at, updated_at, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  `).run(
    id,
    data.name,
    data.description || null,
    data.imageUrl || null,
    data.isVeg ? 1 : 0,
    data.isAvailable === false ? 0 : 1,
    data.sortOrder || 0,
    categoryId,
    restaurantId,
    sanitizePrice(data.price ?? data.basePrice),
    data.unit || (isLiquor ? "ml" : null),
    data.printerTarget || null,
    data.printerName || null,
    menuType,
    gstEnabled,
    data.isSpecial ? 1 : 0,
    data.specialChannel || "BOTH",
    data.specialActive === false ? 0 : 1,
    data.specialExpiresAt ? Number(new Date(data.specialExpiresAt).getTime()) : null,
    Date.now(),
  );

  upsertVenuePrices(restaurantId, id, data.venuePrices);
  upsertVenueAvailability(restaurantId, id, data.venueAvailabilities);

  enqueueSync("menu_item", id, "create");
  invalidateReadCache();
  emitMenuChanged();

  runtimeLog.info("[menuService] Created menu item", { id, name: data.name });
  return { success: true, id };
}

// ── Update (full edit) ───────────────────────────────────────────────────────

export function updateMenuItemEdge(id: string, data: any): MenuEditResult {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return { success: false, error: "No restaurant ID in session", statusCode: 500 };
  if (!id) return { success: false, error: "id is required", statusCode: 400 };

  const db = getDb();
  const existing = db.query("SELECT id, category_id FROM menu_item WHERE id = ? AND restaurant_id = ?").get(id, restaurantId) as any;
  if (!existing) return { success: false, error: "Item not found", statusCode: 404 };

  // Build SET clause dynamically from provided fields.
  const sets: string[] = [];
  const params: any[] = [];

  if (data.name !== undefined) { sets.push("name = ?"); params.push(data.name); }
  if (data.description !== undefined) { sets.push("description = ?"); params.push(data.description || null); }
  if (data.imageUrl !== undefined) { sets.push("image_url = ?"); params.push(data.imageUrl || null); }
  if (data.isVeg !== undefined) { sets.push("is_veg = ?"); params.push(data.isVeg ? 1 : 0); }
  if (data.isAvailable !== undefined) { sets.push("is_available = ?"); params.push(data.isAvailable ? 1 : 0); }
  if (data.sortOrder !== undefined) { sets.push("sort_order = ?"); params.push(Number(data.sortOrder)); }
  if (data.unit !== undefined) { sets.push("unit = ?"); params.push(data.unit || null); }
  if (data.printerTarget !== undefined) { sets.push("printer_target = ?"); params.push(data.printerTarget || null); }
  if (data.printerName !== undefined) { sets.push("printer_name = ?"); params.push(data.printerName || null); }
  if (data.isSpecial !== undefined) { sets.push("is_special = ?"); params.push(data.isSpecial ? 1 : 0); }
  if (data.specialChannel !== undefined) { sets.push("special_channel = ?"); params.push(data.specialChannel); }
  if (data.specialActive !== undefined) { sets.push("special_active = ?"); params.push(data.specialActive ? 1 : 0); }
  if (data.specialExpiresAt !== undefined) {
    sets.push("special_expires_at = ?");
    params.push(data.specialExpiresAt ? Number(new Date(data.specialExpiresAt).getTime()) : null);
  }

  if (data.menuType !== undefined) {
    const menuType = (data.menuType || "FOOD").toUpperCase();
    sets.push("menu_type = ?");
    params.push(menuType);
    // Liquor never carries GST.
    if (menuType === "LIQUOR") {
      sets.push("gst_enabled = 0");
    } else if (data.gstEnabled !== undefined) {
      sets.push("gst_enabled = ?");
      params.push(data.gstEnabled ? 1 : 0);
    }
  } else if (data.gstEnabled !== undefined) {
    sets.push("gst_enabled = ?");
    params.push(data.gstEnabled ? 1 : 0);
  }

  if (data.price !== undefined || data.basePrice !== undefined) {
    sets.push("base_price = ?");
    params.push(sanitizePrice(data.price ?? data.basePrice));
  }

  if (data.category !== undefined) {
    const categoryId = resolveCategoryId(restaurantId, data.category);
    if (categoryId) {
      sets.push("category_id = ?");
      params.push(categoryId);
    }
  }

  // Always bump updated_at + synced_at on an update, even when only venue
  // prices/availability changed (sets may be empty in that case). Without this,
  // a venue-only edit would enqueue a menu_item sync carrying a stale/NULL
  // updated_at, which either bypasses the cloud conflict check or falsely
  // conflicts. The bump is what makes the conflict check meaningful.
  sets.push("synced_at = unixepoch()");
  sets.push("updated_at = ?");
  params.push(Date.now());
  params.push(id, restaurantId);
  db.query(`UPDATE menu_item SET ${sets.join(", ")} WHERE id = ? AND restaurant_id = ?`).run(...params);

  if (data.venuePrices !== undefined) upsertVenuePrices(restaurantId, id, data.venuePrices);
  if (data.venueAvailabilities !== undefined) upsertVenueAvailability(restaurantId, id, data.venueAvailabilities);

  enqueueSync("menu_item", id, "update");
  invalidateReadCache();
  emitMenuChanged();

  runtimeLog.info("[menuService] Updated menu item", { id, fields: sets.length });
  return { success: true, id };
}

// ── Delete (soft) ────────────────────────────────────────────────────────────

export function deleteMenuItemEdge(id: string): MenuEditResult {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return { success: false, error: "No restaurant ID in session", statusCode: 500 };
  if (!id) return { success: false, error: "id is required", statusCode: 400 };

  const db = getDb();
  const existing = db.query("SELECT id FROM menu_item WHERE id = ? AND restaurant_id = ?").get(id, restaurantId) as any;
  if (!existing) return { success: false, error: "Item not found", statusCode: 404 };

  db.query("UPDATE menu_item SET is_deleted = 1, deleted_at = unixepoch(), is_available = 0, updated_at = ?, synced_at = unixepoch() WHERE id = ? AND restaurant_id = ?")
    .run(Date.now(), id, restaurantId);

  enqueueSync("menu_item", id, "delete");
  invalidateReadCache();
  emitMenuChanged();

  runtimeLog.info("[menuService] Deleted menu item", { id });
  return { success: true, id };
}

// ── Availability toggle ──────────────────────────────────────────────────────

export function toggleAvailabilityEdge(id: string): MenuEditResult {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return { success: false, error: "No restaurant ID in session", statusCode: 500 };
  if (!id) return { success: false, error: "id is required", statusCode: 400 };

  const db = getDb();
  const row = db.query("SELECT is_available FROM menu_item WHERE id = ? AND restaurant_id = ? AND is_deleted = 0").get(id, restaurantId) as any;
  if (!row) return { success: false, error: "Item not found", statusCode: 404 };

  const newValue = row.is_available ? 0 : 1;
  db.query("UPDATE menu_item SET is_available = ?, updated_at = ?, synced_at = unixepoch() WHERE id = ? AND restaurant_id = ?")
    .run(newValue, Date.now(), id, restaurantId);

  enqueueSync("menu_item", id, "update");
  invalidateReadCache();
  emitMenuChanged();

  return { success: true, id, isAvailable: !!newValue };
}

// ── Venue availability toggle ────────────────────────────────────────────────

export function toggleVenueAvailabilityEdge(id: string, venueId: string): MenuEditResult {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return { success: false, error: "No restaurant ID in session", statusCode: 500 };
  if (!id || !venueId) return { success: false, error: "id and venueId are required", statusCode: 400 };

  const db = getDb();
  const row = db.query("SELECT is_available FROM venue_menu_item_availability WHERE menu_item_id = ? AND venue_id = ? AND restaurant_id = ?").get(id, venueId, restaurantId) as any;
  // If no row exists, the item is available by default — toggling makes it unavailable.
  const currentValue = row ? !!row.is_available : true;
  const newValue = currentValue ? 0 : 1;

  const vmaaId = `vmaa-${venueId}-${id}`;
  db.query(`
    INSERT INTO venue_menu_item_availability (id, venue_id, menu_item_id, restaurant_id, is_available)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(venue_id, menu_item_id) DO UPDATE SET is_available = excluded.is_available
  `).run(vmaaId, venueId, id, restaurantId, newValue);

  // Bump the parent menu_item row's updated_at + synced_at so the sync payload
  // carries a meaningful timestamp for the cloud conflict check. Without this,
  // the venue-only toggle would sync with a stale/NULL updated_at.
  db.query("UPDATE menu_item SET updated_at = ?, synced_at = unixepoch() WHERE id = ? AND restaurant_id = ?")
    .run(Date.now(), id, restaurantId);

  // Enqueue a menu_item sync so the cloud receives the updated availability map.
  enqueueSync("menu_item", id, "update");
  invalidateReadCache();
  emitMenuChanged();

  return { success: true, id, venueId, isAvailable: !!newValue };
}

// ── Menu type toggle (FOOD ↔ LIQUOR) ─────────────────────────────────────────

export function toggleMenuTypeEdge(id: string, newPrinterTarget?: string | null): MenuEditResult {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return { success: false, error: "No restaurant ID in session", statusCode: 500 };
  if (!id) return { success: false, error: "id is required", statusCode: 400 };

  const db = getDb();
  const row = db.query("SELECT menu_type FROM menu_item WHERE id = ? AND restaurant_id = ? AND is_deleted = 0").get(id, restaurantId) as any;
  if (!row) return { success: false, error: "Item not found", statusCode: 404 };

  const newType = (row.menu_type || "FOOD").toUpperCase() === "LIQUOR" ? "FOOD" : "LIQUOR";
  const gstEnabled = newType === "LIQUOR" ? 0 : 1;

  db.query("UPDATE menu_item SET menu_type = ?, gst_enabled = ?, printer_target = ?, updated_at = ?, synced_at = unixepoch() WHERE id = ? AND restaurant_id = ?")
    .run(newType, gstEnabled, newPrinterTarget || null, Date.now(), id, restaurantId);

  enqueueSync("menu_item", id, "update");
  invalidateReadCache();
  emitMenuChanged();

  return { success: true, id, menuType: newType };
}
