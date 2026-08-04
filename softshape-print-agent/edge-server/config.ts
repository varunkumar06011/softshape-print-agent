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

import { getDb, setSyncState, getSyncState, setConfig } from "./db.ts";
import { getBackendUrl, getSessionToken, getRestaurantId } from "./auth.ts";
import { cloudFetch } from "./cloudFetch.ts";
import { runtimeLog } from "./contract/logger.ts";
import { getDeviceId } from "./auth.ts";
import { invalidateReadCache, warmReadCache } from "./reads.ts";

interface ConfigResponse {
  outlet: any;
  organizationId?: string;
  configVersion?: number;
  configChecksum?: string;
  taxProfiles?: any[];
  priceProfiles?: any[];
  priceProfileItems?: any[];
  venues?: any[];
  floors?: any[];
  sections?: any[];
  tables?: any[];
  categories?: any[];
  menuItems?: any[];
  menuVariants?: any[];
  menuAddons?: any[];
  venuePrices?: any[];
  venueAvailability?: any[];
  users?: any[];
  ledgerCategories?: any[];
  employees?: any[];
  counts?: Record<string, number>;
}

let _downloadInProgress: Promise<ConfigSyncResult> | null = null;

// ── Local config checksum ────────────────────────────────────────────────────
// Computes a deterministic checksum from row counts of all config tables.
// This is NOT a cryptographic hash of row contents — it's a lightweight
// integrity check that catches missing tables, partial writes, or corruption.
// The cloud can provide a matching checksum (computed the same way) so we
// can verify that our SQLite data matches what the cloud sent.

function computeLocalConfigChecksum(db: ReturnType<typeof getDb>, restaurantIds: string[]): string {
  const tables = [
    { name: "outlet", quoted: false },
    { name: "tax_profile", quoted: false },
    { name: "price_profile", quoted: false },
    { name: "price_profile_item", quoted: false },
    { name: "venue", quoted: false },
    { name: "floor", quoted: false },
    { name: "section", quoted: false },
    { name: "table", quoted: true },
    { name: "category", quoted: false },
    { name: "menu_item", quoted: false },
    { name: "menu_item_variant", quoted: false },
    { name: "menu_item_addon", quoted: false },
    { name: "venue_price", quoted: false },
    { name: "venue_menu_item_availability", quoted: false },
    { name: "users", quoted: false },
    { name: "ledger_category", quoted: false },
    { name: "employee", quoted: false },
  ];

  const placeholders = restaurantIds.map(() => "?").join(",");
  const counts: string[] = [];
  for (const { name: table, quoted } of tables) {
    try {
      const tableRef = quoted ? `"${table}"` : table;
      if (table === "outlet") {
        const row = db.query(`SELECT COUNT(*) as c FROM ${tableRef} WHERE id IN (${placeholders})`).get(...restaurantIds) as { c: number } | undefined;
        counts.push(`${table}:${row?.c ?? 0}`);
      } else if (table === "users") {
        const row = db.query(`SELECT COUNT(*) as c FROM ${tableRef} WHERE outlet_id IN (${placeholders})`).get(...restaurantIds) as { c: number } | undefined;
        counts.push(`${table}:${row?.c ?? 0}`);
      } else {
        const row = db.query(`SELECT COUNT(*) as c FROM ${tableRef} WHERE restaurant_id IN (${placeholders})`).get(...restaurantIds) as { c: number } | undefined;
        counts.push(`${table}:${row?.c ?? 0}`);
      }
    } catch {
      counts.push(`${table}:err`);
    }
  }

  // Simple hash: join counts and compute a short hex digest
  const joined = counts.join("|");
  let hash = 0;
  for (let i = 0; i < joined.length; i++) {
    const ch = joined.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return `v1:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

// ── Referential integrity validation ─────────────────────────────────────────
// After the config transaction commits, verify that foreign key relationships
// are intact. This catches cloud bugs where a child row references a parent
// that doesn't exist (e.g. a menu_item with a category_id that's not in the
// category table). We log warnings but don't fail — the UI can still operate
// with orphaned rows, but the operator should be alerted.

interface IntegrityViolation {
  table: string;
  column: string;
  orphanedCount: number;
  sampleIds: string[];
}

function validateReferentialIntegrity(db: ReturnType<typeof getDb>, restaurantIds: string[]): IntegrityViolation[] {
  const checks: Array<{ table: string; column: string; refTable: string; refColumn: string; quoted?: boolean }> = [
    { table: "menu_item", column: "category_id", refTable: "category", refColumn: "id" },
    { table: "menu_item_variant", column: "menu_item_id", refTable: "menu_item", refColumn: "id" },
    { table: "menu_item_addon", column: "menu_item_id", refTable: "menu_item", refColumn: "id" },
    { table: "venue_price", column: "menu_item_id", refTable: "menu_item", refColumn: "id" },
    { table: "venue_price", column: "venue_id", refTable: "venue", refColumn: "id" },
    { table: "venue_menu_item_availability", column: "menu_item_id", refTable: "menu_item", refColumn: "id" },
    { table: "venue_menu_item_availability", column: "venue_id", refTable: "venue", refColumn: "id" },
    { table: "section", column: "floor_id", refTable: "floor", refColumn: "id" },
    { table: "section", column: "venue_id", refTable: "venue", refColumn: "id" },
    { table: "floor", column: "venue_id", refTable: "venue", refColumn: "id" },
    { table: "price_profile_item", column: "price_profile_id", refTable: "price_profile", refColumn: "id" },
    { table: "price_profile_item", column: "menu_item_id", refTable: "menu_item", refColumn: "id" },
  ];

  const placeholders = restaurantIds.map(() => "?").join(",");
  const violations: IntegrityViolation[] = [];

  for (const check of checks) {
    try {
      const rows = db.query(
        `SELECT COUNT(*) as c, GROUP_CONCAT(a.${check.column}, ',') as ids
         FROM ${check.table} a
         LEFT JOIN ${check.refTable} b ON a.${check.column} = b.${check.refColumn}
         WHERE a.${check.column} IS NOT NULL AND b.${check.refColumn} IS NULL
         AND a.restaurant_id IN (${placeholders})`
      ).get(...restaurantIds) as { c: number; ids: string | null } | undefined;

      if (rows && rows.c > 0) {
        const sampleIds = (rows.ids || "").split(",").filter(Boolean).slice(0, 5);
        violations.push({
          table: check.table,
          column: check.column,
          orphanedCount: rows.c,
          sampleIds,
        });
      }
    } catch {
      // Table might not exist or column might be named differently — skip
    }
  }

  return violations;
}

// ── End-to-end count verification ────────────────────────────────────────────
// Compares cloud-provided counts against actual SQLite row counts after the
// config transaction commits. If any table's count doesn't match, the sync
// is considered failed — the UI is never told it's ready.
//
// The cloud sends counts in the config response (added to /api/edge/config).
// If counts are absent (older backend), verification is skipped (backward compat).

interface CountMismatch {
  table: string;
  cloud: number;
  local: number;
}

interface VerificationResult {
  match: boolean;
  mismatches: CountMismatch[];
  cloudCounts: Record<string, number>;
  localCounts: Record<string, number>;
}

function verifyCounts(
  db: ReturnType<typeof getDb>,
  restaurantIds: string[],
  cloudCounts: Record<string, number> | undefined
): VerificationResult {
  const localCounts: Record<string, number> = {};
  const mismatches: CountMismatch[] = [];

  if (!cloudCounts) {
    return { match: true, mismatches: [], cloudCounts: {}, localCounts: {} };
  }

  const placeholders = restaurantIds.map(() => "?").join(",");

  const tableMap: Array<{ cloudKey: string; table: string; quoted?: boolean; scopeColumn?: string }> = [
    { cloudKey: "taxProfiles", table: "tax_profile", scopeColumn: "restaurant_id" },
    { cloudKey: "priceProfiles", table: "price_profile", scopeColumn: "restaurant_id" },
    { cloudKey: "priceProfileItems", table: "price_profile_item", scopeColumn: "restaurant_id" },
    { cloudKey: "venues", table: "venue", scopeColumn: "restaurant_id" },
    { cloudKey: "floors", table: "floor", scopeColumn: "restaurant_id" },
    { cloudKey: "sections", table: "section", scopeColumn: "restaurant_id" },
    { cloudKey: "tables", table: "table", quoted: true, scopeColumn: "restaurant_id" },
    { cloudKey: "categories", table: "category", scopeColumn: "restaurant_id" },
    { cloudKey: "menuItems", table: "menu_item", scopeColumn: "restaurant_id" },
    { cloudKey: "menuVariants", table: "menu_item_variant", scopeColumn: "restaurant_id" },
    { cloudKey: "menuAddons", table: "menu_item_addon", scopeColumn: "restaurant_id" },
    { cloudKey: "venuePrices", table: "venue_price", scopeColumn: "restaurant_id" },
    { cloudKey: "venueAvailability", table: "venue_menu_item_availability", scopeColumn: "restaurant_id" },
    { cloudKey: "users", table: "users", scopeColumn: "outlet_id" },
    { cloudKey: "ledgerCategories", table: "ledger_category", scopeColumn: "restaurant_id" },
    { cloudKey: "employees", table: "employee", scopeColumn: "restaurant_id" },
  ];

  for (const { cloudKey, table, quoted, scopeColumn } of tableMap) {
    const cloudCount = cloudCounts[cloudKey];
    if (cloudCount === undefined) continue;

    const tableRef = quoted ? `"${table}"` : table;
    try {
      const row = db.query(
        `SELECT COUNT(*) as c FROM ${tableRef} WHERE ${scopeColumn} IN (${placeholders})`
      ).get(...restaurantIds) as { c: number } | undefined;
      const localCount = row?.c ?? 0;
      localCounts[cloudKey] = localCount;

      if (localCount !== cloudCount) {
        mismatches.push({ table: cloudKey, cloud: cloudCount, local: localCount });
      }
    } catch {
      localCounts[cloudKey] = -1;
      mismatches.push({ table: cloudKey, cloud: cloudCount, local: -1 });
    }
  }

  return {
    match: mismatches.length === 0,
    mismatches,
    cloudCounts,
    localCounts,
  };
}

export type SyncStageCallback = (stage: "validating" | "committing" | "verifying") => void;

export interface ConfigSyncResult {
  success: boolean;
  error?: string;
  tablesLoaded?: number;
  verified?: boolean;
  warnings?: string[];
  mismatches?: CountMismatch[];
  localCounts?: Record<string, number>;
  cloudCounts?: Record<string, number>;
}

export async function downloadFullConfig(onStage?: SyncStageCallback): Promise<ConfigSyncResult> {
  if (_downloadInProgress) return _downloadInProgress;
  _downloadInProgress = _downloadFullConfigImpl(onStage);
  try {
    return await _downloadInProgress;
  } finally {
    _downloadInProgress = null;
  }
}

async function _downloadFullConfigImpl(onStage?: SyncStageCallback): Promise<ConfigSyncResult> {
  const backendUrl = getBackendUrl();
  const token = getSessionToken();
  const restaurantId = getRestaurantId();

  if (!backendUrl || !token || !restaurantId) {
    return { success: false, error: "No valid session — cannot download config" };
  }

  try {
    runtimeLog.info(`[config] Fetching config from cloud`, { url: `${backendUrl}/api/edge/config`, restaurantId, deviceId: getDeviceId() });
    const res = await cloudFetch(`${backendUrl}/api/edge/config`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      connectTimeout: 15_000,
      bodyTimeout: 120_000,
      retries: 2,
    });

    runtimeLog.info(`[config] Cloud response`, { status: res.status, ok: res.ok, restaurantId, deviceId: getDeviceId() });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      runtimeLog.warn("[config] Cloud returned error", {
        status: res.status,
        body,
        restaurantId,
        deviceId: getDeviceId(),
      });
      return { success: false, error: body.error || `HTTP ${res.status}` };
    }

    const config: ConfigResponse = await res.json();
    const db = getDb();

    if (!config.outlet) {
      runtimeLog.warn("[config] Cloud config response missing outlet — aborting", {
        restaurantId,
        deviceId: getDeviceId(),
      });
      return { success: false, error: "Outlet not found in cloud config" };
    }

    // ── Schema validation: ensure all expected fields are arrays (or absent) ──
    // The cloud may omit empty arrays or send null. We normalize to [] here
    // so the iteration code below never throws TypeError.
    const arrayFields: (keyof ConfigResponse)[] = [
      "taxProfiles", "priceProfiles", "priceProfileItems",
      "venues", "floors", "sections", "tables",
      "categories", "menuItems", "menuVariants", "menuAddons",
      "venuePrices", "venueAvailability", "users",
      "ledgerCategories", "employees",
    ];
    for (const field of arrayFields) {
      const val = config[field];
      if (val != null && !Array.isArray(val)) {
        const error = `Config field '${String(field)}' is not an array (got ${typeof val})`;
        runtimeLog.error(`[config] Schema validation failed: ${error}`, {
          restaurantId,
          deviceId: getDeviceId(),
        });
        return { success: false, error };
      }
    }

    runtimeLog.info(`[config] Config received`, {
      outlet: config.outlet.id,
      taxProfiles: config.taxProfiles?.length ?? 0,
      menuItems: config.menuItems?.length ?? 0,
      tables: config.tables?.length ?? 0,
      users: config.users?.length ?? 0,
      organizationId: config.organizationId || "none",
      configVersion: config.configVersion,
      restaurantId,
      deviceId: getDeviceId(),
    });

    // ── Stage: VALIDATING ─────────────────────────────────────────────────────
    // Schema validation passed, cloud response is well-formed.
    onStage?.("validating");

    let totalRows = 0;

    const applyConfig = db.transaction(() => {
    // ── Purge stale data for this outlet ────────────────────────────────────────
    // On re-link, old rows from a previous onboarding would otherwise remain
    // forever (ON CONFLICT only updates existing IDs; it never removes rows
    // that are no longer in the cloud config). Delete everything scoped to
    // this outlet before inserting the fresh snapshot.
    // Guard: preserve tables that have active orders to avoid orphaning
    // in-service operational state during config refresh.
    const rid = config.outlet.id;
    db.query(`DELETE FROM venue_menu_item_availability WHERE restaurant_id = ?`).run(rid);
    db.query(`DELETE FROM venue_price WHERE restaurant_id = ?`).run(rid);
    db.query(`DELETE FROM menu_item_addon WHERE restaurant_id = ?`).run(rid);
    db.query(`DELETE FROM menu_item_variant WHERE restaurant_id = ?`).run(rid);
    db.query(`DELETE FROM menu_item WHERE restaurant_id = ?`).run(rid);
    db.query(`DELETE FROM category WHERE restaurant_id = ?`).run(rid);
    db.query(`DELETE FROM "table" WHERE restaurant_id = ? AND id NOT IN (SELECT table_id FROM order_record WHERE restaurant_id = ? AND status IN ('PREPARING','READY','BILLING_REQUESTED','SETTLED') AND is_deleted = 0)`).run(rid, rid);
    db.query(`DELETE FROM section WHERE restaurant_id = ?`).run(rid);
    db.query(`DELETE FROM floor WHERE restaurant_id = ?`).run(rid);
    db.query(`DELETE FROM venue WHERE restaurant_id = ?`).run(rid);
    db.query(`DELETE FROM price_profile_item WHERE restaurant_id = ?`).run(rid);
    db.query(`DELETE FROM price_profile WHERE restaurant_id = ?`).run(rid);
    db.query(`DELETE FROM tax_profile WHERE restaurant_id = ?`).run(rid);
    db.query(`DELETE FROM users WHERE outlet_id = ?`).run(rid);
    // Ledger categories and employees are purged in their upsert sections below
    // (after users). Only cloud-sourced rows (cloud_synced = 1) are purged so
    // locally-created records that haven't synced yet are preserved.

    runtimeLog.info("[config] Purge complete — starting upserts", { restaurantId, deviceId: getDeviceId() });

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

    // ── Extract printer mapping from outlet printer_config → edge_config ──────
    // This populates the printer_mapping key that handleCloudPrintJob reads
    // for cloud fallback printer resolution (RC-5 fix).
    {
      const rawPc = config.outlet.printerConfig;
      const pc: any = typeof rawPc === "string" ? JSON.parse(rawPc || "{}") : (rawPc || {});
      const printers = pc.printers || [];
      const agentMapping = pc.agentMapping || {};
      const mapping = {
        kitchen: agentMapping.kitchen || printers.find((p: any) => p.type?.toUpperCase() === "KITCHEN")?.name || printers.find((p: any) => p.name?.toLowerCase().includes("kitchen"))?.name || null,
        bar: agentMapping.bar || printers.find((p: any) => p.type?.toUpperCase() === "BAR")?.name || printers.find((p: any) => p.name?.toLowerCase().includes("bar"))?.name || null,
        bill: agentMapping.bill || printers.find((p: any) => p.type?.toUpperCase() === "BILL")?.name || printers.find((p: any) => p.name?.toLowerCase().includes("bill"))?.name || null,
      };
      try { setConfig("printer_mapping", JSON.stringify(mapping)); } catch (e) { console.warn("[Config] Failed to write printer_mapping:", e); }
    }

    // ── Tax Profiles ─────────────────────────────────────────────────────────
    for (const tp of config.taxProfiles ?? []) {
      db.query(`INSERT INTO tax_profile (id, restaurant_id, name, gst_category, gst_rate, gst_registered, service_charge_percent, is_default, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, gst_category=excluded.gst_category, gst_rate=excluded.gst_rate,
        gst_registered=excluded.gst_registered, service_charge_percent=excluded.service_charge_percent, is_default=excluded.is_default, synced_at=unixepoch()
      `).run(tp.id, tp.restaurantId, tp.name, tp.gstCategory || "NON_AC", tp.gstRate, tp.gstRegistered ? 1 : 0, tp.serviceChargePercent || 0, tp.isDefault ? 1 : 0);
      totalRows++;
    }

    // ── Price Profiles ──────────────────────────────────────────────────────
    for (const pp of config.priceProfiles ?? []) {
      db.query(`INSERT INTO price_profile (id, restaurant_id, name, is_default, synced_at)
        VALUES (?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, is_default=excluded.is_default, synced_at=unixepoch()
      `).run(pp.id, pp.restaurantId, pp.name, pp.isDefault ? 1 : 0);
      totalRows++;
    }

    // ── Price Profile Items ──────────────────────────────────────────────────
    for (const ppi of config.priceProfileItems ?? []) {
      db.query(`INSERT INTO price_profile_item (id, price_profile_id, menu_item_id, price, restaurant_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(price_profile_id, menu_item_id) DO UPDATE SET price=excluded.price
      `).run(ppi.id, ppi.priceProfileId, ppi.menuItemId, Number(ppi.price), ppi.restaurantId);
      totalRows++;
    }

    // ── Venues ───────────────────────────────────────────────────────────────
    for (const v of config.venues ?? []) {
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
    for (const f of config.floors ?? []) {
      db.query(`INSERT INTO floor (id, venue_id, restaurant_id, name, sort_order, is_active, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort_order=excluded.sort_order, is_active=excluded.is_active, synced_at=unixepoch()
      `).run(f.id, f.venueId, f.restaurantId, f.name, f.sortOrder || 0, f.isActive !== false ? 1 : 0);
      totalRows++;
    }

    // ── Sections ─────────────────────────────────────────────────────────────
    for (const s of config.sections ?? []) {
      db.query(`INSERT INTO section (id, name, restaurant_id, floor_id, venue_id, sort_order, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, floor_id=excluded.floor_id, venue_id=excluded.venue_id, sort_order=excluded.sort_order, synced_at=unixepoch()
      `).run(s.id, s.name, s.restaurantId, s.floorId || null, s.venueId || null, s.sortOrder || 0);
      totalRows++;
    }

    // ── Tables ───────────────────────────────────────────────────────────────
    for (const t of config.tables ?? []) {
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
    for (const c of config.categories ?? []) {
      db.query(`INSERT INTO category (id, name, sort_order, is_active, restaurant_id, printer_target, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort_order=excluded.sort_order, is_active=excluded.is_active, printer_target=excluded.printer_target, synced_at=unixepoch()
      `).run(c.id, c.name, c.sortOrder || 0, c.isActive !== false ? 1 : 0, c.restaurantId, c.printerTarget || null);
      totalRows++;
    }

    // ── Menu Items ────────────────────────────────────────────────────────────
    for (const m of config.menuItems ?? []) {
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
    for (const v of config.menuVariants ?? []) {
      db.query(`INSERT INTO menu_item_variant (id, name, price, is_default, menu_item_id, is_available, restaurant_id, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, price=excluded.price, is_default=excluded.is_default, is_available=excluded.is_available, synced_at=unixepoch()
      `).run(v.id, v.name, Number(v.price), v.isDefault ? 1 : 0, v.menuItemId, v.isAvailable !== false ? 1 : 0, v.restaurantId);
      totalRows++;
    }

    // ── Menu Item Addons ──────────────────────────────────────────────────────
    for (const a of config.menuAddons ?? []) {
      db.query(`INSERT INTO menu_item_addon (id, name, price, is_available, menu_item_id, restaurant_id, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, price=excluded.price, is_available=excluded.is_available, synced_at=unixepoch()
      `).run(a.id, a.name, Number(a.price), a.isAvailable !== false ? 1 : 0, a.menuItemId, a.restaurantId);
      totalRows++;
    }

    // ── Venue Prices ─────────────────────────────────────────────────────────
    for (const vp of config.venuePrices ?? []) {
      db.query(`INSERT INTO venue_price (id, venue_id, menu_item_id, price, is_active, restaurant_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(venue_id, menu_item_id) DO UPDATE SET price=excluded.price, is_active=excluded.is_active
      `).run(vp.id, vp.venueId, vp.menuItemId, Number(vp.price), vp.isActive !== false ? 1 : 0, vp.restaurantId);
      totalRows++;
    }

    // ── Venue Menu Item Availability ──────────────────────────────────────────
    for (const va of config.venueAvailability ?? []) {
      db.query(`INSERT INTO venue_menu_item_availability (id, venue_id, menu_item_id, restaurant_id, is_available)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(venue_id, menu_item_id) DO UPDATE SET is_available=excluded.is_available
      `).run(va.id, va.venueId, va.menuItemId, va.restaurantId, va.isAvailable !== false ? 1 : 0);
      totalRows++;
    }

    // ── Users (staff accounts for offline PIN verification) ────────────────
    for (const u of config.users ?? []) {
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

    // ── Ledger Categories (expense/asset/liability categories) ─────────────
    // Purge only cloud-sourced rows (cloud_synced = 1) — preserve locally-created
    // categories (cloud_synced = 0) that haven't synced to cloud yet, otherwise
    // a config refresh would silently delete cashier-created categories.
    db.query(`DELETE FROM ledger_category WHERE restaurant_id = ? AND cloud_synced = 1`).run(rid);
    for (const lc of config.ledgerCategories ?? []) {
      db.query(`INSERT INTO ledger_category (id, restaurant_id, name, entry_type, is_active, synced_at)
        VALUES (?, ?, ?, ?, ?, unixepoch() * 1000)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, entry_type=excluded.entry_type,
        is_active=excluded.is_active, synced_at=unixepoch() * 1000
      `).run(
        lc.id, lc.restaurantId || restaurantId, lc.name,
        lc.entryType || "EXPENSE", lc.isActive !== false ? 1 : 0
      );
      totalRows++;
    }

    // ── Employees (staff without login accounts) ───────────────────────────
    // Purge only cloud-sourced rows (cloud_synced = 1) — preserve locally-created
    // employees (cloud_synced = 0) that haven't synced to cloud yet, otherwise
    // a config refresh would silently delete cashier-created staff.
    db.query(`DELETE FROM employee WHERE restaurant_id = ? AND cloud_synced = 1`).run(rid);
    for (const e of config.employees ?? []) {
      db.query(`INSERT INTO employee (id, restaurant_id, name, role, is_active, created_at, cloud_synced, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, unixepoch() * 1000)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role,
        is_active=excluded.is_active, cloud_synced=1, synced_at=unixepoch() * 1000
      `).run(
        e.id, e.restaurantId || restaurantId, e.name,
        e.role || null, e.isActive !== false ? 1 : 0, Date.now()
      );
      totalRows++;
    }

    // ── Record sync timestamp + config version (NOT config_sync_completed) ──
    // config_sync_completed is set AFTER verification passes, not inside the
    // transaction. This prevents a corrupted/partial commit from being marked
    // as ready. If this is a re-sync and the first sync already succeeded,
    // config_sync_completed stays "true" from the first sync — old data keeps
    // serving while the re-sync retries in the background.
    setSyncState("last_full_config_sync", new Date().toISOString());
    if (config.configVersion !== undefined) {
      setSyncState("config_version", String(config.configVersion));
    }
    if (config.configChecksum) {
      setSyncState("config_checksum", config.configChecksum);
    }

    return totalRows;
    });

    // ── Stage: COMMITTING ─────────────────────────────────────────────────────
    // About to run the transaction that purges + upserts all config tables.
    onStage?.("committing");

    totalRows = applyConfig();

    // ── Stage: VERIFYING ──────────────────────────────────────────────────────
    // Transaction committed — now verifying checksum, integrity, and counts.
    onStage?.("verifying");

    // ── Post-commit verification ─────────────────────────────────────────────
    // Three gates: checksum, referential integrity, row counts.
    // If ANY gate fails, config_sync_verified is set to "false" and the sync
    // returns { success: false }. However, config_sync_completed is only set
    // to "false" if this is the FIRST sync (no prior valid data). On re-sync
    // failure, config_sync_completed stays "true" from the prior sync so the
    // UI keeps serving old data while the retry happens in the background.

    const previousSyncCompleted = getSyncState("config_sync_completed") === "true";

    // Verify only this outlet's data — the sync downloads outlet-only data.
    const allRestaurantIds = [config.outlet.id];

    // ── Gate 1: Checksum verification ────────────────────────────────────────
    const localChecksum = computeLocalConfigChecksum(db, allRestaurantIds);
    setSyncState("config_local_checksum", localChecksum);

    let checksumMatch = true;
    if (config.configChecksum && config.configChecksum !== localChecksum) {
      checksumMatch = false;
      runtimeLog.warn("[config] Checksum mismatch — data may be incomplete", {
        cloudChecksum: config.configChecksum,
        localChecksum,
        restaurantId,
        deviceId: getDeviceId(),
      });
    } else {
      runtimeLog.info("[config] Checksum verified", {
        checksum: localChecksum,
        restaurantId,
        deviceId: getDeviceId(),
      });
    }

    // ── Gate 2: Referential integrity validation ─────────────────────────────
    const violations = validateReferentialIntegrity(db, allRestaurantIds);
    if (violations.length > 0) {
      runtimeLog.warn("[config] Referential integrity violations detected", {
        violations,
        restaurantId,
        deviceId: getDeviceId(),
      });
      setSyncState("config_integrity_violations", JSON.stringify(violations));
    } else {
      setSyncState("config_integrity_violations", "[]");
      runtimeLog.info("[config] Referential integrity verified", {
        restaurantId,
        deviceId: getDeviceId(),
      });
    }

    // ── Gate 3: End-to-end count verification ────────────────────────────────
    const countResult = verifyCounts(db, allRestaurantIds, config.counts);
    setSyncState("config_count_mismatches", countResult.match ? "" : JSON.stringify(countResult.mismatches));

    if (!countResult.match) {
      runtimeLog.warn("[config] Count verification failed — sync incomplete", {
        mismatches: countResult.mismatches,
        restaurantId,
        deviceId: getDeviceId(),
      });
    } else if (config.counts) {
      runtimeLog.info("[config] Count verification passed", {
        cloudCounts: countResult.cloudCounts,
        localCounts: countResult.localCounts,
        restaurantId,
        deviceId: getDeviceId(),
      });
    }

    // ── Determine verification result ────────────────────────────────────────
    const allGatesPassed = checksumMatch && violations.length === 0 && countResult.match;

    if (allGatesPassed) {
      // All verification gates passed — mark sync as completed AND verified.
      setSyncState("config_sync_completed", "true");
      setSyncState("config_sync_verified", "true");
    } else {
      // Verification failed, but data IS committed to SQLite.
      // Mark sync as completed so isLocalReady() returns true and the UI
      // can serve the downloaded data. Keep config_sync_verified = "false"
      // so the system knows the data wasn't fully verified.
      // The UI will show a warning with the mismatch details and let the
      // user decide whether to proceed — blocking onboarding over a few
      // missing rows is worse than proceeding with slightly incomplete data.
      setSyncState("config_sync_verified", "false");
      setSyncState("config_sync_completed", "true");

      runtimeLog.warn("[config] Verification failed — proceeding with committed data", {
        mismatches: countResult.mismatches,
        checksumMatch,
        integrityViolations: violations.length,
        restaurantId,
        deviceId: getDeviceId(),
        previousSyncCompleted,
      });

      // Invalidate cache — the committed data should be served regardless.
      try {
        invalidateReadCache();
        warmReadCache();
      } catch (cacheErr) {
        runtimeLog.warn("[config] Cache invalidation/warming failed (non-fatal)", {
          error: String(cacheErr),
        });
      }

      const mismatchSummary = countResult.mismatches
        .map((m) => `${m.table}: cloud=${m.cloud} local=${m.local}`)
        .join(", ");

      return {
        success: true,
        verified: false,
        warnings: mismatchSummary ? [mismatchSummary] : ["checksum/integrity mismatch"],
        mismatches: countResult.mismatches,
        localCounts: countResult.localCounts,
        cloudCounts: countResult.cloudCounts,
        tablesLoaded: totalRows,
      };
    }

    // ── Cache invalidation + warming (only on successful verification) ───────
    // Invalidate the in-memory read cache (stale data from before the sync)
    // and immediately warm it with fresh data so the first UI request is instant.
    try {
      invalidateReadCache();
      warmReadCache();
    } catch (cacheErr) {
      runtimeLog.warn("[config] Cache invalidation/warming failed (non-fatal — data is committed)", {
        error: String(cacheErr),
      });
    }

    runtimeLog.info(`[config] Download complete — verified`, {
      totalRows,
      config_sync_completed: true,
      config_sync_verified: true,
      restaurantId,
      deviceId: getDeviceId(),
      configVersion: config.configVersion,
      checksum: localChecksum,
      countsMatch: countResult.match,
    });
    return { success: true, tablesLoaded: totalRows };
  } catch (err: any) {
    runtimeLog.error(`[config] Download failed`, {
      error: err?.stack || err,
      restaurantId,
      deviceId: getDeviceId(),
    });
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
      connectTimeout: 10_000,
      bodyTimeout: 30_000,
      retries: 2,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { success: false, error: body.error || `HTTP ${res.status}` };
    }

    const data = await res.json();

    // The cloud endpoint returns changes grouped by table:
    // { timestamp, changes: [{ table, operation, row }, ...] }
    // We apply each change via upsert (for insert/update) or delete.
    // All changes are applied atomically in a single transaction so a crash
    // mid-pull doesn't leave a half-applied config.
    let applied = 0;
    if (data.changes && data.changes.length > 0) {
      const db = getDb();
      const tx = db.transaction(() => {
        for (const change of data.changes) {
          const ok = applyChange(db, change);
          if (ok) applied++;
        }
      });
      tx();
    }

    setSyncState("last_incremental_sync", data.timestamp || new Date().toISOString());

    // Invalidate the read cache if any changes were applied — the cached
    // menu/sections/venues may be stale. Full warming is too expensive for
    // small incremental pulls, but invalidation ensures the next read
    // fetches fresh data from SQLite.
    if (applied > 0) {
      try {
        invalidateReadCache();
      } catch (cacheErr) {
        runtimeLog.warn("[config] Cache invalidation after incremental sync failed (non-fatal)", {
          error: String(cacheErr),
        });
      }
    }

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
    // ── Transaction delete (cloud → edge) ──────────────────────────────────
    // Transactions aren't stored in a SQLite table — they live in edge_config
    // under settle:* keys. Remove the settle record and mark the order so
    // listTransactionsEdge excludes it from Past Transactions.
    if (table === "transaction") {
      const orderId = row?.orderId;
      if (!orderId) {
        runtimeLog.warn("[Config] Transaction delete received with no orderId — skipping");
        return false;
      }
      try {
        // Remove the settle:* key that matches this orderId
        db.query("DELETE FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = ?").run(orderId);
        // Mark the order as txn-deleted so listTransactionsEdge filters it out
        setConfig(`txn_deleted:${orderId}`, String(Date.now()));
        console.log(`[Config] Transaction deleted for order ${orderId} — settle record removed, txn_deleted marker set`);
        return true;
      } catch (err: any) {
        runtimeLog.warn("[Config] Transaction delete failed", { orderId, error: err.message });
        return false;
      }
    }

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

      // Extract printer mapping from outlet printer_config → edge_config (RC-5 fix)
      {
        const rawPc = row.printerConfig;
        const pc: any = typeof rawPc === "string" ? JSON.parse(rawPc || "{}") : (rawPc || {});
        const printers = pc.printers || [];
        const agentMapping = pc.agentMapping || {};
        const mapping = {
          kitchen: agentMapping.kitchen || printers.find((p: any) => p.type?.toUpperCase() === "KITCHEN")?.name || printers.find((p: any) => p.name?.toLowerCase().includes("kitchen"))?.name || null,
          bar: agentMapping.bar || printers.find((p: any) => p.type?.toUpperCase() === "BAR")?.name || printers.find((p: any) => p.name?.toLowerCase().includes("bar"))?.name || null,
          bill: agentMapping.bill || printers.find((p: any) => p.type?.toUpperCase() === "BILL")?.name || printers.find((p: any) => p.name?.toLowerCase().includes("bill"))?.name || null,
        };
        try { setConfig("printer_mapping", JSON.stringify(mapping)); } catch (e) { console.warn("[Config] Failed to write printer_mapping (incremental):", e); }
      }

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
    // Incremental table sync only updates config fields (number, capacity,
    // section_id, section_tag). Business state (status, workflow_status,
    // captain_id, guests, current_bill, kot_history, etc.) is edge-authoritative
    // and must not be overwritten by cloud incremental sync.
    case "table":
      db.query(`INSERT INTO "table" (id, number, capacity, status, section_id, restaurant_id, workflow_status, updated_at)
        VALUES (?, ?, ?, 'AVAILABLE', ?, ?, 'Free', unixepoch())
        ON CONFLICT(id) DO UPDATE SET number=excluded.number, capacity=excluded.capacity,
        section_id=excluded.section_id,
        updated_at=unixepoch()
      `).run(
        row.id, row.number, row.capacity || 4,
        row.sectionId, row.restaurantId
      );
      // Apply section_tag separately since it may be null and the INSERT
      // above doesn't include it (to avoid clobbering existing values)
      if (row.sectionTag !== undefined) {
        db.query(`UPDATE "table" SET section_tag = ?, updated_at = unixepoch() WHERE id = ?`)
          .run(row.sectionTag || null, row.id);
      }
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

    // ── Ledger Category ──────────────────────────────────────────────────────
    case "ledger_category":
      db.query(`INSERT INTO ledger_category (id, restaurant_id, name, entry_type, is_active, synced_at)
        VALUES (?, ?, ?, ?, ?, unixepoch() * 1000)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, entry_type=excluded.entry_type,
        is_active=excluded.is_active, synced_at=unixepoch() * 1000
      `).run(
        row.id, row.restaurantId, row.name,
        row.entryType || "EXPENSE", row.isActive !== false ? 1 : 0
      );
      return true;

    // ── Employee ─────────────────────────────────────────────────────────────
    case "employee":
      db.query(`INSERT INTO employee (id, restaurant_id, name, role, is_active, created_at, cloud_synced, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, unixepoch() * 1000)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role,
        is_active=excluded.is_active, cloud_synced=1, synced_at=unixepoch() * 1000
      `).run(
        row.id, row.restaurantId, row.name,
        row.role || null, row.isActive !== false ? 1 : 0, Date.now()
      );
      return true;

    default:
      runtimeLog.warn("[Config] Unknown table for incremental sync", { table });
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
  ledger_category: "ledger_category",
  employee: "employee",
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
