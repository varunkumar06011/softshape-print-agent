// ─────────────────────────────────────────────────────────────────────────────
// core/projections.ts — Projection registry and replay engine
// ─────────────────────────────────────────────────────────────────────────────
// A projection handler turns an immutable event into operational read-model
// rows. Handlers must be:
//
//   - deterministic:  same event + same prior state ⇒ same result
//   - idempotent:     applying the same event twice must not double-apply
//   - synchronous:    no network, no timers, no async work (they run inside the
//                     SQLite transaction that appends the event)
//   - side-effect free outside SQLite: no printing, no sockets, no cloud calls
//
// Normal startup does NOT replay history. Replay is a recovery/diagnostic path
// (`rebuildProjections`) and is the only place where projection state is reset.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import { runtimeLog } from "../contract/logger.ts";
import {
  RUNTIME_ERROR_CODES,
  RuntimeError,
  normalizeError,
} from "../contract/errors.ts";
import {
  getAggregateOwner,
  type EventOrigin,
} from "../contract/ownership.ts";
import {
  getEventTypeSpec,
  type OperationalEventType,
  type StoredOperationalEvent,
} from "../contract/operationalEvents.ts";
import { readEventsAfterSeq, getMaxSeq } from "./eventStore.ts";

// ── Handler contract ─────────────────────────────────────────────────────────

export type ProjectionHandler = (db: Database, event: StoredOperationalEvent) => void;

export interface ProjectionRegistration {
  // Projection name, used as the projection_state key.
  name: string;
  // Event types this projection consumes.
  eventTypes: OperationalEventType[];
  handler: ProjectionHandler;
  // Tables this projection owns. Used by rebuild to know what to clear, and as
  // documentation of the read model each projection is responsible for.
  tables: string[];
}

const registry = new Map<string, ProjectionRegistration>();
const byEventType = new Map<string, ProjectionRegistration[]>();

export function registerProjection(registration: ProjectionRegistration): void {
  if (registry.has(registration.name)) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.INTERNAL_ERROR,
      `Projection '${registration.name}' is already registered`,
      { name: registration.name },
    );
  }

  for (const eventType of registration.eventTypes) {
    if (!getEventTypeSpec(eventType)) {
      throw new RuntimeError(
        RUNTIME_ERROR_CODES.UNKNOWN_EVENT_TYPE,
        `Projection '${registration.name}' subscribes to unknown event type '${eventType}'`,
        { name: registration.name, eventType },
      );
    }
  }

  registry.set(registration.name, registration);
  for (const eventType of registration.eventTypes) {
    const existing = byEventType.get(eventType) ?? [];
    existing.push(registration);
    byEventType.set(eventType, existing);
  }
}

// Test/diagnostic helper. Not used by the running Runtime.
export function resetProjectionRegistry(): void {
  registry.clear();
  byEventType.clear();
}

export function getProjections(): ProjectionRegistration[] {
  return [...registry.values()];
}

export function getProjectionsForEventType(eventType: string): ProjectionRegistration[] {
  return byEventType.get(eventType) ?? [];
}

export interface ProjectionDiscovery {
  registered: string[];
  eventTypesCovered: string[];
  eventTypesWithoutHandlers: string[];
  duplicateEventTypes: string[];
}

// Discovery is explicit and observable. A missing handler is not silently
// treated as a successful projection: callers can use this result as the
// Platform Freeze gate before enabling business event types.
export function discoverProjections(allEventTypes: string[]): ProjectionDiscovery {
  const duplicateEventTypes: string[] = [];
  const eventTypesCovered: string[] = [];
  const eventTypesWithoutHandlers: string[] = [];

  for (const eventType of allEventTypes) {
    const handlers = byEventType.get(eventType) ?? [];
    if (handlers.length > 1) duplicateEventTypes.push(eventType);
    if (handlers.length > 0) eventTypesCovered.push(eventType);
    else eventTypesWithoutHandlers.push(eventType);
  }

  return {
    registered: [...registry.keys()].sort(),
    eventTypesCovered,
    eventTypesWithoutHandlers,
    duplicateEventTypes,
  };
}

export function assertProjectionRegistryReady(allEventTypes: string[]): void {
  const discovery = discoverProjections(allEventTypes);
  if (discovery.duplicateEventTypes.length > 0 || discovery.eventTypesWithoutHandlers.length > 0) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.INTERNAL_ERROR,
      "Projection registry is incomplete or ambiguous",
      discovery,
    );
  }
}

// ── Apply ────────────────────────────────────────────────────────────────────
// Called inside the command/inbound transaction, immediately after the event is
// appended. Any throw propagates so the caller rolls back the whole transaction:
// an event is never committed without its projections.

export function applyEventToProjections(db: Database, event: StoredOperationalEvent): void {
  // Ownership is re-checked at apply time, not only at command time, so a
  // cloud-originated event can never mutate a Runtime-owned aggregate even if it
  // somehow reached this point.
  assertOwnership(event.eventType, event.origin, event.aggregate);

  const projections = getProjectionsForEventType(event.eventType);
  if (projections.length === 0) {
    // Not an error: some events are pure audit facts with no read model. Logged
    // at debug so a genuinely missing projection is still discoverable.
    runtimeLog.debug("No projection registered for event type", {
      eventType: event.eventType,
      eventId: event.eventId,
    });
    return;
  }

  for (const projection of projections) {
    try {
      projection.handler(db, event);
    } catch (err) {
      const runtimeError = normalizeError(err);
      // Re-thrown with projection context so the DLQ entry says which projection
      // rejected the event, not just that "something failed".
      throw new RuntimeError(runtimeError.code, runtimeError.message, {
        ...(runtimeError.details ?? {}),
        projection: projection.name,
        eventId: event.eventId,
        eventType: event.eventType,
      });
    }
  }

  bumpProjectionState(db, projections, event.seq);
}

export function assertOwnership(eventType: string, origin: EventOrigin, aggregate: string): void {
  const spec = getEventTypeSpec(eventType);
  if (!spec) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.UNKNOWN_EVENT_TYPE,
      `Unknown event type '${eventType}'`,
      { eventType },
    );
  }

  // The event type is the authoritative gate for who may emit what. It is
  // stricter than the aggregate matrix, and it is what lets a shared aggregate
  // like `table` carry cloud-owned layout events (table.layout_upserted) and
  // Runtime-owned state events (table.status_changed) without ambiguity.
  if (spec.origin !== origin) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.OWNERSHIP_VIOLATION,
      `Event type '${eventType}' may only originate from '${spec.origin}', got '${origin}'`,
      { eventType, expectedOrigin: spec.origin, actualOrigin: origin },
    );
  }

  // The aggregate matrix still has to be consulted for two things the event-type
  // check cannot catch: an aggregate nobody owns, and a cloud-derived aggregate
  // that must never be mutated by events at all.
  const owner = getAggregateOwner(aggregate);
  if (owner === null) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.UNKNOWN_AGGREGATE,
      `Aggregate '${aggregate}' has no declared owner`,
      { aggregate, eventType },
    );
  }
  if (owner === "DERIVED") {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.OWNERSHIP_VIOLATION,
      `Aggregate '${aggregate}' is cloud-derived and cannot be mutated by events`,
      { aggregate, eventType, owner },
    );
  }
}

function bumpProjectionState(
  db: Database,
  projections: ProjectionRegistration[],
  seq: number,
  now = Date.now(),
): void {
  for (const projection of projections) {
    db.query(
      `INSERT INTO projection_state (name, last_event_seq, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         last_event_seq = MAX(projection_state.last_event_seq, excluded.last_event_seq),
         updated_at = excluded.updated_at`,
    ).run(projection.name, seq, now);
  }
}

// ── Projection state ─────────────────────────────────────────────────────────

export interface ProjectionStatus {
  name: string;
  lastEventSeq: number;
  rebuiltAt: number | null;
  lag: number;
}

export function getProjectionStatus(db: Database): ProjectionStatus[] {
  const maxSeq = getMaxSeq(db);
  const rows = db
    .query(`SELECT name, last_event_seq, rebuilt_at FROM projection_state ORDER BY name`)
    .all() as Array<{ name: string; last_event_seq: number; rebuilt_at: number | null }>;

  return rows.map((row) => ({
    name: row.name,
    lastEventSeq: row.last_event_seq,
    rebuiltAt: row.rebuilt_at,
    lag: Math.max(0, maxSeq - row.last_event_seq),
  }));
}

// Highest projection lag across all registered projections. Surfaced on
// /runtime/status so divergence is visible instead of inferred.
export function getMaxProjectionLag(db: Database): number {
  const statuses = getProjectionStatus(db);
  return statuses.reduce((max, status) => Math.max(max, status.lag), 0);
}

// ── Rebuild (recovery / diagnostics only) ────────────────────────────────────
// Replays the event store into the projection tables. This is NOT part of normal
// startup: the Runtime boots by reading existing projections.
//
// `clearTables` is opt-in because clearing a read model is destructive. When
// false, the replay relies on handler idempotency and only re-applies events the
// projection has not consumed yet.

export interface RebuildOptions {
  projectionNames?: string[];
  clearTables?: boolean;
  batchSize?: number;
  fromSeq?: number;
}

export interface RebuildResult {
  projections: string[];
  eventsApplied: number;
  fromSeq: number;
  toSeq: number;
  durationMs: number;
}

export function rebuildProjections(db: Database, options: RebuildOptions = {}): RebuildResult {
  const startedAt = Date.now();
  const batchSize = options.batchSize ?? 500;
  const selected = options.projectionNames
    ? options.projectionNames.map((name) => {
        const found = registry.get(name);
        if (!found) {
          throw new RuntimeError(
            RUNTIME_ERROR_CODES.VALIDATION_FAILED,
            `Unknown projection '${name}'`,
            { name },
          );
        }
        return found;
      })
    : getProjections();

  if (selected.length === 0) {
    return {
      projections: [],
      eventsApplied: 0,
      fromSeq: options.fromSeq ?? 0,
      toSeq: options.fromSeq ?? 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const selectedNames = new Set(selected.map((p) => p.name));
  const consumedTypes = new Set<string>();
  for (const projection of selected) {
    for (const eventType of projection.eventTypes) consumedTypes.add(eventType);
  }

  const toSeq = getMaxSeq(db);
  let fromSeq = options.fromSeq ?? 0;
  let eventsApplied = 0;

  runtimeLog.warn("Projection rebuild starting", {
    projections: [...selectedNames],
    clearTables: options.clearTables === true,
    fromSeq,
    toSeq,
  });

  // One transaction for the whole rebuild: a partial rebuild would leave the
  // read model in a state that neither matches the events nor the previous data.
  // When clearing tables, disable FK enforcement first — SQLite does not allow
  // PRAGMA changes inside a transaction, and the Set iteration order is not
  // guaranteed to respect parent-child dependency order.
  let fkWasOn = false;
  if (options.clearTables) {
    try {
      const fkRow = db.query("PRAGMA foreign_keys").get() as { foreign_keys?: number };
      fkWasOn = Number(fkRow?.foreign_keys ?? 0) === 1;
    } catch { /* ignore */ }
    if (fkWasOn) db.exec("PRAGMA foreign_keys = OFF");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    if (options.clearTables) {
      const tables = new Set<string>();
      for (const projection of selected) {
        for (const table of projection.tables) tables.add(table);
      }
      for (const table of tables) {
        db.query(`DELETE FROM "${table}"`).run();
      }
      fromSeq = 0;
      for (const name of selectedNames) {
        db.query(
          `INSERT INTO projection_state (name, last_event_seq, updated_at)
           VALUES (?, 0, ?)
           ON CONFLICT(name) DO UPDATE SET last_event_seq = 0, updated_at = excluded.updated_at`,
        ).run(name, Date.now());
      }
    }

    // Bounded batches so a multi-million-event history never has to fit in
    // memory. `toSeq` is fixed at the start; the exclusive transaction means no
    // new events can appear underneath the replay.
    let cursor = fromSeq;
    while (cursor < toSeq) {
      const batch = readEventsAfterSeq(db, cursor, batchSize);
      if (batch.length === 0) break;

      for (const event of batch) {
        cursor = event.seq;
        if (!consumedTypes.has(event.eventType)) continue;

        for (const projection of getProjectionsForEventType(event.eventType)) {
          if (!selectedNames.has(projection.name)) continue;
          projection.handler(db, event);
          eventsApplied++;
        }
      }
    }

    const finishedAt = Date.now();
    for (const name of selectedNames) {
      db.query(
        `INSERT INTO projection_state (name, last_event_seq, rebuilt_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           last_event_seq = excluded.last_event_seq,
           rebuilt_at = excluded.rebuilt_at,
           updated_at = excluded.updated_at`,
      ).run(name, toSeq, finishedAt, finishedAt);
    }

    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Rollback of an already-aborted transaction is not an additional failure.
    }
    if (fkWasOn) {
      try { db.exec("PRAGMA foreign_keys = ON"); } catch { /* ignore */ }
    }
    const runtimeError = normalizeError(err);
    runtimeLog.error("Projection rebuild failed — read model left unchanged", {
      projections: [...selectedNames],
      code: runtimeError.code,
      error: runtimeError.message,
    });
    throw runtimeError;
  }

  // Re-enable FK enforcement after the transaction completes.
  if (fkWasOn) {
    try { db.exec("PRAGMA foreign_keys = ON"); } catch { /* ignore */ }
  }

  const result: RebuildResult = {
    projections: [...selectedNames],
    eventsApplied,
    fromSeq,
    toSeq,
    durationMs: Date.now() - startedAt,
  };

  runtimeLog.warn("Projection rebuild complete", { ...result });
  return result;
}
