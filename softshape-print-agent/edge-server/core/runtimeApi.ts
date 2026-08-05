// ─────────────────────────────────────────────────────────────────────────────
// core/runtimeApi.ts — Runtime v2 HTTP boundary
// ─────────────────────────────────────────────────────────────────────────────
// This module owns only the v2 transport boundary. Business logic stays in the
// command bus/projections; this file authenticates, validates the envelope, and
// maps stable Runtime results to HTTP responses.
//
// Auth perimeter is declarative in contract/lanAuth.ts. Routes not declared
// there are denied. The only public route is a minimal ping for discovery.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from "../db.ts";
import {
  getDeviceId,
  getRestaurantId,
  isLocalReady,
  isSessionValid,
} from "../auth.ts";
import {
  getRuntimeToken,
  validateRuntimeToken,
  validateStaffToken,
  staffHasPermission,
} from "../contract/auth.ts";
import {
  classifyRoute,
  isRuntimeV2Path,
  roleMeetsMinimum,
  type RouteAuthSpec,
} from "../contract/lanAuth.ts";
import {
  RUNTIME_ERROR_CODES,
  errorHttpStatus,
  toErrorResponse,
  RuntimeError,
} from "../contract/errors.ts";
import {
  executeCommand,
  getRegisteredCommands,
  type CommandContext,
} from "./commandBus.ts";
import { getDeliveryStats } from "./eventStore.ts";
import {
  countUnresolvedDlq,
  countUnresolvedDlqByKind,
  listDlqEntries,
  resolveDlqEntry,
} from "./dlq.ts";
import { getCheckpoint, summarizeMetrics } from "./checkpoints.ts";
import { getMaxProjectionLag, getProjectionStatus, rebuildProjections } from "./projections.ts";
import { CHECKPOINT_CLOUD_DOWNLOAD, type DlqKind } from "./schema.ts";
import { getSyncV2SchedulerStatus } from "../sync/scheduler.ts";
import { handleOrderQuery } from "../handlers/queries.ts";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Staff-Token",
  "Access-Control-Allow-Private-Network": "true",
};

const MAX_BODY_BYTES = 256 * 1024;

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function errorResponse(error: unknown, fallbackStatus = 500): Response {
  const envelope = toErrorResponse(error);
  return response(envelope, errorHttpStatus(envelope.code) || fallbackStatus);
}

export async function handleRuntimeV2Request(req: Request, url: URL): Promise<Response> {
  if (!isRuntimeV2Path(url.pathname)) return response({ error: "Not found" }, 404);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });

  const spec = classifyRoute(url.pathname, req.method);
  if (!spec) {
    return errorResponse(
      new RuntimeError(
        RUNTIME_ERROR_CODES.FORBIDDEN,
        "Runtime v2 route is not declared in the authentication perimeter",
        { path: url.pathname, method: req.method },
      ),
    );
  }

  if (spec.authClass === "PUBLIC") {
    return handlePublicRoute(url, spec);
  }

  if (!isLocalReady()) {
    return errorResponse(
      new RuntimeError(RUNTIME_ERROR_CODES.RUNTIME_NOT_READY, "Runtime is not linked and ready"),
    );
  }

  const authError = authorize(req, spec);
  if (authError) return authError;

  try {
    if (url.pathname === "/runtime/v2/status" && req.method === "GET") {
      return response(buildStatus());
    }

    if (url.pathname === "/runtime/v2/health" && req.method === "GET") {
      return response(buildHealth());
    }

    if (url.pathname === "/runtime/v2/metrics" && req.method === "GET") {
      return response({ ok: true, metrics: summarizeMetrics(getDb(), 60 * 60 * 1000) });
    }

    if (url.pathname === "/runtime/v2/commands" && req.method === "POST") {
      return await handleCommand(req);
    }

    if (url.pathname.startsWith("/runtime/v2/queries/") && req.method === "GET") {
      return handleQuery(url);
    }

    if (url.pathname === "/runtime/v2/dlq" && req.method === "GET") {
      const kindValue = url.searchParams.get("kind");
      const kind = kindValue && ["outbound_event", "inbound_event", "command"].includes(kindValue)
        ? kindValue as DlqKind
        : undefined;
      const includeResolved = url.searchParams.get("includeResolved") === "true";
      const limit = parseBoundedInteger(url.searchParams.get("limit"), 100, 1, 1000);
      const offset = parseBoundedInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
      return response({
        entries: listDlqEntries(getDb(), { kind: kind || undefined, includeResolved, limit, offset }),
      });
    }

    if (url.pathname === "/runtime/v2/dlq/resolve" && req.method === "POST") {
      const body = await readJson(req);
      const id = requirePositiveInteger(body.id, "id");
      const resolution = body.resolution;
      if (!["replayed", "discarded", "fixed"].includes(resolution)) {
        throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "resolution must be replayed, discarded, or fixed");
      }
      const staff = validateStaffToken(req.headers.get("X-Staff-Token"));
      const changed = resolveDlqEntry(getDb(), id, resolution, staff?.userId ?? "unknown");
      if (!changed) return response({ ok: false, error: "DLQ entry not found or already resolved" }, 404);
      return response({ ok: true, id, resolution });
    }

    if (url.pathname === "/runtime/v2/projections/rebuild" && req.method === "POST") {
      const db = getDb();
      const result = rebuildProjections(db, { clearTables: true });
      return response({ ok: true, result });
    }

    // ── Shadow Comparison (M2.5) ──────────────────────────────────────────────
    if (url.pathname === "/runtime/v2/shadow/log" && req.method === "POST") {
      return await handleShadowLog(req);
    }

    if (url.pathname === "/runtime/v2/shadow/stats" && req.method === "GET") {
      return response(buildShadowStats());
    }

    if (url.pathname === "/runtime/v2/shadow/mismatches" && req.method === "GET") {
      const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, 1, 500);
      return response({ mismatches: listShadowMismatches(getDb(), limit) });
    }

    // ── M2.6A: Release Status & Export ──────────────────────────────────────
    if (url.pathname === "/runtime/v2/release-status" && req.method === "GET") {
      return response(buildReleaseStatus());
    }

    if (url.pathname === "/runtime/v2/shadow/export" && req.method === "GET") {
      const limit = parseBoundedInteger(url.searchParams.get("limit"), 1000, 1, 10000);
      return response(exportShadowMismatches(getDb(), limit));
    }

    // Per-session export: /runtime/v2/shadow/export/:sessionId
    const exportMatch = url.pathname.match(/^\/runtime\/v2\/shadow\/export\/(.+)$/);
    if (exportMatch && req.method === "GET") {
      const sessionId = decodeURIComponent(exportMatch[1]);
      const limit = parseBoundedInteger(url.searchParams.get("limit"), 10000, 1, 50000);
      return response(exportShadowMismatchesBySession(getDb(), sessionId, limit));
    }

    return response({ error: "Not found" }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}

function handlePublicRoute(url: URL, spec: RouteAuthSpec): Response {
  if (url.pathname === "/runtime/v2/ping" && spec.authClass === "PUBLIC") {
    return response({
      ok: true,
      apiVersion: 2,
      runtimeState: isLocalReady() ? "READY" : "BOOTING",
    });
  }
  return response({ error: "Not found" }, 404);
}

function authorize(req: Request, spec: RouteAuthSpec): Response | null {
  if (spec.authClass === "RUNTIME_TOKEN") {
    if (!validateRuntimeToken(req.headers.get("Authorization"))) {
      return errorResponse(new RuntimeError(RUNTIME_ERROR_CODES.UNAUTHENTICATED, "Missing or invalid runtime token"));
    }
    return null;
  }

  if (spec.authClass === "STAFF_TOKEN") {
    const staff = validateStaffToken(req.headers.get("X-Staff-Token"));
    if (!staff) {
      return errorResponse(new RuntimeError(RUNTIME_ERROR_CODES.UNAUTHENTICATED, "Staff token required"));
    }
    if (spec.minRole && !roleMeetsMinimum(staff.role, spec.minRole)) {
      return errorResponse(new RuntimeError(RUNTIME_ERROR_CODES.FORBIDDEN, "Insufficient role for Runtime operation"));
    }
    if (spec.permission && !staffHasPermission(staff, spec.permission)) {
      return errorResponse(new RuntimeError(RUNTIME_ERROR_CODES.FORBIDDEN, "Missing Runtime operation permission"));
    }
    return null;
  }

  return errorResponse(new RuntimeError(RUNTIME_ERROR_CODES.FORBIDDEN, "Route authentication policy is invalid"));
}

async function handleCommand(req: Request): Promise<Response> {
  const body = await readJson(req);
  const commandType = requireNonEmptyString(body.commandType, "commandType");
  const requestId = requireNonEmptyString(body.requestId, "requestId");
  const restaurantId = getRestaurantId();
  if (!restaurantId) throw new RuntimeError(RUNTIME_ERROR_CODES.TENANT_MISMATCH, "Runtime has no restaurant identity");

  const staff = validateStaffToken(req.headers.get("X-Staff-Token"));
  const ctx: CommandContext = {
    restaurantId,
    runtimeId: getDeviceId(),
    requestId,
    actorId: staff?.userId ?? null,
    actorRole: staff?.role ?? null,
    deviceId: getDeviceId(),
    correlationId: typeof body.correlationId === "string" ? body.correlationId : requestId,
    permissions: staff?.permissions ?? {},
    occurredAt: typeof body.occurredAt === "number" && Number.isFinite(body.occurredAt)
      ? body.occurredAt
      : Date.now(),
  };

  const result = executeCommand(getDb(), commandType, body.input ?? {}, ctx);
  if (!result.ok) return response(result, errorHttpStatus(result.code as any));
  return response(result);
}

function handleQuery(url: URL): Response {
  // Queries are explicitly dispatched to domain query handlers. Each domain
  // registers its own query functions; there is no generic SQL endpoint.
  const queryName = url.pathname.slice("/runtime/v2/queries/".length);
  const result = handleOrderQuery(getDb(), queryName, url.searchParams);
  if (result.ok) return response(result);
  return response(result, 404);
}

function buildHealth() {
  const db = getDb();
  const checkpoint = getCheckpoint(db, CHECKPOINT_CLOUD_DOWNLOAD);
  const unresolvedDlq = countUnresolvedDlq(db);
  const ready = isLocalReady();
  const bootstrapRequired = checkpoint === null || checkpoint.cursorValue === null;
  const scheduler = getSyncV2SchedulerStatus();
  const cloudConnected = isSessionValid() && (
    scheduler.lastUpload?.ok === true || scheduler.lastDownload?.ok === true
  );

  return {
    ok: ready && !bootstrapRequired,
    state: !ready || bootstrapRequired ? "BOOTSTRAP_REQUIRED" : unresolvedDlq > 0 ? "DEGRADED" : "HEALTHY",
    runtimeReady: ready,
    bootstrapRequired,
    cloudConnected,
    // The HTTP response itself proves the LAN path is reachable.
    lanConnected: true,
    dlqCount: unresolvedDlq,
    cursor: checkpoint?.cursorValue ?? null,
    lastUpload: scheduler.lastUpload,
    lastDownload: scheduler.lastDownload,
  };
}

function buildStatus() {
  const db = getDb();
  const delivery = getDeliveryStats(db);
  const checkpoint = getCheckpoint(db, CHECKPOINT_CLOUD_DOWNLOAD);
  const scheduler = getSyncV2SchedulerStatus();
  const dbSize = (() => {
    try {
      const row = db.query("PRAGMA page_count").get() as { page_count: number };
      const pageSize = db.query("PRAGMA page_size").get() as { page_size: number };
      return row.page_count * pageSize.page_size;
    } catch {
      return 0;
    }
  })();

  return {
    ok: true,
    apiVersion: 2,
    runtime: {
      ready: isLocalReady(),
      restaurantId: getRestaurantId(),
      runtimeId: getDeviceId(),
      // Token itself is never returned by status.
      tokenConfigured: getRuntimeToken() !== null,
    },
    eventStore: {
      pendingUploads: delivery.pending,
      inFlightUploads: delivery.inFlight,
      deadLetterUploads: delivery.deadLetter,
      oldestPendingAt: delivery.oldestPendingAt,
    },
    download: {
      cursor: checkpoint?.cursorValue ?? null,
      lastEventId: checkpoint?.lastEventId ?? null,
      snapshotVersion: checkpoint?.snapshotVersion ?? null,
      snapshotChecksum: checkpoint?.snapshotChecksum ?? null,
      appliedCount: checkpoint?.appliedCount ?? 0,
    },
    projections: {
      maxLag: getMaxProjectionLag(db),
      states: getProjectionStatus(db),
    },
    dlq: {
      unresolved: countUnresolvedDlq(db),
      byKind: countUnresolvedDlqByKind(db),
    },
    connectivity: {
      cloudConnected: isSessionValid() && (scheduler.lastUpload?.ok === true || scheduler.lastDownload?.ok === true),
      lanConnected: true,
    },
    scheduler: {
      started: scheduler.started,
      uploadRunning: scheduler.uploadRunning,
      downloadRunning: scheduler.downloadRunning,
      lastUpload: scheduler.lastUpload,
      lastDownload: scheduler.lastDownload,
    },
    database: { sizeBytes: dbSize },
    commands: { registered: getRegisteredCommands() },
  };
}

async function readJson(req: Request): Promise<Record<string, any>> {
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "Request body exceeds Runtime v2 limit");
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    throw new RuntimeError(RUNTIME_ERROR_CODES.MALFORMED_PAYLOAD, "Unable to read request body");
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, "Request body exceeds Runtime v2 limit");
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON body must be an object");
    }
    return parsed as Record<string, any>;
  } catch {
    throw new RuntimeError(RUNTIME_ERROR_CODES.MALFORMED_PAYLOAD, "Request body must be valid JSON object");
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, `${field} must be a non-empty string`, { field });
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RuntimeError(RUNTIME_ERROR_CODES.VALIDATION_FAILED, `${field} must be a positive integer`, { field });
  }
  return value as number;
}

function parseBoundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

// ── Shadow Comparison handlers (M2.5) ─────────────────────────────────────────
// Temporary: remove after V1 cutover. Stores V1 vs V2 comparison results in
// runtime_shadow_comparison table for the Shadow Dashboard.

async function handleShadowLog(req: Request): Promise<Response> {
  const body = await readJson(req);
  const id = requireNonEmptyString(body.id, "id");
  const operation = requireNonEmptyString(body.operation, "operation");
  const v1RequestId = requireNonEmptyString(body.v1RequestId, "v1RequestId");
  const v2RequestId = requireNonEmptyString(body.v2RequestId, "v2RequestId");
  const match = body.match === true ? 1 : 0;

  const db = getDb();
  db.query(`
    INSERT INTO runtime_shadow_comparison
      (id, operation, v1_request_id, v2_request_id, v1_entity_id, v2_entity_id,
       match, mismatches, v1_duration_ms, v2_duration_ms, v1_result, v2_result, created_at,
       runtime_version, cashier_version, restaurant_id, runtime_id, command, correlation_id,
       event_ids, sqlite_hash, cloud_hash, primary_engine, runtime_uptime_ms, shadow_duration_ms,
       shadow_session_id, comparison_schema_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    operation,
    v1RequestId,
    v2RequestId,
    body.v1EntityId ?? null,
    body.v2EntityId ?? null,
    match,
    body.mismatches ? JSON.stringify(body.mismatches) : null,
    typeof body.v1DurationMs === "number" ? body.v1DurationMs : null,
    typeof body.v2DurationMs === "number" ? body.v2DurationMs : null,
    body.v1Result ? JSON.stringify(body.v1Result) : null,
    body.v2Result ? JSON.stringify(body.v2Result) : null,
    Date.now(),
    body.runtimeVersion ?? null,
    body.cashierVersion ?? null,
    body.restaurantId ?? null,
    body.runtimeId ?? null,
    body.command ?? null,
    body.correlationId ?? null,
    body.eventIds ? JSON.stringify(body.eventIds) : null,
    body.sqliteHash ?? null,
    body.cloudHash ?? null,
    body.primaryEngine ?? "v1",
    typeof body.runtimeUptimeMs === "number" ? body.runtimeUptimeMs : null,
    typeof body.shadowDurationMs === "number" ? body.shadowDurationMs : null,
    body.shadowSessionId ?? null,
    typeof body.comparisonSchemaVersion === "number" ? body.comparisonSchemaVersion : 1,
  );

  return response({ ok: true, id });
}

function buildShadowStats() {
  const db = getDb();

  const total = (db.query("SELECT COUNT(*) as c FROM runtime_shadow_comparison").get() as { c: number }).c;
  const matchCount = (db.query("SELECT COUNT(*) as c FROM runtime_shadow_comparison WHERE match = 1").get() as { c: number }).c;
  const mismatchCount = total - matchCount;
  const matchRate = total > 0 ? (matchCount / total) * 100 : 100;

  const byOperation = db.query(`
    SELECT operation,
      COUNT(*) as total,
      SUM(CASE WHEN match = 1 THEN 1 ELSE 0 END) as matches,
      SUM(CASE WHEN match = 0 THEN 1 ELSE 0 END) as mismatches
    FROM runtime_shadow_comparison
    GROUP BY operation
  `).all() as { operation: string; total: number; matches: number; mismatches: number }[];

  const operations = byOperation.map((row) => ({
    operation: row.operation,
    total: row.total,
    matches: row.matches,
    mismatches: row.mismatches,
    matchRate: row.total > 0 ? (row.matches / row.total) * 100 : 100,
  }));

  // Oldest mismatch age
  const oldestMismatchRow = db.query(
    "SELECT MIN(created_at) as oldest FROM runtime_shadow_comparison WHERE match = 0"
  ).get() as { oldest: number | null };
  const oldestMismatchAt = oldestMismatchRow?.oldest ?? null;
  const oldestMismatchAge = oldestMismatchAt !== null ? Math.floor((Date.now() - oldestMismatchAt) / 1000) : null;

  // Last match timestamp
  const lastMatchRow = db.query(
    "SELECT MAX(created_at) as latest FROM runtime_shadow_comparison WHERE match = 1"
  ).get() as { latest: number | null };
  const lastMatchTimestamp = lastMatchRow?.latest ?? null;

  // Streaks: scan all records in created_at order, compute longest and current
  const allRecords = db.query(
    "SELECT match FROM runtime_shadow_comparison ORDER BY created_at ASC, id ASC"
  ).all() as { match: number }[];

  let longestVerifiedMatchStreak = 0;
  let currentStreak = 0;
  for (const rec of allRecords) {
    if (rec.match === 1) {
      currentStreak++;
      if (currentStreak > longestVerifiedMatchStreak) {
        longestVerifiedMatchStreak = currentStreak;
      }
    } else {
      currentStreak = 0;
    }
  }
  // currentMatchStreak = streak counting backward from the most recent record
  let currentMatchStreak = 0;
  for (let i = allRecords.length - 1; i >= 0; i--) {
    if (allRecords[i].match === 1) {
      currentMatchStreak++;
    } else {
      break;
    }
  }

  // By build version
  const byBuildRows = db.query(`
    SELECT runtime_version,
      COUNT(*) as total,
      SUM(CASE WHEN match = 1 THEN 1 ELSE 0 END) as matches,
      SUM(CASE WHEN match = 0 THEN 1 ELSE 0 END) as mismatches
    FROM runtime_shadow_comparison
    WHERE runtime_version IS NOT NULL
    GROUP BY runtime_version
    ORDER BY runtime_version DESC
  `).all() as { runtime_version: string; total: number; matches: number; mismatches: number }[];

  const byBuildVersion = byBuildRows.map((row) => ({
    runtimeVersion: row.runtime_version,
    total: row.total,
    matches: row.matches,
    mismatches: row.mismatches,
    matchRate: row.total > 0 ? (row.matches / row.total) * 100 : 100,
  }));

  // First mismatch after startup (requires runtime_started_at checkpoint)
  const startupRow = db.query(
    "SELECT value FROM edge_config WHERE key = 'runtime_started_at'"
  ).get() as { value: string } | null;
  const startupTime = startupRow ? Number(startupRow.value) : null;
  let firstMismatchAfterStartup: number | null = null;
  if (startupTime !== null) {
    const firstMismatchRow = db.query(
      "SELECT MIN(created_at) as first FROM runtime_shadow_comparison WHERE match = 0 AND created_at >= ?"
    ).get(startupTime) as { first: number | null };
    if (firstMismatchRow?.first !== null) {
      firstMismatchAfterStartup = Math.floor((firstMismatchRow.first - startupTime) / 1000);
    }
  }

  // Current shadow session
  const sessionRow = db.query(
    "SELECT value FROM edge_config WHERE key = 'shadow_session_id'"
  ).get() as { value: string } | null;
  const shadowSessionId = sessionRow?.value ?? null;

  // Runtime uptime
  const uptimeRow = db.query(
    "SELECT value FROM edge_config WHERE key = 'runtime_started_at'"
  ).get() as { value: string } | null;
  const runtimeUptimeMs = uptimeRow ? Date.now() - Number(uptimeRow.value) : 0;

  return {
    ok: true,
    total,
    matches: matchCount,
    mismatches: mismatchCount,
    matchRate: Math.round(matchRate * 1000) / 1000,
    operations,
    oldestMismatchAge,
    oldestMismatchAt,
    longestVerifiedMatchStreak,
    currentMatchStreak,
    lastMatchTimestamp,
    firstMismatchAfterStartup,
    byBuildVersion,
    shadowSessionId,
    runtimeUptimeMs,
  };
}

function listShadowMismatches(db: ReturnType<typeof getDb>, limit: number) {
  return db.query(`
    SELECT id, operation, v1_request_id, v2_request_id, v1_entity_id, v2_entity_id,
           mismatches, v1_duration_ms, v2_duration_ms, created_at
    FROM runtime_shadow_comparison
    WHERE match = 0
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit).map((row: any) => ({
    ...row,
    mismatches: row.mismatches ? JSON.parse(row.mismatches as string) : [],
  }));
}

// ── M2.6A: Release Status & Export ───────────────────────────────────────────
// Runtime reports runtime facts only. CI-verified gates (P1-P9, C1-C8, W1-W9,
// Simulation) come from external release metadata — the Runtime does NOT
// hardcode them. The dashboard combines runtime facts with external metadata.

function buildReleaseStatus() {
  const stats = buildShadowStats();
  const db = getDb();

  // Primary engine from most recent comparison record (or default v1)
  const primaryEngineRow = db.query(
    "SELECT primary_engine FROM runtime_shadow_comparison ORDER BY created_at DESC LIMIT 1"
  ).get() as { primary_engine: string } | null;
  const primaryEngine = primaryEngineRow?.primary_engine ?? "v1";

  // Migration mode from edge_config (set by frontend, defaults to "shadow")
  const modeRow = db.query(
    "SELECT value FROM edge_config WHERE key = 'shadow_migration_mode'"
  ).get() as { value: string } | null;
  const migrationMode = modeRow?.value ?? "shadow";

  // Runtime version from most recent comparison record
  const versionRow = db.query(
    "SELECT runtime_version FROM runtime_shadow_comparison WHERE runtime_version IS NOT NULL ORDER BY created_at DESC LIMIT 1"
  ).get() as { runtime_version: string } | null;
  const runtimeVersion = versionRow?.runtime_version ?? "unknown";

  const shadowHealthy = stats.mismatches === 0 && stats.matchRate === 100;

  // shadowValidationStatus is computed from runtime facts only
  let shadowValidationStatus: "PASS" | "IN_PROGRESS" | "PENDING";
  if (stats.total === 0) {
    shadowValidationStatus = "PENDING";
  } else if (shadowHealthy) {
    shadowValidationStatus = "PASS";
  } else {
    shadowValidationStatus = "IN_PROGRESS";
  }

  return {
    ok: true,
    runtime: {
      shadowHealthy,
      matchRate: stats.matchRate,
      totalOperations: stats.total,
      mismatches: stats.mismatches,
      oldestMismatchAge: stats.oldestMismatchAge,
      currentMatchStreak: stats.currentMatchStreak,
      longestVerifiedMatchStreak: stats.longestVerifiedMatchStreak,
      lastMatchTimestamp: stats.lastMatchTimestamp,
      primaryEngine,
      migrationMode,
      runtimeVersion,
      shadowSessionId: stats.shadowSessionId,
      runtimeUptimeMs: stats.runtimeUptimeMs,
      byBuildVersion: stats.byBuildVersion,
    },
    release: {
      requiresExternalValidation: true,
      shadowValidationStatus,
    },
  };
}

function exportShadowMismatches(db: ReturnType<typeof getDb>, limit: number) {
  const rows = db.query(`
    SELECT id, operation, v1_request_id, v2_request_id, v1_entity_id, v2_entity_id,
           match, mismatches, v1_duration_ms, v2_duration_ms, v1_result, v2_result,
           created_at, runtime_version, cashier_version, restaurant_id, runtime_id,
           command, correlation_id, event_ids, sqlite_hash, cloud_hash, primary_engine,
           runtime_uptime_ms, shadow_duration_ms, shadow_session_id
    FROM runtime_shadow_comparison
    WHERE match = 0
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as Record<string, unknown>[];

  const mismatches = rows.map((row) => ({
    ...row,
    mismatches: row.mismatches ? JSON.parse(row.mismatches as string) : [],
    event_ids: row.event_ids ? JSON.parse(row.event_ids as string) : [],
    v1_result: row.v1_result ? JSON.parse(row.v1_result as string) : null,
    v2_result: row.v2_result ? JSON.parse(row.v2_result as string) : null,
  }));

  return {
    ok: true,
    exportedAt: Date.now(),
    count: mismatches.length,
    mismatches,
  };
}

function exportShadowMismatchesBySession(db: ReturnType<typeof getDb>, sessionId: string, limit: number) {
  const rows = db.query(`
    SELECT id, operation, v1_request_id, v2_request_id, v1_entity_id, v2_entity_id,
           match, mismatches, v1_duration_ms, v2_duration_ms, v1_result, v2_result,
           created_at, runtime_version, cashier_version, restaurant_id, runtime_id,
           command, correlation_id, event_ids, sqlite_hash, cloud_hash, primary_engine,
           runtime_uptime_ms, shadow_duration_ms, shadow_session_id, comparison_schema_version
    FROM runtime_shadow_comparison
    WHERE shadow_session_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(sessionId, limit) as Record<string, unknown>[];

  const records = rows.map((row: any) => ({
    ...row,
    mismatches: row.mismatches ? JSON.parse(row.mismatches as string) : [],
    event_ids: row.event_ids ? JSON.parse(row.event_ids as string) : [],
    v1_result: row.v1_result ? JSON.parse(row.v1_result as string) : null,
    v2_result: row.v2_result ? JSON.parse(row.v2_result as string) : null,
  }));

  return {
    ok: true,
    exportedAt: Date.now(),
    sessionId,
    count: records.length,
    mismatches: records.filter((r: any) => r.match === 0),
    allRecords: records,
  };
}
