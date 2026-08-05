// ─────────────────────────────────────────────────────────────────────────────
// core/dlq.ts — Dead Letter Queue
// ─────────────────────────────────────────────────────────────────────────────
// Where permanently failing events and commands go so that the restaurant keeps
// serving customers instead of retrying forever. Nothing is ever silently
// dropped: the full payload and failure reason are retained for inspection.
//
// Invariants:
//   - Only PERMANENT/UNKNOWN failures land here. TRANSIENT failures retry.
//   - A DLQ entry never disappears on its own; it is resolved explicitly by an
//     operator action, which is audited (resolved_by / resolution).
//   - Recording a DLQ entry must never itself fail the caller's transaction
//     silently: it is written in the same transaction when one is open, so an
//     aborted command does not leave a phantom DLQ row.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import { runtimeLog } from "../contract/logger.ts";
import type { FailureClass } from "../contract/errors.ts";
import type { DlqKind } from "./schema.ts";

export interface DlqEntryInput {
  kind: DlqKind;
  reasonCode: string;
  reason: string;
  failureClass: FailureClass;
  eventId?: string | null;
  eventSeq?: number | null;
  restaurantId?: string | null;
  aggregate?: string | null;
  aggregateId?: string | null;
  eventType?: string | null;
  commandType?: string | null;
  requestId?: string | null;
  payload?: unknown;
  cursorValue?: string | null;
  attempts?: number;
  occurredAt?: number | null;
}

export interface DlqEntry {
  id: number;
  kind: DlqKind;
  eventId: string | null;
  eventSeq: number | null;
  restaurantId: string | null;
  aggregate: string | null;
  aggregateId: string | null;
  eventType: string | null;
  commandType: string | null;
  requestId: string | null;
  reasonCode: string;
  reason: string | null;
  failureClass: string | null;
  payload: unknown;
  cursorValue: string | null;
  attempts: number;
  occurredAt: number | null;
  createdAt: number;
  resolved: boolean;
  resolvedAt: number | null;
  resolvedBy: string | null;
  resolution: string | null;
}

interface DlqRow {
  id: number;
  kind: string;
  event_id: string | null;
  event_seq: number | null;
  restaurant_id: string | null;
  aggregate: string | null;
  aggregate_id: string | null;
  event_type: string | null;
  command_type: string | null;
  request_id: string | null;
  reason_code: string;
  reason: string | null;
  failure_class: string | null;
  payload: string | null;
  cursor_value: string | null;
  attempts: number;
  occurred_at: number | null;
  created_at: number;
  resolved: number;
  resolved_at: number | null;
  resolved_by: string | null;
  resolution: string | null;
}

function rowToEntry(row: DlqRow): DlqEntry {
  let payload: unknown = null;
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload);
    } catch {
      // Keep the raw string rather than losing the evidence we are trying to
      // preserve for the operator.
      payload = row.payload;
    }
  }

  return {
    id: row.id,
    kind: row.kind as DlqKind,
    eventId: row.event_id,
    eventSeq: row.event_seq,
    restaurantId: row.restaurant_id,
    aggregate: row.aggregate,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    commandType: row.command_type,
    requestId: row.request_id,
    reasonCode: row.reason_code,
    reason: row.reason,
    failureClass: row.failure_class,
    payload,
    cursorValue: row.cursor_value,
    attempts: row.attempts,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    resolved: row.resolved === 1,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolution: row.resolution,
  };
}

// ── Record ───────────────────────────────────────────────────────────────────

export function recordDlqEntry(db: Database, input: DlqEntryInput, now = Date.now()): number {
  let serializedPayload: string | null = null;
  if (input.payload !== undefined && input.payload !== null) {
    try {
      serializedPayload = JSON.stringify(input.payload);
    } catch {
      // A non-serializable payload must not prevent the DLQ record itself.
      serializedPayload = String(input.payload);
    }
  }

  db.query(
    `INSERT INTO runtime_dlq (
       kind, event_id, event_seq, restaurant_id, aggregate, aggregate_id, event_type,
       command_type, request_id, reason_code, reason, failure_class, payload,
       cursor_value, attempts, occurred_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.kind,
    input.eventId ?? null,
    input.eventSeq ?? null,
    input.restaurantId ?? null,
    input.aggregate ?? null,
    input.aggregateId ?? null,
    input.eventType ?? null,
    input.commandType ?? null,
    input.requestId ?? null,
    input.reasonCode,
    input.reason,
    input.failureClass,
    serializedPayload,
    input.cursorValue ?? null,
    input.attempts ?? 0,
    input.occurredAt ?? null,
    now,
  );

  const id = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

  runtimeLog.error("Dead letter recorded", {
    dlqId: id,
    kind: input.kind,
    reasonCode: input.reasonCode,
    failureClass: input.failureClass,
    eventId: input.eventId ?? null,
    eventType: input.eventType ?? null,
    commandType: input.commandType ?? null,
    // Payload intentionally omitted from logs: it can contain customer and
    // payment data. It is available in the DLQ table for authorized operators.
  });

  return id;
}

// ── Read ─────────────────────────────────────────────────────────────────────

export interface DlqQuery {
  kind?: DlqKind;
  includeResolved?: boolean;
  limit?: number;
  offset?: number;
}

export function listDlqEntries(db: Database, query: DlqQuery = {}): DlqEntry[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!query.includeResolved) conditions.push("resolved = 0");
  if (query.kind) {
    conditions.push("kind = ?");
    params.push(query.kind);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
  const offset = Math.max(query.offset ?? 0, 0);

  const bindings = [...params, limit, offset] as any[];
  const rows = db
    .query(`SELECT * FROM runtime_dlq ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...bindings) as DlqRow[];

  return rows.map(rowToEntry);
}

export function getDlqEntry(db: Database, id: number): DlqEntry | null {
  const row = db.query("SELECT * FROM runtime_dlq WHERE id = ?").get(id) as DlqRow | null;
  return row ? rowToEntry(row) : null;
}

export function countUnresolvedDlq(db: Database): number {
  return (
    db.query("SELECT COUNT(*) AS c FROM runtime_dlq WHERE resolved = 0").get() as { c: number }
  ).c;
}

export function countUnresolvedDlqByKind(db: Database): Record<string, number> {
  const rows = db
    .query(
      `SELECT kind, COUNT(*) AS c FROM runtime_dlq WHERE resolved = 0 GROUP BY kind`,
    )
    .all() as Array<{ kind: string; c: number }>;

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.kind] = row.c;
  return counts;
}

// ── Resolve ──────────────────────────────────────────────────────────────────
// Explicit operator action. `resolvedBy` is required so every resolution is
// attributable.

export type DlqResolution = "replayed" | "discarded" | "fixed";

export function resolveDlqEntry(
  db: Database,
  id: number,
  resolution: DlqResolution,
  resolvedBy: string,
  now = Date.now(),
): boolean {
  const result = db
    .query(
      `UPDATE runtime_dlq
       SET resolved = 1, resolved_at = ?, resolved_by = ?, resolution = ?
       WHERE id = ? AND resolved = 0`,
    )
    .run(now, resolvedBy, resolution, id);

  const changed = (result.changes ?? 0) > 0;
  if (changed) {
    runtimeLog.warn("Dead letter resolved", { dlqId: id, resolution, resolvedBy });
  }
  return changed;
}
