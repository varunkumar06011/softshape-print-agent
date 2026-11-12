// ─────────────────────────────────────────────────────────────────────────────
// pricing.ts — THE ONLY place that decides what an item costs in a venue.
// ─────────────────────────────────────────────────────────────────────────────
// The menu screen (captain/cashier), the KOT, the saved order, the table and
// the bill all read prices through these two functions. Before this file
// existed the menu and the order each had their own rule (menu: venue price
// first; order: price list only), so the KOT and the table could show
// different prices for the same item. Do not add another price lookup —
// call these.
//
// Rule, in order:
//   1. The venue's own price (venue_price) — set on this PC's Edit Menu or
//      synced down from the admin panel. Newest edit wins on both sides.
//   2. The venue's price list (price_profile_item) — the cloud's list.
//   3. The item's base price, if above 0.
//   4. The item's default portion (variant) price.
// A venue price of 0 means "not sold in this venue": the menu hides the item,
// and billing falls through to the base price only as a safety net.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from "./db.ts";

/** menuItemId → venue price (venue price over price list) for one venue. */
export function buildVenuePriceMap(venueId: string | null | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!venueId) return map;
  const db = getDb();

  const venue = db.query("SELECT price_profile_id FROM venue WHERE id = ?").get(venueId) as any;
  if (venue?.price_profile_id) {
    const rows = db.query(
      "SELECT menu_item_id, price FROM price_profile_item WHERE price_profile_id = ?",
    ).all(venue.price_profile_id) as any[];
    for (const r of rows) map.set(r.menu_item_id, Number(r.price));
  }

  const own = db.query(
    "SELECT menu_item_id, price FROM venue_price WHERE venue_id = ? AND is_active = 1",
  ).all(venueId) as any[];
  for (const r of own) map.set(r.menu_item_id, Number(r.price));

  return map;
}

/** venueId → (menuItemId → price) for every venue of the outlet. */
export function buildAllVenuePriceMaps(restaurantId: string): Record<string, Record<string, number>> {
  const db = getDb();
  const byItem: Record<string, Record<string, number>> = {};
  const put = (venueId: string, itemId: string, price: number) => {
    (byItem[itemId] ??= {})[venueId] = price;
  };

  const listRows = db.query(`
    SELECT v.id AS venue_id, ppi.menu_item_id, ppi.price
    FROM venue v
    JOIN price_profile_item ppi ON v.price_profile_id = ppi.price_profile_id
    WHERE COALESCE(v.is_deleted, 0) = 0 AND v.restaurant_id = ?
  `).all(restaurantId) as any[];
  for (const r of listRows) put(r.venue_id, r.menu_item_id, Number(r.price));

  const ownRows = db.query(
    "SELECT venue_id, menu_item_id, price FROM venue_price WHERE restaurant_id = ? AND is_active = 1",
  ).all(restaurantId) as any[];
  for (const r of ownRows) put(r.venue_id, r.menu_item_id, Number(r.price));

  return byItem;
}

/**
 * The price to show AND to bill for one item. `venuePrice` is the value from
 * buildVenuePriceMap (undefined when the venue sets none).
 */
export function effectiveItemPrice(
  venuePrice: number | undefined,
  basePrice: number | null | undefined,
  defaultVariantPrice: number | null | undefined,
): number {
  if (venuePrice != null && venuePrice > 0) return venuePrice;
  const base = Number(basePrice ?? 0);
  if (base > 0) return base;
  const variant = Number(defaultVariantPrice ?? 0);
  return variant > 0 ? variant : 0;
}

/** Default portion price of an item, or null. */
export function defaultVariantPrice(menuItemId: string): number | null {
  const row = getDb().query(
    "SELECT price FROM menu_item_variant WHERE menu_item_id = ? AND is_default = 1 LIMIT 1",
  ).get(menuItemId) as any;
  return row ? Number(row.price) : null;
}
