// ─────────────────────────────────────────────────────────────────────────────
// contract/operationalEvents.ts — Operational Event Store contract (Runtime v2)
// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — the envelope and event type names are the wire format
// shared by the Runtime and the Business Cloud.
//
// NOTE: this is NOT the same thing as contract/events.ts. That file defines the
// LAN WebSocket UI notification bus ("something changed, re-render"). This file
// defines durable, immutable business facts that are appended to SQLite and
// uploaded to the cloud.
//
// Rules:
//   - Events are immutable business facts, past tense, never commands.
//   - `payload` is validated per event type. Arbitrary HTTP url/method/body
//     replay is explicitly not an event and is not accepted.
//   - `occurredAt` is informational only. Local ordering is `seq` (SQLite
//     autoincrement); cloud ordering is the cloud-assigned sequence. Client
//     wall-clock time is never the ordering authority.
//   - Delivery/attempt/status metadata lives outside the immutable event.
// ─────────────────────────────────────────────────────────────────────────────

import { AGGREGATES, type Aggregate, type EventOrigin } from "./ownership.ts";
import { RUNTIME_ERROR_CODES, RuntimeError } from "./errors.ts";

// ── Envelope version ─────────────────────────────────────────────────────────

export const EVENT_ENVELOPE_VERSION = 1 as const;

// The default schema version for a newly minted event payload. Individual event
// types may advance their own payload schema version independently.
export const DEFAULT_EVENT_SCHEMA_VERSION = 1 as const;

// ── Operational event types ──────────────────────────────────────────────────
// Past-tense business facts. Names are stable and case-sensitive.

export const OPERATIONAL_EVENT_TYPES = {
  // Orders / KOT
  ORDER_CREATED: "order.created",
  ORDER_ITEMS_ADDED: "order.items_added",
  ORDER_ITEM_CANCELLED: "order.item_cancelled",
  ORDER_STATUS_CHANGED: "order.status_changed",
  ORDER_ITEMS_TRANSFERRED: "order.items_transferred",
  ORDER_VOIDED: "order.voided",
  KOT_SENT: "kot.sent",
  KOT_CANCELLED: "kot.cancelled",

  // Billing / payment / settlement
  BILL_REQUESTED: "bill.requested",
  BILL_GENERATED: "bill.generated",
  BILL_EDITED: "bill.edited",
  PAYMENT_RECORDED: "payment.recorded",
  ORDER_SETTLED: "settlement.order_settled",
  SETTLEMENT_VOIDED: "settlement.voided",
  SHIFT_OPENED: "shift.opened",
  SHIFT_CLOSED: "shift.closed",

  // Tables / sessions / customers
  TABLE_SESSION_OPENED: "table_session.opened",
  TABLE_SESSION_CLOSED: "table_session.closed",
  TABLE_STATUS_CHANGED: "table.status_changed",
  TABLE_SWAPPED: "table.swapped",
  CUSTOMER_CREATED: "customer.created",
  CUSTOMER_ATTACHED: "customer.attached",

  // Inventory
  INVENTORY_DEDUCTED: "inventory.deducted",
  INVENTORY_RESTORED: "inventory.restored",
  INVENTORY_ADJUSTED: "inventory.adjusted",

  // Cloud-owned configuration (inbound only)
  MENU_ITEM_UPSERTED: "menu_item.upserted",
  MENU_ITEM_DELETED: "menu_item.deleted",
  MENU_CATEGORY_UPSERTED: "menu_category.upserted",
  MENU_CATEGORY_DELETED: "menu_category.deleted",
  MENU_VARIANT_UPSERTED: "menu_variant.upserted",
  MENU_VARIANT_DELETED: "menu_variant.deleted",
  MENU_ADDON_UPSERTED: "menu_addon.upserted",
  MENU_ADDON_DELETED: "menu_addon.deleted",
  COMBO_UPSERTED: "combo.upserted",
  COMBO_DELETED: "combo.deleted",
  PRICE_PROFILE_UPSERTED: "price_profile.upserted",
  TAX_PROFILE_UPSERTED: "tax_profile.upserted",
  VENUE_UPSERTED: "venue.upserted",
  FLOOR_UPSERTED: "floor.upserted",
  SECTION_UPSERTED: "section.upserted",
  TABLE_LAYOUT_UPSERTED: "table.layout_upserted",
  OUTLET_UPSERTED: "outlet.upserted",
  USER_UPSERTED: "user.upserted",
  USER_DEACTIVATED: "user.deactivated",
  EMPLOYEE_UPSERTED: "employee.upserted",
  LEDGER_CATEGORY_UPSERTED: "ledger_category.upserted",
  PRINTER_CONFIG_UPDATED: "printer_config.updated",
} as const;

export type OperationalEventType =
  (typeof OPERATIONAL_EVENT_TYPES)[keyof typeof OPERATIONAL_EVENT_TYPES];

// ── Event type registry ──────────────────────────────────────────────────────
// Every event type declares its aggregate and its allowed origin. The aggregate
// mapping is what ownership enforcement is applied to, so a typo cannot silently
// create an unowned event.

export interface EventTypeSpec {
  aggregate: Aggregate;
  origin: EventOrigin;
  schemaVersion: number;
}

function runtimeEvent(aggregate: Aggregate): EventTypeSpec {
  return { aggregate, origin: "runtime", schemaVersion: DEFAULT_EVENT_SCHEMA_VERSION };
}

function cloudEvent(aggregate: Aggregate): EventTypeSpec {
  return { aggregate, origin: "cloud", schemaVersion: DEFAULT_EVENT_SCHEMA_VERSION };
}

export const EVENT_TYPE_REGISTRY: Record<OperationalEventType, EventTypeSpec> = {
  [OPERATIONAL_EVENT_TYPES.ORDER_CREATED]: runtimeEvent(AGGREGATES.ORDER),
  [OPERATIONAL_EVENT_TYPES.ORDER_ITEMS_ADDED]: runtimeEvent(AGGREGATES.ORDER),
  [OPERATIONAL_EVENT_TYPES.ORDER_ITEM_CANCELLED]: runtimeEvent(AGGREGATES.ORDER),
  [OPERATIONAL_EVENT_TYPES.ORDER_STATUS_CHANGED]: runtimeEvent(AGGREGATES.ORDER),
  [OPERATIONAL_EVENT_TYPES.ORDER_ITEMS_TRANSFERRED]: runtimeEvent(AGGREGATES.ORDER),
  [OPERATIONAL_EVENT_TYPES.ORDER_VOIDED]: runtimeEvent(AGGREGATES.ORDER),
  [OPERATIONAL_EVENT_TYPES.KOT_SENT]: runtimeEvent(AGGREGATES.KOT),
  [OPERATIONAL_EVENT_TYPES.KOT_CANCELLED]: runtimeEvent(AGGREGATES.KOT),

  [OPERATIONAL_EVENT_TYPES.BILL_REQUESTED]: runtimeEvent(AGGREGATES.BILL),
  [OPERATIONAL_EVENT_TYPES.BILL_GENERATED]: runtimeEvent(AGGREGATES.BILL),
  [OPERATIONAL_EVENT_TYPES.BILL_EDITED]: runtimeEvent(AGGREGATES.BILL),
  [OPERATIONAL_EVENT_TYPES.PAYMENT_RECORDED]: runtimeEvent(AGGREGATES.PAYMENT),
  [OPERATIONAL_EVENT_TYPES.ORDER_SETTLED]: runtimeEvent(AGGREGATES.SETTLEMENT),
  [OPERATIONAL_EVENT_TYPES.SETTLEMENT_VOIDED]: runtimeEvent(AGGREGATES.SETTLEMENT),
  [OPERATIONAL_EVENT_TYPES.SHIFT_OPENED]: runtimeEvent(AGGREGATES.SHIFT),
  [OPERATIONAL_EVENT_TYPES.SHIFT_CLOSED]: runtimeEvent(AGGREGATES.SHIFT),

  [OPERATIONAL_EVENT_TYPES.TABLE_SESSION_OPENED]: runtimeEvent(AGGREGATES.TABLE_SESSION),
  [OPERATIONAL_EVENT_TYPES.TABLE_SESSION_CLOSED]: runtimeEvent(AGGREGATES.TABLE_SESSION),
  [OPERATIONAL_EVENT_TYPES.TABLE_STATUS_CHANGED]: runtimeEvent(AGGREGATES.TABLE),
  [OPERATIONAL_EVENT_TYPES.TABLE_SWAPPED]: runtimeEvent(AGGREGATES.TABLE),
  [OPERATIONAL_EVENT_TYPES.CUSTOMER_CREATED]: runtimeEvent(AGGREGATES.CUSTOMER),
  [OPERATIONAL_EVENT_TYPES.CUSTOMER_ATTACHED]: runtimeEvent(AGGREGATES.CUSTOMER),

  [OPERATIONAL_EVENT_TYPES.INVENTORY_DEDUCTED]: runtimeEvent(AGGREGATES.INVENTORY),
  [OPERATIONAL_EVENT_TYPES.INVENTORY_RESTORED]: runtimeEvent(AGGREGATES.INVENTORY),
  [OPERATIONAL_EVENT_TYPES.INVENTORY_ADJUSTED]: runtimeEvent(AGGREGATES.INVENTORY),

  [OPERATIONAL_EVENT_TYPES.MENU_ITEM_UPSERTED]: cloudEvent(AGGREGATES.MENU_ITEM),
  [OPERATIONAL_EVENT_TYPES.MENU_ITEM_DELETED]: cloudEvent(AGGREGATES.MENU_ITEM),
  [OPERATIONAL_EVENT_TYPES.MENU_CATEGORY_UPSERTED]: cloudEvent(AGGREGATES.MENU_CATEGORY),
  [OPERATIONAL_EVENT_TYPES.MENU_CATEGORY_DELETED]: cloudEvent(AGGREGATES.MENU_CATEGORY),
  [OPERATIONAL_EVENT_TYPES.MENU_VARIANT_UPSERTED]: cloudEvent(AGGREGATES.MENU_VARIANT),
  [OPERATIONAL_EVENT_TYPES.MENU_VARIANT_DELETED]: cloudEvent(AGGREGATES.MENU_VARIANT),
  [OPERATIONAL_EVENT_TYPES.MENU_ADDON_UPSERTED]: cloudEvent(AGGREGATES.MENU_ADDON),
  [OPERATIONAL_EVENT_TYPES.MENU_ADDON_DELETED]: cloudEvent(AGGREGATES.MENU_ADDON),
  [OPERATIONAL_EVENT_TYPES.COMBO_UPSERTED]: cloudEvent(AGGREGATES.COMBO),
  [OPERATIONAL_EVENT_TYPES.COMBO_DELETED]: cloudEvent(AGGREGATES.COMBO),
  [OPERATIONAL_EVENT_TYPES.PRICE_PROFILE_UPSERTED]: cloudEvent(AGGREGATES.PRICE_PROFILE),
  [OPERATIONAL_EVENT_TYPES.TAX_PROFILE_UPSERTED]: cloudEvent(AGGREGATES.TAX_PROFILE),
  [OPERATIONAL_EVENT_TYPES.VENUE_UPSERTED]: cloudEvent(AGGREGATES.VENUE),
  [OPERATIONAL_EVENT_TYPES.FLOOR_UPSERTED]: cloudEvent(AGGREGATES.FLOOR),
  [OPERATIONAL_EVENT_TYPES.SECTION_UPSERTED]: cloudEvent(AGGREGATES.SECTION),
  // Cloud may only change table identity/layout fields, never live table state.
  // See CLOUD_WRITABLE_TABLE_FIELDS in contract/ownership.ts.
  [OPERATIONAL_EVENT_TYPES.TABLE_LAYOUT_UPSERTED]: cloudEvent(AGGREGATES.TABLE),
  [OPERATIONAL_EVENT_TYPES.OUTLET_UPSERTED]: cloudEvent(AGGREGATES.OUTLET),
  [OPERATIONAL_EVENT_TYPES.USER_UPSERTED]: cloudEvent(AGGREGATES.USER),
  [OPERATIONAL_EVENT_TYPES.USER_DEACTIVATED]: cloudEvent(AGGREGATES.USER),
  [OPERATIONAL_EVENT_TYPES.EMPLOYEE_UPSERTED]: cloudEvent(AGGREGATES.EMPLOYEE),
  [OPERATIONAL_EVENT_TYPES.LEDGER_CATEGORY_UPSERTED]: cloudEvent(AGGREGATES.LEDGER_CATEGORY),
  [OPERATIONAL_EVENT_TYPES.PRINTER_CONFIG_UPDATED]: cloudEvent(AGGREGATES.PRINTER_CONFIG),
};

export function isKnownEventType(eventType: string): eventType is OperationalEventType {
  return Object.prototype.hasOwnProperty.call(EVENT_TYPE_REGISTRY, eventType);
}

export function getEventTypeSpec(eventType: string): EventTypeSpec | null {
  if (!isKnownEventType(eventType)) return null;
  return EVENT_TYPE_REGISTRY[eventType];
}

// The `table` aggregate is shared: cloud owns layout, Runtime owns live state.
// Ownership is therefore enforced per event type, not only per aggregate.
export function getEventOrigin(eventType: string): EventOrigin | null {
  return getEventTypeSpec(eventType)?.origin ?? null;
}

// ── Envelope ─────────────────────────────────────────────────────────────────

export interface OperationalEventEnvelope {
  // Identity
  eventId: string;                 // globally unique, stable across retries
  envelopeVersion: number;
  schemaVersion: number;

  // Tenancy / provenance
  restaurantId: string;
  runtimeId: string | null;        // device id of the emitting Runtime
  origin: EventOrigin;

  // Classification
  aggregate: Aggregate;
  aggregateId: string;
  eventType: OperationalEventType;

  // Actor
  actorId: string | null;
  actorRole: string | null;

  // Correlation
  requestId: string | null;        // command idempotency key that produced this
  correlationId: string | null;    // groups events from one business action
  causationId: string | null;      // eventId that caused this event

  // Time (informational; ordering authority is the sequence, not the clock)
  occurredAt: number;

  // Business facts
  payload: Record<string, unknown>;
}

// A stored event adds local ordering and durability metadata. `seq` is the local
// total order and is assigned by SQLite on append.
export interface StoredOperationalEvent extends OperationalEventEnvelope {
  seq: number;
  aggregateSeq: number | null;
  recordedAt: number;
}

// ── Envelope construction ────────────────────────────────────────────────────

export interface NewEventInput {
  eventType: OperationalEventType;
  aggregateId: string;
  payload: Record<string, unknown>;
  restaurantId: string;
  runtimeId?: string | null;
  actorId?: string | null;
  actorRole?: string | null;
  requestId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  occurredAt?: number;
  eventId?: string;
  schemaVersion?: number;
}

export function newEventId(): string {
  return crypto.randomUUID();
}

// Builds a validated envelope. Throws RuntimeError (PERMANENT) on bad input so a
// malformed event can never reach the event store.
export function buildEventEnvelope(input: NewEventInput): OperationalEventEnvelope {
  const spec = getEventTypeSpec(input.eventType);
  if (!spec) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.UNKNOWN_EVENT_TYPE,
      `Unknown operational event type '${input.eventType}'`,
      { eventType: input.eventType },
    );
  }

  if (!input.restaurantId) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.TENANT_MISMATCH,
      `Event '${input.eventType}' is missing restaurantId`,
      { eventType: input.eventType },
    );
  }

  if (!input.aggregateId) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.VALIDATION_FAILED,
      `Event '${input.eventType}' is missing aggregateId`,
      { eventType: input.eventType },
    );
  }

  if (input.payload === null || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.MALFORMED_PAYLOAD,
      `Event '${input.eventType}' payload must be a JSON object`,
      { eventType: input.eventType },
    );
  }

  return {
    eventId: input.eventId ?? newEventId(),
    envelopeVersion: EVENT_ENVELOPE_VERSION,
    schemaVersion: input.schemaVersion ?? spec.schemaVersion,
    restaurantId: input.restaurantId,
    runtimeId: input.runtimeId ?? null,
    origin: spec.origin,
    aggregate: spec.aggregate,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    actorId: input.actorId ?? null,
    actorRole: input.actorRole ?? null,
    requestId: input.requestId ?? null,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    occurredAt: input.occurredAt ?? Date.now(),
    payload: input.payload,
  };
}

// ── Inbound envelope validation ──────────────────────────────────────────────
// Applied to events received from the cloud change feed before anything touches
// the database. Unknown fields are ignored (forward compatible); missing or
// wrong-typed required fields are permanent failures.

export function parseInboundEnvelope(raw: unknown): OperationalEventEnvelope {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.MALFORMED_PAYLOAD, "Inbound event is not an object");
  }

  const value = raw as Record<string, unknown>;
  const requireString = (field: string): string => {
    const found = value[field];
    if (typeof found !== "string" || found.length === 0) {
      throw new RuntimeError(
        RUNTIME_ERROR_CODES.MALFORMED_PAYLOAD,
        `Inbound event field '${field}' must be a non-empty string`,
        { field },
      );
    }
    return found;
  };

  const eventType = requireString("eventType");
  const spec = getEventTypeSpec(eventType);
  if (!spec) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.UNKNOWN_EVENT_TYPE,
      `Unknown inbound event type '${eventType}'`,
      { eventType },
    );
  }

  const schemaVersion = value.schemaVersion === undefined
    ? spec.schemaVersion
    : Number(value.schemaVersion);
  if (!Number.isFinite(schemaVersion) || schemaVersion < 1) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
      `Inbound event '${eventType}' has an invalid schemaVersion`,
      { eventType, schemaVersion: value.schemaVersion },
    );
  }
  if (schemaVersion > spec.schemaVersion) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
      `Inbound event '${eventType}' schemaVersion ${schemaVersion} is newer than supported ${spec.schemaVersion}`,
      { eventType, schemaVersion, supported: spec.schemaVersion },
    );
  }

  const payload = value.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.MALFORMED_PAYLOAD,
      `Inbound event '${eventType}' payload must be a JSON object`,
      { eventType },
    );
  }

  const occurredAt = value.occurredAt === undefined ? Date.now() : Number(value.occurredAt);
  if (!Number.isFinite(occurredAt)) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.MALFORMED_PAYLOAD,
      `Inbound event '${eventType}' has an invalid occurredAt`,
      { eventType },
    );
  }

  const optionalString = (field: string): string | null => {
    const found = value[field];
    return typeof found === "string" && found.length > 0 ? found : null;
  };

  return {
    eventId: requireString("eventId"),
    envelopeVersion: Number(value.envelopeVersion ?? EVENT_ENVELOPE_VERSION),
    schemaVersion,
    restaurantId: requireString("restaurantId"),
    runtimeId: optionalString("runtimeId"),
    // Origin is derived from the registry, never trusted from the wire.
    origin: spec.origin,
    aggregate: spec.aggregate,
    aggregateId: requireString("aggregateId"),
    eventType: eventType as OperationalEventType,
    actorId: optionalString("actorId"),
    actorRole: optionalString("actorRole"),
    requestId: optionalString("requestId"),
    correlationId: optionalString("correlationId"),
    causationId: optionalString("causationId"),
    occurredAt,
    payload: payload as Record<string, unknown>,
  };
}

// ── Upload / ingest outcomes ─────────────────────────────────────────────────
// Per-event outcome returned by the cloud ingest endpoint. Delivery state is
// updated from each event's own outcome, never from a batch-level verdict.

export type EventIngestOutcome = "applied" | "duplicate" | "rejected" | "retry";

export interface EventIngestResult {
  eventId: string;
  outcome: EventIngestOutcome;
  code?: string;
  message?: string;
  cloudSeq?: number;
}

export interface EventIngestResponse {
  results: EventIngestResult[];
}

// ── Download page ────────────────────────────────────────────────────────────

export interface EventChangesPage {
  events: unknown[];        // validated individually via parseInboundEnvelope
  nextCursor: string | null;
  hasMore: boolean;
  cloudSeq?: number;
}
