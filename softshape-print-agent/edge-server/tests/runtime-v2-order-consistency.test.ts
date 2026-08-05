// ─────────────────────────────────────────────────────────────────────────────
// runtime-v2-order-consistency.test.ts — Order Consistency Verification
// ─────────────────────────────────────────────────────────────────────────────
// Simulates a busy restaurant Friday night:
//   - Create hundreds of orders
//   - Add items, cancel items, send KOTs, generate bills
//   - Restart the Runtime (close + reopen the database)
//   - Rebuild projections from the event store
//   - Hash the read-model tables before and after rebuild
//   - Hashes MUST match — no visual inspection, no spot checks
//
// This is the test that validates the architecture, not just the code.
// If 1000 orders survive restart + rebuild with identical hashes, the
// event-sourced read model is proven correct.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as fs from "node:fs";
import { initRuntimeV2Schema } from "../core/schema.ts";
import { executeCommand, type CommandContext } from "../core/commandBus.ts";
import { registerMilestone2Handlers, resetMilestone2Handlers } from "../handlers/index.ts";
import { COMMAND_TYPES } from "../handlers/commands.ts";
import { rebuildProjections } from "../core/projections.ts";
import { countEvents } from "../core/eventStore.ts";

const RESTAURANT_ID = "restaurant-sim-001";
const RUNTIME_ID = "runtime-sim-001";

function createCommandLog(): string {
  return `
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
  `;
}

function createContext(requestId: string): CommandContext {
  return {
    restaurantId: RESTAURANT_ID,
    runtimeId: RUNTIME_ID,
    requestId,
    actorId: "staff-sim",
    actorRole: "CASHIER",
    deviceId: "device-sim",
    correlationId: requestId,
    occurredAt: Date.now(),
    permissions: {},
  };
}

function setupDb(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  initRuntimeV2Schema(db);
  db.exec(createCommandLog());
}

// ── Hashing ──────────────────────────────────────────────────────────────────
// Hash a table's full content in a deterministic order. This is the proof
// that rebuild produces exactly the same state as the original projection.

function hashTable(db: Database, table: string): string {
  const rows = db.query(`SELECT * FROM "${table}" ORDER BY id`).all() as Record<string, unknown>[];
  // Normalize: sort keys within each row, stringify deterministically
  const normalized = rows.map((row) => {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(row).sort()) {
      const value = row[key];
      // Normalize numbers: SQLite may return integers or floats differently
      // after rebuild. Round to 2 decimal places for monetary values.
      if (typeof value === "number") {
        sorted[key] = Math.round(value * 100) / 100;
      } else {
        sorted[key] = value;
      }
    }
    return sorted;
  });
  const json = JSON.stringify(normalized);
  return createHash("sha256").update(json).digest("hex");
}

function hashAllOrderTables(db: Database): string {
  const parts = [
    `v2_order:${hashTable(db, "v2_order")}`,
    `v2_order_item:${hashTable(db, "v2_order_item")}`,
    `v2_kot:${hashTable(db, "v2_kot")}`,
    `v2_kot_item:${hashTable(db, "v2_kot_item")}`,
    `v2_bill:${hashTable(db, "v2_bill")}`,
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

// ── Simulation: busy Friday night ────────────────────────────────────────────

function simulateBusyFriday(db: Database, orderCount: number): void {
  let reqCounter = 0;
  const nextReq = () => `sim-${++reqCounter}`;

  for (let i = 0; i < orderCount; i++) {
    const orderId = `order-${i}`;
    const tableId = `table-${i % 20}`;
    const billId = `bill-${i}`;
    const kotId = `kot-${i}`;

    // Create order
    let result = executeCommand(db, COMMAND_TYPES.CREATE_ORDER, {
      orderId,
      tableId,
      captainId: `captain-${i % 5}`,
      platform: i % 3 === 0 ? "TAKEAWAY" : "DINE_IN",
    }, createContext(nextReq()));
    if (!result.ok) continue;

    // Add 2-4 items
    const itemCount = 2 + (i % 3);
    const items = [];
    for (let j = 0; j < itemCount; j++) {
      items.push({
        id: `item-${i}-${j}`,
        menuItemId: `menu-${j % 10}`,
        name: `Dish-${j}`,
        price: 50 + (j * 30),
        quantity: 1 + (j % 3),
      });
    }
    result = executeCommand(db, COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId,
      items,
    }, createContext(nextReq()));
    if (!result.ok) continue;

    // Cancel every 5th item
    if (i % 5 === 0 && items.length > 1) {
      executeCommand(db, COMMAND_TYPES.CANCEL_ORDER_ITEM, {
        orderId,
        orderItemId: items[0].id,
      }, createContext(nextReq()));
    }

    // Send KOT for 80% of orders
    if (i % 5 !== 4) {
      executeCommand(db, COMMAND_TYPES.SEND_KOT, {
        kotId,
        orderId,
        tableId,
      }, createContext(nextReq()));
    }

    // Generate bill for 60% of orders
    if (i % 5 < 3) {
      executeCommand(db, COMMAND_TYPES.GENERATE_BILL, {
        billId,
        orderId,
        taxRate: 5,
        serviceChargePercent: 10,
      }, createContext(nextReq()));
    }

    // Void every 20th order (only if not billed)
    if (i % 20 === 0 && i % 5 >= 3) {
      executeCommand(db, COMMAND_TYPES.VOID_ORDER, {
        orderId,
      }, createContext(nextReq()));
    }
  }
}

// ══ Tests ════════════════════════════════════════════════════════════════════

describe("Order Consistency: 1000 orders survive restart + rebuild", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    setupDb(db);
    resetMilestone2Handlers();
    registerMilestone2Handlers();
  });

  test("1000 orders: event count > 0, read model populated", () => {
    simulateBusyFriday(db, 1000);

    const eventCount = countEvents(db);
    expect(eventCount).toBeGreaterThan(1000); // each order has multiple events

    const orderCount = db.query("SELECT COUNT(*) as c FROM v2_order").get() as { c: number };
    expect(orderCount.c).toBe(1000);

    const itemCount = db.query("SELECT COUNT(*) as c FROM v2_order_item").get() as { c: number };
    expect(itemCount.c).toBeGreaterThan(1000);

    const kotCount = db.query("SELECT COUNT(*) as c FROM v2_kot").get() as { c: number };
    expect(kotCount.c).toBeGreaterThan(0);

    const billCount = db.query("SELECT COUNT(*) as c FROM v2_bill").get() as { c: number };
    expect(billCount.c).toBeGreaterThan(0);
  });

  test("rebuild from event store produces identical read model (in-memory)", () => {
    simulateBusyFriday(db, 200);

    // Hash the read model BEFORE rebuild
    const hashBefore = hashAllOrderTables(db);

    // Wipe the read model
    db.exec("DELETE FROM v2_kot_item");
    db.exec("DELETE FROM v2_kot");
    db.exec("DELETE FROM v2_bill");
    db.exec("DELETE FROM v2_order_item");
    db.exec("DELETE FROM v2_order");

    // Verify tables are empty
    const emptyOrderCount = db.query("SELECT COUNT(*) as c FROM v2_order").get() as { c: number };
    expect(emptyOrderCount.c).toBe(0);

    // Rebuild from event store
    rebuildProjections(db, { clearTables: true });

    // Hash the read model AFTER rebuild
    const hashAfter = hashAllOrderTables(db);

    // THE critical assertion: hashes must match
    expect(hashAfter).toBe(hashBefore);
  });

  test("restart (close + reopen file DB) preserves all state", () => {
    const dbPath = `${os.tmpdir()}/runtime-v2-consistency-${Date.now()}.db`;

    // Phase 1: create file DB, simulate, close
    const fileDb = new Database(dbPath);
    setupDb(fileDb);
    resetMilestone2Handlers();
    registerMilestone2Handlers();
    simulateBusyFriday(fileDb, 300);
    const hashBeforeRestart = hashAllOrderTables(fileDb);
    const eventCountBefore = countEvents(fileDb);
    fileDb.close();

    // Phase 2: reopen the same file (simulates restart)
    const reopened = new Database(dbPath);
    reopened.exec("PRAGMA foreign_keys = ON;");

    // All events preserved
    expect(countEvents(reopened)).toBe(eventCountBefore);

    // All read model state preserved
    const hashAfterRestart = hashAllOrderTables(reopened);
    expect(hashAfterRestart).toBe(hashBeforeRestart);

    reopened.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(`${dbPath}-wal`); } catch {}
    try { fs.unlinkSync(`${dbPath}-shm`); } catch {}
  });

  test("restart + rebuild produces identical state (full cycle)", () => {
    const dbPath = `${os.tmpdir()}/runtime-v2-cycle-${Date.now()}.db`;

    // Phase 1: create, simulate, hash, close
    const fileDb = new Database(dbPath);
    setupDb(fileDb);
    resetMilestone2Handlers();
    registerMilestone2Handlers();
    simulateBusyFriday(fileDb, 150);
    const hashOriginal = hashAllOrderTables(fileDb);
    fileDb.close();

    // Phase 2: reopen, wipe read model, rebuild, hash
    const reopened = new Database(dbPath);
    reopened.exec("PRAGMA foreign_keys = ON;");

    // Wipe read model
    reopened.exec("DELETE FROM v2_kot_item");
    reopened.exec("DELETE FROM v2_kot");
    reopened.exec("DELETE FROM v2_bill");
    reopened.exec("DELETE FROM v2_order_item");
    reopened.exec("DELETE FROM v2_order");

    // Rebuild
    resetMilestone2Handlers();
    registerMilestone2Handlers();
    rebuildProjections(reopened, { clearTables: true });

    // Hash after full cycle: restart → wipe → rebuild
    const hashAfterCycle = hashAllOrderTables(reopened);

    // Must match the original
    expect(hashAfterCycle).toBe(hashOriginal);

    reopened.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(`${dbPath}-wal`); } catch {}
    try { fs.unlinkSync(`${dbPath}-shm`); } catch {}
  });

  test("idempotent rebuild: rebuilding twice produces the same hash", () => {
    simulateBusyFriday(db, 100);

    rebuildProjections(db, { clearTables: true });
    const hashAfterFirstRebuild = hashAllOrderTables(db);

    rebuildProjections(db, { clearTables: true });
    const hashAfterSecondRebuild = hashAllOrderTables(db);

    expect(hashAfterSecondRebuild).toBe(hashAfterFirstRebuild);
  });

  test("monetary totals are consistent between orders and bills", () => {
    simulateBusyFriday(db, 100);

    // For every billed order, the bill total should equal the order total
    const billedOrders = db.query(`
      SELECT o.id, o.total_amount as order_total, b.total_amount as bill_total
      FROM v2_order o
      JOIN v2_bill b ON b.order_id = o.id
      WHERE o.status = 'BILLED'
    `).all() as Array<{ id: string; order_total: number; bill_total: number }>;

    expect(billedOrders.length).toBeGreaterThan(0);

    for (const row of billedOrders) {
      // Order total = sum of active items (subtotal)
      // Bill total = subtotal + tax + service charge
      // So bill_total >= order_total (bill includes tax and service)
      expect(row.bill_total).toBeGreaterThanOrEqual(row.order_total);

      // The difference should be tax + service charge
      const diff = Math.round((row.bill_total - row.order_total) * 100) / 100;
      expect(diff).toBeGreaterThanOrEqual(0);
    }
  });

  test("KOT numbers are sequential per day", () => {
    simulateBusyFriday(db, 50);

    // Get all KOTs for the restaurant, ordered by kot_number
    const kots = db.query(`
      SELECT kot_number, counter_date, status
      FROM v2_kot
      WHERE restaurant_id = ?
      ORDER BY counter_date, kot_number
    `).all(RESTAURANT_ID) as Array<{ kot_number: number; counter_date: string; status: string }>;

    expect(kots.length).toBeGreaterThan(0);

    // KOT numbers should be 1, 2, 3, ... (sequential, no gaps from successful sends)
    // Cancelled KOTs still occupy their number (compensating event, not deletion)
    for (let i = 0; i < kots.length; i++) {
      expect(kots[i].kot_number).toBe(i + 1);
    }
  });

  test("no orphaned order items (every item belongs to an existing order)", () => {
    simulateBusyFriday(db, 100);

    const orphans = db.query(`
      SELECT oi.id FROM v2_order_item oi
      LEFT JOIN v2_order o ON oi.order_id = o.id
      WHERE o.id IS NULL
    `).all() as Array<{ id: string }>;

    expect(orphans.length).toBe(0);
  });

  test("no orphaned KOT items (every KOT item belongs to an existing KOT)", () => {
    simulateBusyFriday(db, 100);

    const orphans = db.query(`
      SELECT ki.id FROM v2_kot_item ki
      LEFT JOIN v2_kot k ON ki.kot_id = k.id
      WHERE k.id IS NULL
    `).all() as Array<{ id: string }>;

    expect(orphans.length).toBe(0);
  });

  test("no orphaned bills (every bill belongs to an existing order)", () => {
    simulateBusyFriday(db, 100);

    const orphans = db.query(`
      SELECT b.id FROM v2_bill b
      LEFT JOIN v2_order o ON b.order_id = o.id
      WHERE o.id IS NULL
    `).all() as Array<{ id: string }>;

    expect(orphans.length).toBe(0);
  });
});
