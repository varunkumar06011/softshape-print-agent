// ─────────────────────────────────────────────────────────────────────────────
// core/inboundApplier.ts — Apply cloud-originated events atomically with cursor
// ─────────────────────────────────────────────────────────────────────────────
// One transaction per inbound event:
//
//   dedupe check → append (origin='cloud') → projections → cursor advance
//
// Because the cursor moves in the same transaction as the apply, the classic
// failure modes are structurally impossible:
//
//   - crash after apply, before cursor advance  → both roll back, event refetched
//   - crash after cursor advance, before apply  → cannot happen
//   - redelivery of an already-applied event    → dedupe no-op, cursor still moves
//
// Outcome policy:
//   applied    — event appended and projected, cursor advances
//   duplicate  — already known, nothing re-applied, cursor advances
//   dead_letter— permanent failure, recorded in DLQ, cursor advances so one bad
//                event cannot block the whole feed
//   retry      — transient failure, cursor does NOT advance
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import { runtimeLog } from "../contract/logger.ts";
import { normalizeError } from "../contract/errors.ts";
import {
  parseInboundEnvelope,
  type OperationalEventEnvelope,
} from "../contract/operationalEvents.ts";
import {
  appendEvent,
  isInboundEventApplied,
  hasEvent,
  recordInboundEvent,
} from "./eventStore.ts";
import { applyEventToProjections } from "./projections.ts";
import { advanceCursor } from "./checkpoints.ts";
import { recordDlqEntry } from "./dlq.ts";

export type InboundOutcome = "applied" | "duplicate" | "dead_letter" | "retry";

export interface InboundResult {
  outcome: InboundOutcome;
  eventId: string | null;
  code?: string;
  error?: string;
  dlqId?: number;
}

export interface ApplyInboundOptions {
  // Cursor value that corresponds to this event's position in the cloud feed.
  cursorValue: string | null;
  checkpointName?: string;
  // Required tenant fence. An event from another restaurant is permanent and
  // must be dead-lettered without touching local projections.
  restaurantId: string;
}

export function applyInboundEvent(
  db: Database,
  raw: unknown,
  options: ApplyInboundOptions,
): InboundResult {
  // Parsing happens before any transaction: a malformed envelope is a permanent
  // failure that never touches the database except as a DLQ record.
  let envelope: OperationalEventEnvelope;
  try {
    envelope = parseInboundEnvelope(raw);
  } catch (err) {
    const runtimeError = normalizeError(err);
    if (runtimeError.failureClass === "TRANSIENT") {
      return { outcome: "retry", eventId: null, code: runtimeError.code, error: runtimeError.message };
    }
    return deadLetterInbound(db, {
      raw,
      cursorValue: options.cursorValue,
      checkpointName: options.checkpointName,
      code: runtimeError.code,
      message: runtimeError.message,
      eventId: null,
      envelope: null,
      restaurantId: options.restaurantId,
    });
  }

  if (envelope.restaurantId !== options.restaurantId) {
    return deadLetterInbound(db, {
      raw,
      cursorValue: options.cursorValue,
      checkpointName: options.checkpointName,
      code: "TENANT_MISMATCH",
      message: `Inbound event belongs to restaurant '${envelope.restaurantId}', expected '${options.restaurantId}'`,
      eventId: envelope.eventId,
      envelope,
      restaurantId: options.restaurantId,
    });
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    // Two dedupe sources: the inbound log (what we processed) and the event store
    // (what we stored). Either one means this event must not be applied again.
    if (isInboundEventApplied(db, envelope.eventId) || hasEvent(db, envelope.eventId)) {
      if (options.cursorValue !== null) {
        advanceCursor(db, {
          name: options.checkpointName,
          cursorValue: options.cursorValue,
          lastEventId: envelope.eventId,
        });
      }
      db.exec("COMMIT");
      return { outcome: "duplicate", eventId: envelope.eventId };
    }

    const stored = appendEvent(db, envelope);
    applyEventToProjections(db, stored);

    recordInboundEvent(db, {
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      aggregate: envelope.aggregate,
      aggregateId: envelope.aggregateId,
      cursorValue: options.cursorValue,
      outcome: "applied",
    });

    if (options.cursorValue !== null) {
      advanceCursor(db, {
        name: options.checkpointName,
        cursorValue: options.cursorValue,
        lastEventId: envelope.eventId,
        appliedDelta: 1,
      });
    }

    db.exec("COMMIT");
    return { outcome: "applied", eventId: envelope.eventId };
  } catch (err) {
    rollbackQuietly(db);

    const runtimeError = normalizeError(err);

    // Transient: leave the cursor alone so this exact event is refetched.
    if (runtimeError.failureClass === "TRANSIENT") {
      runtimeLog.warn("Inbound event apply deferred (transient)", {
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        code: runtimeError.code,
      });
      return {
        outcome: "retry",
        eventId: envelope.eventId,
        code: runtimeError.code,
        error: runtimeError.message,
      };
    }

    return deadLetterInbound(db, {
      raw,
      cursorValue: options.cursorValue,
      checkpointName: options.checkpointName,
      code: runtimeError.code,
      message: runtimeError.message,
      eventId: envelope.eventId,
      envelope,
      restaurantId: options.restaurantId,
    });
  }
}

// ── Dead-letter path ─────────────────────────────────────────────────────────
// The cursor advances past a dead-lettered event on purpose: one poison event
// from the cloud must not stall every subsequent configuration change. The event
// is fully preserved in the DLQ, so nothing is lost.

function deadLetterInbound(
  db: Database,
  params: {
    raw: unknown;
    cursorValue: string | null;
    checkpointName?: string;
    code: string;
    message: string;
    eventId: string | null;
    envelope: OperationalEventEnvelope | null;
    restaurantId: string;
  },
): InboundResult {
  let dlqId: number | undefined;

  db.exec("BEGIN IMMEDIATE");
  try {
    dlqId = recordDlqEntry(db, {
      kind: "inbound_event",
      reasonCode: params.code,
      reason: params.message,
      failureClass: "PERMANENT",
      eventId: params.eventId,
      restaurantId: params.restaurantId,
      aggregate: params.envelope?.aggregate ?? null,
      aggregateId: params.envelope?.aggregateId ?? null,
      eventType: params.envelope?.eventType ?? null,
      payload: params.raw,
      cursorValue: params.cursorValue,
      occurredAt: params.envelope?.occurredAt ?? null,
    });

    if (params.eventId) {
      recordInboundEvent(db, {
        eventId: params.eventId,
        eventType: params.envelope?.eventType ?? "unknown",
        aggregate: params.envelope?.aggregate ?? "unknown",
        aggregateId: params.envelope?.aggregateId ?? "unknown",
        cursorValue: params.cursorValue,
        outcome: "rejected",
      });
    }

    if (params.cursorValue !== null) {
      advanceCursor(db, {
        name: params.checkpointName,
        cursorValue: params.cursorValue,
        lastEventId: params.eventId,
      });
    }

    db.exec("COMMIT");
  } catch (err) {
    rollbackQuietly(db);
    // If we cannot even record the dead letter, the safe outcome is to retry
    // rather than silently advance past an event we failed to preserve.
    runtimeLog.error("Failed to dead-letter inbound event — will retry", {
      eventId: params.eventId,
      code: params.code,
      error: normalizeError(err).message,
    });
    return {
      outcome: "retry",
      eventId: params.eventId,
      code: params.code,
      error: params.message,
    };
  }

  return {
    outcome: "dead_letter",
    eventId: params.eventId,
    code: params.code,
    error: params.message,
    dlqId,
  };
}

function rollbackQuietly(db: Database): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // No active transaction to roll back.
  }
}

// ── Batch application ────────────────────────────────────────────────────────
// Events are applied one transaction at a time, in feed order. Processing stops
// at the first transient failure so the cursor never skips an event that still
// needs to be applied.

export interface InboundBatchSummary {
  applied: number;
  duplicates: number;
  deadLettered: number;
  stoppedEarly: boolean;
  lastCursor: string | null;
  results: InboundResult[];
}

export function applyInboundBatch(
  db: Database,
  events: Array<{ raw: unknown; cursorValue: string | null }>,
  restaurantId: string,
  checkpointName?: string,
): InboundBatchSummary {
  const summary: InboundBatchSummary = {
    applied: 0,
    duplicates: 0,
    deadLettered: 0,
    stoppedEarly: false,
    lastCursor: null,
    results: [],
  };

  for (const item of events) {
    const result = applyInboundEvent(db, item.raw, {
      cursorValue: item.cursorValue,
      checkpointName,
      restaurantId,
    });
    summary.results.push(result);

    if (result.outcome === "retry") {
      summary.stoppedEarly = true;
      break;
    }

    if (result.outcome === "applied") summary.applied++;
    else if (result.outcome === "duplicate") summary.duplicates++;
    else if (result.outcome === "dead_letter") summary.deadLettered++;

    if (item.cursorValue !== null) summary.lastCursor = item.cursorValue;
  }

  return summary;
}
