// ─────────────────────────────────────────────────────────────────────────────
// multi-pc.e2e.test.ts — two-billing-PC restaurant (dine-in + curry point)
// ─────────────────────────────────────────────────────────────────────────────
// Spawns the real edge-server for the CURRY-POINT PC next to a fake cloud
// (Bun.serve) and checks, end to end:
//   - the PC only shows its own venue (sections / tables / venues)
//   - /health reports captainHub=false + the bound venue (captain discovery skips it)
//   - a table order still prints its KOT to the shared kitchen printer
//   - the bill goes to the venue's own bill printer and carries the "C-" prefix
//   - a walk-in bill goes to the venue's bill printer too (was restaurant-wide)
//   - everything reaches the cloud: order + items + KOT + transaction with the
//     prefixed bill number, walk-in transaction with its bill number, and the
//     local rows are marked synced afterwards
//
// Run: cd edge-server && bun test tests/e2e/multi-pc.e2e.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const EDGE_PORT = "4202";
const CLOUD_PORT = 4302;
const BASE_URL = `http://localhost:${EDGE_PORT}`;

const RID = "mpc-restaurant";
const DINE = "mpc-venue-dine";
const CURRY = "mpc-venue-curry";
const CAT = "mpc-cat";
const ITEM = "mpc-item";
const CURRY_TABLE = "mpc-table-curry";
const DINE_TABLE = "mpc-table-dine";

const edgeServerDir = join(dirname(import.meta.path), "..", "..");

let serverProc: ReturnType<typeof Bun.spawn>;
let cloud: ReturnType<typeof Bun.serve>;
let tempDir: string;
let dbPath: string;
let runtimeToken: string;

// What the fake cloud received
const cloudOrders: any[] = [];
const cloudWalkins: any[] = [];

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${runtimeToken}`, "Content-Type": "application/json" };
}

async function post(path: string, body: any) {
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function get(path: string) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  return (await res.json()) as any;
}

function openDb(): Database {
  return new Database(dbPath, { readonly: true });
}

async function waitForHealth(deadlineMs = 30_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch { /* not ready */ }
    await Bun.sleep(500);
  }
  throw new Error("Edge server did not become healthy");
}

function seedDatabase(): void {
  const db = new Database(dbPath);
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const cfg = (k: string, v: string) =>
    db.query("INSERT OR REPLACE INTO edge_config (key, value, updated_at) VALUES (?, ?, ?)").run(k, v, now);
  cfg("session_token", "mpc-session-token");
  cfg("restaurant_id", RID);
  cfg("restaurant_name", "Multi PC Restaurant");
  cfg("restaurant_code", "MPC001");
  cfg("backend_url", `http://localhost:${CLOUD_PORT}`);
  cfg("session_expires_at", String(now + 365 * 24 * 3600 * 1000));
  db.query("INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)").run("config_sync_completed", "true", now);

  db.query(`INSERT INTO outlet (id, name, slug, restaurant_code, is_active, synced_at) VALUES (?, ?, ?, ?, 1, ?)`)
    .run(RID, "Multi PC Restaurant", "mpc", "MPC001", nowSec);

  const venue = db.query(
    `INSERT INTO venue (id, restaurant_id, name, venue_type, is_active, is_deleted, kot_enabled, bill_printer_name, synced_at) VALUES (?, ?, ?, ?, 1, 0, 1, ?, ?)`,
  );
  venue.run(DINE, RID, "Dine In", "DINE_IN", "DineBillPrinter", nowSec);
  venue.run(CURRY, RID, "Curry Point", "TAKEAWAY", "CurryBillPrinter", nowSec);

  for (const [v, sec, tbl] of [[DINE, "mpc-sec-dine", DINE_TABLE], [CURRY, "mpc-sec-curry", CURRY_TABLE]] as const) {
    db.query(`INSERT INTO section (id, restaurant_id, venue_id, name, is_default, synced_at) VALUES (?, ?, ?, ?, 0, ?)`)
      .run(sec, RID, v, sec === "mpc-sec-dine" ? "Hall" : "Counter", nowSec);
    db.query(`INSERT INTO "table" (id, number, capacity, status, section_id, restaurant_id, revision, updated_at) VALUES (?, 1, 4, 'AVAILABLE', ?, ?, 1, ?)`)
      .run(tbl, sec, RID, nowSec);
  }

  db.query(`INSERT INTO category (id, name, restaurant_id, is_active, synced_at) VALUES (?, ?, ?, 1, ?)`).run(CAT, "Curries", RID, nowSec);
  db.query(
    `INSERT INTO menu_item (id, name, category_id, restaurant_id, base_price, is_available, is_deleted, is_veg, menu_type, gst_enabled, printer_name, synced_at) VALUES (?, ?, ?, ?, 100, 1, 0, 1, 'FOOD', 1, 'SharedKitchenPrinter', ?)`,
  ).run(ITEM, "Chicken Curry", CAT, RID, nowSec);
  db.close();
}

beforeAll(async () => {
  // Fake cloud: accepts the sync endpoints the edge worker uses and records payloads.
  cloud = Bun.serve({
    port: CLOUD_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      if (url.pathname === "/api/edge/sync-order") {
        cloudOrders.push(body);
        return Response.json({ outcome: "applied", appliedRevision: body.snapshotRevision });
      }
      if (url.pathname === "/api/edge/sync-walkin-transaction") {
        cloudWalkins.push(body);
        return Response.json({ outcome: "applied", appliedRevision: body.snapshotRevision });
      }
      if (url.pathname === "/api/edge/sync") return Response.json({ accepted: [], rejected: [] });
      return Response.json({ error: "not found in fake cloud" }, { status: 404 });
    },
  });

  tempDir = mkdtempSync(join(tmpdir(), "edge-mpc-"));
  dbPath = join(tempDir, "edge.db");
  serverProc = Bun.spawn({
    cmd: [process.execPath, "run", "server.ts"],
    cwd: edgeServerDir,
    env: { ...process.env, EDGE_PORT, EDGE_DB_PATH: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForHealth();
  seedDatabase();
  const db = openDb();
  runtimeToken = (db.query("SELECT value FROM edge_config WHERE key = 'runtime_token'").get() as any).value;
  db.close();
}, 60_000);

afterAll(async () => {
  try { await fetch(`${BASE_URL}/runtime/shutdown`, { method: "POST", headers: authHeaders(), signal: AbortSignal.timeout(5000) }); } catch { /* down */ }
  try { serverProc.kill(); } catch { /* exited */ }
  try { cloud.stop(true); } catch { /* stopped */ }
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test("before configuring: PC behaves as a normal single-PC runtime (all venues, captains allowed)", async () => {
  const scope = await get("/api/edge/device-scope");
  expect(scope.boundVenueId).toBeNull();
  expect(scope.billPrefix).toBe("");
  expect(scope.captainHub).toBe(true);
  expect(scope.availableVenues.map((v: any) => v.id).sort()).toEqual([CURRY, DINE]);
  const sections = await get("/api/edge/sections");
  expect(sections.map((s: any) => s.venueId).sort()).toEqual([CURRY, DINE]);
});

test("binding to the curry point hides dine-in and tells captains to stay away", async () => {
  const r = await post("/api/edge/device-scope", { boundVenueId: CURRY, billPrefix: "C-", captainHub: false });
  expect(r.status).toBe(200);
  expect(r.body.boundVenueId).toBe(CURRY);

  const sections = await get("/api/edge/sections");
  expect(sections.map((s: any) => s.venueId)).toEqual([CURRY]);
  const venues = await get("/api/edge/venues");
  expect(venues.map((v: any) => v.id)).toEqual([CURRY]);
  const flat = await get("/api/edge/tables/flat");
  expect(flat.map((t: any) => t.id)).toEqual([CURRY_TABLE]);

  const health: any = await (await fetch(`${BASE_URL}/health`)).json();
  expect(health.captainHub).toBe(false);
  expect(health.boundVenueId).toBe(CURRY);

  // Bad input is rejected and changes nothing
  expect((await post("/api/edge/device-scope", { boundVenueId: "does-not-exist" })).status).toBe(400);
  expect((await post("/api/edge/device-scope", { billPrefix: "has space" })).status).toBe(400);
  expect((await get("/api/edge/device-scope")).boundVenueId).toBe(CURRY);
});

let orderId = "";

test("table order: KOT goes to the shared kitchen printer", async () => {
  const r = await post("/api/edge/order", {
    tableId: CURRY_TABLE,
    items: [{ menuItemId: ITEM, name: "Chicken Curry", price: 100, quantity: 2 }],
    captainId: "mpc-cashier",
    captainName: "Counter Cashier",
    platform: "DINE_IN",
    requestId: `mpc-order-${Date.now()}`,
  });
  expect(r.status).toBe(200);
  orderId = r.body.orderId;
  await Bun.sleep(800);
  const db = openDb();
  const job = db.query("SELECT * FROM print_job WHERE order_id = ? AND job_type = 'KOT'").get(orderId) as any;
  db.close();
  expect(job.printer_name).toBe("SharedKitchenPrinter");
});

test("table bill: venue bill printer + 'C-' bill number", async () => {
  const rb = await post("/api/edge/order/request-billing", { orderId, requestId: `mpc-rb-${Date.now()}` });
  expect(rb.status).toBe(200);
  const r = await post("/api/edge/order/print-bill", { orderId, tableNumber: "1", requestId: `mpc-pb-${Date.now()}` });
  expect(r.status).toBe(200);
  expect(r.body.billNumber).toBe("C-1");
  await Bun.sleep(500);
  const db = openDb();
  const job = db.query("SELECT * FROM print_job WHERE order_id = ? AND job_type = 'BILL'").get(orderId) as any;
  db.close();
  expect(job.printer_name).toBe("CurryBillPrinter");
});

test("settle the order", async () => {
  const r = await post("/api/edge/order/settle", {
    orderId,
    paymentMethod: "CASH",
    cashAmount: 210,
    subtotal: 200,
    cgst: 5,
    sgst: 5,
    grandTotal: 210,
    requestId: `mpc-settle-${Date.now()}`,
  });
  expect(r.status).toBe(200);
});

test("walk-in bill: goes to the venue bill printer (not the restaurant-wide one) with the next 'C-' number", async () => {
  const r = await post("/api/edge/print/walkin-bill", {
    restaurantId: RID,
    tableNumber: "1",
    items: [{ name: "Chicken Curry", quantity: 1, price: 100, menuType: "FOOD" }],
    subtotal: 100,
    grandTotal: 105,
    // Placeholder tag the cashier sends when no kot-disabled venue exists
    sectionTag: "venue-restaurant-parcel",
    sectionName: "Walk-in",
    requestId: `mpc-walkin-${Date.now()}`,
    billEventId: `mpc-walkin-bill-${Date.now()}`,
  });
  expect(r.status).toBe(200);
  expect(r.body.billNumber).toBe("C-2");
  await Bun.sleep(500);
  const db = openDb();
  const job = db.query("SELECT * FROM print_job WHERE job_type = 'BILL' AND order_id = '' ORDER BY id DESC").get() as any;
  db.close();
  expect(job.printer_name).toBe("CurryBillPrinter");

  const t = await post("/api/edge/transaction", {
    grandTotal: 105,
    subtotal: 100,
    paymentMethod: "CASH",
    items: [{ name: "Chicken Curry", quantity: 1, price: 100 }],
    billNumber: r.body.billNumber,
    sectionTag: "venue-restaurant-parcel",
    requestId: `mpc-walkin-txn-${Date.now()}`,
  });
  expect(t.status).toBe(200);
});

test("cloud sync: order, KOT, items, transaction and walk-in all reach the cloud with their prefixed bill numbers", async () => {
  let pushed: any = {};
  for (let i = 0; i < 5; i++) {
    pushed = await post("/api/edge/sync/push", {});
    if (cloudOrders.length > 0 && cloudWalkins.length > 0) break;
    await Bun.sleep(500);
  }
  // Give the background worker a moment too, then assert on what the fake cloud saw
  const deadline = Date.now() + 15_000;
  while ((cloudOrders.length === 0 || cloudWalkins.length === 0) && Date.now() < deadline) {
    await post("/api/edge/sync/push", {});
    await Bun.sleep(500);
  }

  const sent = cloudOrders.filter((o) => o.order?.id === orderId).pop();
  expect(sent).toBeTruthy();
  expect(sent.order.bill_number).toBe("C-1");
  expect(sent.order.status).toBe("SETTLED");
  expect(sent.items).toHaveLength(1);
  expect(sent.kots).toHaveLength(1);
  expect(sent.kots[0].items).toHaveLength(1);
  expect(sent.transactions.length).toBeGreaterThanOrEqual(1);
  expect(sent.restaurantId).toBe(RID);
  expect(typeof sent.deviceId).toBe("string");

  const walkin = cloudWalkins.pop();
  expect(walkin).toBeTruthy();
  expect(walkin.transaction.billNumber).toBe("C-2");

  // Local rows are marked synced once the cloud acknowledged them
  await Bun.sleep(500);
  const db = openDb();
  const order = db.query("SELECT revision, cloud_synced_version, cloud_synced FROM order_record WHERE id = ?").get(orderId) as any;
  const pending = db.query("SELECT COUNT(*) as c FROM order_record WHERE revision > cloud_synced_version AND is_deleted = 0").get() as any;
  const pendingWalkins = db.query("SELECT COUNT(*) as c FROM transaction_record WHERE kind = 'walkin' AND sync_version > cloud_synced_version").get() as any;
  db.close();
  expect(order.cloud_synced_version).toBe(order.revision);
  expect(order.cloud_synced).toBe(1);
  expect(pending.c).toBe(0);
  expect(pendingWalkins.c).toBe(0);
  expect(pushed).toBeDefined();
});

test("releasing the binding restores the all-venues view", async () => {
  const r = await post("/api/edge/device-scope", { boundVenueId: null, billPrefix: null, captainHub: true });
  expect(r.status).toBe(200);
  const sections = await get("/api/edge/sections");
  expect(sections.map((s: any) => s.venueId).sort()).toEqual([CURRY, DINE]);
  const health: any = await (await fetch(`${BASE_URL}/health`)).json();
  expect(health.captainHub).toBe(true);
  expect(health.boundVenueId).toBeNull();
});
