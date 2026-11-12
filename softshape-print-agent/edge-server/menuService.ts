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
import { buildVenuePriceMap } from "./pricing.ts";
import { getServerTimeOffsetMs } from "./cloudFetch.ts";

// Edit time on the cloud's clock. The cloud decides "whose edit is newer" by
// comparing this with its own times, so a PC clock running slow or fast must
// not make a fresh edit look old (and be thrown away) or an old one look new.
function editTime(): number {
  return Date.now() + getServerTimeOffsetMs();
}

export interface MenuEditResult {
  success: boolean;
  id?: string;
  error?: string;
  statusCode?: number;
  isAvailable?: boolean;
  venueId?: string;
  sectionId?: string;
  menuType?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function emitMenuChanged(): void {
  try {
    emitEvent({
      event: EVENT_NAMES.CONFIG_CHANGED,
      data: { tables: ["menu_item", "venue_price", "venue_menu_item_availability", "section_menu_item_availability"], source: "socket" },
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
// `savedVenueIds`: venues whose price the user explicitly saved in Edit Menu.
// Those are always marked for upload, even when the PC already shows that
// price — re-saving is how a price that differs between the PC and the cloud
// is put right (the PC's value then goes to the cloud).
export function upsertVenuePrices(
  restaurantId: string,
  itemId: string,
  venuePrices: Record<string, any>,
  savedVenueIds: string[] = [],
): void {
  const db = getDb();
  if (!venuePrices || typeof venuePrices !== "object") return;
  const entries = Object.entries(venuePrices).filter(([, price]) => price !== undefined && price !== null && price !== "");
  if (entries.length === 0) return;

  // pending_push marks the price as edited here and not yet confirmed by the
  // cloud — only marked prices travel up with the menu item (sync.ts).
  const editedAt = Date.now();
  const stmt = db.query(`
    INSERT INTO venue_price (id, venue_id, menu_item_id, price, is_active, restaurant_id, pending_push)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(venue_id, menu_item_id) DO UPDATE SET price = excluded.price, is_active = 1, pending_push = excluded.pending_push
  `);
  // Orders take their price from the venue's price profile first
  // (buildEdgePriceMap in orderService.ts), so a price edited here must land
  // there too or new orders keep the old price until the cloud round-trip.
  // A list shared with another venue is left alone: writing to it would also change
  // (or be overwritten by) the other venue. The cloud gives this venue its own list
  // when the edit syncs up, and the new list comes back down.
  const profileOf = db.query(
    `SELECT price_profile_id FROM venue v WHERE id = ?
     AND NOT EXISTS (SELECT 1 FROM venue o WHERE o.price_profile_id = v.price_profile_id AND o.id != v.id AND COALESCE(o.is_deleted, 0) = 0)`,
  );
  const profileStmt = db.query(`
    INSERT INTO price_profile_item (id, price_profile_id, menu_item_id, price, restaurant_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(price_profile_id, menu_item_id) DO UPDATE SET price = excluded.price
  `);
  db.transaction(() => {
    for (const [venueId, price] of entries) {
      const id = `vp-${venueId}-${itemId}`;
      const clean = sanitizePrice(price);
      // Unchanged price (the edit form re-sends every venue's price): leave
      // the row alone so it is not uploaded again as a new edit.
      const current = buildVenuePriceMap(venueId).get(itemId);
      if (current !== undefined && Number(current) === clean && !savedVenueIds.includes(venueId)) continue;
      stmt.run(id, venueId, itemId, clean, restaurantId, editedAt);
      const profileId = (profileOf.get(venueId) as any)?.price_profile_id;
      if (profileId && clean > 0) {
        profileStmt.run(`ppi-${profileId}-${itemId}`, profileId, itemId, clean, restaurantId);
      }
    }
  })();
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

// Upsert section_menu_item_availability rows for an item. Same transaction
// wrapping as upsertVenueAvailability for atomicity + throughput.
function upsertSectionAvailability(restaurantId: string, itemId: string, sectionAvail: Record<string, any>): void {
  const db = getDb();
  if (!sectionAvail || typeof sectionAvail !== "object") return;
  const entries = Object.entries(sectionAvail);
  if (entries.length === 0) return;

  const stmt = db.query(`
    INSERT INTO section_menu_item_availability (id, section_id, menu_item_id, restaurant_id, is_available)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(section_id, menu_item_id) DO UPDATE SET is_available = excluded.is_available
  `);
  db.exec("BEGIN");
  try {
    for (const [sectionId, isAvailable] of entries) {
      const id = `smaa-${sectionId}-${itemId}`;
      stmt.run(id, sectionId, itemId, restaurantId, isAvailable ? 1 : 0);
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
      is_special, special_channel, special_active, special_expires_at, report_category, updated_at, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
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
    data.reportCategory || null,
    editTime(),
  );

  upsertVenuePrices(restaurantId, id, data.venuePrices);
  upsertVenueAvailability(restaurantId, id, data.venueAvailabilities);
  upsertSectionAvailability(restaurantId, id, data.sectionAvailabilities);

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
  if (data.reportCategory !== undefined) { sets.push("report_category = ?"); params.push(data.reportCategory || null); }
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
  params.push(editTime());
  params.push(id, restaurantId);
  db.query(`UPDATE menu_item SET ${sets.join(", ")} WHERE id = ? AND restaurant_id = ?`).run(...params);

  if (data.venuePrices !== undefined) {
    upsertVenuePrices(restaurantId, id, data.venuePrices, Array.isArray(data.savedVenueIds) ? data.savedVenueIds : []);
  }
  if (data.venueAvailabilities !== undefined) upsertVenueAvailability(restaurantId, id, data.venueAvailabilities);
  if (data.sectionAvailabilities !== undefined) upsertSectionAvailability(restaurantId, id, data.sectionAvailabilities);

  enqueueSync("menu_item", id, "update");
  invalidateReadCache();
  emitMenuChanged();

  runtimeLog.info("[menuService] Updated menu item", { id, fields: sets.length });
  return { success: true, id };
}

// ── Category printer ─────────────────────────────────────────────────────────

export function listCategoriesWithPrinters(): { id: string; name: string; printerTarget: string | null }[] {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return [];
  const rows = getDb()
    .query("SELECT id, name, printer_target FROM category WHERE restaurant_id = ? AND is_active = 1 ORDER BY sort_order ASC, name ASC")
    .all(restaurantId) as any[];
  return rows.map((r) => ({ id: r.id, name: r.name, printerTarget: r.printer_target || null }));
}

/**
 * Set a category's KOT printer. This overrides every per-item printer in the
 * category (item-level printer_target is cleared so all items follow the
 * category). A per-item printer set afterwards wins over the category again.
 */
export function setCategoryPrinterEdge(categoryId: string, printerTarget: string | null): MenuEditResult {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return { success: false, error: "No restaurant ID in session", statusCode: 500 };
  if (!categoryId) return { success: false, error: "id is required", statusCode: 400 };

  const db = getDb();
  const cat = db.query("SELECT id FROM category WHERE id = ? AND restaurant_id = ?").get(categoryId, restaurantId) as any;
  if (!cat) return { success: false, error: "Category not found", statusCode: 404 };

  const target = typeof printerTarget === "string" && printerTarget.trim() ? printerTarget.trim() : null;
  const now = Date.now();

  // Items carrying their own printer: a logical one (printer_target) or a physical
  // override (printer_name). The physical override outranks everything at print time,
  // so it must be cleared too or the category printer would never take effect.
  const itemIds = (db.query(
    "SELECT id FROM menu_item WHERE category_id = ? AND restaurant_id = ? AND ((printer_target IS NOT NULL AND printer_target != '') OR (printer_name IS NOT NULL AND printer_name != ''))"
  ).all(categoryId, restaurantId) as any[]).map((r) => r.id);

  db.transaction(() => {
    db.query("UPDATE category SET printer_target = ? WHERE id = ? AND restaurant_id = ?").run(target, categoryId, restaurantId);
    db.query("UPDATE menu_item SET printer_target = NULL, printer_name = NULL, updated_at = ?, synced_at = unixepoch() WHERE category_id = ? AND restaurant_id = ?")
      .run(now, categoryId, restaurantId);
  })();

  enqueueSync("category", categoryId, "update");
  for (const itemId of itemIds) enqueueSync("menu_item", itemId, "update");
  invalidateReadCache();
  emitMenuChanged();

  runtimeLog.info("[menuService] Set category printer", { categoryId, printerTarget: target, itemsReset: itemIds.length });
  return { success: true, id: categoryId };
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
    .run(editTime(), id, restaurantId);

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
    .run(newValue, editTime(), id, restaurantId);

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
    .run(editTime(), id, restaurantId);

  // Enqueue a menu_item sync so the cloud receives the updated availability map.
  enqueueSync("menu_item", id, "update");
  invalidateReadCache();
  emitMenuChanged();

  return { success: true, id, venueId, isAvailable: !!newValue };
}

// ── Section availability toggle ──────────────────────────────────────────────

export function toggleSectionAvailabilityEdge(id: string, sectionId: string): MenuEditResult {
  const restaurantId = getRestaurantId();
  if (!restaurantId) return { success: false, error: "No restaurant ID in session", statusCode: 500 };
  if (!id || !sectionId) return { success: false, error: "id and sectionId are required", statusCode: 400 };

  const db = getDb();
  const row = db.query("SELECT is_available FROM section_menu_item_availability WHERE menu_item_id = ? AND section_id = ? AND restaurant_id = ?").get(id, sectionId, restaurantId) as any;
  // If no row exists, the item is available by default — toggling makes it unavailable.
  const currentValue = row ? !!row.is_available : true;
  const newValue = currentValue ? 0 : 1;

  const smaaId = `smaa-${sectionId}-${id}`;
  db.query(`
    INSERT INTO section_menu_item_availability (id, section_id, menu_item_id, restaurant_id, is_available)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(section_id, menu_item_id) DO UPDATE SET is_available = excluded.is_available
  `).run(smaaId, sectionId, id, restaurantId, newValue);

  // Bump the parent menu_item row's updated_at + synced_at so the sync payload
  // carries a meaningful timestamp for the cloud conflict check.
  db.query("UPDATE menu_item SET updated_at = ?, synced_at = unixepoch() WHERE id = ? AND restaurant_id = ?")
    .run(editTime(), id, restaurantId);

  // Enqueue a menu_item sync so the cloud receives the updated availability map.
  enqueueSync("menu_item", id, "update");
  invalidateReadCache();
  emitMenuChanged();

  return { success: true, id, sectionId, isAvailable: !!newValue };
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
    .run(newType, gstEnabled, newPrinterTarget || null, editTime(), id, restaurantId);

  enqueueSync("menu_item", id, "update");
  invalidateReadCache();
  emitMenuChanged();

  return { success: true, id, menuType: newType };
}
