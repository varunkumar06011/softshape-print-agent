// ─────────────────────────────────────────────────────────────────────────────
// core/commandBus.ts — Atomic command execution
// ─────────────────────────────────────────────────────────────────────────────
// The single write path for Runtime-owned operational state. One command call
// produces exactly one SQLite transaction that:
//
//   1. checks the idempotency log and short-circuits a replay
//   2. validates the command and enforces ownership
//   3. appends immutable event(s) to the event store
//   4. applies the projections for those events
//   5. records the command result for idempotency
//   6. commits — or rolls back completely
//
// There is no path that commits an event without its projection, and no path
// that reports success before the transaction commits. That is what lets a
// client treat a 200 as "durably recorded", even with no cloud connectivity.
//
// Failure handling follows contract/errors.ts:
//   PERMANENT / UNKNOWN → roll back, record a DLQ entry, return the error
//   TRANSIENT           → roll back, return the error, do NOT dead-letter
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import { runtimeLog } from "../contract/logger.ts";
import {
  RUNTIME_ERROR_CODES,
  RuntimeError,
  normalizeError,
  type FailureClass,
} from "../contract/errors.ts";
import {
  buildEventEnvelope,
  type NewEventInput,
  type OperationalEventType,
  type StoredOperationalEvent,
} from "../contract/operationalEvents.ts";
import { roleMeetsMinimum } from "../contract/lanAuth.ts";
import { appendEvent } from "./eventStore.ts";
import { applyEventToProjections } from "./projections.ts";
import { recordDlqEntry } from "./dlq.ts";

// ── Command context ──────────────────────────────────────────────────────────

export interface CommandContext {
  restaurantId: string;
  runtimeId: string | null;
  requestId: string;
  actorId: string | null;
  actorRole: string | null;
  deviceId: string | null;
  correlationId: string | null;
  occurredAt: number;
  permissions: Record<string, unknown>;
}

// What a handler is allowed to emit. The handler describes facts; it never
// writes to the event store or the network itself.
export interface EmittedEvent {
  eventType: OperationalEventType;
  aggregateId: string;
  payload: Record<string, unknown>;
  eventId?: string;
  causationId?: string | null;
}

export interface CommandOutcome<TResult = unknown> {
  result: TResult;
  events: EmittedEvent[];
}

// Handlers run INSIDE the transaction. They may read projections through `db`
// for validation, but must not perform network I/O, spawn timers, print, or
// mutate projection tables directly — projections are derived from events only.
export type CommandHandler<TInput = unknown, TResult = unknown> = (
  db: Database,
  input: TInput,
  ctx: CommandContext,
) => CommandOutcome<TResult>;

export interface CommandRegistration<TInput = unknown, TResult = unknown> {
  type: string;
  handler: CommandHandler<TInput, TResult>;
  // Primary entity this command targets; used for the idempotency log's audit
  // columns so operators can find every command that touched an aggregate.
  entityType: string;
  resolveEntityId: (input: TInput) => string;
  // Operational commands require a staff identity by default. Internal-only
  // commands may explicitly opt out; no command gets role behavior accidentally
  // through an omitted authorization declaration.
  requiresStaff?: boolean;
  minRole?: "CAPTAIN" | "CASHIER" | "MANAGER" | "ADMIN" | "OWNER";
  permission?: string;
  // Optional pre-flight validation. Throw RuntimeError(VALIDATION_FAILED) for
  // bad input. Runs inside the transaction, before any event is appended.
  validate?: (input: TInput, ctx: CommandContext) => void;
}

const commands = new Map<string, CommandRegistration<any, any>>();

export function registerCommand<TInput, TResult>(
  registration: CommandRegistration<TInput, TResult>,
): void {
  if (commands.has(registration.type)) {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.INTERNAL_ERROR,
      `Command '${registration.type}' is already registered`,
      { type: registration.type },
    );
  }
  commands.set(registration.type, registration);
}

export function resetCommandRegistry(): void {
  commands.clear();
}

export function getRegisteredCommands(): string[] {
  return [...commands.keys()].sort();
}

// ── Execution result ─────────────────────────────────────────────────────────

export interface CommandSuccess<TResult = unknown> {
  ok: true;
  result: TResult;
  events: StoredOperationalEvent[];
  replayed: boolean;
}

export interface CommandFailure {
  ok: false;
  code: string;
  error: string;
  failureClass: FailureClass;
  retryable: boolean;
  dlqId?: number;
}

export type CommandResult<TResult = unknown> = CommandSuccess<TResult> | CommandFailure;

// ── Idempotency ──────────────────────────────────────────────────────────────
// Reuses the existing command_log table, whose unique index on
// (restaurant_id, request_id, command_type) already provides the dedup key.

interface CommandLogRow {
  status: string;
  response_json: string | null;
  error_message: string | null;
}

function findCommandLog(
  db: Database,
  restaurantId: string,
  requestId: string,
  commandType: string,
): CommandLogRow | null {
  return db
    .query(
      `SELECT status, response_json, error_message FROM command_log
       WHERE restaurant_id = ? AND request_id = ? AND command_type = ?`,
    )
    .get(restaurantId, requestId, commandType) as CommandLogRow | null;
}

function recordCommandLog(
  db: Database,
  params: {
    restaurantId: string;
    requestId: string;
    commandType: string;
    entityType: string;
    entityId: string;
    deviceId: string | null;
    commandTs: number;
    status: "applied" | "rejected" | "failed";
    responseJson: string | null;
    errorMessage: string | null;
  },
  now = Date.now(),
): void {
  db.query(
    `INSERT INTO command_log (
       restaurant_id, request_id, command_type, entity_type, entity_id, device_id,
       command_ts, status, response_json, error_message, applied_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(restaurant_id, request_id, command_type) DO NOTHING`,
  ).run(
    params.restaurantId,
    params.requestId,
    params.commandType,
    params.entityType,
    params.entityId,
    params.deviceId,
    params.commandTs,
    params.status,
    params.responseJson,
    params.errorMessage,
    now,
  );
}

// ── Execute ──────────────────────────────────────────────────────────────────

export function executeCommand<TInput, TResult>(
  db: Database,
  commandType: string,
  input: TInput,
  ctx: CommandContext,
): CommandResult<TResult> {
  const registration = commands.get(commandType) as
    | CommandRegistration<TInput, TResult>
    | undefined;

  if (!registration) {
    return failure(
      new RuntimeError(
        RUNTIME_ERROR_CODES.UNKNOWN_COMMAND,
        `Unknown command '${commandType}'`,
        { commandType },
      ),
    );
  }

  if (!ctx.requestId) {
    return failure(
      new RuntimeError(
        RUNTIME_ERROR_CODES.MISSING_REQUEST_ID,
        `Command '${commandType}' requires a requestId for idempotency`,
        { commandType },
      ),
    );
  }

  if (!ctx.restaurantId) {
    return failure(
      new RuntimeError(
        RUNTIME_ERROR_CODES.TENANT_MISMATCH,
        `Command '${commandType}' requires a restaurantId`,
        { commandType },
      ),
    );
  }

  const requiresStaff = registration.requiresStaff !== false;
  if (requiresStaff && !ctx.actorId) {
    return failure(
      new RuntimeError(
        RUNTIME_ERROR_CODES.FORBIDDEN,
        `Command '${commandType}' requires an authenticated staff identity`,
        { commandType },
      ),
    );
  }
  if (registration.minRole && !roleMeetsMinimum(ctx.actorRole, registration.minRole)) {
    return failure(
      new RuntimeError(
        RUNTIME_ERROR_CODES.FORBIDDEN,
        `Staff role is insufficient for command '${commandType}'`,
        { commandType, requiredRole: registration.minRole },
      ),
    );
  }
  if (registration.permission && !ctx.permissions[registration.permission]) {
    return failure(
      new RuntimeError(
        RUNTIME_ERROR_CODES.FORBIDDEN,
        `Staff lacks permission '${registration.permission}' for command '${commandType}'`,
        { commandType, permission: registration.permission },
      ),
    );
  }

  // Fast path for a replayed request. Checked again inside the transaction to
  // close the race between two concurrent replays of the same requestId.
  const priorLog = findCommandLog(db, ctx.restaurantId, ctx.requestId, commandType);
  if (priorLog) return replayResult<TResult>(priorLog, commandType, ctx.requestId);

  const storedEvents: StoredOperationalEvent[] = [];
  let handlerResult: TResult;

  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-check under the write lock: the unique index would reject the duplicate
    // insert anyway, but detecting it here returns the original response instead
    // of surfacing a constraint error.
    const raced = findCommandLog(db, ctx.restaurantId, ctx.requestId, commandType);
    if (raced) {
      db.exec("ROLLBACK");
      return replayResult<TResult>(raced, commandType, ctx.requestId);
    }

    registration.validate?.(input, ctx);

    const outcome = registration.handler(db, input, ctx);
    handlerResult = outcome.result;

    let previousEventId: string | null = null;
    for (const emitted of outcome.events) {
      const envelopeInput: NewEventInput = {
        eventType: emitted.eventType,
        aggregateId: emitted.aggregateId,
        payload: emitted.payload,
        restaurantId: ctx.restaurantId,
        runtimeId: ctx.runtimeId,
        actorId: ctx.actorId,
        actorRole: ctx.actorRole,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId ?? ctx.requestId,
        // Chain events from one command so the cloud can preserve intra-command
        // ordering without relying on timestamps.
        causationId: emitted.causationId ?? previousEventId,
        occurredAt: ctx.occurredAt,
        eventId: emitted.eventId,
      };

      const envelope = buildEventEnvelope(envelopeInput);
      const stored = appendEvent(db, envelope);
      applyEventToProjections(db, stored);
      storedEvents.push(stored);
      previousEventId = stored.eventId;
    }

    recordCommandLog(db, {
      restaurantId: ctx.restaurantId,
      requestId: ctx.requestId,
      commandType,
      entityType: registration.entityType,
      entityId: safeEntityId(registration, input),
      deviceId: ctx.deviceId,
      commandTs: ctx.occurredAt,
      status: "applied",
      responseJson: safeStringify(handlerResult),
      errorMessage: null,
    });

    db.exec("COMMIT");
  } catch (err) {
    rollbackQuietly(db);

    const runtimeError = normalizeError(err);
    const failureClass = runtimeError.failureClass;

    runtimeLog.warn("Command failed", {
      commandType,
      requestId: ctx.requestId,
      code: runtimeError.code,
      failureClass,
      error: runtimeError.message,
    });

    // Transient failures are retried by the caller with the same requestId, so
    // they must not be dead-lettered and must not be recorded as a terminal
    // outcome in the idempotency log.
    if (failureClass === "TRANSIENT") return failure(runtimeError);

    // Permanent/unknown: the command can never succeed as submitted. Record it
    // for audit so the rejection is not invisible, and dead-letter it.
    let dlqId: number | undefined;
    try {
      db.exec("BEGIN IMMEDIATE");
      recordCommandLog(db, {
        restaurantId: ctx.restaurantId,
        requestId: ctx.requestId,
        commandType,
        entityType: registration.entityType,
        entityId: safeEntityId(registration, input),
        deviceId: ctx.deviceId,
        commandTs: ctx.occurredAt,
        status: "rejected",
        responseJson: null,
        errorMessage: runtimeError.message,
      });
      dlqId = recordDlqEntry(db, {
        kind: "command",
        reasonCode: runtimeError.code,
        reason: runtimeError.message,
        failureClass,
        restaurantId: ctx.restaurantId,
        commandType,
        requestId: ctx.requestId,
        aggregate: registration.entityType,
        aggregateId: safeEntityId(registration, input),
        payload: input,
        occurredAt: ctx.occurredAt,
      });
      db.exec("COMMIT");
    } catch (auditErr) {
      rollbackQuietly(db);
      // The command already failed; failing to audit it is a separate problem
      // that must be visible but must not change what the caller is told.
      runtimeLog.error("Failed to record command rejection audit", {
        commandType,
        requestId: ctx.requestId,
        error: normalizeError(auditErr).message,
      });
    }

    return { ...failure(runtimeError), ...(dlqId !== undefined ? { dlqId } : {}) };
  }

  return { ok: true, result: handlerResult, events: storedEvents, replayed: false };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rollbackQuietly(db: Database): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Already rolled back / no active transaction. Not an additional failure.
  }
}

function failure(err: RuntimeError): CommandFailure {
  return {
    ok: false,
    code: err.code,
    error: err.message,
    failureClass: err.failureClass,
    retryable: err.retryable,
  };
}

function replayResult<TResult>(
  log: CommandLogRow,
  commandType: string,
  requestId: string,
): CommandResult<TResult> {
  if (log.status === "applied") {
    let result: TResult;
    try {
      result = (log.response_json ? JSON.parse(log.response_json) : null) as TResult;
    } catch {
      result = null as TResult;
    }
    runtimeLog.debug("Command replay served from idempotency log", { commandType, requestId });
    // No events are returned: they were appended by the original execution and
    // must not be re-emitted.
    return { ok: true, result, events: [], replayed: true };
  }

  // A previously rejected command replays to the same rejection, so a retrying
  // client cannot flip a permanent rejection into a success.
  return {
    ok: false,
    code: RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED,
    error: log.error_message ?? `Command '${commandType}' was previously rejected`,
    failureClass: "PERMANENT",
    retryable: false,
  };
}

function safeEntityId<TInput, TResult>(
  registration: CommandRegistration<TInput, TResult>,
  input: TInput,
): string {
  try {
    return registration.resolveEntityId(input) || "unknown";
  } catch {
    return "unknown";
  }
}

function safeStringify(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
