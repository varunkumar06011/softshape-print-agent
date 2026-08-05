// ─────────────────────────────────────────────────────────────────────────────
// core/checkpoints.ts — Durable sync cursors and snapshot identity
// ─────────────────────────────────────────────────────────────────────────────
// The cursor is the single fact that makes incremental download safe: the
// Runtime asks the cloud "what changed after X" instead of re-downloading whole
// tables. Getting cursor advancement wrong is how you get duplicated menus or
// skipped changes, so the rules here are deliberately strict:
//
//   - The cursor is advanced in the SAME transaction that applies the inbound
//     event. A crash between apply and advance is therefore impossible.
//   - The cursor is only advanced forward past an event that was either applied
//     or explicitly dead-lettered. A retryable failure leaves it untouched so
//     the event is refetched.
//   - Snapshot identity (version + checksum) is stored alongside the cursor so
//     bootstrap provenance is auditable after the fact.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import { CHECKPOINT_CLOUD_DOWNLOAD } from "./schema.ts";

export interface Checkpoint {
  name: string;
  cursorValue: string | null;
  lastEventId: string | null;
  snapshotVersion: string | null;
  snapshotChecksum: string | null;
  snapshotSchema: number | null;
  appliedCount: number;
  updatedAt: number;
}

interface CheckpointRow {
  name: string;
  cursor_value: string | null;
  last_event_id: string | null;
  snapshot_version: string | null;
  snapshot_checksum: string | null;
  snapshot_schema: number | null;
  applied_count: number;
  updated_at: number;
}

function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    name: row.name,
    cursorValue: row.cursor_value,
    lastEventId: row.last_event_id,
    snapshotVersion: row.snapshot_version,
    snapshotChecksum: row.snapshot_checksum,
    snapshotSchema: row.snapshot_schema,
    appliedCount: row.applied_count,
    updatedAt: row.updated_at,
  };
}

export function getCheckpoint(db: Database, name: string): Checkpoint | null {
  const row = db
    .query("SELECT * FROM sync_checkpoint WHERE name = ?")
    .get(name) as CheckpointRow | null;
  return row ? rowToCheckpoint(row) : null;
}

export function getDownloadCursor(db: Database): string | null {
  return getCheckpoint(db, CHECKPOINT_CLOUD_DOWNLOAD)?.cursorValue ?? null;
}

// True when the Runtime has never been bootstrapped. Callers must treat this as
// "run bootstrap", not "download everything from cursor zero".
export function needsBootstrap(db: Database): boolean {
  const checkpoint = getCheckpoint(db, CHECKPOINT_CLOUD_DOWNLOAD);
  return checkpoint === null || checkpoint.cursorValue === null;
}

// ── Cursor advancement ───────────────────────────────────────────────────────
// MUST be called inside the transaction that applied the inbound event(s).

export function advanceCursor(
  db: Database,
  params: { name?: string; cursorValue: string; lastEventId?: string | null; appliedDelta?: number },
  now = Date.now(),
): void {
  const name = params.name ?? CHECKPOINT_CLOUD_DOWNLOAD;
  db.query(
    `INSERT INTO sync_checkpoint (name, cursor_value, last_event_id, applied_count, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       cursor_value = excluded.cursor_value,
       last_event_id = COALESCE(excluded.last_event_id, sync_checkpoint.last_event_id),
       applied_count = sync_checkpoint.applied_count + ?,
       updated_at = excluded.updated_at`,
  ).run(
    name,
    params.cursorValue,
    params.lastEventId ?? null,
    params.appliedDelta ?? 0,
    now,
    params.appliedDelta ?? 0,
  );
}

// ── Snapshot identity ────────────────────────────────────────────────────────
// Written when a verified snapshot is promoted. Recording the cursor and the
// snapshot fingerprint together is what makes "snapshot then cursor" auditable:
// you can always tell which snapshot a Runtime started from.

export function recordSnapshot(
  db: Database,
  params: {
    name?: string;
    cursorValue: string;
    snapshotVersion: string;
    snapshotChecksum: string;
    snapshotSchema: number;
  },
  now = Date.now(),
): void {
  const name = params.name ?? CHECKPOINT_CLOUD_DOWNLOAD;
  db.query(
    `INSERT INTO sync_checkpoint (
       name, cursor_value, snapshot_version, snapshot_checksum, snapshot_schema,
       applied_count, updated_at
     ) VALUES (?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(name) DO UPDATE SET
       cursor_value = excluded.cursor_value,
       snapshot_version = excluded.snapshot_version,
       snapshot_checksum = excluded.snapshot_checksum,
       snapshot_schema = excluded.snapshot_schema,
       applied_count = 0,
       updated_at = excluded.updated_at`,
  ).run(
    name,
    params.cursorValue,
    params.snapshotVersion,
    params.snapshotChecksum,
    params.snapshotSchema,
    now,
  );
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export function recordMetric(
  db: Database,
  metric: string,
  value: number,
  detail?: string,
  now = Date.now(),
): void {
  db.query(
    `INSERT INTO runtime_metric (metric, value, detail, recorded_at) VALUES (?, ?, ?, ?)`,
  ).run(metric, value, detail ?? null, now);
}

// Retention for the metric samples. Metrics are diagnostics, not business facts,
// so unlike the event store they are safe to prune unconditionally.
export function pruneMetrics(db: Database, olderThanMs: number, now = Date.now()): number {
  const cutoff = now - olderThanMs;
  const result = db.query("DELETE FROM runtime_metric WHERE recorded_at < ?").run(cutoff);
  return result.changes ?? 0;
}

export interface MetricSummary {
  metric: string;
  count: number;
  last: number;
  min: number;
  max: number;
  avg: number;
  lastAt: number;
}

export function summarizeMetrics(
  db: Database,
  sinceMs: number,
  now = Date.now(),
): MetricSummary[] {
  const since = now - sinceMs;
  const rows = db
    .query(
      `SELECT metric,
              COUNT(*) AS count,
              MIN(value) AS min,
              MAX(value) AS max,
              AVG(value) AS avg,
              MAX(recorded_at) AS last_at
       FROM runtime_metric
       WHERE recorded_at >= ?
       GROUP BY metric
       ORDER BY metric`,
    )
    .all(since) as Array<{
    metric: string;
    count: number;
    min: number;
    max: number;
    avg: number;
    last_at: number;
  }>;

  return rows.map((row) => {
    const lastRow = db
      .query(
        `SELECT value FROM runtime_metric WHERE metric = ? AND recorded_at = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(row.metric, row.last_at) as { value: number } | null;

    return {
      metric: row.metric,
      count: row.count,
      last: lastRow?.value ?? 0,
      min: row.min,
      max: row.max,
      avg: row.avg,
      lastAt: row.last_at,
    };
  });
}
