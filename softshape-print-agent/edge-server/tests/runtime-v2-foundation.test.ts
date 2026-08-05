// ─────────────────────────────────────────────────────────────────────────────
// runtime-v2-foundation.test.ts — Runtime v2 persistence invariants
// ─────────────────────────────────────────────────────────────────────────────
// These tests exercise the foundation without starting the HTTP server:
//   - event store append + immutable triggers
//   - atomic event/projection command commits
//   - command idempotency across retries
//   - permanent vs transient failure classification
//   - inbound apply + cursor atomicity
//   - duplicate inbound delivery
//   - DLQ preservation/resolution
//   - route-table security invariants
// ─────────────────────────────────────────────────────────────────────────────

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initRuntimeV2Schema } from "../core/schema.ts";
import { appendEvent, getEventById, getDeliveryStatus, getLatestAggregateSeq, countEvents } from "../core/eventStore.ts";
import { registerProjection, resetProjectionRegistry, getProjectionStatus, rebuildProjections, discoverProjections, assertProjectionRegistryReady } from "../core/projections.ts";
import { registerCommand, resetCommandRegistry, executeCommand } from "../core/commandBus.ts";
import { applyInboundEvent } from "../core/inboundApplier.ts";
import { getCheckpoint, needsBootstrap, recordSnapshot, advanceCursor } from "../core/checkpoints.ts";
import { countUnresolvedDlq, getDlqEntry, listDlqEntries, resolveDlqEntry } from "../core/dlq.ts";
import { buildEventEnvelope, OPERATIONAL_EVENT_TYPES } from "../contract/operationalEvents.ts";
import { RUNTIME_ERROR_CODES, RuntimeError } from "../contract/errors.ts";
import { auditRouteTable, classifyRoute } from "../contract/lanAuth.ts";

const RESTAURANT_ID = "restaurant-test-001";
const OTHER_RESTAURANT_ID = "restaurant-other-999";
const RUNTIME_ID = "runtime-test-001";

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  initRuntimeV2Schema(db);
  // command_log is an existing operational table and is intentionally reused by
  // the v2 command bus for idempotency.
  db.exec(`
    CREATE TABLE command_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      command_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      device_id TEXT,
      command_ts INTEGER NOT NULL,
      expected_revision INTEGER,
      resulting_revision INTEGER,
      status TEXT NOT NULL,
      response_json TEXT,
      error_message TEXT,
      applied_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_command_log_dedup
      ON command_log(restaurant_id, request_id, command_type);
  `);
  return db;
}

function eventInput(overrides: Partial<Parameters<typeof buildEventEnvelope>[0]> = {}) {
  return buildEventEnvelope({
    eventType: OPERATIONAL_EVENT_TYPES.ORDER_CREATED,
    aggregateId: "order-1",
    restaurantId: RESTAURANT_ID,
    runtimeId: RUNTIME_ID,
    payload: { tableId: "table-1", items: [] },
    ...overrides,
  });
}

function context(requestId: string) {
  return {
    restaurantId: RESTAURANT_ID,
    runtimeId: RUNTIME_ID,
    requestId,
    actorId: "staff-1",
    actorRole: "CASHIER",
    deviceId: "device-1",
    correlationId: requestId,
    occurredAt: Date.now(),
    permissions: {},
  };
}

describe("Runtime v2 event store", () => {
  let db: Database;

  beforeEach(() => {
    db = createDb();
  });

  test("appends an event with local and aggregate ordering and delivery state", () => {
    const first = appendEvent(db, eventInput());
    const second = appendEvent(db, eventInput({
      eventId: "event-2",
      aggregateId: "order-1",
      eventType: OPERATIONAL_EVENT_TYPES.ORDER_STATUS_CHANGED,
      payload: { status: "OPEN" },
    }));

    expect(first.seq).toBe(1);
    expect(first.aggregateSeq).toBe(1);
    expect(second.seq).toBe(2);
    expect(second.aggregateSeq).toBe(2);
    expect(getDeliveryStatus(db, first.eventId)).toBe("pending");
    expect(getEventById(db, first.eventId)?.payload).toEqual({ tableId: "table-1", items: [] });
  });

  test("keeps event sequence correct when cloud and Runtime events are interleaved", () => {
    const runtimeFirst = appendEvent(db, eventInput({ eventId: "runtime-1" }));
    const cloudEnvelope = buildEventEnvelope({
      eventId: "cloud-1",
      eventType: OPERATIONAL_EVENT_TYPES.MENU_ITEM_UPSERTED,
      aggregateId: "menu-1",
      restaurantId: RESTAURANT_ID,
      payload: {},
    });
    const cloudEvent = appendEvent(db, { ...cloudEnvelope, origin: "cloud" });
    const runtimeSecond = appendEvent(db, eventInput({ eventId: "runtime-2", aggregateId: "order-2" }));

    expect([runtimeFirst.seq, cloudEvent.seq, runtimeSecond.seq]).toEqual([1, 2, 3]);
    expect(getDeliveryStatus(db, "runtime-1")).toBe("pending");
    expect(getDeliveryStatus(db, "runtime-2")).toBe("pending");
    expect(getDeliveryStatus(db, "cloud-1")).toBeNull();
    expect(db.query("SELECT event_seq FROM event_delivery ORDER BY event_seq").all()).toEqual([
      { event_seq: 1 },
      { event_seq: 3 },
    ]);
  });

  test("rejects event mutation and undelivered deletion at the database boundary", () => {
    const event = appendEvent(db, eventInput());

    expect(() => db.query("UPDATE event_store SET payload = ? WHERE seq = ?").run("{}", event.seq)).toThrow(
      "event_store is append-only",
    );
    expect(() => db.query("DELETE FROM event_store WHERE seq = ?").run(event.seq)).toThrow(
      "events cannot be deleted",
    );

    db.query("UPDATE event_delivery SET status = 'delivered' WHERE event_id = ?").run(event.eventId);
    expect(() => db.query("DELETE FROM event_store WHERE seq = ?").run(event.seq)).toThrow(
      "events cannot be deleted",
    );
  });

  test("rejects duplicate event IDs", () => {
    appendEvent(db, eventInput({ eventId: "same-event" }));
    expect(() => appendEvent(db, eventInput({ eventId: "same-event" }))).toThrowError(
      /already exists in the event store/,
    );
  });

  test("builds only declared event types and validates payload shape", () => {
    expect(() => buildEventEnvelope({
      eventType: "not-a-real-event" as never,
      aggregateId: "x",
      restaurantId: RESTAURANT_ID,
      payload: {},
    })).toThrowError(/Unknown operational event type/);

    expect(() => buildEventEnvelope({
      eventType: OPERATIONAL_EVENT_TYPES.ORDER_CREATED,
      aggregateId: "x",
      restaurantId: RESTAURANT_ID,
      payload: [] as never,
    })).toThrowError(/payload must be a JSON object/);
  });
});

describe("Runtime v2 projections and command atomicity", () => {
  let db: Database;

  beforeEach(() => {
    db = createDb();
    resetProjectionRegistry();
    resetCommandRegistry();
  });

  test("commits event and projection atomically", () => {
    db.exec("CREATE TABLE order_projection (id TEXT PRIMARY KEY, status TEXT NOT NULL);");
    registerProjection({
      name: "orders",
      eventTypes: [OPERATIONAL_EVENT_TYPES.ORDER_CREATED],
      tables: ["order_projection"],
      handler: (runtimeDb, event) => {
        runtimeDb.query(
          "INSERT INTO order_projection (id, status) VALUES (?, ?)",
        ).run(event.aggregateId, "OPEN");
      },
    });
    registerCommand({
      type: "createOrder",
      entityType: "order",
      resolveEntityId: (input: { orderId: string }) => input.orderId,
      handler: (_runtimeDb, input: { orderId: string }, _ctx) => ({
        result: { orderId: input.orderId },
        events: [{
          eventType: OPERATIONAL_EVENT_TYPES.ORDER_CREATED,
          aggregateId: input.orderId,
          payload: { tableId: "table-1", items: [] },
        }],
      }),
    });

    const result = executeCommand<{ orderId: string }, { orderId: string }>(
      db,
      "createOrder",
      { orderId: "order-1" },
      context("request-1"),
    );

    expect(result.ok).toBe(true);
    expect(countEvents(db)).toBe(1);
    expect(db.query("SELECT status FROM order_projection WHERE id = 'order-1'").get()).toEqual({ status: "OPEN" });
  });

  test("rolls back the event when a projection fails and records a rejection", () => {
    db.exec("CREATE TABLE order_projection (id TEXT PRIMARY KEY);");
    registerProjection({
      name: "failing-orders",
      eventTypes: [OPERATIONAL_EVENT_TYPES.ORDER_CREATED],
      tables: ["order_projection"],
      handler: () => {
        throw new RuntimeError(RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED, "projection rejected event");
      },
    });
    registerCommand({
      type: "createOrder",
      entityType: "order",
      resolveEntityId: (input: { orderId: string }) => input.orderId,
      handler: (_runtimeDb, input: { orderId: string }) => ({
        result: null,
        events: [{
          eventType: OPERATIONAL_EVENT_TYPES.ORDER_CREATED,
          aggregateId: input.orderId,
          payload: {},
        }],
      }),
    });

    const result = executeCommand(db, "createOrder", { orderId: "order-1" }, context("request-fail"));

    expect(result.ok).toBe(false);
    expect(countEvents(db)).toBe(0);
    expect(countUnresolvedDlq(db)).toBe(1);
    expect(db.query("SELECT status FROM command_log WHERE request_id = 'request-fail'").get()).toEqual({ status: "rejected" });
  });

  test("serves the original result for a duplicate command", () => {
    registerCommand({
      type: "createOrder",
      entityType: "order",
      resolveEntityId: (input: { orderId: string }) => input.orderId,
      handler: (_runtimeDb, input: { orderId: string }) => ({
        result: { orderId: input.orderId, created: true },
        events: [],
      }),
    });

    const first = executeCommand(db, "createOrder", { orderId: "order-1" }, context("request-dup"));
    const second = executeCommand(db, "createOrder", { orderId: "order-1" }, context("request-dup"));

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: true, replayed: true, result: { orderId: "order-1", created: true } });
  });

  test("does not dead-letter transient database failures", () => {
    registerCommand({
      type: "transient",
      entityType: "order",
      resolveEntityId: () => "order-1",
      handler: () => {
        throw new RuntimeError(RUNTIME_ERROR_CODES.DATABASE_BUSY, "database is busy");
      },
    });

    const result = executeCommand(db, "transient", {}, context("request-transient"));

    expect(result).toMatchObject({ ok: false, code: RUNTIME_ERROR_CODES.DATABASE_BUSY, retryable: true });
    expect(countUnresolvedDlq(db)).toBe(0);
    expect(db.query("SELECT COUNT(*) AS c FROM command_log").get()).toEqual({ c: 0 });
  });
});

describe("Runtime v2 inbound cursor and DLQ behavior", () => {
  let db: Database;

  beforeEach(() => {
    db = createDb();
    resetProjectionRegistry();
    registerProjection({
      name: "inbound-config",
      eventTypes: [OPERATIONAL_EVENT_TYPES.MENU_ITEM_UPSERTED],
      tables: [],
      handler: () => {},
    });
  });

  function inboundEvent(eventId: string, payload: Record<string, unknown> = {}) {
    return {
      eventId,
      envelopeVersion: 1,
      schemaVersion: 1,
      restaurantId: RESTAURANT_ID,
      runtimeId: null,
      origin: "cloud",
      aggregate: "menu_item",
      aggregateId: "menu-1",
      eventType: OPERATIONAL_EVENT_TYPES.MENU_ITEM_UPSERTED,
      actorId: "admin-1",
      actorRole: "ADMIN",
      requestId: null,
      correlationId: null,
      causationId: null,
      occurredAt: Date.now(),
      payload,
    };
  }

  test("applies inbound event and advances cursor in one logical operation", () => {
    const result = applyInboundEvent(db, inboundEvent("cloud-1"), { cursorValue: "101", restaurantId: RESTAURANT_ID });

    expect(result.outcome).toBe("applied");
    expect(getCheckpoint(db, "cloud_download")?.cursorValue).toBe("101");
    expect(db.query("SELECT origin FROM event_store WHERE event_id = 'cloud-1'").get()).toEqual({ origin: "cloud" });
  });

  test("duplicate inbound delivery is a no-op but still advances the cursor", () => {
    applyInboundEvent(db, inboundEvent("cloud-1"), { cursorValue: "101", restaurantId: RESTAURANT_ID });
    const duplicate = applyInboundEvent(db, inboundEvent("cloud-1"), { cursorValue: "102", restaurantId: RESTAURANT_ID });

    expect(duplicate.outcome).toBe("duplicate");
    expect(countEvents(db)).toBe(1);
    expect(getCheckpoint(db, "cloud_download")?.cursorValue).toBe("102");
  });

  test("permanent inbound projection failure is preserved in DLQ and advances cursor", () => {
    resetProjectionRegistry();
    registerProjection({
      name: "rejecting-config",
      eventTypes: [OPERATIONAL_EVENT_TYPES.MENU_ITEM_UPSERTED],
      tables: [],
      handler: () => {
        throw new RuntimeError(RUNTIME_ERROR_CODES.SNAPSHOT_INVALID, "bad configuration");
      },
    });

    const result = applyInboundEvent(db, inboundEvent("cloud-bad"), { cursorValue: "103", restaurantId: RESTAURANT_ID });

    expect(result.outcome).toBe("dead_letter");
    expect(getCheckpoint(db, "cloud_download")?.cursorValue).toBe("103");
    expect(countUnresolvedDlq(db)).toBe(1);
    const entry = listDlqEntries(db)[0];
    expect(entry.eventId).toBe("cloud-bad");
    expect(resolveDlqEntry(db, entry.id, "fixed", "admin-1")).toBe(true);
    expect(getDlqEntry(db, entry.id)?.resolved).toBe(true);
  });

  test("invalid inbound payload is dead-lettered without advancing a null cursor", () => {
    const result = applyInboundEvent(db, { eventId: "bad" }, { cursorValue: null, restaurantId: RESTAURANT_ID });

    expect(result.outcome).toBe("dead_letter");
    expect(getCheckpoint(db, "cloud_download")).toBeNull();
    expect(countUnresolvedDlq(db)).toBe(1);
  });

  test("rejects a cross-tenant inbound event before it reaches projections", () => {
    const result = applyInboundEvent(
      db,
      { ...inboundEvent("cross-tenant"), restaurantId: OTHER_RESTAURANT_ID },
      { cursorValue: "104", restaurantId: RESTAURANT_ID },
    );

    expect(result.outcome).toBe("dead_letter");
    expect(getCheckpoint(db, "cloud_download")?.cursorValue).toBe("104");
    expect(db.query("SELECT COUNT(*) AS c FROM event_store").get()).toEqual({ c: 0 });
    expect(listDlqEntries(db)[0].reasonCode).toBe("TENANT_MISMATCH");
  });
});

describe("Runtime v2 LAN authentication perimeter", () => {
  test("route table satisfies its own security invariants", () => {
    expect(auditRouteTable()).toEqual([]);
    expect(classifyRoute("/runtime/v2/ping", "GET")?.authClass).toBe("PUBLIC");
    expect(classifyRoute("/runtime/v2/commands", "POST")?.authClass).toBe("RUNTIME_TOKEN");
    expect(classifyRoute("/runtime/v2/dlq/replay", "POST")?.minRole).toBe("ADMIN");
    expect(classifyRoute("/runtime/v2/unknown", "GET")).toBeNull();
  });
});

describe("Runtime v2 projection registry discovery", () => {
  beforeEach(() => {
    resetProjectionRegistry();
  });

  test("reports covered, missing, and duplicate event types", () => {
    registerProjection({
      name: "orders",
      eventTypes: [OPERATIONAL_EVENT_TYPES.ORDER_CREATED],
      tables: [],
      handler: () => {},
    });
    registerProjection({
      name: "orders-status",
      eventTypes: [OPERATIONAL_EVENT_TYPES.ORDER_STATUS_CHANGED],
      tables: [],
      handler: () => {},
    });
    // Duplicate: two projections subscribe to the same event type.
    registerProjection({
      name: "orders-status-audit",
      eventTypes: [OPERATIONAL_EVENT_TYPES.ORDER_STATUS_CHANGED],
      tables: [],
      handler: () => {},
    });

    const discovery = discoverProjections([
      OPERATIONAL_EVENT_TYPES.ORDER_CREATED,
      OPERATIONAL_EVENT_TYPES.ORDER_STATUS_CHANGED,
      OPERATIONAL_EVENT_TYPES.ORDER_VOIDED,
    ]);

    expect(discovery.registered).toEqual(["orders", "orders-status", "orders-status-audit"]);
    expect(discovery.eventTypesCovered).toContain(OPERATIONAL_EVENT_TYPES.ORDER_CREATED);
    expect(discovery.eventTypesCovered).toContain(OPERATIONAL_EVENT_TYPES.ORDER_STATUS_CHANGED);
    expect(discovery.eventTypesWithoutHandlers).toEqual([OPERATIONAL_EVENT_TYPES.ORDER_VOIDED]);
    expect(discovery.duplicateEventTypes).toEqual([OPERATIONAL_EVENT_TYPES.ORDER_STATUS_CHANGED]);
  });

  test("assertProjectionRegistryReady throws when handlers are missing", () => {
    registerProjection({
      name: "orders",
      eventTypes: [OPERATIONAL_EVENT_TYPES.ORDER_CREATED],
      tables: [],
      handler: () => {},
    });

    expect(() =>
      assertProjectionRegistryReady([
        OPERATIONAL_EVENT_TYPES.ORDER_CREATED,
        OPERATIONAL_EVENT_TYPES.ORDER_VOIDED,
      ]),
    ).toThrowError(/Projection registry is incomplete or ambiguous/);
  });

  test("assertProjectionRegistryReady passes when every event type has exactly one handler", () => {
    registerProjection({
      name: "orders",
      eventTypes: [OPERATIONAL_EVENT_TYPES.ORDER_CREATED, OPERATIONAL_EVENT_TYPES.ORDER_VOIDED],
      tables: [],
      handler: () => {},
    });

    expect(() =>
      assertProjectionRegistryReady([
        OPERATIONAL_EVENT_TYPES.ORDER_CREATED,
        OPERATIONAL_EVENT_TYPES.ORDER_VOIDED,
      ]),
    ).not.toThrow();
  });
});

describe("Runtime v2 bootstrap gating", () => {
  let db: Database;

  beforeEach(() => {
    db = createDb();
  });

  test("needsBootstrap is true until a verified snapshot is recorded", () => {
    expect(needsBootstrap(db)).toBe(true);
    expect(getCheckpoint(db, "cloud_download")).toBeNull();

    recordSnapshot(db, {
      cursorValue: "42",
      snapshotVersion: "runtime-snapshot-42",
      snapshotChecksum: "abc123",
      snapshotSchema: 1,
    });

    expect(needsBootstrap(db)).toBe(false);
    const checkpoint = getCheckpoint(db, "cloud_download");
    expect(checkpoint?.cursorValue).toBe("42");
    expect(checkpoint?.snapshotVersion).toBe("runtime-snapshot-42");
    expect(checkpoint?.snapshotChecksum).toBe("abc123");
    expect(checkpoint?.snapshotSchema).toBe(1);
  });

  test("advanceCursor moves past the snapshot cursor without losing snapshot identity", () => {
    recordSnapshot(db, {
      cursorValue: "42",
      snapshotVersion: "runtime-snapshot-42",
      snapshotChecksum: "abc123",
      snapshotSchema: 1,
    });

    // Simulate incremental download advancing the cursor.
    advanceCursor(db, { cursorValue: "43", lastEventId: "cloud-43", appliedDelta: 1 });

    const checkpoint = getCheckpoint(db, "cloud_download");
    expect(checkpoint?.cursorValue).toBe("43");
    expect(checkpoint?.lastEventId).toBe("cloud-43");
    expect(checkpoint?.appliedCount).toBe(1);
    // Snapshot provenance is preserved across cursor advancement.
    expect(checkpoint?.snapshotVersion).toBe("runtime-snapshot-42");
    expect(checkpoint?.snapshotChecksum).toBe("abc123");
  });
});
