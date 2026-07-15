// ─────────────────────────────────────────────────────────────────────────────
// config.ts — Download restaurant config from cloud and populate local SQLite
// ─────────────────────────────────────────────────────────────────────────────
// Called on first boot after setup token auth, or when a "config refresh" is
// triggered (menu changes, settings updates pushed via socket).
//
// Fetches: outlet settings, tax profiles, price profiles, venues, floors,
// sections, tables, categories, menu items, variants, addons, venue prices,
// venue availability, printer config.
//
// All data is upserted into local SQLite, replacing stale rows.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, setSyncState, getSyncState } from "./db.ts";
import { getBackendUrl, getSessionToken, getRestaurantId } from "./auth.ts";
import { cloudFetch } from "./cloudFetch.ts";

interface ConfigResponse {
  outlet: any;
  taxProfiles: any[];
  priceProfiles: any[];
  priceProfileItems: any[];
  venues: any[];
  floors: any[];
  sections: any[];
  tables: any[];
  categories: any[];
  menuItems: any[];
  menuVariants: any[];
  menuAddons: any[];
  venuePrices: any[];
  venueAvailability: any[];
  users: any[];
}

export async function downloadFullConfig(): Promise<{ success: boolean; error?: string; tablesLoaded?: number }> {
  const backendUrl = getBackendUrl();
  const token = getSessionToken();
  const restaurantId = getRestaurantId();

  if (!backendUrl || !token || !restaurantId) {
    return { success: false, error: "No valid session — cannot download config" };
  }

  try {
    const res = await cloudFetch(`${backendUrl}/api/edge/config`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { success: false, error: body.error || `HTTP ${res.status}` };
    }

    const config: ConfigResponse = await res.json();
    const db = getDb();

    if (!config.outlet) {
      return { success: false, error: "Outlet not found in cloud config" };
    }

    let totalRows = 0;

    // ── Outlet ──────────────────────────────────────────────────────────────
    db.query(`INSERT INTO outlet (
      id, name, slug, restaurant_code, restaurant_type, address, phone, email,
      gstin, logo_url, receipt_header, receipt_sub_header, theme_primary, theme_secondary,
      printer_config, bar_unit_ml, full_bottle_ml, half_bottle_ml, fssai,
      prices_include_gst, gst_category, gst_rate, gst_registered, service_charge_percent,
      enabled_modules, shared_kitchen_outlet_id, organization_id, is_active, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, slug=excluded.slug, restaurant_code=excluded.restaurant_code,
      restaurant_type=excluded.restaurant_type, address=excluded.address, phone=excluded.phone,
      email=excluded.email, gstin=excluded.gstin, logo_url=excluded.logo_url,
      receipt_header=excluded.receipt_header, receipt_sub_header=excluded.receipt_sub_header,
      theme_primary=excluded.theme_primary, theme_secondary=excluded.theme_secondary,
      printer_config=excluded.printer_config, bar_unit_ml=excluded.bar_unit_ml,
      full_bottle_ml=excluded.full_bottle_ml, half_bottle_ml=excluded.half_bottle_ml,
      fssai=excluded.fssai, prices_include_gst=excluded.prices_include_gst,
      gst_category=excluded.gst_category, gst_rate=excluded.gst_rate,
      gst_registered=excluded.gst_registered, service_charge_percent=excluded.service_charge_percent,
      enabled_modules=excluded.enabled_modules, shared_kitchen_outlet_id=excluded.shared_kitchen_outlet_id,
      organization_id=excluded.organization_id, is_active=excluded.is_active,
      synced_at=unixepoch()
    `).run(
      config.outlet.id, config.outlet.name, config.outlet.slug, config.outlet.restaurantCode,
      config.outlet.restaurantType || null, config.outlet.address || null,
      config.outlet.phone || null, config.outlet.email || null,
      config.outlet.gstin || null, config.outlet.logoUrl || null,
      config.outlet.receiptHeader || null, config.outlet.receiptSubHeader || null,
      config.outlet.themePrimary || null, config.outlet.themeSecondary || null,
      JSON.stringify(config.outlet.printerConfig || {}),
      config.outlet.barUnitMl || 30, config.outlet.fullBottleMl || 750,
      config.outlet.halfBottleMl || 375, config.outlet.fssai || null,
      config.outlet.pricesIncludeGst ? 1 : 0, config.outlet.gstCategory || "NON_AC",
      config.outlet.gstRate || null, config.outlet.gstRegistered !== false ? 1 : 0,
      config.outlet.serviceChargePercent || 0,
      JSON.stringify(config.outlet.enabledModules || {}),
      config.outlet.sharedKitchenOutletId || null,
      config.outlet.organizationId || null, config.outlet.isActive !== false ? 1 : 0
    );
    totalRows++;

    // ── Tax Profiles ─────────────────────────────────────────────────────────
    for (const tp of config.taxProfiles) {
      db.query(`INSERT INTO tax_profile (id, restaurant_id, name, gst_category, gst_rate, gst_registered, service_charge_percent, is_default, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, gst_category=excluded.gst_category, gst_rate=excluded.gst_rate,
        gst_registered=excluded.gst_registered, service_charge_percent=excluded.service_charge_percent, is_default=excluded.is_default, synced_at=unixepoch()
      `).run(tp.id, tp.restaurantId, tp.name, tp.gstCategory || "NON_AC", tp.gstRate, tp.gstRegistered ? 1 : 0, tp.serviceChargePercent || 0, tp.isDefault ? 1 : 0);
      totalRows++;
    }

    // ── Price Profiles ──────────────────────────────────────────────────────
    for (const pp of config.priceProfiles) {
      db.query(`INSERT INTO price_profile (id, restaurant_id, name, is_default, synced_at)
        VALUES (?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, is_default=excluded.is_default, synced_at=unixepoch()
      `).run(pp.id, pp.restaurantId, pp.name, pp.isDefault ? 1 : 0);
      totalRows++;
    }

    // ── Price Profile Items ──────────────────────────────────────────────────
    for (const ppi of config.priceProfileItems) {
      db.query(`INSERT INTO price_profile_item (id, price_profile_id, menu_item_id, price, restaurant_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(price_profile_id, menu_item_id) DO UPDATE SET price=excluded.price
      `).run(ppi.id, ppi.priceProfileId, ppi.menuItemId, Number(ppi.price), ppi.restaurantId);
      totalRows++;
    }

    // ── Venues ───────────────────────────────────────────────────────────────
    for (const v of config.venues) {
      db.query(`INSERT INTO venue (id, restaurant_id, name, venue_type, sort_order, is_active, is_deleted, price_profile_id, tax_profile_id, kot_printer_name, bill_printer_name, kot_enabled, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, venue_type=excluded.venue_type, sort_order=excluded.sort_order,
        is_active=excluded.is_active, is_deleted=excluded.is_deleted, price_profile_id=excluded.price_profile_id,
        tax_profile_id=excluded.tax_profile_id, kot_printer_name=excluded.kot_printer_name,
        bill_printer_name=excluded.bill_printer_name, kot_enabled=excluded.kot_enabled, synced_at=unixepoch()
      `).run(v.id, v.restaurantId, v.name, v.venueType || "DINE_IN", v.sortOrder || 0,
        v.isActive !== false ? 1 : 0, v.isDeleted ? 1 : 0, v.priceProfileId || null,
        v.taxProfileId || null, v.kotPrinterName || null, v.billPrinterName || null,
        v.kotEnabled !== false ? 1 : 0);
      totalRows++;
    }

    // ── Floors ───────────────────────────────────────────────────────────────
    for (const f of config.floors) {
      db.query(`INSERT INTO floor (id, venue_id, restaurant_id, name, sort_order, is_active, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort_order=excluded.sort_order, is_active=excluded.is_active, synced_at=unixepoch()
      `).run(f.id, f.venueId, f.restaurantId, f.name, f.sortOrder || 0, f.isActive !== false ? 1 : 0);
      totalRows++;
    }

    // ── Sections ─────────────────────────────────────────────────────────────
    for (const s of config.sections) {
      db.query(`INSERT INTO section (id, name, restaurant_id, floor_id, venue_id, sort_order, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, floor_id=excluded.floor_id, venue_id=excluded.venue_id, sort_order=excluded.sort_order, synced_at=unixepoch()
      `).run(s.id, s.name, s.restaurantId, s.floorId || null, s.venueId || null, s.sortOrder || 0);
      totalRows++;
    }

    // ── Tables ───────────────────────────────────────────────────────────────
    for (const t of config.tables) {
      db.query(`INSERT INTO "table" (id, number, capacity, status, section_id, restaurant_id, workflow_status, captain_id, guests, session_started_at, current_bill, kot_history, discount, section_tag, last_waiter_call_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET number=excluded.number, capacity=excluded.capacity, status=excluded.status,
        section_id=excluded.section_id, workflow_status=excluded.workflow_status, captain_id=excluded.captain_id,
        guests=excluded.guests, session_started_at=excluded.session_started_at, current_bill=excluded.current_bill,
        kot_history=excluded.kot_history, discount=excluded.discount, section_tag=excluded.section_tag,
        last_waiter_call_at=excluded.last_waiter_call_at, updated_at=unixepoch()
      `).run(
        t.id, t.number, t.capacity || 4, t.status || "AVAILABLE",
        t.sectionId, t.restaurantId, t.workflowStatus || null, t.captainId || null,
        t.guests || 0, t.sessionStartedAt ? new Date(t.sessionStartedAt).getTime() : null,
        Number(t.currentBill || 0), JSON.stringify(t.kotHistory || []),
        t.discount ? Number(t.discount) : null, t.sectionTag || null,
        t.lastWaiterCallAt ? new Date(t.lastWaiterCallAt).getTime() : null
      );
      totalRows++;
    }

    // ── Categories ────────────────────────────────────────────────────────────
    for (const c of config.categories) {
      db.query(`INSERT INTO category (id, name, sort_order, is_active, restaurant_id, printer_target, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort_order=excluded.sort_order, is_active=excluded.is_active, printer_target=excluded.printer_target, synced_at=unixepoch()
      `).run(c.id, c.name, c.sortOrder || 0, c.isActive !== false ? 1 : 0, c.restaurantId, c.printerTarget || null);
      totalRows++;
    }

    // ── Menu Items ────────────────────────────────────────────────────────────
    for (const m of config.menuItems) {
      db.query(`INSERT INTO menu_item (id, name, description, image_url, is_veg, is_available, sort_order, category_id, restaurant_id, base_price, unit, is_deleted, deleted_at, printer_target, printer_name, menu_type, gst_enabled, is_special, special_channel, special_active, special_expires_at, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, image_url=excluded.image_url,
        is_veg=excluded.is_veg, is_available=excluded.is_available, sort_order=excluded.sort_order,
        category_id=excluded.category_id, base_price=excluded.base_price, unit=excluded.unit,
        is_deleted=excluded.is_deleted, deleted_at=excluded.deleted_at, printer_target=excluded.printer_target,
        printer_name=excluded.printer_name, menu_type=excluded.menu_type, gst_enabled=excluded.gst_enabled,
        is_special=excluded.is_special, special_channel=excluded.special_channel, special_active=excluded.special_active,
        special_expires_at=excluded.special_expires_at, synced_at=unixepoch()
      `).run(
        m.id, m.name, m.description || null, m.imageUrl || null,
        m.isVeg !== false ? 1 : 0, m.isAvailable !== false ? 1 : 0, m.sortOrder || 0,
        m.categoryId, m.restaurantId, Number(m.basePrice || 0), m.unit || null,
        m.isDeleted ? 1 : 0, m.deletedAt ? new Date(m.deletedAt).getTime() : null,
        m.printerTarget || null, m.printerName || null, m.menuType || "FOOD",
        m.gstEnabled !== false ? 1 : 0, m.isSpecial ? 1 : 0,
        m.specialChannel || "BOTH", m.specialActive !== false ? 1 : 0,
        m.specialExpiresAt ? new Date(m.specialExpiresAt).getTime() : null
      );
      totalRows++;
    }

    // ── Menu Item Variants ────────────────────────────────────────────────────
    for (const v of config.menuVariants) {
      db.query(`INSERT INTO menu_item_variant (id, name, price, is_default, menu_item_id, is_available, restaurant_id, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, price=excluded.price, is_default=excluded.is_default, is_available=excluded.is_available, synced_at=unixepoch()
      `).run(v.id, v.name, Number(v.price), v.isDefault ? 1 : 0, v.menuItemId, v.isAvailable !== false ? 1 : 0, v.restaurantId);
      totalRows++;
    }

    // ── Menu Item Addons ──────────────────────────────────────────────────────
    for (const a of config.menuAddons) {
      db.query(`INSERT INTO menu_item_addon (id, name, price, is_available, menu_item_id, restaurant_id, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, price=excluded.price, is_available=excluded.is_available, synced_at=unixepoch()
      `).run(a.id, a.name, Number(a.price), a.isAvailable !== false ? 1 : 0, a.menuItemId, a.restaurantId);
      totalRows++;
    }

    // ── Venue Prices ─────────────────────────────────────────────────────────
    for (const vp of config.venuePrices) {
      db.query(`INSERT INTO venue_price (id, venue_id, menu_item_id, price, is_active, restaurant_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(venue_id, menu_item_id) DO UPDATE SET price=excluded.price, is_active=excluded.is_active
      `).run(vp.id, vp.venueId, vp.menuItemId, Number(vp.price), vp.isActive !== false ? 1 : 0, vp.restaurantId);
      totalRows++;
    }

    // ── Venue Menu Item Availability ──────────────────────────────────────────
    for (const va of config.venueAvailability) {
      db.query(`INSERT INTO venue_menu_item_availability (id, venue_id, menu_item_id, restaurant_id, is_available)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(venue_id, menu_item_id) DO UPDATE SET is_available=excluded.is_available
      `).run(va.id, va.venueId, va.menuItemId, va.restaurantId, va.isAvailable !== false ? 1 : 0);
      totalRows++;
    }

    // ── Users (staff accounts for offline PIN verification) ────────────────
    for (const u of config.users || []) {
      db.query(`INSERT INTO users (id, name, pin, role, is_active, outlet_id, permissions, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, pin=excluded.pin, role=excluded.role,
        is_active=excluded.is_active, permissions=excluded.permissions, synced_at=unixepoch()
      `).run(
        u.id, u.name, u.pin || null, u.role,
        u.isActive !== false ? 1 : 0, u.outletId || restaurantId,
        JSON.stringify(u.permissions || {})
      );
      totalRows++;
    }

    // ── Record sync timestamp ─────────────────────────────────────────────────
    setSyncState("last_full_config_sync", new Date().toISOString());

    return { success: true, tablesLoaded: totalRows };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to download config" };
  }
}

// ── Incremental config pull (cloud → edge) ───────────────────────────────────

export async function pullIncrementalChanges(): Promise<{ success: boolean; changesApplied?: number; error?: string }> {
  const backendUrl = getBackendUrl();
  const token = getSessionToken();
  const restaurantId = getRestaurantId();

  if (!backendUrl || !token || !restaurantId) {
    return { success: false, error: "No valid session" };
  }

  const since = getSyncState("last_incremental_sync") || new Date(0).toISOString();

  try {
    const res = await cloudFetch(`${backendUrl}/api/edge/changes?since=${encodeURIComponent(since)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { success: false, error: body.error || `HTTP ${res.status}` };
    }

    const data = await res.json();

    // The cloud endpoint returns changes grouped by table:
    // { timestamp, changes: [{ table, operation, row }, ...] }
    // We apply each change via upsert (for insert/update) or delete.
    let applied = 0;
    if (data.changes && data.changes.length > 0) {
      const db = getDb();
      for (const change of data.changes) {
        const ok = applyChange(db, change);
        if (ok) applied++;
      }
    }

    setSyncState("last_incremental_sync", data.timestamp || new Date().toISOString());

    return { success: true, changesApplied: applied };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to pull changes" };
  }
}

// ── Apply a single change from cloud → edge ──────────────────────────────────
// Returns true if applied, false if skipped/unknown.
function applyChange(db: any, change: any): boolean {
  const table = change.table;
  const op = change.operation || "upsert";
  const row = change.row;

  // Handle delete operations
  if (op === "delete") {
    const tableName = TABLE_NAME_MAP[table] || table;
    try {
      db.query(`DELETE FROM ${tableName} WHERE id = ?`).run(row?.id || row);
      return true;
    } catch {
      return false;
    }
  }

  if (!row) return false;

  switch (table) {
    // ── Outlet ──────────────────────────────────────────────────────────────
    case "outlet":
      db.query(`INSERT INTO outlet (
        id, name, slug, restaurant_code, restaurant_type, address, phone, email,
        gstin, logo_url, receipt_header, receipt_sub_header, theme_primary, theme_secondary,
        printer_config, bar_unit_ml, full_bottle_ml, half_bottle_ml, fssai,
        prices_include_gst, gst_category, gst_rate, gst_registered, service_charge_percent,
        enabled_modules, shared_kitchen_outlet_id, organization_id, is_active, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, slug=excluded.slug, restaurant_code=excluded.restaurant_code,
        restaurant_type=excluded.restaurant_type, address=excluded.address, phone=excluded.phone,
        email=excluded.email, gstin=excluded.gstin, logo_url=excluded.logo_url,
        receipt_header=excluded.receipt_header, receipt_sub_header=excluded.receipt_sub_header,
        theme_primary=excluded.theme_primary, theme_secondary=excluded.theme_secondary,
        printer_config=excluded.printer_config, bar_unit_ml=excluded.bar_unit_ml,
        full_bottle_ml=excluded.full_bottle_ml, half_bottle_ml=excluded.half_bottle_ml,
        fssai=excluded.fssai, prices_include_gst=excluded.prices_include_gst,
        gst_category=excluded.gst_category, gst_rate=excluded.gst_rate,
        gst_registered=excluded.gst_registered, service_charge_percent=excluded.service_charge_percent,
        enabled_modules=excluded.enabled_modules, shared_kitchen_outlet_id=excluded.shared_kitchen_outlet_id,
        organization_id=excluded.organization_id, is_active=excluded.is_active, synced_at=unixepoch()
      `).run(
        row.id, row.name, row.slug, row.restaurantCode,
        row.restaurantType || null, row.address || null, row.phone || null, row.email || null,
        row.gstin || null, row.logoUrl || null, row.receiptHeader || null, row.receiptSubHeader || null,
        row.themePrimary || null, row.themeSecondary || null,
        JSON.stringify(row.printerConfig || {}),
        row.barUnitMl || 30, row.fullBottleMl || 750, row.halfBottleMl || 375, row.fssai || null,
        row.pricesIncludeGst ? 1 : 0, row.gstCategory || "NON_AC", row.gstRate || null,
        row.gstRegistered !== false ? 1 : 0, row.serviceChargePercent || 0,
        JSON.stringify(row.enabledModules || {}), row.sharedKitchenOutletId || null,
        row.organizationId || null, row.isActive !== false ? 1 : 0
      );
      return true;

    // ── Tax Profile ─────────────────────────────────────────────────────────
    case "tax_profile":
      db.query(`INSERT INTO tax_profile (id, restaurant_id, name, gst_category, gst_rate, gst_registered, service_charge_percent, is_default, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, gst_category=excluded.gst_category, gst_rate=excluded.gst_rate,
        gst_registered=excluded.gst_registered, service_charge_percent=excluded.service_charge_percent, is_default=excluded.is_default, synced_at=unixepoch()
      `).run(row.id, row.restaurantId, row.name, row.gstCategory || "NON_AC", row.gstRate, row.gstRegistered ? 1 : 0, row.serviceChargePercent || 0, row.isDefault ? 1 : 0);
      return true;

    // ── Price Profile ───────────────────────────────────────────────────────
    case "price_profile":
      db.query(`INSERT INTO price_profile (id, restaurant_id, name, is_default, synced_at)
        VALUES (?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, is_default=excluded.is_default, synced_at=unixepoch()
      `).run(row.id, row.restaurantId, row.name, row.isDefault ? 1 : 0);
      return true;

    // ── Price Profile Item ──────────────────────────────────────────────────
    case "price_profile_item":
      db.query(`INSERT INTO price_profile_item (id, price_profile_id, menu_item_id, price, restaurant_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(price_profile_id, menu_item_id) DO UPDATE SET price=excluded.price
      `).run(row.id, row.priceProfileId, row.menuItemId, Number(row.price), row.restaurantId);
      return true;

    // ── Venue ───────────────────────────────────────────────────────────────
    case "venue":
      db.query(`INSERT INTO venue (id, restaurant_id, name, venue_type, sort_order, is_active, is_deleted, price_profile_id, tax_profile_id, kot_printer_name, bill_printer_name, kot_enabled, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, venue_type=excluded.venue_type, sort_order=excluded.sort_order,
        is_active=excluded.is_active, is_deleted=excluded.is_deleted, price_profile_id=excluded.price_profile_id,
        tax_profile_id=excluded.tax_profile_id, kot_printer_name=excluded.kot_printer_name,
        bill_printer_name=excluded.bill_printer_name, kot_enabled=excluded.kot_enabled, synced_at=unixepoch()
      `).run(row.id, row.restaurantId, row.name, row.venueType || "DINE_IN", row.sortOrder || 0,
        row.isActive !== false ? 1 : 0, row.isDeleted ? 1 : 0, row.priceProfileId || null,
        row.taxProfileId || null, row.kotPrinterName || null, row.billPrinterName || null,
        row.kotEnabled !== false ? 1 : 0);
      return true;

    // ── Floor ───────────────────────────────────────────────────────────────
    case "floor":
      db.query(`INSERT INTO floor (id, venue_id, restaurant_id, name, sort_order, is_active, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort_order=excluded.sort_order, is_active=excluded.is_active, synced_at=unixepoch()
      `).run(row.id, row.venueId, row.restaurantId, row.name, row.sortOrder || 0, row.isActive !== false ? 1 : 0);
      return true;

    // ── Section ─────────────────────────────────────────────────────────────
    case "section":
      db.query(`INSERT INTO section (id, name, restaurant_id, floor_id, venue_id, sort_order, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, floor_id=excluded.floor_id, venue_id=excluded.venue_id, sort_order=excluded.sort_order, synced_at=unixepoch()
      `).run(row.id, row.name, row.restaurantId, row.floorId || null, row.venueId || null, row.sortOrder || 0);
      return true;

    // ── Table ───────────────────────────────────────────────────────────────
    case "table":
      db.query(`INSERT INTO "table" (id, number, capacity, status, section_id, restaurant_id, workflow_status, captain_id, guests, session_started_at, current_bill, kot_history, discount, section_tag, last_waiter_call_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET number=excluded.number, capacity=excluded.capacity, status=excluded.status,
        section_id=excluded.section_id, workflow_status=excluded.workflow_status, captain_id=excluded.captain_id,
        guests=excluded.guests, session_started_at=excluded.session_started_at, current_bill=excluded.current_bill,
        kot_history=excluded.kot_history, discount=excluded.discount, section_tag=excluded.section_tag,
        last_waiter_call_at=excluded.last_waiter_call_at, updated_at=unixepoch()
      `).run(
        row.id, row.number, row.capacity || 4, row.status || "AVAILABLE",
        row.sectionId, row.restaurantId, row.workflowStatus || null, row.captainId || null,
        row.guests || 0, row.sessionStartedAt ? new Date(row.sessionStartedAt).getTime() : null,
        Number(row.currentBill || 0), JSON.stringify(row.kotHistory || []),
        row.discount ? Number(row.discount) : null, row.sectionTag || null,
        row.lastWaiterCallAt ? new Date(row.lastWaiterCallAt).getTime() : null
      );
      return true;

    // ── Category ────────────────────────────────────────────────────────────
    case "category":
      db.query(`INSERT INTO category (id, name, sort_order, is_active, restaurant_id, printer_target, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort_order=excluded.sort_order, is_active=excluded.is_active, printer_target=excluded.printer_target, synced_at=unixepoch()
      `).run(row.id, row.name, row.sortOrder || 0, row.isActive !== false ? 1 : 0, row.restaurantId, row.printerTarget || null);
      return true;

    // ── Menu Item ───────────────────────────────────────────────────────────
    case "menu_item":
      db.query(`INSERT INTO menu_item (id, name, description, image_url, is_veg, is_available, sort_order, category_id, restaurant_id, base_price, unit, is_deleted, deleted_at, printer_target, printer_name, menu_type, gst_enabled, is_special, special_channel, special_active, special_expires_at, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, image_url=excluded.image_url,
        is_veg=excluded.is_veg, is_available=excluded.is_available, sort_order=excluded.sort_order,
        category_id=excluded.category_id, base_price=excluded.base_price, unit=excluded.unit,
        is_deleted=excluded.is_deleted, deleted_at=excluded.deleted_at, printer_target=excluded.printer_target,
        printer_name=excluded.printer_name, menu_type=excluded.menu_type, gst_enabled=excluded.gst_enabled,
        is_special=excluded.is_special, special_channel=excluded.special_channel, special_active=excluded.special_active,
        special_expires_at=excluded.special_expires_at, synced_at=unixepoch()
      `).run(
        row.id, row.name, row.description || null, row.imageUrl || null,
        row.isVeg !== false ? 1 : 0, row.isAvailable !== false ? 1 : 0, row.sortOrder || 0,
        row.categoryId, row.restaurantId, Number(row.basePrice || 0), row.unit || null,
        row.isDeleted ? 1 : 0, row.deletedAt ? new Date(row.deletedAt).getTime() : null,
        row.printerTarget || null, row.printerName || null, row.menuType || "FOOD",
        row.gstEnabled !== false ? 1 : 0, row.isSpecial ? 1 : 0,
        row.specialChannel || "BOTH", row.specialActive !== false ? 1 : 0,
        row.specialExpiresAt ? new Date(row.specialExpiresAt).getTime() : null
      );
      return true;

    // ── Menu Item Variant ───────────────────────────────────────────────────
    case "menu_item_variant":
      db.query(`INSERT INTO menu_item_variant (id, name, price, is_default, menu_item_id, is_available, restaurant_id, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, price=excluded.price, is_default=excluded.is_default, is_available=excluded.is_available, synced_at=unixepoch()
      `).run(row.id, row.name, Number(row.price), row.isDefault ? 1 : 0, row.menuItemId, row.isAvailable !== false ? 1 : 0, row.restaurantId);
      return true;

    // ── Menu Item Addon ─────────────────────────────────────────────────────
    case "menu_item_addon":
      db.query(`INSERT INTO menu_item_addon (id, name, price, is_available, menu_item_id, restaurant_id, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, price=excluded.price, is_available=excluded.is_available, synced_at=unixepoch()
      `).run(row.id, row.name, Number(row.price), row.isAvailable !== false ? 1 : 0, row.menuItemId, row.restaurantId);
      return true;

    // ── Venue Price ─────────────────────────────────────────────────────────
    case "venue_price":
      db.query(`INSERT INTO venue_price (id, venue_id, menu_item_id, price, is_active, restaurant_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(venue_id, menu_item_id) DO UPDATE SET price=excluded.price, is_active=excluded.is_active
      `).run(row.id, row.venueId, row.menuItemId, Number(row.price), row.isActive !== false ? 1 : 0, row.restaurantId);
      return true;

    // ── Venue Menu Item Availability ─────────────────────────────────────────
    case "venue_menu_item_availability":
      db.query(`INSERT INTO venue_menu_item_availability (id, venue_id, menu_item_id, restaurant_id, is_available)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(venue_id, menu_item_id) DO UPDATE SET is_available=excluded.is_available
      `).run(row.id, row.venueId, row.menuItemId, row.restaurantId, row.isAvailable !== false ? 1 : 0);
      return true;

    // ── User ─────────────────────────────────────────────────────────────────
    case "user":
      db.query(`INSERT INTO users (id, name, pin, role, is_active, outlet_id, permissions, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, pin=excluded.pin, role=excluded.role,
        is_active=excluded.is_active, permissions=excluded.permissions, synced_at=unixepoch()
      `).run(
        row.id, row.name, row.pin || null, row.role,
        row.isActive !== false ? 1 : 0, row.outletId,
        JSON.stringify(row.permissions || {})
      );
      return true;

    default:
      console.warn(`[Config] Unknown table for incremental sync: ${table}`);
      return false;
  }
}

// Map cloud table names to local SQLite table names
const TABLE_NAME_MAP: Record<string, string> = {
  outlet: "outlet",
  tax_profile: "tax_profile",
  price_profile: "price_profile",
  price_profile_item: "price_profile_item",
  venue: "venue",
  floor: "floor",
  section: "section",
  table: "\"table\"",
  category: "category",
  menu_item: "menu_item",
  menu_item_variant: "menu_item_variant",
  menu_item_addon: "menu_item_addon",
  venue_price: "venue_price",
  venue_menu_item_availability: "venue_menu_item_availability",
  user: "users",
};

// ── Apply a batch of changes (used by socket real-time push) ─────────────────

export function applyChangesBatch(changes: any[]): number {
  const db = getDb();
  let applied = 0;
  for (const change of changes) {
    if (applyChange(db, change)) applied++;
  }
  return applied;
}
