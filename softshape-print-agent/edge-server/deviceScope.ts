// ─────────────────────────────────────────────────────────────────────────────
// deviceScope.ts — per-PC settings for restaurants with more than one billing PC
// ─────────────────────────────────────────────────────────────────────────────
// A restaurant that runs several billing PCs (e.g. dine-in + an outside curry
// point) shares ONE cloud config. These settings are stored ONLY in this PC's
// local edge_config table — they are never downloaded from or uploaded to the
// cloud, so one PC can never overwrite another PC's values.
//
//   bound_venue_id  — when set, this PC only shows/bills that venue's sections
//                     and tables. Unset = legacy behaviour (all venues).
//   bill_prefix     — text put in front of the daily bill counter ("D-", "C-")
//                     so two PCs never issue the same bill number.
//   captain_hub     — false = captains must NOT connect to this PC. Reported in
//                     /health so captain LAN discovery skips it.
//
// With nothing configured every function returns the legacy default, so
// single-PC restaurants behave exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, getConfig, setConfig } from "./db.ts";

const KEY_VENUE = "device_bound_venue_id";
const KEY_PREFIX = "device_bill_prefix";
const KEY_CAPTAIN_HUB = "device_captain_hub";

// Prefix is printed on bills and stored as part of the bill number, so keep it
// short and free of anything that could break receipts or CSV exports.
const PREFIX_RE = /^[A-Za-z0-9-]{0,6}$/;

export interface DeviceScope {
  boundVenueId: string | null;
  billPrefix: string;
  captainHub: boolean;
}

let _warnedDanglingVenue: string | null = null;

export function getBoundVenueId(): string | null {
  const v = getConfig(KEY_VENUE);
  const id = v && v.trim() ? v.trim() : null;
  if (!id) return null;
  // If the venue was deleted/deactivated in the cloud, binding to it would leave
  // this PC with an empty table list in the middle of service. Fall back to the
  // legacy all-venues view instead and say so in the log.
  const exists = getDb().query("SELECT 1 FROM venue WHERE id = ? AND is_deleted = 0").get(id);
  if (!exists) {
    if (_warnedDanglingVenue !== id) {
      _warnedDanglingVenue = id;
      console.warn(`[deviceScope] Bound venue ${id} no longer exists — showing all venues until it is re-bound`);
    }
    return null;
  }
  return id;
}

export function getBillPrefix(): string {
  return getConfig(KEY_PREFIX) || "";
}

export function isCaptainHub(): boolean {
  return getConfig(KEY_CAPTAIN_HUB) !== "false";
}

export function getDeviceScope(): DeviceScope {
  return {
    boundVenueId: getBoundVenueId(),
    billPrefix: getBillPrefix(),
    captainHub: isCaptainHub(),
  };
}

// All venues of the restaurant, ignoring the binding — used by the setup screen
// so a bound PC can still be re-bound or released.
export function listAllVenues(restaurantId: string): Array<{ id: string; name: string; venueType: string | null }> {
  return getDb()
    .query("SELECT id, name, venue_type as venueType FROM venue WHERE restaurant_id = ? AND is_deleted = 0 ORDER BY sort_order ASC, name ASC")
    .all(restaurantId) as any[];
}

export interface DeviceScopeUpdate {
  boundVenueId?: string | null;
  billPrefix?: string | null;
  captainHub?: boolean;
}

// Validates and stores the given fields. Fields that are undefined are left
// untouched. Returns an error message instead of throwing so the HTTP layer can
// answer 400.
export function updateDeviceScope(restaurantId: string, update: DeviceScopeUpdate): { ok: true; scope: DeviceScope } | { ok: false; error: string } {
  if (update.boundVenueId !== undefined && update.boundVenueId !== null && update.boundVenueId !== "") {
    const row = getDb()
      .query("SELECT id FROM venue WHERE id = ? AND restaurant_id = ? AND is_deleted = 0")
      .get(update.boundVenueId, restaurantId);
    if (!row) return { ok: false, error: "Venue not found for this restaurant" };
  }
  if (update.billPrefix !== undefined && update.billPrefix !== null && !PREFIX_RE.test(update.billPrefix)) {
    return { ok: false, error: "Bill prefix may contain only letters, digits and '-', max 6 characters" };
  }

  if (update.boundVenueId !== undefined) setConfig(KEY_VENUE, update.boundVenueId || "");
  if (update.billPrefix !== undefined) setConfig(KEY_PREFIX, update.billPrefix || "");
  if (update.captainHub !== undefined) setConfig(KEY_CAPTAIN_HUB, update.captainHub ? "true" : "false");
  return { ok: true, scope: getDeviceScope() };
}

// Resolves the venue a walk-in/takeaway bill belongs to. The cashier sends a
// sectionTag like "venue-<venueId>"; if it does not resolve to a real venue
// (e.g. the legacy "venue-restaurant-parcel" placeholder) fall back to the
// venue this PC is bound to. Returns null when neither applies (legacy path).
export function resolveWalkinVenue(restaurantId: string, sectionTag?: string | null): any | null {
  const db = getDb();
  if (sectionTag && sectionTag.startsWith("venue-")) {
    const venue = db
      .query("SELECT * FROM venue WHERE id = ? AND restaurant_id = ? AND is_deleted = 0")
      .get(sectionTag.slice("venue-".length), restaurantId);
    if (venue) return venue;
  }
  const bound = getBoundVenueId();
  if (bound) {
    return db.query("SELECT * FROM venue WHERE id = ? AND restaurant_id = ? AND is_deleted = 0").get(bound, restaurantId) || null;
  }
  return null;
}
