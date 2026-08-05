// ─────────────────────────────────────────────────────────────────────────────
// core/eventStore.ts — Append-only Operational Event Store repository
// ─────────────────────────────────────────────────────────────────────────────
// The only sanctioned way to write to event_store. There is deliberately no
// update or arbitrary-delete API: corrections are new compensating events, and
// the schema triggers reject anything else.
//
// Every function takes an explicit Database so the store is unit-testable
// against a temporary database and never depends on process-global state.
//
// Ordering:
//   - `seq` is the local total order (SQLite autoincrement).
//   - `aggregate_seq` is the per-aggregate order, used for dependency checks and
//     optimistic concurrency without a table-wide scan.
//   - `occurred_at` is informational. Client clocks are never the authority.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import {
  RUNTIME_ERROR_CODES,
  RuntimeError,
  type FailureClass,
} from "../contract/errors.ts";
import type {
  OperationalEventEnvelope,
  StoredOperationalEvent,
} from "../contract/operationalEvents.ts";
import type { Aggregate } from "../contract/ownership.ts";
import type { DeliveryStatus } from "./schema.ts";

// ── Row shapes ───────────────────────────────────────────────────────────────

interface EventStoreRow {
  seq: number;
  event_id: string;
  envelope_version: number;
  schema_version: number;
  restaurant_id: string;
  runtime_id: string | null;
  origin: string;
  aggregate: string;
  aggregate_id: string;
  aggregate_seq: number | null;
  event_type: string;
  actor_id: string | null;
  actor_role: string | null;
  request_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  payload: string;
  occurred_at: number;
  recorded_at: number;
}

function rowToEvent(row: EventStoreRow): StoredOperationalEvent {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    // A stored event whose payload no longer parses is corruption, not a
    // business condition — surface it instead of silently returning {}.
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.INTERNAL_ERROR,
      `event_store row ${row.seq} (${row.event_id}) has an unparseable payload`,
      { seq: row.seq, eventId: row.event_id },
    );
  }

  return {
    seq: row.seq,
    eventId: row.event_id,
    envelopeVersion: row.envelope_version,
    schemaVersion: row.schema_version,
    restaurantId: row.restaurant_id,
    runtimeId: row.runtime_id,
    origin: row.origin === "cloud" ? "cloud" : "runtime",
    aggregate: row.aggregate as Aggregate,
    aggregateId: row.aggregate_id,
    aggregateSeq: row.aggregate_seq,
    eventType: row.event_type as StoredOperationalEvent["eventType"],
    actorId: row.actor_id,
    actorRole: row.actor_role,
    requestId: row.request_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    payload,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}

// ── Append ───────────────────────────────────────────────────────────────────
// MUST be called inside a transaction that also applies the projections. The
// caller owns the transaction so that event + projection commit atomically.

export function appendEvent(
  db: Database,
  envelope: OperationalEventEnvelope,
  now = Date.now(),
): StoredOperationalEvent {
  // Idempotent append: the same eventId must never produce two rows. This is the
  // last line of defence behind the unique index, and turns a redelivered or
  // retried event into an explicit, catchable condition.
  const existing = db
    .query("SELECT seq FROM event_store WHERE event_id = ?")
    .get(envelope.eventId) as { seq: number } | null;
  if (existing) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.DUPLICATE_EVENT_ID,
      `Event ${envelope.eventId} already exists in the event store`,
      { eventId: envelope.eventId, seq: existing.seq },
    );
  }

  const nextAggregateSeq = (
    db
      .query(
        `SELECT COALESCE(MAX(aggregate_seq), 0) + 1 AS next
         FROM event_store WHERE aggregate = ? AND aggregate_id = ?`,
      )
      .get(envelope.aggregate, envelope.aggregateId) as { next: number }
  ).next;

  db.query(
    `INSERT INTO event_store (
       event_id, envelope_version, schema_version, restaurant_id, runtime_id,
       origin, aggregate, aggregate_id, aggregate_seq, event_type,
       actor_id, actor_role, request_id, correlation_id, causation_id,
       payload, occurred_at, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    envelope.eventId,
    envelope.envelopeVersion,
    envelope.schemaVersion,
    envelope.restaurantId,
    envelope.runtimeId,
    envelope.origin,
    envelope.aggregate,
    envelope.aggregateId,
    nextAggregateSeq,
    envelope.eventType,
    envelope.actorId,
    envelope.actorRole,
    envelope.requestId,
    envelope.correlationId,
    envelope.causationId,
    JSON.stringify(envelope.payload),
    envelope.occurredAt,
    now,
  );

  // Capture the event rowid BEFORE inserting event_delivery. SQLite's
  // last_insert_rowid() is connection-global, so reading it after the delivery
  // insert can return the delivery row's id instead of event_store.seq when
  // cloud-originated and runtime-originated events are interleaved.
  const seq = (db.query("SELECT last_insert_rowid() AS seq").get() as { seq: number }).seq;

  // Only runtime-origin events are uploaded. Cloud-origin events arrived from
  // the cloud and must never be echoed back.
  if (envelope.origin === "runtime") {
    db.query(
      `INSERT INTO event_delivery (
         event_seq, event_id, status, attempts, next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, 'pending', 0, ?, ?, ?)`,
    ).run(seq, envelope.eventId, now, now, now);
  }

  return { ...envelope, seq, aggregateSeq: nextAggregateSeq, recordedAt: now };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export function getEventById(db: Database, eventId: string): StoredOperationalEvent | null {
  const row = db
    .query("SELECT * FROM event_store WHERE event_id = ?")
    .get(eventId) as EventStoreRow | null;
  return row ? rowToEvent(row) : null;
}

export function hasEvent(db: Database, eventId: string): boolean {
  const row = db.query("SELECT 1 AS found FROM event_store WHERE event_id = ?").get(eventId);
  return row !== null && row !== undefined;
}

export function readEventsForAggregate(
  db: Database,
  aggregate: string,
  aggregateId: string,
): StoredOperationalEvent[] {
  const rows = db
    .query(
      `SELECT * FROM event_store
       WHERE aggregate = ? AND aggregate_id = ?
       ORDER BY seq ASC`,
    )
    .all(aggregate, aggregateId) as EventStoreRow[];
  return rows.map(rowToEvent);
}

export function getLatestAggregateSeq(
  db: Database,
  aggregate: string,
  aggregateId: string,
): number {
  const row = db
    .query(
      `SELECT COALESCE(MAX(aggregate_seq), 0) AS current
       FROM event_store WHERE aggregate = ? AND aggregate_id = ?`,
    )
    .get(aggregate, aggregateId) as { current: number };
  return row.current;
}

// Streaming read used by projection replay/rebuild. Bounded by `limit` so a
// rebuild never loads the whole history into memory.
export function readEventsAfterSeq(
  db: Database,
  afterSeq: number,
  limit: number,
): StoredOperationalEvent[] {
  const rows = db
    .query(`SELECT * FROM event_store WHERE seq > ? ORDER BY seq ASC LIMIT ?`)
    .all(afterSeq, limit) as EventStoreRow[];
  return rows.map(rowToEvent);
}

export function getMaxSeq(db: Database): number {
  const row = db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM event_store").get() as {
    seq: number;
  };
  return row.seq;
}

export function countEvents(db: Database): number {
  return (db.query("SELECT COUNT(*) AS c FROM event_store").get() as { c: number }).c;
}

// ── Outbound delivery ────────────────────────────────────────────────────────

export interface PendingDelivery {
  event: StoredOperationalEvent;
  attempts: number;
}

// Deterministic local order (seq ASC) so causally related events upload in the
// order they were committed. Only rows whose backoff has elapsed are returned.
export function readPendingDeliveries(
  db: Database,
  limit: number,
  now = Date.now(),
): PendingDelivery[] {
  const rows = db
    .query(
      `SELECT e.*, d.attempts AS delivery_attempts
       FROM event_delivery d
       JOIN event_store e ON e.seq = d.event_seq
       WHERE (
         (d.status = 'pending' AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?))
         OR (d.status = 'in_flight' AND d.lease_until IS NOT NULL AND d.lease_until <= ?)
       )
       ORDER BY d.event_seq ASC
       LIMIT ?`,
    )
    .all(now, now, limit) as Array<EventStoreRow & { delivery_attempts: number }>;

  return rows.map((row) => ({
    event: rowToEvent(row),
    attempts: row.delivery_attempts,
  }));
}

export function markDeliveryInFlight(
  db: Database,
  eventIds: string[],
  leaseUntil: number,
  now = Date.now(),
): void {
  if (eventIds.length === 0) return;
  const placeholders = eventIds.map(() => "?").join(",");
  db.query(
    `UPDATE event_delivery
     SET status = 'in_flight', attempts = attempts + 1, lease_until = ?, updated_at = ?
     WHERE event_id IN (${placeholders}) AND status IN ('pending', 'in_flight')`,
  ).run(leaseUntil, now, ...eventIds);
}

// Applied per event from its own ACK. A batch-level failure must never mark an
// unacknowledged event as delivered, and an acknowledged event must never be
// resent because a sibling in the same batch failed.
export function markDelivered(
  db: Database,
  eventId: string,
  cloudSeq: number | null = null,
  now = Date.now(),
): void {
  db.query(
    `UPDATE event_delivery
     SET status = 'delivered', delivered_at = ?, cloud_seq = ?, last_error = NULL,
         last_error_class = NULL, lease_until = NULL, next_attempt_at = NULL, updated_at = ?
     WHERE event_id = ?`,
  ).run(now, cloudSeq, now, eventId);
}

export function markDeliveryRetry(
  db: Database,
  eventId: string,
  error: string,
  failureClass: FailureClass,
  nextAttemptAt: number,
  now = Date.now(),
): void {
  db.query(
    `UPDATE event_delivery
     SET status = 'pending', last_error = ?, last_error_class = ?, next_attempt_at = ?,
         lease_until = NULL, updated_at = ?
     WHERE event_id = ?`,
  ).run(error, failureClass, nextAttemptAt, now, eventId);
}

export function markDeliveryDeadLetter(
  db: Database,
  eventId: string,
  error: string,
  failureClass: FailureClass,
  now = Date.now(),
): void {
  db.query(
    `UPDATE event_delivery
     SET status = 'dead_letter', last_error = ?, last_error_class = ?,
         lease_until = NULL, next_attempt_at = NULL, updated_at = ?
     WHERE event_id = ?`,
  ).run(error, failureClass, now, eventId);
}

// Reclaims events whose in-flight lease expired (process killed mid-upload).
// Safe because cloud ingest is event-id idempotent: a re-sent event that was in
// fact applied comes back as `duplicate`.
export function reclaimExpiredLeases(db: Database, now = Date.now()): number {
  const result = db
    .query(
      `UPDATE event_delivery
       SET status = 'pending', lease_until = NULL, updated_at = ?
       WHERE status = 'in_flight' AND lease_until IS NOT NULL AND lease_until < ?`,
    )
    .run(now, now);
  return result.changes ?? 0;
}

export function getDeliveryStatus(db: Database, eventId: string): DeliveryStatus | null {
  const row = db
    .query("SELECT status FROM event_delivery WHERE event_id = ?")
    .get(eventId) as { status: DeliveryStatus } | null;
  return row?.status ?? null;
}

// ── Delivery metrics ─────────────────────────────────────────────────────────

export interface DeliveryStats {
  pending: number;
  inFlight: number;
  deadLetter: number;
  oldestPendingAt: number | null;
}

export function getDeliveryStats(db: Database): DeliveryStats {
  const row = db
    .query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN status = 'in_flight' THEN 1 ELSE 0 END), 0) AS in_flight,
         COALESCE(SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END), 0) AS dead_letter
       FROM event_delivery`,
    )
    .get() as { pending: number; in_flight: number; dead_letter: number };

  const oldest = db
    .query(
      `SELECT MIN(e.recorded_at) AS oldest
       FROM event_delivery d JOIN event_store e ON e.seq = d.event_seq
       WHERE d.status IN ('pending', 'in_flight')`,
    )
    .get() as { oldest: number | null };

  return {
    pending: row.pending,
    inFlight: row.in_flight,
    deadLetter: row.dead_letter,
    oldestPendingAt: oldest.oldest ?? null,
  };
}

// ── Inbound dedupe ───────────────────────────────────────────────────────────

export function isInboundEventApplied(db: Database, eventId: string): boolean {
  const row = db.query("SELECT 1 AS found FROM inbound_event WHERE event_id = ?").get(eventId);
  return row !== null && row !== undefined;
}

export function recordInboundEvent(
  db: Database,
  params: {
    eventId: string;
    eventType: string;
    aggregate: string;
    aggregateId: string;
    cursorValue: string | null;
    outcome: "applied" | "duplicate" | "rejected";
  },
  now = Date.now(),
): void {
  db.query(
    `INSERT INTO inbound_event (event_id, event_type, aggregate, aggregate_id, cursor_value, outcome, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO NOTHING`,
  ).run(
    params.eventId,
    params.eventType,
    params.aggregate,
    params.aggregateId,
    params.cursorValue,
    params.outcome,
    now,
  );
}
