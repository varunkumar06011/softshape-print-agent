#!/usr/bin/env bun
// ─────────────────────────────────────────────────────────────────────────────
// simulate-friday.ts — Restaurant Simulation Day: Friday Dinner
// ─────────────────────────────────────────────────────────────────────────────
// Standalone script that runs a simulated Friday dinner and prints a report.
//
// Usage:  bun run scripts/simulate-friday.ts
// Exit:   0 = all checks pass, 1 = any anomaly detected
// ─────────────────────────────────────────────────────────────────────────────

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

// ── Config ───────────────────────────────────────────────────────────────────

const RESTAURANT_ID = "restaurant-sim-friday";
const RUNTIME_ID = "runtime-sim-friday";
const ORDER_COUNT = 1000;
const RESTART_POINTS = [200, 400, 600, 800, 950];
const DISCONNECT_POINT = 300;
const RECONNECT_POINT = 700;

// ── Helpers ──────────────────────────────────────────────────────────────────

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

let reqCounter = 0;
function nextReq(): string {
  return `sim-${++reqCounter}`;
}

function ctx(captainIdx: number): CommandContext {
  return {
    restaurantId: RESTAURANT_ID,
    runtimeId: RUNTIME_ID,
    requestId: nextReq(),
    actorId: `captain-${captainIdx % 10}`,
    actorRole: "CASHIER",
    deviceId: `device-${captainIdx % 10}`,
    correlationId: `sim-${reqCounter}`,
    occurredAt: Date.now(),
    permissions: {},
  };
}

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

function restartDb(oldDb: Database, dbPath: string): Database {
  oldDb.close();
  const reopened = new Database(dbPath);
  reopened.exec("PRAGMA foreign_keys = ON;");
  resetMilestone2Handlers();
  registerMilestone2Handlers();
  return reopened;
}

// ── Stats ────────────────────────────────────────────────────────────────────

interface SimStats {
  ordersCreated: number;
  itemsAdded: number;
  itemsCancelled: number;
  kotsSent: number;
  kotsCancelled: number;
  billsGenerated: number;
  ordersVoided: number;
  restarts: number;
  commandLatencies: number[];
}

function emptyStats(): SimStats {
  return {
    ordersCreated: 0, itemsAdded: 0, itemsCancelled: 0,
    kotsSent: 0, kotsCancelled: 0, billsGenerated: 0,
    ordersVoided: 0, restarts: 0, commandLatencies: [],
  };
}

// ── Simulation segment ───────────────────────────────────────────────────────

function runSegment(db: Database, startIdx: number, endIdx: number, stats: SimStats): void {
  for (let i = startIdx; i <= endIdx; i++) {
    const orderId = `order-${i}`;
    const tableId = `table-${i % 300}`;
    const captainIdx = i % 10;

    // Create order
    const t0 = performance.now();
    let result = executeCommand(db, COMMAND_TYPES.CREATE_ORDER, {
      orderId, tableId, captainId: `captain-${captainIdx}`,
      platform: i % 5 === 0 ? "TAKEAWAY" : "DINE_IN",
    }, ctx(captainIdx));
    stats.commandLatencies.push(performance.now() - t0);
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
    }, ctx(captainIdx));
    if (result.ok) stats.itemsAdded += items.length;

    // Cancel every 10th item
    if (i % 10 === 0 && items.length > 1) {
      const cancelResult = executeCommand(db, COMMAND_TYPES.CANCEL_ORDER_ITEM, {
        orderId, orderItemId: items[0].id,
      }, ctx(captainIdx));
      if (cancelResult.ok) stats.itemsCancelled++;
    }

    // Send KOT for 80% of orders
    if (i % 5 !== 4) {
      const kotResult = executeCommand(db, COMMAND_TYPES.SEND_KOT, {
        kotId: `kot-${i}`, orderId, tableId,
      }, ctx(captainIdx));
      if (kotResult.ok) stats.kotsSent++;

      // Every 50th order: cancel KOT and re-send
      if (i % 50 === 0 && i > 0) {
        const cancelKotResult = executeCommand(db, COMMAND_TYPES.CANCEL_KOT, {
          kotId: `kot-${i}`, orderId,
        }, ctx(captainIdx));
        if (cancelKotResult.ok) stats.kotsCancelled++;

        const reSendResult = executeCommand(db, COMMAND_TYPES.SEND_KOT, {
          kotId: `kot-${i}-re`, orderId, tableId,
        }, ctx(captainIdx));
        if (reSendResult.ok) stats.kotsSent++;
      }
    }

    // Generate bill for 60% of orders
    if (i % 5 < 3) {
      const billResult = executeCommand(db, COMMAND_TYPES.GENERATE_BILL, {
        billId: `bill-${i}`, orderId, taxRate: 5, serviceChargePercent: 10,
      }, ctx(captainIdx));
      if (billResult.ok) stats.billsGenerated++;
    }

    // Void every 30th order (only if not billed)
    if (i % 30 === 0 && i % 5 >= 3) {
      const voidResult = executeCommand(db, COMMAND_TYPES.VOID_ORDER, {
        orderId,
      }, ctx(captainIdx));
      if (voidResult.ok) stats.ordersVoided++;
    }

    // Cloud disconnect/reconnect
    if (i === RECONNECT_POINT) {
      const allEvents = readEventsAfterSeq(db, 0, 100000);
      for (const event of allEvents) {
        if (getDeliveryStatus(db, event.eventId) === "pending") {
          markDelivered(db, event.eventId, 1000 + event.seq, Date.now());
        }
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const dbPath = `${os.tmpdir()}/runtime-v2-friday-${Date.now()}.db`;
const simStart = performance.now();

console.log("");
console.log("═══════════════════════════════════════════════════════════════════════════");
console.log("  RESTAURANT SIMULATION DAY — Friday Dinner");
console.log("═══════════════════════════════════════════════════════════════════════════");
console.log("");
console.log(`  Profile:`);
console.log(`    Captains:           10`);
console.log(`    Tables:             300`);
console.log(`    Orders:             ${ORDER_COUNT}`);
console.log(`    Restart points:     ${RESTART_POINTS.join(", ")}`);
console.log(`    Cloud disconnect:   order #${DISCONNECT_POINT}`);
console.log(`    Cloud reconnect:    order #${RECONNECT_POINT}`);
console.log("");

// Phase 1: Setup
let db = new Database(dbPath);
setupDb(db);
resetMilestone2Handlers();
registerMilestone2Handlers();
console.log("[setup] Database initialized at", dbPath);

// Phase 2: Run simulation with interleaved restarts
const stats = emptyStats();
const segments: [number, number][] = [
  [0, 199], [200, 399], [400, 599], [600, 799], [800, 949], [950, 999],
];

for (let s = 0; s < segments.length; s++) {
  const [start, end] = segments[s];
  const segStart = performance.now();
  runSegment(db, start, end, stats);
  const segDuration = (performance.now() - segStart).toFixed(0);
  console.log(`[segment ${s + 1}] orders ${start}-${end} done in ${segDuration}ms`);

  // Restart between segments (not after the last one)
  if (s < segments.length - 1) {
    db = restartDb(db, dbPath);
    stats.restarts++;
    console.log(`[restart ${stats.restarts}] Runtime restarted (DB closed + reopened)`);
  }
}

const simDuration = (performance.now() - simStart).toFixed(0);
const eventCount = countEvents(db);
console.log("");
console.log("[simulation complete]");
console.log(`  Duration:            ${simDuration}ms`);
console.log(`  Events appended:     ${eventCount}`);
console.log("");

// Phase 3: Hash read model BEFORE rebuild
const hashBefore = hashAllTables(db);
console.log("[hash] Before rebuild:");
console.log(`  v2_order:        ${hashTable(db, "v2_order").slice(0, 16)}...`);
console.log(`  v2_order_item:   ${hashTable(db, "v2_order_item").slice(0, 16)}...`);
console.log(`  v2_kot:          ${hashTable(db, "v2_kot").slice(0, 16)}...`);
console.log(`  v2_kot_item:     ${hashTable(db, "v2_kot_item").slice(0, 16)}...`);
console.log(`  v2_bill:         ${hashTable(db, "v2_bill").slice(0, 16)}...`);
console.log(`  COMBINED:        ${hashBefore.slice(0, 16)}...`);
console.log("");

// Phase 4: Wipe read model and rebuild from event store
const rebuildStart = performance.now();
db.exec("PRAGMA foreign_keys = OFF");
db.exec("DELETE FROM v2_kot_item");
db.exec("DELETE FROM v2_kot");
db.exec("DELETE FROM v2_bill");
db.exec("DELETE FROM v2_order_item");
db.exec("DELETE FROM v2_order");
db.exec("PRAGMA foreign_keys = ON");
rebuildProjections(db, { clearTables: true });
const rebuildDuration = (performance.now() - rebuildStart).toFixed(0);
console.log(`[rebuild] Wiped 5 tables, replayed ${eventCount} events in ${rebuildDuration}ms`);

// Phase 5: Hash AFTER rebuild
const hashAfter = hashAllTables(db);
console.log("");
console.log("[hash] After rebuild:");
console.log(`  v2_order:        ${hashTable(db, "v2_order").slice(0, 16)}...`);
console.log(`  v2_order_item:   ${hashTable(db, "v2_order_item").slice(0, 16)}...`);
console.log(`  v2_kot:          ${hashTable(db, "v2_kot").slice(0, 16)}...`);
console.log(`  v2_kot_item:     ${hashTable(db, "v2_kot_item").slice(0, 16)}...`);
console.log(`  v2_bill:         ${hashTable(db, "v2_bill").slice(0, 16)}...`);
console.log(`  COMBINED:        ${hashAfter.slice(0, 16)}...`);
console.log("");

// Phase 6: Referential integrity
const orphanItems = (db.query(`
  SELECT COUNT(*) as c FROM v2_order_item oi
  LEFT JOIN v2_order o ON oi.order_id = o.id
  WHERE o.id IS NULL
`).get() as { c: number }).c;

const orphanKotItems = (db.query(`
  SELECT COUNT(*) as c FROM v2_kot_item ki
  LEFT JOIN v2_kot k ON ki.kot_id = k.id
  WHERE k.id IS NULL
`).get() as { c: number }).c;

const orphanBills = (db.query(`
  SELECT COUNT(*) as c FROM v2_bill b
  LEFT JOIN v2_order o ON b.order_id = o.id
  WHERE o.id IS NULL
`).get() as { c: number }).c;

// Phase 7: Delivery status
const allEvents = readEventsAfterSeq(db, 0, 100000);
const pendingCount = allEvents.filter(
  (e) => getDeliveryStatus(db, e.eventId) === "pending",
).length;
const deliveredCount = allEvents.length - pendingCount;

// Phase 8: Row counts
const rowCount = (table: string): number =>
  (db.query(`SELECT COUNT(*) as c FROM "${table}"`).get() as { c: number }).c;

// ── Report ───────────────────────────────────────────────────────────────────

const avgLatency = stats.commandLatencies.length > 0
  ? (stats.commandLatencies.reduce((a, b) => a + b, 0) / stats.commandLatencies.length).toFixed(2)
  : "N/A";
const maxLatency = stats.commandLatencies.length > 0
  ? Math.max(...stats.commandLatencies).toFixed(2)
  : "N/A";

console.log("═══════════════════════════════════════════════════════════════════════════");
console.log("  REPORT");
console.log("═══════════════════════════════════════════════════════════════════════════");
console.log("");
console.log("  Simulation stats:");
console.log(`    Orders created:        ${stats.ordersCreated}`);
console.log(`    Items added:           ${stats.itemsAdded}`);
console.log(`    Items cancelled:       ${stats.itemsCancelled}`);
console.log(`    KOTs sent:             ${stats.kotsSent}`);
console.log(`    KOTs cancelled:        ${stats.kotsCancelled}`);
console.log(`    Bills generated:       ${stats.billsGenerated}`);
console.log(`    Orders voided:         ${stats.ordersVoided}`);
console.log(`    Restarts:              ${stats.restarts}`);
console.log("");
console.log("  Event store:");
console.log(`    Total events:          ${eventCount}`);
console.log(`    Delivered to cloud:    ${deliveredCount}`);
console.log(`    Pending (post-reconnect): ${pendingCount}`);
console.log("");
console.log("  Read model row counts:");
console.log(`    v2_order:              ${rowCount("v2_order")}`);
console.log(`    v2_order_item:         ${rowCount("v2_order_item")}`);
console.log(`    v2_kot:                ${rowCount("v2_kot")}`);
console.log(`    v2_kot_item:           ${rowCount("v2_kot_item")}`);
console.log(`    v2_bill:               ${rowCount("v2_bill")}`);
console.log("");
console.log("  Performance:");
console.log(`    Total duration:        ${simDuration}ms`);
console.log(`    Rebuild duration:      ${rebuildDuration}ms`);
console.log(`    Avg command latency:   ${avgLatency}ms`);
console.log(`    Max command latency:   ${maxLatency}ms`);
console.log(`    Events/sec:            ${(eventCount / (parseFloat(simDuration) / 1000)).toFixed(0)}`);
console.log("");
console.log("  Referential integrity:");
console.log(`    Orphaned order items:  ${orphanItems}`);
console.log(`    Orphaned KOT items:    ${orphanKotItems}`);
console.log(`    Orphaned bills:        ${orphanBills}`);
console.log("");
console.log("  Hash comparison:");
console.log(`    Before rebuild:        ${hashBefore.slice(0, 32)}...`);
console.log(`    After rebuild:         ${hashAfter.slice(0, 32)}...`);
console.log(`    Match:                 ${hashBefore === hashAfter ? "YES ✓" : "NO ✗"}`);
console.log("");

// ── Verdict ──────────────────────────────────────────────────────────────────

let anomalies = 0;
const checks: [string, boolean][] = [
  ["Hash match (before == after rebuild)", hashBefore === hashAfter],
  ["No orphaned order items", orphanItems === 0],
  ["No orphaned KOT items", orphanKotItems === 0],
  ["No orphaned bills", orphanBills === 0],
  [`Orders created > 900 (${stats.ordersCreated})`, stats.ordersCreated > 900],
  [`Events appended > 1000 (${eventCount})`, eventCount > 1000],
  [`Restarts completed (${stats.restarts})`, stats.restarts === 5],
];

console.log("═══════════════════════════════════════════════════════════════════════════");
console.log("  CHECKS");
console.log("═══════════════════════════════════════════════════════════════════════════");
for (const [name, passed] of checks) {
  console.log(`    ${passed ? "✓ PASS" : "✗ FAIL"}  ${name}`);
  if (!passed) anomalies++;
}
console.log("");

console.log("═══════════════════════════════════════════════════════════════════════════");
if (anomalies === 0) {
  console.log("  VERDICT: ALL CHECKS PASSED — Architecture validated for Milestone 3");
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("");
} else {
  console.log(`  VERDICT: ${anomalies} CHECK(S) FAILED — Milestone 3 BLOCKED`);
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("");
}

// Cleanup
db.close();
try { fs.unlinkSync(dbPath); } catch {}
try { fs.unlinkSync(`${dbPath}-wal`); } catch {}
try { fs.unlinkSync(`${dbPath}-shm`); } catch {}

process.exit(anomalies === 0 ? 0 : 1);
