// ─────────────────────────────────────────────────────────────────────────────
// order-flow.e2e.test.ts — Level 1 E2E: Order → KOT → Print dispatch → DB state
// ─────────────────────────────────────────────────────────────────────────────
// Spawns the real edge-server as a subprocess with an isolated temp SQLite DB.
// Seeds a fake session + outlet + menu, then simulates a captain app creating
// an order via POST /api/edge/order. Asserts the full business flow:
//   - Order + order_items written to SQLite
//   - KOT + KOT items written
//   - Print job persisted in durable queue with valid ESC/POS data
//   - Table status → OCCUPIED, revision incremented, bill updated
//   - Sync queue entries enqueued for cloud push
//   - Command log idempotency entry recorded
//   - GET /api/edge/orders and /api/edge/tables reflect the new state
//   - Duplicate request is rejected with 409
//   - /runtime/shutdown exits cleanly
//
// No cloud backend, no physical printer, no Tauri app required.
// Print service is not spawned (no PRINT_SERVICE_EXE) — print jobs are persisted
// but dispatch fails gracefully (status → "retrying").
//
// Run: cd edge-server && bun test tests/e2e/order-flow.e2e.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// ── Constants ─────────────────────────────────────────────────────────────────

const EDGE_PORT = "4201";
const BASE_URL = `http://localhost:${EDGE_PORT}`;

const RESTAURANT_ID = "e2e-restaurant-001";
const VENUE_ID = "e2e-venue-001";
const FLOOR_ID = "e2e-floor-001";
const SECTION_ID = "e2e-section-001";
const TABLE_ID = "e2e-table-001";
const CATEGORY_ID = "e2e-category-001";
const MENU_ITEM_ID = "e2e-menu-item-001";

const edgeServerDir = join(dirname(import.meta.path), "..", "..");

// ── Shared state ──────────────────────────────────────────────────────────────

let serverProc: ReturnType<typeof Bun.spawn>;
let tempDir: string;
let dbPath: string;
let runtimeToken: string;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForHealth(deadlineMs = 30_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return; // Server is accepting requests — operational state doesn't matter for setup
    } catch {
      // server not ready yet
    }
    await Bun.sleep(500);
  }
  throw new Error(`Edge server did not become healthy within ${deadlineMs / 1000}s`);
}

function seedDatabase(): void {
  const db = new Database(dbPath);
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const expiresAt = now + 365 * 24 * 60 * 60 * 1000;

  const upsertConfig = (key: string, value: string) =>
    db.query("INSERT OR REPLACE INTO edge_config (key, value, updated_at) VALUES (?, ?, ?)").run(key, value, now);

  // ── Session (fake — bypasses cloud registration) ────────────────────────────
  upsertConfig("session_token", "e2e-session-token");
  upsertConfig("restaurant_id", RESTAURANT_ID);
  upsertConfig("restaurant_name", "E2E Test Restaurant");
  upsertConfig("restaurant_code", "E2E001");
  upsertConfig("backend_url", "http://localhost:9999");
  upsertConfig("session_expires_at", String(expiresAt));

  // ── Config sync state (isLocalReady requires this) ──────────────────────────
  db.query("INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)")
    .run("config_sync_completed", "true", now);

  // ── Outlet ──────────────────────────────────────────────────────────────────
  db.query(
    `INSERT INTO outlet (id, name, slug, restaurant_code, is_active, synced_at) VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(RESTAURANT_ID, "E2E Test Restaurant", "e2e-test", "E2E001", nowSec);

  // ── Venue → Floor → Section → Table ─────────────────────────────────────────
  db.query(
    `INSERT INTO venue (id, restaurant_id, name, venue_type, is_active, is_deleted, kot_enabled, synced_at) VALUES (?, ?, ?, 'DINE_IN', 1, 0, 1, ?)`,
  ).run(VENUE_ID, RESTAURANT_ID, "Main Hall", nowSec);

  db.query(
    `INSERT INTO floor (id, venue_id, restaurant_id, name, is_active, synced_at) VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(FLOOR_ID, VENUE_ID, RESTAURANT_ID, "Ground Floor", nowSec);

  db.query(
    `INSERT INTO section (id, restaurant_id, floor_id, venue_id, name, is_active, synced_at) VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(SECTION_ID, RESTAURANT_ID, FLOOR_ID, VENUE_ID, "Main Section", nowSec);

  db.query(
    `INSERT INTO "table" (id, number, capacity, status, section_id, restaurant_id, revision, updated_at) VALUES (?, 1, 4, 'AVAILABLE', ?, ?, 1, ?)`,
  ).run(TABLE_ID, SECTION_ID, RESTAURANT_ID, nowSec);

  // ── Category → Menu Item ────────────────────────────────────────────────────
  db.query(
    `INSERT INTO category (id, name, restaurant_id, is_active, synced_at) VALUES (?, ?, ?, 1, ?)`,
  ).run(CATEGORY_ID, "Kitchen", RESTAURANT_ID, nowSec);

  db.query(
    `INSERT INTO menu_item (id, name, category_id, restaurant_id, base_price, is_available, is_deleted, is_veg, menu_type, gst_enabled, printer_name, synced_at) VALUES (?, ?, ?, ?, 150, 1, 0, 1, 'FOOD', 1, 'KitchenPrinter', ?)`,
  ).run(MENU_ITEM_ID, "Paneer Butter Masala", CATEGORY_ID, RESTAURANT_ID, nowSec);

  db.close();
}

function readRuntimeToken(): string {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query("SELECT value FROM edge_config WHERE key = ?").get("runtime_token") as { value: string } | null;
  db.close();
  if (!row?.value) throw new Error("Runtime token not found in DB — server may not have started");
  return row.value;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${runtimeToken}`, "Content-Type": "application/json" };
}

function openDb(): Database {
  return new Database(dbPath, { readonly: true });
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "edge-e2e-"));
  dbPath = join(tempDir, "edge.db");

  serverProc = Bun.spawn({
    cmd: [process.execPath, "run", "server.ts"],
    cwd: edgeServerDir,
    env: {
      ...process.env,
      EDGE_PORT,
      EDGE_DB_PATH: dbPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  await waitForHealth();
  seedDatabase();
  runtimeToken = readRuntimeToken();
}, 60_000);

afterAll(async () => {
  try {
    await fetch(`${BASE_URL}/runtime/shutdown`, {
      method: "POST",
      headers: authHeaders(),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // server may already be down
  }
  try {
    serverProc.kill();
  } catch {
    // already exited
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test("E2E: /health returns ok after startup", async () => {
  const res = await fetch(`${BASE_URL}/health`);
  expect(res.ok).toBe(true);
  const body: any = await res.json();
  expect(body.service).toBe("softshape-edge-server");
});

test("E2E: /runtime/status returns correct shape", async () => {
  const res = await fetch(`${BASE_URL}/runtime/status`, { headers: authHeaders() });
  expect(res.ok).toBe(true);
  const body: any = await res.json();
  expect(body).toHaveProperty("running");
  expect(body).toHaveProperty("ready");
  expect(body).toHaveProperty("state");
  expect(body).toHaveProperty("services");
});

test("E2E: POST /api/edge/order creates order + KOT + print job", async () => {
  const requestId = `e2e-order-${Date.now()}`;
  const res = await fetch(`${BASE_URL}/api/edge/order`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      tableId: TABLE_ID,
      items: [{
        menuItemId: MENU_ITEM_ID,
        name: "Paneer Butter Masala",
        price: 150,
        quantity: 2,
      }],
      captainId: "e2e-captain",
      captainName: "E2E Captain",
      platform: "DINE_IN",
      requestId,
    }),
  });

  expect(res.ok).toBe(true);
  const body: any = await res.json();
  expect(body.success).toBe(true);
  expect(body.orderId).toBeTruthy();
  expect(body.kotNumber).toBeGreaterThan(0);

  // Wait for async print dispatch to settle
  await Bun.sleep(1000);

  // ── Verify SQLite state ─────────────────────────────────────────────────────
  const db = openDb();

  // Order
  const order = db.query("SELECT * FROM order_record WHERE id = ?").get(body.orderId) as any;
  expect(order).toBeTruthy();
  expect(order.status).toBe("PREPARING");
  expect(Number(order.total_amount)).toBe(300);
  expect(order.revision).toBe(1);
  expect(order.last_request_id).toBe(requestId);

  // Order items
  const orderItems = db.query("SELECT * FROM order_item WHERE order_id = ?").all(body.orderId) as any[];
  expect(orderItems.length).toBe(1);
  expect(orderItems[0].name).toBe("Paneer Butter Masala");
  expect(orderItems[0].quantity).toBe(2);
  expect(Number(orderItems[0].price)).toBe(150);

  // KOT
  const kot = db.query("SELECT * FROM kot WHERE order_id = ?").get(body.orderId) as any;
  expect(kot).toBeTruthy();
  expect(kot.kot_number).toBe(body.kotNumber);

  // KOT items
  const kotItems = db.query("SELECT * FROM kot_item WHERE kot_id = ?").all(kot.id) as any[];
  expect(kotItems.length).toBe(1);
  expect(kotItems[0].name).toBe("Paneer Butter Masala");
  expect(kotItems[0].quantity).toBe(2);

  // Print job (durable queue — persisted inside the transaction)
  const printJob = db.query("SELECT * FROM print_job WHERE order_id = ?").get(body.orderId) as any;
  expect(printJob).toBeTruthy();
  expect(printJob.job_type).toBe("KOT");
  expect(printJob.printer_name).toBe("KitchenPrinter");
  expect(printJob.kot_number).toBe(body.kotNumber);
  // Status should be "retrying" (print service not running) or "queued"
  expect(["queued", "retrying", "printing"]).toContain(printJob.status);
  // ESC/POS data is valid JSON array with content
  const escpos = JSON.parse(printJob.escpos_data);
  expect(Array.isArray(escpos)).toBe(true);
  expect(escpos.length).toBeGreaterThan(0);

  // Table updated
  const table = db.query('SELECT * FROM "table" WHERE id = ?').get(TABLE_ID) as any;
  expect(table.status).toBe("OCCUPIED");
  expect(table.workflow_status).toBe("Preparing");
  expect(Number(table.current_bill)).toBe(300);
  expect(table.revision).toBeGreaterThan(1);
  expect(table.last_command_id).toBe(requestId);

  // Sync queue entries (order, kot, table)
  const syncEntries = db.query("SELECT * FROM sync_queue WHERE synced = 0").all() as any[];
  const tableSync = syncEntries.filter((e) => e.record_id === TABLE_ID);
  const orderSync = syncEntries.filter((e) => e.record_id === body.orderId);
  const kotSync = syncEntries.filter((e) => e.record_id === kot.id);
  expect(orderSync.length).toBeGreaterThanOrEqual(1);
  expect(kotSync.length).toBeGreaterThanOrEqual(1);
  expect(tableSync.length).toBeGreaterThanOrEqual(1);

  // Command log (idempotency)
  const cmdLog = db.query("SELECT * FROM command_log WHERE request_id = ?").get(requestId) as any;
  expect(cmdLog).toBeTruthy();
  expect(cmdLog.status).toBe("applied");
  expect(cmdLog.command_type).toBe("createOrder");

  db.close();
});

test("E2E: GET /api/edge/orders returns the created order with items", async () => {
  const res = await fetch(`${BASE_URL}/api/edge/orders`, { headers: authHeaders() });
  expect(res.ok).toBe(true);
  const orders: any = await res.json();
  expect(Array.isArray(orders)).toBe(true);
  expect(orders.length).toBeGreaterThanOrEqual(1);

  const order = orders[0];
  expect(order.status).toBe("PREPARING");
  expect(order.items).toBeTruthy();
  expect(order.items.length).toBe(1);
  expect(order.items[0].name).toBe("Paneer Butter Masala");
  expect(order.items[0].quantity).toBe(2);
});

test("E2E: GET /api/edge/tables shows table as OCCUPIED", async () => {
  const res = await fetch(`${BASE_URL}/api/edge/tables`, { headers: authHeaders() });
  expect(res.ok).toBe(true);
  const sections: any = await res.json();
  expect(Array.isArray(sections)).toBe(true);

  let foundTable: any = null;
  for (const section of sections) {
    if (section.tables) {
      foundTable = section.tables.find((t: any) => t.id === TABLE_ID);
      if (foundTable) break;
    }
  }
  expect(foundTable).toBeTruthy();
  expect(foundTable.status).toBe("OCCUPIED");
});

test("E2E: duplicate order on same table is rejected with 409", async () => {
  const res = await fetch(`${BASE_URL}/api/edge/order`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      tableId: TABLE_ID,
      items: [{ menuItemId: MENU_ITEM_ID, name: "Paneer Butter Masala", price: 150, quantity: 1 }],
      requestId: `e2e-dup-${Date.now()}`,
    }),
  });

  expect(res.status).toBe(409);
  const body: any = await res.json();
  expect(body.success).toBe(false);
  expect(body.error).toContain("Table already has an active order");
});

test("E2E: POST /runtime/shutdown exits cleanly", async () => {
  try {
    const res = await fetch(`${BASE_URL}/runtime/shutdown`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.ok).toBe(true);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
  } catch (err: any) {
    // ECONNRESET is expected — the server exits immediately after sending the response
    if (err?.code !== "ECONNRESET") throw err;
  }

  const exitCode = await serverProc.exited;
  expect(exitCode).toBe(0);
});
