// ─────────────────────────────────────────────────────────────────────────────
// core/schema.ts — Runtime v2 persistence schema (Operational Event Store)
// ─────────────────────────────────────────────────────────────────────────────
// All statements are idempotent (CREATE ... IF NOT EXISTS) so this runs safely
// on both a fresh database and an in-place migration from an older schema.
//
// Design:
//   event_store       — append-only immutable business facts. `seq` is the local
//                       total order. Enforced append-only by triggers, not by
//                       convention.
//   event_delivery    — MUTABLE upload state, kept out of the immutable event so
//                       retries never rewrite history. One row per outbound
//                       (runtime-origin) event.
//   inbound_event     — dedupe log for cloud-originated events, so a redelivered
//                       event is a cheap no-op instead of a double-apply.
//   sync_checkpoint   — durable cursors (cloud download position, snapshot
//                       identity/checksum). Advanced in the same transaction
//                       that applies the inbound event.
//   projection_state  — how far each projection has consumed the event store.
//                       Used by rebuild tooling and projection-lag metrics.
//   runtime_dlq       — poison events/commands with full audit context.
//   runtime_metric    — time-series counters/gauges for /runtime/status.
//
// Deliberately NOT here: operational projections (order_record, "table", etc.)
// already exist in db.ts and are reused as the read model.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";

export function initRuntimeV2Schema(database: Database): void {
  database.exec(`
    -- ── Operational Event Store (append-only) ────────────────────────────────
    CREATE TABLE IF NOT EXISTS event_store (
      seq               INTEGER PRIMARY KEY AUTOINCREMENT,  -- local total order
      event_id          TEXT NOT NULL UNIQUE,               -- global identity
      envelope_version  INTEGER NOT NULL DEFAULT 1,
      schema_version    INTEGER NOT NULL DEFAULT 1,
      restaurant_id     TEXT NOT NULL,
      runtime_id        TEXT,
      origin            TEXT NOT NULL,                      -- 'runtime' | 'cloud'
      aggregate         TEXT NOT NULL,
      aggregate_id      TEXT NOT NULL,
      aggregate_seq     INTEGER,                            -- per-aggregate order
      event_type        TEXT NOT NULL,
      actor_id          TEXT,
      actor_role        TEXT,
      request_id        TEXT,
      correlation_id    TEXT,
      causation_id      TEXT,
      payload           TEXT NOT NULL,                      -- JSON object
      occurred_at       INTEGER NOT NULL,                   -- informational
      recorded_at       INTEGER NOT NULL                    -- local commit time
    );
    CREATE INDEX IF NOT EXISTS idx_event_store_aggregate
      ON event_store(aggregate, aggregate_id, seq);
    CREATE INDEX IF NOT EXISTS idx_event_store_restaurant
      ON event_store(restaurant_id, seq);
    CREATE INDEX IF NOT EXISTS idx_event_store_type ON event_store(event_type, seq);
    CREATE INDEX IF NOT EXISTS idx_event_store_request ON event_store(request_id)
      WHERE request_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_event_store_aggregate_seq
      ON event_store(aggregate, aggregate_id, aggregate_seq)
      WHERE aggregate_seq IS NOT NULL;

    -- Append-only enforcement. Business facts are never edited: any correction
    -- is a new compensating event. This makes immutability a database
    -- guarantee rather than a code review rule.
    CREATE TRIGGER IF NOT EXISTS trg_event_store_no_update
      BEFORE UPDATE ON event_store
    BEGIN
      SELECT RAISE(ABORT, 'event_store is append-only: events cannot be updated');
    END;

    -- The event store is immutable for its entire lifetime. Events are never
    -- deleted, including delivered events. Archive/retention operations may
    -- copy verified ranges to external durable storage and record a manifest,
    -- but there is no local deletion API and this trigger rejects raw SQL
    -- deletes as well. Compaction applies only to derived metrics/state tables.
    DROP TRIGGER IF EXISTS trg_event_store_delete_guard;
    CREATE TRIGGER IF NOT EXISTS trg_event_store_no_delete
      BEFORE DELETE ON event_store
    BEGIN
      SELECT RAISE(ABORT, 'event_store is append-only: events cannot be deleted');
    END;

    -- Operator-visible policy/manifest metadata. The event rows remain local;
    -- an archive manifest is evidence of an external copy, not permission to
    -- remove the source history.
    CREATE TABLE IF NOT EXISTS event_retention_policy (
      name              TEXT PRIMARY KEY,
      retention_days    INTEGER NOT NULL,
      archive_required  INTEGER NOT NULL DEFAULT 1,
      updated_at        INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_archive_manifest (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      first_seq         INTEGER NOT NULL,
      last_seq          INTEGER NOT NULL,
      event_count       INTEGER NOT NULL,
      archive_uri       TEXT NOT NULL,
      archive_checksum  TEXT NOT NULL,
      archived_at       INTEGER NOT NULL,
      verified_at       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_event_archive_manifest_range
      ON event_archive_manifest(first_seq, last_seq);

    -- ── Outbound delivery state (mutable) ────────────────────────────────────
    CREATE TABLE IF NOT EXISTS event_delivery (
      event_seq         INTEGER PRIMARY KEY,
      event_id          TEXT NOT NULL UNIQUE,
      status            TEXT NOT NULL DEFAULT 'pending',  -- pending|in_flight|delivered|dead_letter
      attempts          INTEGER NOT NULL DEFAULT 0,
      next_attempt_at   INTEGER,
      last_error        TEXT,
      last_error_class  TEXT,                             -- PERMANENT|TRANSIENT|UNKNOWN
      lease_until       INTEGER,
      cloud_seq         INTEGER,
      delivered_at      INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      FOREIGN KEY (event_seq) REFERENCES event_store(seq)
    );
    -- Partial index: the upload worker only ever scans undelivered work.
    CREATE INDEX IF NOT EXISTS idx_event_delivery_pending
      ON event_delivery(next_attempt_at, event_seq)
      WHERE status IN ('pending', 'in_flight');
    CREATE INDEX IF NOT EXISTS idx_event_delivery_status ON event_delivery(status);

    -- ── Inbound dedupe log (cloud → runtime) ─────────────────────────────────
    CREATE TABLE IF NOT EXISTS inbound_event (
      event_id          TEXT PRIMARY KEY,
      event_type        TEXT NOT NULL,
      aggregate         TEXT NOT NULL,
      aggregate_id      TEXT NOT NULL,
      cursor_value      TEXT,
      outcome           TEXT NOT NULL,          -- applied|duplicate|rejected
      applied_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbound_event_applied ON inbound_event(applied_at);

    -- ── Durable checkpoints ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sync_checkpoint (
      name              TEXT PRIMARY KEY,       -- e.g. 'cloud_download'
      cursor_value      TEXT,
      last_event_id     TEXT,
      snapshot_version  TEXT,
      snapshot_checksum TEXT,
      snapshot_schema   INTEGER,
      applied_count     INTEGER NOT NULL DEFAULT 0,
      updated_at        INTEGER NOT NULL
    );

    -- ── Projection state ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS projection_state (
      name              TEXT PRIMARY KEY,
      last_event_seq    INTEGER NOT NULL DEFAULT 0,
      rebuilt_at        INTEGER,
      updated_at        INTEGER NOT NULL
    );

    -- ── Dead Letter Queue ───────────────────────────────────────────────────
    -- Nothing is ever silently dropped: permanent failures land here with the
    -- full payload so an operator can inspect, resolve, or replay them.
    CREATE TABLE IF NOT EXISTS runtime_dlq (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      kind              TEXT NOT NULL,          -- outbound_event|inbound_event|command
      event_id          TEXT,
      event_seq         INTEGER,
      restaurant_id     TEXT,
      aggregate         TEXT,
      aggregate_id      TEXT,
      event_type        TEXT,
      command_type      TEXT,
      request_id        TEXT,
      reason_code       TEXT NOT NULL,
      reason            TEXT,
      failure_class     TEXT,
      payload           TEXT,                   -- JSON snapshot for inspection
      cursor_value      TEXT,
      attempts          INTEGER NOT NULL DEFAULT 0,
      occurred_at       INTEGER,
      created_at        INTEGER NOT NULL,
      resolved          INTEGER NOT NULL DEFAULT 0,
      resolved_at       INTEGER,
      resolved_by       TEXT,
      resolution        TEXT                    -- replayed|discarded|fixed
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_dlq_unresolved
      ON runtime_dlq(created_at) WHERE resolved = 0;
    CREATE INDEX IF NOT EXISTS idx_runtime_dlq_kind ON runtime_dlq(kind, created_at);
    CREATE INDEX IF NOT EXISTS idx_runtime_dlq_event ON runtime_dlq(event_id)
      WHERE event_id IS NOT NULL;

    -- ── Metrics ─────────────────────────────────────────────────────────────
    -- Append-only samples, pruned by retention. Kept generic so adding a metric
    -- does not require a migration.
    CREATE TABLE IF NOT EXISTS runtime_metric (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      metric            TEXT NOT NULL,
      value             REAL NOT NULL,
      detail            TEXT,
      recorded_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_metric_name
      ON runtime_metric(metric, recorded_at);

    -- ══ Milestone 2: Restaurant Transaction Pipeline read model ══════════════
    -- These tables are the v2 read model for orders, KOTs, and bills. They are
    -- updated atomically with events by projection handlers, never written to
    -- directly by command handlers or the API layer. The v1 tables (order_record,
    -- order_item, kot, kot_item, bill) remain for compatibility during migration.

    -- v2 orders
    CREATE TABLE IF NOT EXISTS v2_order (
      id              TEXT PRIMARY KEY,
      restaurant_id   TEXT NOT NULL,
      table_id        TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'OPEN',   -- OPEN|BILLED|VOIDED
      total_amount    REAL NOT NULL DEFAULT 0,
      captain_id      TEXT,
      platform        TEXT NOT NULL DEFAULT 'DINE_IN',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      revision        INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_v2_order_restaurant_status ON v2_order(restaurant_id, status);
    CREATE INDEX IF NOT EXISTS idx_v2_order_table ON v2_order(table_id, status);

    -- v2 order items
    CREATE TABLE IF NOT EXISTS v2_order_item (
      id              TEXT PRIMARY KEY,
      order_id        TEXT NOT NULL,
      menu_item_id    TEXT NOT NULL,
      name            TEXT NOT NULL,
      price           REAL NOT NULL,
      quantity        INTEGER NOT NULL DEFAULT 0,
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE|CANCELLED
      kot_id          TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES v2_order(id)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_order_item_order ON v2_order_item(order_id);
    CREATE INDEX IF NOT EXISTS idx_v2_order_item_status ON v2_order_item(order_id, status);

    -- v2 KOTs (Kitchen Order Tickets)
    CREATE TABLE IF NOT EXISTS v2_kot (
      id              TEXT PRIMARY KEY,
      restaurant_id   TEXT NOT NULL,
      table_id        TEXT NOT NULL,
      order_id        TEXT NOT NULL,
      kot_number      INTEGER NOT NULL,
      counter_date    TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'SENT',    -- SENT|CANCELLED
      created_at      INTEGER NOT NULL,
      cancelled_at    INTEGER,
      FOREIGN KEY (order_id) REFERENCES v2_order(id)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_kot_restaurant_order ON v2_kot(restaurant_id, order_id);
    CREATE INDEX IF NOT EXISTS idx_v2_kot_restaurant_date ON v2_kot(restaurant_id, counter_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_kot_number_date
      ON v2_kot(restaurant_id, kot_number, counter_date);

    -- v2 KOT items
    CREATE TABLE IF NOT EXISTS v2_kot_item (
      id              TEXT PRIMARY KEY,
      kot_id          TEXT NOT NULL,
      order_item_id   TEXT NOT NULL,
      menu_item_id    TEXT NOT NULL,
      name            TEXT NOT NULL,
      quantity        INTEGER NOT NULL,
      price           REAL NOT NULL,
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'SENT',    -- SENT|CANCELLED
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (kot_id) REFERENCES v2_kot(id)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_kot_item_kot ON v2_kot_item(kot_id);

    -- v2 bills (no payment — Milestone 3)
    CREATE TABLE IF NOT EXISTS v2_bill (
      id              TEXT PRIMARY KEY,
      restaurant_id   TEXT NOT NULL,
      order_id        TEXT NOT NULL,
      bill_number     INTEGER NOT NULL,
      counter_date    TEXT NOT NULL,
      subtotal        REAL NOT NULL DEFAULT 0,
      tax_amount      REAL NOT NULL DEFAULT 0,
      service_charge  REAL NOT NULL DEFAULT 0,
      total_amount    REAL NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'GENERATED', -- GENERATED (no payment yet)
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES v2_order(id)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_bill_restaurant_order ON v2_bill(restaurant_id, order_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_bill_number_date
      ON v2_bill(restaurant_id, bill_number, counter_date);

    -- ── Shadow Comparison Log (M2.5) ────────────────────────────────────────
    -- Stores V1 vs V2 comparison results during shadow integration.
    -- Queried by /runtime/v2/shadow/* endpoints for the Shadow Dashboard.
    -- Temporary: drop after V1 cutover.
    CREATE TABLE IF NOT EXISTS runtime_shadow_comparison (
      id              TEXT PRIMARY KEY,
      operation       TEXT NOT NULL,          -- createOrder|addOrderItems|cancelOrderItem|sendKot|generateBill
      v1_request_id   TEXT NOT NULL,
      v2_request_id   TEXT NOT NULL,
      v1_entity_id    TEXT,
      v2_entity_id    TEXT,
      match           INTEGER NOT NULL,       -- 1 = match, 0 = mismatch
      mismatches      TEXT,                   -- JSON array of mismatch strings
      v1_duration_ms  INTEGER,
      v2_duration_ms  INTEGER,
      v1_result       TEXT,                   -- JSON
      v2_result       TEXT,                   -- JSON
      created_at      INTEGER NOT NULL,
      -- M2.6A: rich context for self-contained bug reports
      runtime_version   TEXT,
      cashier_version   TEXT,
      restaurant_id     TEXT,
      runtime_id        TEXT,
      command           TEXT,
      correlation_id    TEXT,
      event_ids         TEXT,                 -- JSON array
      sqlite_hash       TEXT,
      cloud_hash        TEXT,
      primary_engine    TEXT DEFAULT 'v1',
      runtime_uptime_ms INTEGER,
      shadow_duration_ms INTEGER,
      shadow_session_id TEXT,
      comparison_schema_version INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_match ON runtime_shadow_comparison(match);
    CREATE INDEX IF NOT EXISTS idx_shadow_operation ON runtime_shadow_comparison(operation);
    CREATE INDEX IF NOT EXISTS idx_shadow_created ON runtime_shadow_comparison(created_at);
  `);
}

// ── Checkpoint names ─────────────────────────────────────────────────────────

export const CHECKPOINT_CLOUD_DOWNLOAD = "cloud_download";

// ── Delivery status ──────────────────────────────────────────────────────────

export type DeliveryStatus = "pending" | "in_flight" | "delivered" | "dead_letter";

// ── DLQ kinds ────────────────────────────────────────────────────────────────

export type DlqKind = "outbound_event" | "inbound_event" | "command";
