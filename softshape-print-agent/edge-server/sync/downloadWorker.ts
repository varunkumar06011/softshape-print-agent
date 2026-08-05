// ─────────────────────────────────────────────────────────────────────────────
// sync/downloadWorker.ts — Runtime v2 cursor-based cloud change applier
// ─────────────────────────────────────────────────────────────────────────────
// Downloads cloud-originated configuration events after the durable local cursor
// and applies them through inboundApplier. It never performs a full-table refresh.
//
// The cursor is advanced only by inboundApplier, in the same SQLite transaction
// that appends/applies/dead-letters each event. A transient failure stops the
// page immediately; later events are not skipped.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from "../db.ts";
import { getBackendUrl, getSessionToken, getRestaurantId } from "../auth.ts";
import { cloudFetch } from "../cloudFetch.ts";
import { runtimeLog } from "../contract/logger.ts";
import { RUNTIME_ERROR_CODES, RuntimeError } from "../contract/errors.ts";
import { getDownloadCursor, needsBootstrap } from "../core/checkpoints.ts";
import { applyInboundBatch } from "../core/inboundApplier.ts";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;

let running = false;

export interface DownloadWorkerOptions {
  pageSize?: number;
}

export interface DownloadSummary {
  ok: boolean;
  cursorBefore: string | null;
  cursorAfter: string | null;
  received: number;
  applied: number;
  duplicates: number;
  deadLettered: number;
  stoppedEarly: boolean;
  error?: string;
}

export function getDownloadWorkerState(): { running: boolean } {
  return { running };
}

export async function downloadCloudChanges(options: DownloadWorkerOptions = {}): Promise<DownloadSummary> {
  if (running) {
    const cursor = getDownloadCursor(getDb());
    return {
      ok: true,
      cursorBefore: cursor,
      cursorAfter: cursor,
      received: 0,
      applied: 0,
      duplicates: 0,
      deadLettered: 0,
      stoppedEarly: false,
    };
  }

  running = true;
  const db = getDb();
  const cursorBefore = getDownloadCursor(db);
  const pageSize = Math.min(Math.max(options.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  // Bootstrap is a hard gate: until a verified snapshot has been promoted and
  // the cursor established, incremental download must not run. Fetching cloud
  // changes from cursor "0" before the snapshot is applied would either project
  // events into an empty read model (wrong state) or race with the bootstrap
  // transaction. The scheduler retries on its next tick once bootstrap completes.
  if (needsBootstrap(db)) {
    runtimeLog.info("Runtime v2 download skipped — bootstrap required before incremental sync", {
      cursorBefore,
    });
    return {
      ok: true,
      cursorBefore,
      cursorAfter: cursorBefore,
      received: 0,
      applied: 0,
      duplicates: 0,
      deadLettered: 0,
      stoppedEarly: false,
    };
  }

  try {
    const backendUrl = getBackendUrl();
    const token = getSessionToken();
    const restaurantId = getRestaurantId();
    if (!backendUrl || !token || !restaurantId) {
      throw new RuntimeError(RUNTIME_ERROR_CODES.CLOUD_UNAVAILABLE, "Runtime cloud session is unavailable");
    }

    // needsBootstrap gate above guarantees cursorBefore is non-null here.
    const cursor = cursorBefore as string;
    const response = await cloudFetch(
      `${backendUrl}/api/edge/runtime/v2/events/changes?cursor=${encodeURIComponent(cursor)}&limit=${pageSize}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30_000,
        retries: 0,
      },
    );

    if (!response.ok) {
      throw new RuntimeError(
        response.status === 401 || response.status === 403
          ? RUNTIME_ERROR_CODES.UNAUTHENTICATED
          : RUNTIME_ERROR_CODES.CLOUD_UNAVAILABLE,
        `Cloud changes request failed with HTTP ${response.status}`,
      );
    }

    const body = await response.json() as {
      events?: unknown[];
      nextCursor?: string;
      hasMore?: boolean;
    };
    if (!Array.isArray(body.events) || typeof body.nextCursor !== "string") {
      throw new RuntimeError(RUNTIME_ERROR_CODES.MALFORMED_PAYLOAD, "Cloud changes response has an invalid shape");
    }

    const items = body.events.map((event: any) => ({
      raw: event,
      cursorValue: typeof event.cloudSequence === "string"
        ? event.cloudSequence
        : String(event.cloudSequence ?? body.nextCursor),
    }));
    const applied = applyInboundBatch(db, items, restaurantId);
    const cursorAfter = getDownloadCursor(db);

    // If the server says there are more rows but the applier stopped, the next
    // scheduler cycle resumes from the last committed event. Never advance to
    // body.nextCursor speculatively.
    const summary: DownloadSummary = {
      ok: !applied.stoppedEarly,
      cursorBefore,
      cursorAfter,
      received: body.events.length,
      applied: applied.applied,
      duplicates: applied.duplicates,
      deadLettered: applied.deadLettered,
      stoppedEarly: applied.stoppedEarly,
      ...(applied.stoppedEarly ? { error: "Inbound event application deferred" } : {}),
    };

    runtimeLog.info("Runtime v2 cloud changes applied", {
      received: summary.received,
      applied: summary.applied,
      duplicates: summary.duplicates,
      deadLettered: summary.deadLettered,
      stoppedEarly: summary.stoppedEarly,
      cursorBefore,
      cursorAfter,
    });
    return summary;
  } catch (error) {
    const runtimeError = error instanceof RuntimeError
      ? error
      : new RuntimeError(RUNTIME_ERROR_CODES.CLOUD_UNAVAILABLE, error instanceof Error ? error.message : String(error));
    runtimeLog.warn("Runtime v2 cloud changes failed", {
      code: runtimeError.code,
      error: runtimeError.message,
      cursor: cursorBefore,
    });
    return {
      ok: false,
      cursorBefore,
      cursorAfter: getDownloadCursor(db),
      received: 0,
      applied: 0,
      duplicates: 0,
      deadLettered: 0,
      stoppedEarly: false,
      error: runtimeError.message,
    };
  } finally {
    running = false;
  }
}
