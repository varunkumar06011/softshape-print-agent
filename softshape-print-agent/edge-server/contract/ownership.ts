// ─────────────────────────────────────────────────────────────────────────────
// contract/ownership.ts — Entity ownership matrix (Runtime v2)
// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — every operational entity has exactly one authoritative
// owner. Cross-owner mutations are rejected, not merged.
//
// The synchronization layer performs delivery, ordering, retry, idempotency and
// checkpointing. It does NOT perform business conflict resolution. Any event
// whose owner does not match its origin is routed to the Dead Letter Queue with
// full audit information instead of being applied.
//
//   RUNTIME — the billing-PC Runtime is the operational authority. Only the
//             Runtime may emit these events. Cloud-originated mutations for
//             these aggregates are rejected.
//   CLOUD   — the Business Cloud / Admin plane is the authority. The Runtime
//             applies validated inbound events but never emits local edits.
//   DERIVED — computed downstream in the cloud (reports/analytics). Neither
//             side syncs these as operational events.
// ─────────────────────────────────────────────────────────────────────────────

export type EntityOwner = "RUNTIME" | "CLOUD" | "DERIVED";

// The event origin. `runtime` events are produced locally and uploaded.
// `cloud` events arrive from the cloud change feed and are applied locally.
export type EventOrigin = "runtime" | "cloud";

// ── Aggregates ───────────────────────────────────────────────────────────────
// An aggregate is the consistency boundary an event belongs to. Aggregate names
// are stable strings and are part of the wire contract.

export const AGGREGATES = {
  ORDER: "order",
  KOT: "kot",
  BILL: "bill",
  PAYMENT: "payment",
  TABLE: "table",
  TABLE_SESSION: "table_session",
  CUSTOMER: "customer",
  INVENTORY: "inventory",
  SHIFT: "shift",
  SETTLEMENT: "settlement",
  PRINT: "print",
  MENU_ITEM: "menu_item",
  MENU_CATEGORY: "menu_category",
  MENU_VARIANT: "menu_variant",
  MENU_ADDON: "menu_addon",
  COMBO: "combo",
  PRICE_PROFILE: "price_profile",
  TAX_PROFILE: "tax_profile",
  VENUE: "venue",
  FLOOR: "floor",
  SECTION: "section",
  OUTLET: "outlet",
  USER: "user",
  EMPLOYEE: "employee",
  LEDGER_CATEGORY: "ledger_category",
  PRINTER_CONFIG: "printer_config",
  LICENSE: "license",
  REPORT: "report",
} as const;

export type Aggregate = (typeof AGGREGATES)[keyof typeof AGGREGATES];

// ── Ownership matrix ─────────────────────────────────────────────────────────
// Exhaustive: every aggregate above must appear here. A missing entry is a bug
// and is treated as "unknown owner" (rejected) rather than defaulting to allow.

export const AGGREGATE_OWNER: Record<Aggregate, EntityOwner> = {
  // Runtime-owned operational state
  [AGGREGATES.ORDER]: "RUNTIME",
  [AGGREGATES.KOT]: "RUNTIME",
  [AGGREGATES.BILL]: "RUNTIME",
  [AGGREGATES.PAYMENT]: "RUNTIME",
  [AGGREGATES.TABLE]: "RUNTIME",
  [AGGREGATES.TABLE_SESSION]: "RUNTIME",
  [AGGREGATES.CUSTOMER]: "RUNTIME",
  [AGGREGATES.INVENTORY]: "RUNTIME",
  [AGGREGATES.SHIFT]: "RUNTIME",
  [AGGREGATES.SETTLEMENT]: "RUNTIME",
  [AGGREGATES.PRINT]: "RUNTIME",

  // Cloud/admin-owned configuration
  [AGGREGATES.MENU_ITEM]: "CLOUD",
  [AGGREGATES.MENU_CATEGORY]: "CLOUD",
  [AGGREGATES.MENU_VARIANT]: "CLOUD",
  [AGGREGATES.MENU_ADDON]: "CLOUD",
  [AGGREGATES.COMBO]: "CLOUD",
  [AGGREGATES.PRICE_PROFILE]: "CLOUD",
  [AGGREGATES.TAX_PROFILE]: "CLOUD",
  [AGGREGATES.VENUE]: "CLOUD",
  [AGGREGATES.FLOOR]: "CLOUD",
  [AGGREGATES.SECTION]: "CLOUD",
  [AGGREGATES.OUTLET]: "CLOUD",
  [AGGREGATES.USER]: "CLOUD",
  [AGGREGATES.EMPLOYEE]: "CLOUD",
  [AGGREGATES.LEDGER_CATEGORY]: "CLOUD",
  [AGGREGATES.PRINTER_CONFIG]: "CLOUD",
  [AGGREGATES.LICENSE]: "CLOUD",

  // Cloud-derived (never synced as operational events)
  [AGGREGATES.REPORT]: "DERIVED",
};

// ── Structural exception: table identity vs. table operational state ─────────
// A table row carries BOTH cloud-owned identity/layout fields (number, capacity,
// section placement) and Runtime-owned operational fields (status, workflow,
// captain, guests, current bill, session). Inbound cloud events for the `table`
// aggregate are therefore allowed to update ONLY the fields listed here, and the
// download applier must never write any other table column.
//
// This mirrors the pre-existing behavior in config.ts, which deliberately
// refuses to let cloud config overwrite live table business state.

export const CLOUD_WRITABLE_TABLE_FIELDS = [
  "number",
  "capacity",
  "section_id",
  "section_tag",
] as const;

export type CloudWritableTableField = (typeof CLOUD_WRITABLE_TABLE_FIELDS)[number];

// ── Lookups ──────────────────────────────────────────────────────────────────

export function isKnownAggregate(aggregate: string): aggregate is Aggregate {
  return Object.prototype.hasOwnProperty.call(AGGREGATE_OWNER, aggregate);
}

// Returns the owner of an aggregate, or null when the aggregate is unknown.
// Callers must treat null as "reject", never as "allow".
export function getAggregateOwner(aggregate: string): EntityOwner | null {
  if (!isKnownAggregate(aggregate)) return null;
  return AGGREGATE_OWNER[aggregate];
}

export function isRuntimeOwned(aggregate: string): boolean {
  return getAggregateOwner(aggregate) === "RUNTIME";
}

export function isCloudOwned(aggregate: string): boolean {
  return getAggregateOwner(aggregate) === "CLOUD";
}

// ── Ownership enforcement ────────────────────────────────────────────────────
// The single decision point used by both the command bus (outbound) and the
// download applier (inbound).

export interface OwnershipDecision {
  allowed: boolean;
  owner: EntityOwner | null;
  reason?: string;
}

export function checkOwnership(aggregate: string, origin: EventOrigin): OwnershipDecision {
  const owner = getAggregateOwner(aggregate);

  if (owner === null) {
    return {
      allowed: false,
      owner: null,
      reason: `Unknown aggregate '${aggregate}' — no owner declared in the ownership matrix`,
    };
  }

  if (owner === "DERIVED") {
    return {
      allowed: false,
      owner,
      reason: `Aggregate '${aggregate}' is cloud-derived and cannot be mutated by events`,
    };
  }

  const expectedOrigin: EventOrigin = owner === "RUNTIME" ? "runtime" : "cloud";
  if (origin !== expectedOrigin) {
    return {
      allowed: false,
      owner,
      reason: `Aggregate '${aggregate}' is owned by ${owner}; refusing '${origin}'-originated mutation`,
    };
  }

  return { allowed: true, owner };
}
