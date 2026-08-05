// ─────────────────────────────────────────────────────────────────────────────
// runtime-v2-transaction-pipeline.test.ts — Milestone 2 Workflow Gates W1–W9
// ─────────────────────────────────────────────────────────────────────────────
// Tests the full Restaurant Transaction Pipeline:
//   Create Order → Add Item → Update Quantity → Remove Item →
//   Send KOT → Cancel KOT → Generate Bill
//
// Every workflow must pass the full pipeline:
//   Command → Validation → Event → SQLite Update → Commit → Upload → Cloud → ACK → UI
//
// These tests verify the Command → SQLite portion (the Runtime side). The
// resilience test file covers restart, duplicate, offline, crash, and ACK
// scenarios.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initRuntimeV2Schema } from "../core/schema.ts";
import { executeCommand, type CommandContext } from "../core/commandBus.ts";
import { registerMilestone2Handlers, resetMilestone2Handlers, MILESTONE_2_EVENT_TYPES } from "../handlers/index.ts";
import { COMMAND_TYPES } from "../handlers/commands.ts";
import { discoverProjections } from "../core/projections.ts";
import { getOrder, getOrderItems, getActiveOrderItems } from "../sqlite/orders.ts";
import { getKot, getKotItems, getKotsForOrder } from "../sqlite/kots.ts";
import { getBill, getBillForOrder } from "../sqlite/bills.ts";
import { countEvents } from "../core/eventStore.ts";
import { OPERATIONAL_EVENT_TYPES } from "../contract/operationalEvents.ts";

const RESTAURANT_ID = "restaurant-test-001";
const RUNTIME_ID = "runtime-test-001";

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  initRuntimeV2Schema(db);
  // command_log is reused by v2 command bus for idempotency
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

function context(requestId: string): CommandContext {
  return {
    restaurantId: RESTAURANT_ID,
    runtimeId: RUNTIME_ID,
    requestId,
    actorId: "staff-1",
    // CASHIER meets the minimum role for all Milestone 2 commands
    // (CAPTAIN for order/KOT commands, CASHIER for void/bill commands).
    actorRole: "CASHIER",
    deviceId: "device-1",
    correlationId: requestId,
    occurredAt: Date.now(),
    permissions: {},
  };
}

let db: Database;
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter++;
  return `req-${requestCounter}`;
}

beforeEach(() => {
  db = createDb();
  resetMilestone2Handlers();
  registerMilestone2Handlers();
  requestCounter = 0;
});

// ── Helper: run a command and assert success ─────────────────────────────────

function runCommand<TInput, TResult>(
  commandType: string,
  input: TInput,
  requestId?: string,
): { ok: true; result: TResult; events: any[]; replayed: boolean } | { ok: false; code: string; error: string } {
  const ctx = context(requestId ?? nextRequestId());
  return executeCommand<TInput, TResult>(db, commandType, input, ctx) as any;
}

function expectOk<T>(result: { ok: boolean; result?: T; code?: string; error?: string }): T {
  expect(result.ok).toBe(true);
  return (result as any).result;
}

function expectFail(result: { ok: boolean; code?: string; error?: string }, expectedCode: string): void {
  expect(result.ok).toBe(false);
  expect((result as any).code).toBe(expectedCode);
}

// ── W1: Create Order ─────────────────────────────────────────────────────────

describe("W1: Create Order", () => {
  test("command commits atomically, event appended, SQLite updated, order is OPEN", () => {
    const result = expectOk(runCommand(COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-1",
      tableId: "table-1",
      captainId: "captain-1",
      platform: "DINE_IN",
    }));

    expect(result.orderId).toBe("order-1");
    expect(result.status).toBe("OPEN");

    // Event was appended
    expect(countEvents(db)).toBe(1);

    // SQLite projection was updated
    const order = getOrder(db, "order-1");
    expect(order).not.toBeNull();
    expect(order!.status).toBe("OPEN");
    expect(order!.table_id).toBe("table-1");
    expect(order!.captain_id).toBe("captain-1");
    expect(order!.platform).toBe("DINE_IN");
    expect(order!.total_amount).toBe(0);
  });

  test("rejects duplicate order ID", () => {
    expectOk(runCommand(COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-dup",
      tableId: "table-1",
    }));

    expectFail(
      runCommand(COMMAND_TYPES.CREATE_ORDER, {
        orderId: "order-dup",
        tableId: "table-2",
      }, "req-different"),
      "DUPLICATE_EVENT_ID",
    );
  });

  test("rejects missing orderId", () => {
    expectFail(
      runCommand(COMMAND_TYPES.CREATE_ORDER, {
        orderId: "",
        tableId: "table-1",
      }),
      "VALIDATION_FAILED",
    );
  });
});

// ── W2: Add Item ─────────────────────────────────────────────────────────────

describe("W2: Add Item", () => {
  test("items added to existing order, SQLite updated, total recalculated", () => {
    expectOk(runCommand(COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-2",
      tableId: "table-1",
    }));

    const result = expectOk(runCommand(COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId: "order-2",
      items: [
        { id: "item-1", menuItemId: "menu-1", name: "Biryani", price: 250, quantity: 2 },
        { id: "item-2", menuItemId: "menu-2", name: "Coke", price: 50, quantity: 1 },
      ],
    }));

    expect(result.itemsAdded).toBe(2);

    // SQLite updated
    const items = getOrderItems(db, "order-2");
    expect(items.length).toBe(2);
    expect(items[0].name).toBe("Biryani");
    expect(items[0].quantity).toBe(2);
    expect(items[0].status).toBe("ACTIVE");

    // Total recalculated: 250*2 + 50*1 = 550
    const order = getOrder(db, "order-2");
    expect(order!.total_amount).toBe(550);
  });

  test("rejects adding items to non-existent order", () => {
    expectFail(
      runCommand(COMMAND_TYPES.ADD_ORDER_ITEMS, {
        orderId: "nonexistent",
        items: [{ id: "item-1", menuItemId: "menu-1", name: "Test", price: 100, quantity: 1 }],
      }),
      "AGGREGATE_NOT_FOUND",
    );
  });

  test("rejects adding items to a voided order", () => {
    expectOk(runCommand(COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-void",
      tableId: "table-1",
    }));
    expectOk(runCommand(COMMAND_TYPES.VOID_ORDER, { orderId: "order-void" }));

    expectFail(
      runCommand(COMMAND_TYPES.ADD_ORDER_ITEMS, {
        orderId: "order-void",
        items: [{ id: "item-1", menuItemId: "menu-1", name: "Test", price: 100, quantity: 1 }],
      }),
      "BUSINESS_RULE_REJECTED",
    );
  });
});

// ── W3: Remove Item (Cancel Order Item) ──────────────────────────────────────

describe("W3: Remove Item", () => {
  test("item cancelled, SQLite reflects removal, total recalculated", () => {
    expectOk(runCommand(COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-3",
      tableId: "table-1",
    }));

    expectOk(runCommand(COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId: "order-3",
      items: [
        { id: "item-1", menuItemId: "menu-1", name: "Biryani", price: 250, quantity: 2 },
        { id: "item-2", menuItemId: "menu-2", name: "Coke", price: 50, quantity: 1 },
      ],
    }));

    // Cancel the coke
    expectOk(runCommand(COMMAND_TYPES.CANCEL_ORDER_ITEM, {
      orderId: "order-3",
      orderItemId: "item-2",
    }));

    const items = getOrderItems(db, "order-3");
    expect(items.find((i) => i.id === "item-2")!.status).toBe("CANCELLED");

    // Active items only include biryani
    const active = getActiveOrderItems(db, "order-3");
    expect(active.length).toBe(1);
    expect(active[0].id).toBe("item-1");

    // Total recalculated: 250*2 = 500
    const order = getOrder(db, "order-3");
    expect(order!.total_amount).toBe(500);
  });

  test("rejects cancelling already-cancelled item", () => {
    expectOk(runCommand(COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-3b",
      tableId: "table-1",
    }));
    expectOk(runCommand(COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId: "order-3b",
      items: [{ id: "item-1", menuItemId: "menu-1", name: "Test", price: 100, quantity: 1 }],
    }));
    expectOk(runCommand(COMMAND_TYPES.CANCEL_ORDER_ITEM, {
      orderId: "order-3b",
      orderItemId: "item-1",
    }));

    expectFail(
      runCommand(COMMAND_TYPES.CANCEL_ORDER_ITEM, {
        orderId: "order-3b",
        orderItemId: "item-1",
      }, "req-cancel-again"),
      "BUSINESS_RULE_REJECTED",
    );
  });
});

// ── W4: Quantity Change (modeled as adding more items) ───────────────────────

describe("W4: Quantity Change", () => {
  test("adding more of the same item increases quantity via a new ORDER_ITEMS_ADDED event", () => {
    expectOk(runCommand(COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-4",
      tableId: "table-1",
    }));

    // Add 2 biryanis
    expectOk(runCommand(COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId: "order-4",
      items: [{ id: "item-1", menuItemId: "menu-1", name: "Biryani", price: 250, quantity: 2 }],
    }));

    // Add 1 more biryani as a separate line item
    expectOk(runCommand(COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId: "order-4",
      items: [{ id: "item-2", menuItemId: "menu-1", name: "Biryani", price: 250, quantity: 1 }],
    }));

    const items = getOrderItems(db, "order-4");
    expect(items.length).toBe(2);
    // Both are active
    const active = getActiveOrderItems(db, "order-4");
    expect(active.length).toBe(2);

    // Total: 250*2 + 250*1 = 750
    const order = getOrder(db, "order-4");
    expect(order!.total_amount).toBe(750);
  });
});

// ── W5: Send KOT ─────────────────────────────────────────────────────────────

describe("W5: Send KOT", () => {
  test("KOT generated from order items, event appended, KOT SQLite table written", () => {
    expectOk(runCommand(COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-5",
      tableId: "table-5",
    }));

    expectOk(runCommand(COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId: "order-5",
      items: [
        { id: "item-1", menuItemId: "menu-1", name: "Biryani", price: 250, quantity: 2 },
        { id: "item-2", menuItemId: "menu-2", name: "Coke", price: 50, quantity: 1 },
      ],
    }));

    const result = expectOk(runCommand(COMMAND_TYPES.SEND_KOT, {
      kotId: "kot-1",
      orderId: "order-5",
      tableId: "table-5",
    }));

    expect(result.kotNumber).toBe(1);
    expect(result.itemCount).toBe(2);

    // KOT in SQLite
    const kot = getKot(db, "kot-1");
    expect(kot).not.toBeNull();
    expect(kot!.status).toBe("SENT");
    expect(kot!.order_id).toBe("order-5");
    expect(kot!.table_id).toBe("table-5");

    // KOT items
    const kotItems = getKotItems(db, "kot-1");
    expect(kotItems.length).toBe(2);
    expect(kotItems[0].name).toBe("Biryani");

    // Order items linked to KOT
    const items = getOrderItems(db, "order-5");
    expect(items.every((i) => i.kot_id === "kot-1")).toBe(true);
  });

  test("rejects KOT for order with no unsent items", () => {
    expectOk(runCommand(COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-5b",
      tableId: "table-5b",
    }));
    expectOk(runCommand(COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId: "order-5b",
      items: [{ id: "item-1", menuItemId: "menu-1", name: "Test", price: 100, quantity: 1 }],
    }));
    expectOk(runCommand(COMMAND_TYPES.SEND_KOT, {
      kotId: "kot-5b",
      orderId: "order-5b",
      tableId: "table-5b",
    }));

    // Try to send another KOT — no unsent items
    expectFail(
      runCommand(COMMAND_TYPES.SEND_KOT, {
        kotId: "kot-5b-2",
        orderId: "order-5b",
        tableId: "table-5b",
      }),
      "BUSINESS_RULE_REJECTED",
    );
  });
});

// ── W6: Cancel KOT ───────────────────────────────────────────────────────────

describe("W6: Cancel KOT", () => {
  test("KOT cancelled, compensating event, KOT table marked cancelled, order items unlinked", () => {
    expectOk(runCommand(COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-6",
      tableId: "table-6",
    }));
    expectOk(runCommand(COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId: "order-6",
      items: [{ id: "item-1", menuItemId: "menu-1", name: "Biryani", price: 250, quantity: 1 }],
    }));
    expectOk(runCommand(COMMAND_TYPES.SEND_KOT, {
      kotId: "kot-6",
      orderId: "order-6",
      tableId: "table-6",
    }));

    // Cancel the KOT
    expectOk(runCommand(COMMAND_TYPES.CANCEL_KOT, {
      kotId: "kot-6",
      orderId: "order-6",
    }));

    const kot = getKot(db, "kot-6");
    expect(kot!.status).toBe("CANCELLED");
    expect(kot!.cancelled_at).not.toBeNull();

    // KOT items cancelled
    const kotItems = getKotItems(db, "kot-6");
    expect(kotItems.every((i) => i.status === "CANCELLED")).toBe(true);

    // Order items unlinked from KOT
    const items = getOrderItems(db, "order-6");
    expect(items[0].kot_id).toBeNull();
  });

  test("rejects cancelling already-cancelled KOT", () => {
    expectOk(runCommand(COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-6b",
      tableId: "table-6b",
    }));
    expectOk(runCommand(COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId: "order-6b",
      items: [{ id: "item-1", menuItemId: "menu-1", name: "Test", price: 100, quantity: 1 }],
    }));
    expectOk(runCommand(COMMAND_TYPES.SEND_KOT, {
      kotId: "kot-6b",
      orderId: "order-6b",
      tableId: "table-6b",
    }));
    expectOk(runCommand(COMMAND_TYPES.CANCEL_KOT, {
      kotId: "kot-6b",
      orderId: "order-6b",
    }));

    expectFail(
      runCommand(COMMAND_TYPES.CANCEL_KOT, {
        kotId: "kot-6b",
        orderId: "order-6b",
      }, "req-cancel-kot-again"),
      "BUSINESS_RULE_REJECTED",
    );
  });
});

// ── W7: Generate Bill ────────────────────────────────────────────────────────

describe("W7: Generate Bill", () => {
  test("bill generated from order state, event appended, bill table written (no payment)", () => {
    expectOk(runCommand(COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-7",
      tableId: "table-7",
    }));
    expectOk(runCommand(COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId: "order-7",
      items: [
        { id: "item-1", menuItemId: "menu-1", name: "Biryani", price: 250, quantity: 2 },
        { id: "item-2", menuItemId: "menu-2", name: "Coke", price: 50, quantity: 1 },
      ],
    }));

    const result = expectOk(runCommand(COMMAND_TYPES.GENERATE_BILL, {
      billId: "bill-7",
      orderId: "order-7",
      taxRate: 5,
      serviceChargePercent: 10,
    }));

    // subtotal = 550, tax = 27.5, service = 55, total = 632.5
    expect(result.subtotal).toBe(550);
    expect(result.taxAmount).toBe(27.5);
    expect(result.serviceCharge).toBe(55);
    expect(result.totalAmount).toBe(632.5);
    expect(result.billNumber).toBe(1);

    // Bill in SQLite
    const bill = getBill(db, "bill-7");
    expect(bill).not.toBeNull();
    expect(bill!.status).toBe("GENERATED");
    expect(bill!.total_amount).toBe(632.5);

    // Order marked as BILLED
    const order = getOrder(db, "order-7");
    expect(order!.status).toBe("BILLED");
  });

  test("rejects bill for order with no active items", () => {
    expectOk(runCommand(COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-7b",
      tableId: "table-7b",
    }));
    expectOk(runCommand(COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId: "order-7b",
      items: [{ id: "item-1", menuItemId: "menu-1", name: "Test", price: 100, quantity: 1 }],
    }));
    expectOk(runCommand(COMMAND_TYPES.CANCEL_ORDER_ITEM, {
      orderId: "order-7b",
      orderItemId: "item-1",
    }));

    expectFail(
      runCommand(COMMAND_TYPES.GENERATE_BILL, {
        billId: "bill-7b",
        orderId: "order-7b",
      }),
      "BUSINESS_RULE_REJECTED",
    );
  });

  test("rejects duplicate bill for same order", () => {
    expectOk(runCommand(COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-7c",
      tableId: "table-7c",
    }));
    expectOk(runCommand(COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId: "order-7c",
      items: [{ id: "item-1", menuItemId: "menu-1", name: "Test", price: 100, quantity: 1 }],
    }));
    expectOk(runCommand(COMMAND_TYPES.GENERATE_BILL, {
      billId: "bill-7c",
      orderId: "order-7c",
    }));

    expectFail(
      runCommand(COMMAND_TYPES.GENERATE_BILL, {
        billId: "bill-7c-2",
        orderId: "order-7c",
      }, "req-dup-bill"),
      "BUSINESS_RULE_REJECTED",
    );
  });
});

// ── W8: Restart During Order ─────────────────────────────────────────────────

describe("W8: Restart During Order", () => {
  test("Runtime restart mid-order preserves all committed state", () => {
    // Simulate: create order, add items, then "restart" by creating a new db
    // connection to the same file-backed database
    const tmpDir = require("node:os").tmpdir();
    const dbPath = `${tmpDir}/runtime-v2-w8-${Date.now()}.db`;
    const fileDb = new Database(dbPath);
    fileDb.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    initRuntimeV2Schema(fileDb);
    fileDb.exec(`
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

    // Create order and add items before "restart"
    let ctx = context("req-w8-1");
    executeCommand(fileDb, COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-w8",
      tableId: "table-w8",
    }, ctx);

    ctx = context("req-w8-2");
    executeCommand(fileDb, COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId: "order-w8",
      items: [{ id: "item-w8", menuItemId: "menu-1", name: "Biryani", price: 250, quantity: 2 }],
    }, ctx);

    // Simulate restart: close and reopen the database
    fileDb.close();
    const reopened = new Database(dbPath);
    reopened.exec("PRAGMA foreign_keys = ON;");

    // All state preserved
    const order = getOrder(reopened, "order-w8");
    expect(order).not.toBeNull();
    expect(order!.status).toBe("OPEN");
    expect(order!.total_amount).toBe(500);

    const items = getOrderItems(reopened, "order-w8");
    expect(items.length).toBe(1);
    expect(items[0].name).toBe("Biryani");

    // Events preserved
    expect(countEvents(reopened)).toBe(2);

    reopened.close();
    // Cleanup
    try { require("node:fs").unlinkSync(dbPath); } catch {}
    try { require("node:fs").unlinkSync(`${dbPath}-wal`); } catch {}
    try { require("node:fs").unlinkSync(`${dbPath}-shm`); } catch {}
  });
});

// ── W9: Offline → Reconnect (simulated) ──────────────────────────────────────

describe("W9: Offline → Reconnect", () => {
  test("captain creates order offline, event is pending upload, order appears in SQLite", () => {
    // In the real system, the upload worker handles the cloud sync.
    // Here we verify that the command succeeds without any cloud connectivity
    // and the event is in 'pending' delivery state (ready for upload when
    // connectivity returns).

    const result = expectOk(runCommand(COMMAND_TYPES.CREATE_ORDER, {
      orderId: "order-w9",
      tableId: "table-w9",
    }));

    expect(result.orderId).toBe("order-w9");

    // Order is in SQLite immediately (no cloud needed)
    const order = getOrder(db, "order-w9");
    expect(order).not.toBeNull();
    expect(order!.status).toBe("OPEN");

    // Event is pending delivery (not yet uploaded)
    const { getDeliveryStatus } = require("../core/eventStore.ts");
    const events = (require("../core/eventStore.ts").readEventsAfterSeq(db, 0, 10)) as any[];
    expect(events.length).toBe(1);
    const deliveryStatus = getDeliveryStatus(db, events[0].eventId);
    expect(deliveryStatus).toBe("pending");
  });
});

// ── Projection discovery ─────────────────────────────────────────────────────

describe("Milestone 2 projection discovery", () => {
  test("all Milestone 2 event types have registered projections", () => {
    const discovery = discoverProjections([...MILESTONE_2_EVENT_TYPES]);
    expect(discovery.eventTypesWithoutHandlers).toEqual([]);
    expect(discovery.duplicateEventTypes).toEqual([]);
  });
});
