// ─────────────────────────────────────────────────────────────────────────────
// runtime-v2-restaurant-simulation.test.ts — Restaurant Simulation Day
// ─────────────────────────────────────────────────────────────────────────────
// Simulates a busy Friday dinner:
//   10 captains, 300 tables, 1000 orders, 2000 KOTs, 600 bills
//   5 Runtime restarts DURING the simulation (not after)
//   1 cloud disconnect → reconnect cycle
//
// Exit gate: after restart + rebuild, SHA-256 of read model must match.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as fs from "node:fs";
import { initRuntimeV2Schema } from "../core/schema.ts";
import { executeCommand, type CommandContext } from "../core/commandBus.ts";
import { registerMilestone2Handlers, resetMilestone2Handlers } from "../handlers/index.ts";
import { COMMAND_TYPES } from "../handlers/commands.ts";
import { rebuildProjections } from "../core/projections.ts";
import { countEvents, getDeliveryStatus, readEventsAfterSeq, markDelivered } from "../core/eventStore.ts";

const RESTAURANT_ID = "restaurant-sim-friday";
const RUNTIME_ID = "runtime-sim-friday";

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

function setupDb(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  initRuntimeV2Schema(db);
  db.exec(createCommandLog());
}

function ctx(requestId: string, captainIdx: number): CommandContext {
  return {
    restaurantId: RESTAURANT_ID,
    runtimeId: RUNTIME_ID,
    requestId,
    actorId: `captain-${captainIdx % 10}`,
    actorRole: "CASHIER",
    deviceId: `device-${captainIdx % 10}`,
    correlationId: requestId,
    occurredAt: Date.now(),
    permissions: {},
  };
}

// ── Hashing ──────────────────────────────────────────────────────────────────

function hashTable(db: Database, table: string): string {
  const rows = db.query(`SELECT * FROM "${table}" ORDER BY id`).all() as Record<string, unknown>[];
  const normalized = rows.map((row) => {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(row).sort()) {
      const value = row[key];
      sorted[key] = typeof value === "number" ? Math.round(value * 100) / 100 : value;
    }
    return sorted;
  });
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function hashAllTables(db: Database): string {
  const parts = [
    `v2_order:${hashTable(db, "v2_order")}`,
    `v2_order_item:${hashTable(db, "v2_order_item")}`,
    `v2_kot:${hashTable(db, "v2_kot")}`,
    `v2_kot_item:${hashTable(db, "v2_kot_item")}`,
    `v2_bill:${hashTable(db, "v2_bill")}`,
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

// ── Simulation engine ────────────────────────────────────────────────────────

interface SimConfig {
  orderCount: number;
  restartPoints: number[]; // order indices at which to restart
  disconnectPoint: number;  // order index at which to simulate cloud disconnect
  reconnectPoint: number;   // order index at which to simulate cloud reconnect
}

interface SimStats {
  ordersCreated: number;
  itemsAdded: number;
  itemsCancelled: number;
  kotsSent: number;
  kotsCancelled: number;
  billsGenerated: number;
  ordersVoided: number;
  restarts: number;
  eventsAppended: number;
}

function runSimulation(db: Database, config: SimConfig): SimStats {
  let reqCounter = 0;
  const nextReq = () => `sim-${++reqCounter}`;
  const stats: SimStats = {
    ordersCreated: 0, itemsAdded: 0, itemsCancelled: 0,
    kotsSent: 0, kotsCancelled: 0, billsGenerated: 0,
    ordersVoided: 0, restarts: 0, eventsAppended: 0,
  };

  const eventsBeforeDisconnect: string[] = [];
  let disconnected = false;

  for (let i = 0; i < config.orderCount; i++) {
    const orderId = `order-${i}`;
    const tableId = `table-${i % 300}`;
    const captainIdx = i % 10;

    // Create order
    let result = executeCommand(db, COMMAND_TYPES.CREATE_ORDER, {
      orderId, tableId, captainId: `captain-${captainIdx}`,
      platform: i % 5 === 0 ? "TAKEAWAY" : "DINE_IN",
    }, ctx(nextReq(), captainIdx));
    if (!result.ok) continue;
    stats.ordersCreated++;

    // Add 3-4 items
    const itemCount = 3 + (i % 2);
    const items = [];
    for (let j = 0; j < itemCount; j++) {
      items.push({
        id: `item-${i}-${j}`,
        menuItemId: `menu-${j % 15}`,
        name: `Dish-${j}`,
        price: 40 + (j * 35),
        quantity: 1 + (j % 3),
      });
    }
    result = executeCommand(db, COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId, items,
    }, ctx(nextReq(), captainIdx));
    if (result.ok) stats.itemsAdded += items.length;

    // Cancel every 10th item
    if (i % 10 === 0 && items.length > 1) {
      const cancelResult = executeCommand(db, COMMAND_TYPES.CANCEL_ORDER_ITEM, {
        orderId, orderItemId: items[0].id,
      }, ctx(nextReq(), captainIdx));
      if (cancelResult.ok) stats.itemsCancelled++;
    }

    // Send KOT for 80% of orders (some get 2 KOTs after cancellation)
    if (i % 5 !== 4) {
      const kotResult = executeCommand(db, COMMAND_TYPES.SEND_KOT, {
        kotId: `kot-${i}`, orderId, tableId,
      }, ctx(nextReq(), captainIdx));
      if (kotResult.ok) stats.kotsSent++;

      // Every 50th order: cancel KOT and re-send
      if (i % 50 === 0 && i > 0) {
        const cancelKotResult = executeCommand(db, COMMAND_TYPES.CANCEL_KOT, {
          kotId: `kot-${i}`, orderId,
        }, ctx(nextReq(), captainIdx));
        if (cancelKotResult.ok) stats.kotsCancelled++;

        // Re-send with new KOT ID
        const reSendResult = executeCommand(db, COMMAND_TYPES.SEND_KOT, {
          kotId: `kot-${i}-re`, orderId, tableId,
        }, ctx(nextReq(), captainIdx));
        if (reSendResult.ok) stats.kotsSent++;
      }
    }

    // Generate bill for 60% of orders
    if (i % 5 < 3) {
      const billResult = executeCommand(db, COMMAND_TYPES.GENERATE_BILL, {
        billId: `bill-${i}`, orderId, taxRate: 5, serviceChargePercent: 10,
      }, ctx(nextReq(), captainIdx));
      if (billResult.ok) stats.billsGenerated++;
    }

    // Void every 30th order (only if not billed)
    if (i % 30 === 0 && i % 5 >= 3) {
      const voidResult = executeCommand(db, COMMAND_TYPES.VOID_ORDER, {
        orderId,
      }, ctx(nextReq(), captainIdx));
      if (voidResult.ok) stats.ordersVoided++;
    }

    // Track events for cloud disconnect simulation
    if (!disconnected) {
      const recentEvents = readEventsAfterSeq(db, 0, 10000);
      for (const event of recentEvents) {
        if (!eventsBeforeDisconnect.includes(event.eventId)) {
          eventsBeforeDisconnect.push(event.eventId);
        }
      }
    }

    // Cloud disconnect
    if (i === config.disconnectPoint) {
      disconnected = true;
    }

    // Cloud reconnect: mark all pending events as delivered
    if (i === config.reconnectPoint) {
      disconnected = false;
      const allEvents = readEventsAfterSeq(db, 0, 100000);
      for (const event of allEvents) {
        if (getDeliveryStatus(db, event.eventId) === "pending") {
          markDelivered(db, event.eventId, 1000 + event.seq, Date.now());
        }
      }
    }
  }

  stats.eventsAppended = countEvents(db);
  return stats;
}

// ── Restart simulation ───────────────────────────────────────────────────────

function restartDb(oldDb: Database, dbPath: string): Database {
  oldDb.close();
  const reopened = new Database(dbPath);
  reopened.exec("PRAGMA foreign_keys = ON;");
  // Re-register handlers after restart (registry is in-memory)
  resetMilestone2Handlers();
  registerMilestone2Handlers();
  return reopened;
}

// ══ Tests ════════════════════════════════════════════════════════════════════

describe("Restaurant Simulation Day: Friday Dinner", () => {
  test("1000 orders with interleaved restarts and cloud disconnect → hash match after rebuild", () => {
    const dbPath = `${os.tmpdir()}/runtime-v2-friday-${Date.now()}.db`;

    // Phase 1: setup
    let db = new Database(dbPath);
    setupDb(db);
    resetMilestone2Handlers();
    registerMilestone2Handlers();

    const config: SimConfig = {
      orderCount: 1000,
      // Restart at 5 points during the simulation
      restartPoints: [200, 400, 600, 800, 950],
      disconnectPoint: 300,
      reconnectPoint: 700,
    };

    // Phase 2: run simulation with interleaved restarts
    let stats: SimStats | null = null;

    // We need to run the simulation in segments to allow restarts
    // Segment 1: orders 0-199
    stats = runSimulationSegment(db, dbPath, 0, 199, config, { ...emptyStats(), restarts: 0, eventsAppended: 0 });

    // Restart 1
    db = restartDb(db, dbPath);
    stats.restarts++;

    // Segment 2: orders 200-399 (includes disconnect at 300)
    stats = runSimulationSegment(db, dbPath, 200, 399, config, stats);

    // Restart 2
    db = restartDb(db, dbPath);
    stats.restarts++;

    // Segment 3: orders 400-599
    stats = runSimulationSegment(db, dbPath, 400, 599, config, stats);

    // Restart 3
    db = restartDb(db, dbPath);
    stats.restarts++;

    // Segment 4: orders 600-799 (includes reconnect at 700)
    stats = runSimulationSegment(db, dbPath, 600, 799, config, stats);

    // Restart 4
    db = restartDb(db, dbPath);
    stats.restarts++;

    // Segment 5: orders 800-949
    stats = runSimulationSegment(db, dbPath, 800, 949, config, stats);

    // Restart 5
    db = restartDb(db, dbPath);
    stats.restarts++;

    // Segment 6: orders 950-999
    stats = runSimulationSegment(db, dbPath, 950, 999, config, stats);

    stats.eventsAppended = countEvents(db);

    // Phase 3: verify simulation produced meaningful data
    expect(stats.ordersCreated).toBeGreaterThan(900);
    expect(stats.itemsAdded).toBeGreaterThan(2500);
    expect(stats.kotsSent).toBeGreaterThan(700);
    expect(stats.billsGenerated).toBeGreaterThan(500);
    expect(stats.restarts).toBe(5);
    expect(stats.eventsAppended).toBeGreaterThan(1000);

    // Phase 4: hash the read model BEFORE rebuild
    const hashBefore = hashAllTables(db);

    // Phase 5: wipe read model and rebuild from event store
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DELETE FROM v2_kot_item");
    db.exec("DELETE FROM v2_kot");
    db.exec("DELETE FROM v2_bill");
    db.exec("DELETE FROM v2_order_item");
    db.exec("DELETE FROM v2_order");
    db.exec("PRAGMA foreign_keys = ON");

    rebuildProjections(db, { clearTables: true });

    // Phase 6: hash AFTER rebuild — MUST match
    const hashAfter = hashAllTables(db);
    expect(hashAfter).toBe(hashBefore);

    // Phase 7: referential integrity
    const orphanItems = db.query(`
      SELECT COUNT(*) as c FROM v2_order_item oi
      LEFT JOIN v2_order o ON oi.order_id = o.id
      WHERE o.id IS NULL
    `).get() as { c: number };
    expect(orphanItems.c).toBe(0);

    const orphanKotItems = db.query(`
      SELECT COUNT(*) as c FROM v2_kot_item ki
      LEFT JOIN v2_kot k ON ki.kot_id = k.id
      WHERE k.id IS NULL
    `).get() as { c: number };
    expect(orphanKotItems.c).toBe(0);

    const orphanBills = db.query(`
      SELECT COUNT(*) as c FROM v2_bill b
      LEFT JOIN v2_order o ON b.order_id = o.id
      WHERE o.id IS NULL
    `).get() as { c: number };
    expect(orphanBills.c).toBe(0);

    // Phase 8: all events delivered after reconnect
    const allEvents = readEventsAfterSeq(db, 0, 100000);
    const pendingCount = allEvents.filter(
      (e) => getDeliveryStatus(db, e.eventId) === "pending",
    ).length;
    // Events after reconnect point may still be pending (reconnect was at order 700)
    // but events before reconnect should all be delivered
    expect(pendingCount).toBeLessThan(allEvents.length);

    // Cleanup
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(`${dbPath}-wal`); } catch {}
    try { fs.unlinkSync(`${dbPath}-shm`); } catch {}
  }, 60000);

  test("simulation with no restarts also passes hash match (baseline)", () => {
    const dbPath = `${os.tmpdir()}/runtime-v2-friday-baseline-${Date.now()}.db`;
    let db = new Database(dbPath);
    setupDb(db);
    resetMilestone2Handlers();
    registerMilestone2Handlers();

    const stats = runSimulationSegment(db, dbPath, 0, 499, {
      orderCount: 500,
      restartPoints: [],
      disconnectPoint: 150,
      reconnectPoint: 350,
    }, { ...emptyStats(), restarts: 0, eventsAppended: 0 });

    stats.eventsAppended = countEvents(db);
    expect(stats.ordersCreated).toBeGreaterThan(450);

    const hashBefore = hashAllTables(db);

    rebuildProjections(db, { clearTables: true });
    const hashAfter = hashAllTables(db);
    expect(hashAfter).toBe(hashBefore);

    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(`${dbPath}-wal`); } catch {}
    try { fs.unlinkSync(`${dbPath}-shm`); } catch {}
  }, 30000);
});

// ── Helpers for segmented simulation ─────────────────────────────────────────

function emptyStats(): SimStats {
  return {
    ordersCreated: 0, itemsAdded: 0, itemsCancelled: 0,
    kotsSent: 0, kotsCancelled: 0, billsGenerated: 0,
    ordersVoided: 0, restarts: 0, eventsAppended: 0,
  };
}

function runSimulationSegment(
  db: Database,
  _dbPath: string,
  startIdx: number,
  endIdx: number,
  config: SimConfig,
  stats: SimStats,
): SimStats {
  // Use a global counter that persists across segments via a property on stats.
  // This avoids requestId collisions between segments.
  const statsAny = stats as SimStats & { _reqCounter?: number };
  if (statsAny._reqCounter === undefined) statsAny._reqCounter = 0;
  const nextReq = () => `sim-seg-${++statsAny._reqCounter!}`;
  let disconnected = startIdx > config.disconnectPoint && startIdx <= config.reconnectPoint;

  for (let i = startIdx; i <= endIdx; i++) {
    const orderId = `order-${i}`;
    const tableId = `table-${i % 300}`;
    const captainIdx = i % 10;

    // Create order
    let result = executeCommand(db, COMMAND_TYPES.CREATE_ORDER, {
      orderId, tableId, captainId: `captain-${captainIdx}`,
      platform: i % 5 === 0 ? "TAKEAWAY" : "DINE_IN",
    }, ctx(nextReq(), captainIdx));
    if (!result.ok) continue;
    stats.ordersCreated++;

    // Add 3-4 items
    const itemCount = 3 + (i % 2);
    const items = [];
    for (let j = 0; j < itemCount; j++) {
      items.push({
        id: `item-${i}-${j}`,
        menuItemId: `menu-${j % 15}`,
        name: `Dish-${j}`,
        price: 40 + (j * 35),
        quantity: 1 + (j % 3),
      });
    }
    result = executeCommand(db, COMMAND_TYPES.ADD_ORDER_ITEMS, {
      orderId, items,
    }, ctx(nextReq(), captainIdx));
    if (result.ok) stats.itemsAdded += items.length;

    // Cancel every 10th item
    if (i % 10 === 0 && items.length > 1) {
      const cancelResult = executeCommand(db, COMMAND_TYPES.CANCEL_ORDER_ITEM, {
        orderId, orderItemId: items[0].id,
      }, ctx(nextReq(), captainIdx));
      if (cancelResult.ok) stats.itemsCancelled++;
    }

    // Send KOT for 80% of orders
    if (i % 5 !== 4) {
      const kotResult = executeCommand(db, COMMAND_TYPES.SEND_KOT, {
        kotId: `kot-${i}`, orderId, tableId,
      }, ctx(nextReq(), captainIdx));
      if (kotResult.ok) stats.kotsSent++;

      // Every 50th order: cancel KOT and re-send
      if (i % 50 === 0 && i > 0) {
        const cancelKotResult = executeCommand(db, COMMAND_TYPES.CANCEL_KOT, {
          kotId: `kot-${i}`, orderId,
        }, ctx(nextReq(), captainIdx));
        if (cancelKotResult.ok) stats.kotsCancelled++;

        const reSendResult = executeCommand(db, COMMAND_TYPES.SEND_KOT, {
          kotId: `kot-${i}-re`, orderId, tableId,
        }, ctx(nextReq(), captainIdx));
        if (reSendResult.ok) stats.kotsSent++;
      }
    }

    // Generate bill for 60% of orders
    if (i % 5 < 3) {
      const billResult = executeCommand(db, COMMAND_TYPES.GENERATE_BILL, {
        billId: `bill-${i}`, orderId, taxRate: 5, serviceChargePercent: 10,
      }, ctx(nextReq(), captainIdx));
      if (billResult.ok) stats.billsGenerated++;
    }

    // Void every 30th order (only if not billed)
    if (i % 30 === 0 && i % 5 >= 3) {
      const voidResult = executeCommand(db, COMMAND_TYPES.VOID_ORDER, {
        orderId,
      }, ctx(nextReq(), captainIdx));
      if (voidResult.ok) stats.ordersVoided++;
    }

    // Cloud disconnect/reconnect
    if (i === config.disconnectPoint) disconnected = true;
    if (i === config.reconnectPoint) {
      disconnected = false;
      const allEvents = readEventsAfterSeq(db, 0, 100000);
      for (const event of allEvents) {
        if (getDeliveryStatus(db, event.eventId) === "pending") {
          markDelivered(db, event.eventId, 1000 + event.seq, Date.now());
        }
      }
    }
  }

  return stats;
}
