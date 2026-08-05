// ─────────────────────────────────────────────────────────────────────────────
// sync/uploadWorker.ts — Runtime v2 immutable event uploader
// ─────────────────────────────────────────────────────────────────────────────
// Uploads event envelopes only. It never reads or serializes operational tables.
//
// A batch is single-flight and per-event acknowledged:
//   applied/duplicate → delivered
//   rejected           → outbound DLQ
//   retry/transport    → pending with backoff
//
// A transport failure marks no event delivered. Repeating the batch is safe
// because the cloud deduplicates by eventId.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from "../db.ts";
import { getBackendUrl, getSessionToken, getRestaurantId } from "../auth.ts";
import { cloudFetch } from "../cloudFetch.ts";
import type { EventIngestResponse, EventIngestResult, StoredOperationalEvent } from "../contract/operationalEvents.ts";
import {
  markDeliveryDeadLetter,
  markDelivered,
  markDeliveryInFlight,
  markDeliveryRetry,
  readPendingDeliveries,
  reclaimExpiredLeases,
} from "../core/eventStore.ts";
import { recordDlqEntry } from "../core/dlq.ts";
import { recordMetric } from "../core/checkpoints.ts";

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 100;
const LEASE_MS = 60_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 30 * 60_000;

let running = false;

export interface UploadWorkerOptions {
  batchSize?: number;
  now?: () => number;
}

export interface UploadSummary {
  ok: boolean;
  selected: number;
  delivered: number;
  duplicates: number;
  rejected: number;
  retried: number;
  error?: string;
  durationMs: number;
}

export function getUploadWorkerState(): { running: boolean } {
  return { running };
}

export async function uploadPendingEvents(options: UploadWorkerOptions = {}): Promise<UploadSummary> {
  const startedAt = Date.now();
  if (running) {
    return {
      ok: true,
      selected: 0,
      delivered: 0,
      duplicates: 0,
      rejected: 0,
      retried: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  running = true;
  const now = options.now ?? Date.now;
  const db = getDb();
  const batchSize = Math.min(Math.max(options.batchSize ?? DEFAULT_BATCH_SIZE, 1), MAX_BATCH_SIZE);
  let selectedEvents: StoredOperationalEvent[] = [];

  try {
    reclaimExpiredLeases(db, now());
    const deliveries = readPendingDeliveries(db, batchSize, now());
    if (deliveries.length === 0) {
      return {
        ok: true,
        selected: 0,
        delivered: 0,
        duplicates: 0,
        rejected: 0,
        retried: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    const events = deliveries.map((delivery) => delivery.event);
    selectedEvents = events;
    const eventIds = events.map((event) => event.eventId);
    markDeliveryInFlight(db, eventIds, now() + LEASE_MS, now());

    const backendUrl = getBackendUrl();
    const token = getSessionToken();
    const restaurantId = getRestaurantId();
    if (!backendUrl || !token || !restaurantId) {
      const message = "Runtime cloud session is unavailable";
      const retried = retryEvents(db, events, message, now);
      return summaryWithError(events.length, retried, message, startedAt);
    }

    const response = await cloudFetch(`${backendUrl}/api/edge/runtime/v2/events/ingest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ restaurantId, events: events.map(toWireEvent) }),
      timeout: LEASE_MS,
      retries: 0,
    });

    if (!response.ok) {
      const message = await readHttpError(response);
      // Auth/validation failures are permanent for this batch as submitted. Put
      // every event in DLQ rather than retrying a poison payload forever.
      if (response.status >= 400 && response.status < 500) {
        const rejected = deadLetterEvents(db, events, message, `HTTP_${response.status}`, now());
        return {
          ok: false,
          selected: events.length,
          delivered: 0,
          duplicates: 0,
          rejected,
          retried: 0,
          error: message,
          durationMs: Date.now() - startedAt,
        };
      }
      const retried = retryEvents(db, events, message, now);
      return summaryWithError(events.length, retried, message, startedAt);
    }

    const body = await response.json() as EventIngestResponse;
    return applyOutcomes(db, events, body?.results, now, startedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The request may have committed at cloud even if the response was lost;
    // retry is safe because the cloud's eventId unique key returns duplicates.
    const retried = retryEvents(db, selectedEvents, message, now);
    return summaryWithError(selectedEvents.length, retried, message, startedAt);
  } finally {
    running = false;
  }
}

function toWireEvent(event: StoredOperationalEvent): Record<string, unknown> {
  return {
    eventId: event.eventId,
    envelopeVersion: event.envelopeVersion,
    schemaVersion: event.schemaVersion,
    restaurantId: event.restaurantId,
    runtimeId: event.runtimeId,
    origin: event.origin,
    aggregate: event.aggregate,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    actorId: event.actorId,
    actorRole: event.actorRole,
    requestId: event.requestId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    occurredAt: event.occurredAt,
    payload: event.payload,
  };
}

function applyOutcomes(
  db: ReturnType<typeof getDb>,
  events: StoredOperationalEvent[],
  outcomes: EventIngestResult[] | undefined,
  now: () => number,
  startedAt: number,
): UploadSummary {
  const byId = new Map((outcomes ?? []).map((outcome) => [outcome.eventId, outcome]));
  let delivered = 0;
  let duplicates = 0;
  let rejected = 0;
  let retried = 0;

  for (const event of events) {
    const outcome = byId.get(event.eventId);
    if (!outcome) {
      // A successful HTTP response that omits an event is not an ACK. Keep it
      // retryable; never infer success from a batch-level 200.
      retried += retryOne(db, event, "Cloud response omitted event outcome", now());
      continue;
    }

    if (outcome.outcome === "applied") {
      markDelivered(db, event.eventId, outcome.cloudSeq ? Number(outcome.cloudSeq) : null, now());
      delivered++;
    } else if (outcome.outcome === "duplicate") {
      markDelivered(db, event.eventId, outcome.cloudSeq ? Number(outcome.cloudSeq) : null, now());
      duplicates++;
    } else if (outcome.outcome === "rejected") {
      deadLetterOne(db, event, outcome.message ?? "Cloud rejected event", outcome.code ?? "REJECTED", now());
      rejected++;
    } else {
      retried += retryOne(db, event, outcome.message ?? "Cloud requested retry", now());
    }
  }

  const summary: UploadSummary = {
    ok: retried === 0 && rejected === 0,
    selected: events.length,
    delivered,
    duplicates,
    rejected,
    retried,
    durationMs: Date.now() - startedAt,
  };
  recordMetric(db, "runtime.upload.batch_size", events.length, undefined, now());
  recordMetric(db, "runtime.upload.delivered", delivered, undefined, now());
  recordMetric(db, "runtime.upload.rejected", rejected, undefined, now());
  recordMetric(db, "runtime.upload.duration_ms", summary.durationMs, undefined, now());
  return summary;
}

function retryEvents(db: ReturnType<typeof getDb>, events: StoredOperationalEvent[], error: string, now: () => number): number {
  let retried = 0;
  for (const event of events) retried += retryOne(db, event, error, now());
  return retried;
}

function retryOne(db: ReturnType<typeof getDb>, event: StoredOperationalEvent, error: string, now: number): number {
  const row = db.query("SELECT attempts FROM event_delivery WHERE event_id = ?").get(event.eventId) as { attempts: number } | null;
  const attempts = row?.attempts ?? 1;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), BACKOFF_MAX_MS);
  markDeliveryRetry(db, event.eventId, error.slice(0, 1000), "TRANSIENT", now + delay, now);
  return 1;
}

function deadLetterEvents(db: ReturnType<typeof getDb>, events: StoredOperationalEvent[], error: string, code: string, now: number): number {
  for (const event of events) deadLetterOne(db, event, error, code, now);
  return events.length;
}

function deadLetterOne(db: ReturnType<typeof getDb>, event: StoredOperationalEvent, error: string, code: string, now: number): void {
  recordDlqEntry(db, {
    kind: "outbound_event",
    eventId: event.eventId,
    eventSeq: event.seq,
    restaurantId: event.restaurantId,
    aggregate: event.aggregate,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    requestId: event.requestId,
    reasonCode: code,
    reason: error.slice(0, 2000),
    failureClass: "PERMANENT",
    payload: toWireEvent(event),
    occurredAt: event.occurredAt,
    attempts: 1,
  });
  markDeliveryDeadLetter(db, event.eventId, error.slice(0, 1000), "PERMANENT", now);
}

function summaryWithError(selected: number, retried: number, error: string, startedAt: number): UploadSummary {
  return {
    ok: false,
    selected,
    delivered: 0,
    duplicates: 0,
    rejected: 0,
    retried,
    error,
    durationMs: Date.now() - startedAt,
  };
}

async function readHttpError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string; message?: string };
    return body.error ?? body.message ?? `Cloud returned HTTP ${response.status}`;
  } catch {
    return `Cloud returned HTTP ${response.status}`;
  }
}
