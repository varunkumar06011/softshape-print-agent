// Soak test for the edge→cloud sync engine.
//
// Creates an isolated test DB, starts a mock cloud server, and drives the sync
// engine's SQL queries directly (same SQL as sync.ts) to verify convergence,
// data integrity, and performance under load.
//
// Scenarios:
//   1. 1000 offline settlements → reconnect → converge + data integrity
//   2. Dinner rush (500 → sync → 250 while syncing → disconnect → 250 → reconnect)
//   3. Chaos (disconnect every 15s, kill/restart, repeat 10x)
//   4. Offline + crash + restart
//
// Usage: bun run dev-scripts/soak-test.ts [--skip-chaos]
//
// Uses os.tmpdir()/softshape-soak/ — never touches production data.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, existsSync } from "node:fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const SOAK_DIR = join(tmpdir(), "softshape-soak");
const DB_PATH = join(SOAK_DIR, "edge-test.db");
const MAX_ATTEMPTS = 5;
const MAX_BATCH_SIZE = 100;
const SYNC_INTERVAL_MS = 2000; // simulate sync cycle every 2s
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const SKIP_CHAOS = process.argv.includes("--skip-chaos");

// ─── Schema (matches db.ts production schema) ────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS order_record (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL,
    restaurant_id TEXT NOT NULL,
    status TEXT DEFAULT 'PENDING',
    total_amount REAL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    paid_at INTEGER,
    bill_number TEXT,
    cloud_synced INTEGER DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    is_extra_table INTEGER DEFAULT 0,
    platform TEXT DEFAULT 'DINE_IN'
  );

  CREATE TABLE IF NOT EXISTS order_item (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    menu_item_id TEXT,
    name TEXT,
    price REAL,
    quantity INTEGER DEFAULT 1,
    cloud_synced INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transaction_record (
    id TEXT PRIMARY KEY,
    order_id TEXT,
    kind TEXT DEFAULT 'settle',
    payload TEXT,
    cloud_synced INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    synced INTEGER DEFAULT 0,
    state TEXT DEFAULT 'pending'
  );
  CREATE INDEX IF NOT EXISTS idx_sync_queue_pending ON sync_queue(synced) WHERE synced = 0;
  CREATE INDEX IF NOT EXISTS idx_sync_queue_state ON sync_queue(state) WHERE state != 'pending';

  CREATE TABLE IF NOT EXISTS sync_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id INTEGER,
    table_name TEXT,
    record_id TEXT,
    operation TEXT,
    outcome TEXT,
    message TEXT,
    audited_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS edge_config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
  );
`;

// ─── collectBatch SQL (matches sync.ts production query) ─────────────────────

const COLLECT_BATCH_SQL = `
  SELECT * FROM sync_queue
  WHERE synced = 0
    AND state = 'pending'
    AND NOT (
      table_name IN ('transaction', 'walkin_transaction')
      AND EXISTS (
        SELECT 1 FROM transaction_record tr
        WHERE tr.id = sync_queue.record_id
          AND tr.order_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM sync_queue sq2
            WHERE sq2.table_name = 'order'
              AND sq2.record_id = tr.order_id
              AND sq2.synced = 0
              AND sq2.state IN ('pending', 'in_flight', 'waiting_dependency', 'dead_letter')
          )
          AND NOT EXISTS (
            SELECT 1 FROM order_record o
            WHERE o.id = tr.order_id
              AND o.cloud_synced = 1
          )
      )
    )
  ORDER BY
    CASE WHEN attempts >= ? THEN 2 ELSE 1 END,
    created_at ASC, id ASC
  LIMIT ?
`;

// ─── Mock cloud server ───────────────────────────────────────────────────────

interface MockCloudState {
  orders: Map<string, any>;
  transactions: Map<string, any>;
  isDown: boolean;
  port: number;
  server?: any;
}

function createMockCloud(port: number): MockCloudState {
  const state: MockCloudState = {
    orders: new Map(),
    transactions: new Map(),
    isDown: false,
    port,
  };

  const server = Bun.serve({
    port,
    async fetch(req) {
      if (state.isDown) {
        return new Response(JSON.stringify({ error: "Service Unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }

      const url = new URL(req.url);
      if (url.pathname === "/api/edge/sync" && req.method === "POST") {
        const body = await req.json() as any;
        const batch: any[] = body.batch || [];
        const accepted: number[] = [];
        const rejected: Array<{ queueId: number; error: string; outcome?: string }> = [];

        for (const item of batch) {
          const { queueId, tableName, recordId, data } = item;
          if (tableName === "order") {
            const orderId = recordId;
            if (state.orders.has(orderId)) {
              rejected.push({ queueId, error: "duplicate", outcome: "duplicate" });
            } else {
              state.orders.set(orderId, { ...data, id: orderId });
              accepted.push(queueId);
            }
          } else if (tableName === "transaction" || tableName === "walkin_transaction") {
            const txnId = recordId;
            if (state.transactions.has(txnId)) {
              rejected.push({ queueId, error: "duplicate", outcome: "duplicate" });
            } else {
              const orderId = data?.orderId || data?.order_id;
              if (orderId && !state.orders.has(orderId)) {
                rejected.push({ queueId, error: `Order ${orderId} not found`, outcome: "waiting_dependency" });
              } else {
                state.transactions.set(txnId, { ...data, id: txnId });
                accepted.push(queueId);
              }
            }
          } else {
            // Other table types — accept
            accepted.push(queueId);
          }
        }

        return new Response(JSON.stringify({ accepted, rejected }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  state.server = server;
  return state;
}

// ─── Test DB helpers ─────────────────────────────────────────────────────────

function deleteFileWithRetry(path: string, retries = 5): void {
  for (let i = 0; i < retries; i++) {
    try {
      if (existsSync(path)) rmSync(path);
      return;
    } catch {
      // Windows may lock the file briefly after db.close()
      if (i < retries - 1) {
        // Synchronous busy-wait for 200ms
        const start = Date.now();
        while (Date.now() - start < 200) { /* spin */ }
      }
    }
  }
}

function createTestDb(scenarioName?: string): Database {
  // Use a unique DB path per scenario to avoid Windows file locking issues
  const dbPath = scenarioName
    ? join(SOAK_DIR, `edge-test-${scenarioName}.db`)
    : DB_PATH;
  deleteFileWithRetry(dbPath);
  deleteFileWithRetry(dbPath + "-wal");
  deleteFileWithRetry(dbPath + "-shm");

  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);
  return db;
}

function settleOrder(
  db: Database,
  orderId: string,
  txnId: string,
  grandTotal: number,
  createdAt: number = Date.now(),
): void {
  const items = Math.floor(Math.random() * 5) + 1;
  const subtotal = grandTotal / 1.05; // 5% tax
  const tax = grandTotal - subtotal;
  const cgst = tax / 2;
  const sgst = tax / 2;
  const method = ["CASH", "CARD", "UPI"][Math.floor(Math.random() * 3)];

  db.query(
    `INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, paid_at, cloud_synced) VALUES (?, 'table-1', 'rest-1', 'SETTLED', ?, ?, 0)`,
  ).run(orderId, grandTotal, createdAt);

  for (let i = 0; i < items; i++) {
    db.query(
      `INSERT INTO order_item (id, order_id, menu_item_id, name, price, quantity, cloud_synced) VALUES (?, ?, ?, ?, ?, 1, 0)`,
    ).run(`${orderId}-item-${i}`, orderId, `menu-${i}`, `Item ${i}`, subtotal / items);
  }

  const payload = JSON.stringify({
    orderId,
    restaurantId: "rest-1",
    paymentMethod: method,
    grandTotal,
    subtotal,
    cgst,
    sgst,
    itemCount: items,
    amount: grandTotal,
    discountAmount: 0,
    localTxnId: txnId,
    settledAt: createdAt,
  });

  db.query(
    `INSERT INTO transaction_record (id, order_id, kind, payload, cloud_synced) VALUES (?, ?, 'settle', ?, 0)`,
  ).run(txnId, orderId, payload);

  db.query(
    `INSERT INTO sync_queue (table_name, record_id, operation, created_at, state) VALUES ('order', ?, 'insert', ?, 'pending')`,
  ).run(orderId, createdAt);
  db.query(
    `INSERT INTO sync_queue (table_name, record_id, operation, created_at, state) VALUES ('transaction', ?, 'insert', ?, 'pending')`,
  ).run(txnId, createdAt + 1);
}

// ─── Sync engine simulation (mirrors sync.ts logic) ──────────────────────────

interface SyncResult {
  pushed: number;
  accepted: number;
  rejected: number;
}

interface PerfMetrics {
  batchSizes: number[];
  queueDepths: number[];
  waitingDepths: number[];
  syncLatencies: number[]; // ms from enqueue to cloud appearance
  enqueueTimes: Map<string, number>; // recordId → enqueue timestamp
}

function createPerfMetrics(): PerfMetrics {
  return {
    batchSizes: [],
    queueDepths: [],
    waitingDepths: [],
    syncLatencies: [],
    enqueueTimes: new Map(),
  };
}

function recordEnqueueTimes(db: Database, metrics: PerfMetrics): void {
  const rows = db.query(`SELECT record_id, created_at FROM sync_queue WHERE synced = 0 AND state = 'pending'`).all() as any[];
  for (const row of rows) {
    if (!metrics.enqueueTimes.has(row.record_id)) {
      metrics.enqueueTimes.set(row.record_id, row.created_at);
    }
  }
}

function pollMetrics(db: Database, metrics: PerfMetrics): void {
  const pending = (db.query(`SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0 AND state = 'pending'`).get() as any).c;
  const waiting = (db.query(`SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0 AND state = 'waiting_dependency'`).get() as any).c;
  metrics.queueDepths.push(pending);
  metrics.waitingDepths.push(waiting);
}

async function runSyncCycle(
  db: Database,
  cloudUrl: string,
  metrics: PerfMetrics,
): Promise<SyncResult> {
  // claimBatch
  const batch = db.query(COLLECT_BATCH_SQL).all(MAX_ATTEMPTS, MAX_BATCH_SIZE) as any[];
  if (batch.length === 0) return { pushed: 0, accepted: 0, rejected: 0 };

  const queueIds = batch.map((b) => b.id);
  const placeholders = queueIds.map(() => "?").join(",");
  db.query(`UPDATE sync_queue SET state = 'in_flight', last_error = 'IN_FLIGHT' WHERE id IN (${placeholders}) AND synced = 0`)
    .run(...queueIds);

  // Build payload
  const payload: any[] = [];
  for (const row of batch) {
    let data: any = null;
    if (row.table_name === "order") {
      data = db.query("SELECT * FROM order_record WHERE id = ?").get(row.record_id) as any;
      if (data) {
        const items = db.query("SELECT * FROM order_item WHERE order_id = ?").all(row.record_id) as any[];
        data.items = items;
      }
    } else if (row.table_name === "transaction" || row.table_name === "walkin_transaction") {
      const txn = db.query("SELECT * FROM transaction_record WHERE id = ?").get(row.record_id) as any;
      if (txn) {
        data = JSON.parse(txn.payload);
      }
    }
    if (data) {
      payload.push({ queueId: row.id, tableName: row.table_name, recordId: row.record_id, operation: row.operation, data });
    }
  }

  metrics.batchSizes.push(payload.length);

  // Push to cloud
  let result: { accepted: number[]; rejected: Array<{ queueId: number; error: string; outcome?: string }> };
  try {
    const res = await fetch(`${cloudUrl}/api/edge/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restaurantId: "rest-1", deviceId: "test", schemaVersion: 7, pushedAt: new Date().toISOString(), batch: payload }),
    });
    if (!res.ok) {
      // Network error — increment attempts on all
      db.query(`UPDATE sync_queue SET attempts = attempts + 1, last_error = ?, state = 'pending' WHERE id IN (${placeholders})`)
        .run(`HTTP ${res.status}`, ...queueIds);
      return { pushed: payload.length, accepted: 0, rejected: payload.length };
    }
    result = await res.json() as any;
  } catch (err: any) {
    db.query(`UPDATE sync_queue SET attempts = attempts + 1, last_error = ?, state = 'pending' WHERE id IN (${placeholders})`)
      .run(err.message, ...queueIds);
    return { pushed: payload.length, accepted: 0, rejected: payload.length };
  }

  // Process accepted — markSynced (atomic)
  if (result.accepted.length > 0) {
    db.transaction(() => {
      const acceptedPlaceholders = result.accepted.map(() => "?").join(",");
      const rows = db.query(`SELECT id, table_name, record_id FROM sync_queue WHERE id IN (${acceptedPlaceholders})`).all(...result.accepted) as any[];
      for (const row of rows) {
        if (row.table_name === "order") {
          db.query("UPDATE order_record SET cloud_synced = 1 WHERE id = ?").run(row.record_id);
          // Flip waiting_dependency transactions for this order
          db.query(
            `UPDATE sync_queue SET state = 'pending', last_error = NULL
             WHERE state = 'waiting_dependency'
               AND table_name IN ('transaction', 'walkin_transaction')
               AND EXISTS (SELECT 1 FROM transaction_record tr WHERE tr.id = sync_queue.record_id AND tr.order_id = ?)`,
          ).run(row.record_id);
        } else if (row.table_name === "transaction" || row.table_name === "walkin_transaction") {
          db.query("UPDATE transaction_record SET cloud_synced = 1 WHERE id = ?").run(row.record_id);
        }

        // Record sync latency
        const enqueueTime = metrics.enqueueTimes.get(row.record_id);
        if (enqueueTime) {
          metrics.syncLatencies.push(Date.now() - enqueueTime);
          metrics.enqueueTimes.delete(row.record_id);
        }
      }
      db.query(`DELETE FROM sync_queue WHERE id IN (${acceptedPlaceholders})`).run(...result.accepted);
    })();
  }

  // Process rejected
  const dequeueIds: number[] = [];
  for (const rej of result.rejected) {
    if (rej.outcome === "waiting_dependency") {
      db.query("UPDATE sync_queue SET state = 'waiting_dependency', last_error = ? WHERE id = ?")
        .run(rej.error, rej.queueId);
    } else if (rej.outcome === "rejected" || rej.outcome === "conflict" || rej.outcome === "duplicate" || rej.outcome === "permanent") {
      dequeueIds.push(rej.queueId);
      const item = payload.find((p) => p.queueId === rej.queueId);
      if (item) {
        db.query(
          `INSERT INTO sync_audit (queue_id, table_name, record_id, operation, outcome, message, audited_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(rej.queueId, item.tableName, item.recordId, item.operation, rej.outcome, rej.error, Date.now());
      }
    } else {
      db.query(`UPDATE sync_queue SET attempts = attempts + 1, last_error = ?, state = 'pending' WHERE id = ?`)
        .run(rej.error, rej.queueId);
    }
  }
  if (dequeueIds.length > 0) {
    const dlPlaceholders = dequeueIds.map(() => "?").join(",");
    db.query(`DELETE FROM sync_queue WHERE id IN (${dlPlaceholders})`).run(...dequeueIds);
  }

  // Dead-letter exhausted
  db.query(`
    UPDATE sync_queue SET state = 'dead_letter',
      last_error = CASE WHEN last_error IS NULL OR last_error = 'IN_FLIGHT' THEN 'max attempts reached' ELSE last_error END
    WHERE synced = 0 AND attempts >= ? AND state != 'dead_letter'
  `).run(MAX_ATTEMPTS);

  return {
    pushed: payload.length,
    accepted: result.accepted.length,
    rejected: result.rejected.length - dequeueIds.length,
  };
}

async function waitForConvergence(
  db: Database,
  cloudUrl: string,
  metrics: PerfMetrics,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    pollMetrics(db, metrics);
    await runSyncCycle(db, cloudUrl, metrics);
    const remaining = (db.query(`SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0`).get() as any).c;
    if (remaining === 0) return true;
    await Bun.sleep(SYNC_INTERVAL_MS);
  }
  return false;
}

// ─── Data integrity verification ─────────────────────────────────────────────

function verifyDataIntegrity(db: Database, cloud: MockCloudState): { match: number; mismatch: number; details: string[] } {
  let match = 0;
  let mismatch = 0;
  const details: string[] = [];

  const localTxns = db.query(`SELECT id, payload FROM transaction_record`).all() as any[];
  for (const localTxn of localTxns) {
    const localData = JSON.parse(localTxn.payload);
    const cloudTxn = cloud.transactions.get(localTxn.id);
    if (!cloudTxn) {
      mismatch++;
      details.push(`Transaction ${localTxn.id} missing from cloud`);
      continue;
    }

    // Compare transaction-level fields (items are on the order, not the transaction)
    const fields = ["amount", "grandTotal", "cgst", "sgst", "itemCount", "method", "subtotal", "discountAmount"];
    let allMatch = true;
    for (const field of fields) {
      const localVal = localData[field];
      const cloudVal = cloudTxn[field];
      if (localVal !== cloudVal) {
        allMatch = false;
        details.push(`Transaction ${localTxn.id} field "${field}": local=${localVal} cloud=${cloudVal}`);
      }
    }

    // Verify the order's items count matches in the cloud
    const orderId = localData.orderId;
    const cloudOrder = cloud.orders.get(orderId);
    if (cloudOrder) {
      const localItems = db.query(`SELECT COUNT(*) as c FROM order_item WHERE order_id = ?`).get(orderId) as any;
      const cloudItems = cloudOrder.items?.length ?? 0;
      if (localItems.c !== cloudItems) {
        allMatch = false;
        details.push(`Order ${orderId} items: local=${localItems.c} cloud=${cloudItems}`);
      }
    }

    if (allMatch) {
      match++;
    } else {
      mismatch++;
    }
  }

  return { match, mismatch, details };
}

// ─── Performance metrics summary ─────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function printPerfMetrics(metrics: PerfMetrics): void {
  const nonZeroBatches = metrics.batchSizes.filter((b) => b > 0);
  const avgBatch = nonZeroBatches.length > 0
    ? nonZeroBatches.reduce((a, b) => a + b, 0) / nonZeroBatches.length
    : 0;
  const maxDepth = metrics.queueDepths.length > 0 ? Math.max(...metrics.queueDepths) : 0;
  const peakWaiting = metrics.waitingDepths.length > 0 ? Math.max(...metrics.waitingDepths) : 0;
  const sortedLatencies = [...metrics.syncLatencies].sort((a, b) => a - b);
  const avgLatency = sortedLatencies.length > 0
    ? sortedLatencies.reduce((a, b) => a + b, 0) / sortedLatencies.length
    : 0;
  const longestAge = sortedLatencies.length > 0 ? sortedLatencies[sortedLatencies.length - 1] : 0;
  const p95 = percentile(sortedLatencies, 95);

  console.log(`[Soak]   --- Performance ---`);
  console.log(`[Soak]   Average batch size: ${avgBatch.toFixed(1)}`);
  console.log(`[Soak]   Max queue depth: ${maxDepth}`);
  console.log(`[Soak]   Peak waiting_dependency: ${peakWaiting}`);
  console.log(`[Soak]   Longest queue age: ${(longestAge / 1000).toFixed(1)}s`);
  console.log(`[Soak]   Average sync latency: ${(avgLatency / 1000).toFixed(1)}s`);
  console.log(`[Soak]   95th percentile sync latency: ${(p95 / 1000).toFixed(1)}s`);
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

async function scenario1(db: Database, cloud: MockCloudState, cloudUrl: string): Promise<boolean> {
  console.log(`[Soak] Scenario 1: 1000 offline settlements`);
  const COUNT = 1000;
  const metrics = createPerfMetrics();
  const startTime = Date.now();

  // 1. Network down
  cloud.isDown = true;
  cloud.orders.clear();
  cloud.transactions.clear();

  // 2. Fire 1000 settlements
  db.transaction(() => {
    for (let i = 0; i < COUNT; i++) {
      settleOrder(db, `order-${i}`, `txn-${i}`, 100 + i * 10);
    }
  })();
  console.log(`[Soak]   Settlements: ${COUNT}`);

  // 3. Record enqueue times
  recordEnqueueTimes(db, metrics);

  // 4. Network up
  cloud.isDown = false;

  // 5. Wait for convergence
  const converged = await waitForConvergence(db, cloudUrl, metrics, 120_000);
  const syncTime = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!converged) {
    console.log(`[Soak] Scenario 1: FAILED (timeout — did not converge in 120s)`);
    return false;
  }

  // 6. Assertions
  const cloudOrders = cloud.orders.size;
  const cloudTxns = cloud.transactions.size;
  const duplicates = (db.query(`SELECT COUNT(*) as c FROM sync_audit WHERE outcome = 'duplicate'`).get() as any).c;
  const deadLetters = (db.query(`SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0 AND state = 'dead_letter'`).get() as any).c;
  const waitingDep = (db.query(`SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0 AND state = 'waiting_dependency'`).get() as any).c;
  const remaining = (db.query(`SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0`).get() as any).c;
  const integrity = verifyDataIntegrity(db, cloud);

  console.log(`[Soak]   Sync time: ${syncTime}s`);
  console.log(`[Soak]   Orders in cloud: ${cloudOrders} ${cloudOrders === COUNT ? "✓" : "✗"}`);
  console.log(`[Soak]   Transactions in cloud: ${cloudTxns} ${cloudTxns === COUNT ? "✓" : "✗"}`);
  console.log(`[Soak]   Duplicates: ${duplicates} ${duplicates === 0 ? "✓" : "✗"}`);
  console.log(`[Soak]   Dead letters: ${deadLetters} ${deadLetters === 0 ? "✓" : "✗"}`);
  console.log(`[Soak]   Waiting dependency: ${waitingDep} ${waitingDep === 0 ? "✓" : "✗"}`);
  console.log(`[Soak]   Queue remaining: ${remaining} ${remaining === 0 ? "✓" : "✗"}`);
  console.log(`[Soak]   Data integrity: ${integrity.match}/${COUNT} match ${integrity.mismatch === 0 ? "✓" : "✗"}`);
  if (integrity.mismatch > 0) {
    for (const d of integrity.details.slice(0, 5)) console.log(`[Soak]     ${d}`);
  }
  printPerfMetrics(metrics);

  const passed = cloudOrders === COUNT && cloudTxns === COUNT && deadLetters === 0 && waitingDep === 0 && remaining === 0 && integrity.mismatch === 0;
  console.log(`[Soak] Scenario 1: ${passed ? "PASSED" : "FAILED"}`);
  return passed;
}

async function scenario2(db: Database, cloud: MockCloudState, cloudUrl: string): Promise<boolean> {
  console.log(`[Soak] Scenario 2: Dinner rush`);
  const metrics = createPerfMetrics();
  const startTime = Date.now();

  cloud.isDown = true;
  cloud.orders.clear();
  cloud.transactions.clear();

  // 1. 500 offline
  db.transaction(() => {
    for (let i = 0; i < 500; i++) settleOrder(db, `order-r2-${i}`, `txn-r2-${i}`, 200 + i);
  })();
  recordEnqueueTimes(db, metrics);

  // 2. Network up — start syncing
  cloud.isDown = false;
  await runSyncCycle(db, cloudUrl, metrics);
  await Bun.sleep(5000);

  // 3. 250 more while syncing
  db.transaction(() => {
    for (let i = 0; i < 250; i++) settleOrder(db, `order-r2b-${i}`, `txn-r2b-${i}`, 300 + i);
  })();
  recordEnqueueTimes(db, metrics);
  await Bun.sleep(5000);

  // 4. Network down
  cloud.isDown = true;
  await Bun.sleep(2000);

  // 5. 250 more offline
  db.transaction(() => {
    for (let i = 0; i < 250; i++) settleOrder(db, `order-r2c-${i}`, `txn-r2c-${i}`, 400 + i);
  })();
  recordEnqueueTimes(db, metrics);

  // 6. Network up
  cloud.isDown = false;

  // 7. Converge
  const converged = await waitForConvergence(db, cloudUrl, metrics, 120_000);
  const syncTime = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!converged) {
    console.log(`[Soak] Scenario 2: FAILED (timeout)`);
    return false;
  }

  const totalOrders = 500 + 250 + 250;
  const integrity = verifyDataIntegrity(db, cloud);
  const deadLetters = (db.query(`SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0 AND state = 'dead_letter'`).get() as any).c;
  const remaining = (db.query(`SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0`).get() as any).c;

  console.log(`[Soak]   Sync time: ${syncTime}s`);
  console.log(`[Soak]   Orders in cloud: ${cloud.orders.size} ${cloud.orders.size === totalOrders ? "✓" : "✗"}`);
  console.log(`[Soak]   Transactions in cloud: ${cloud.transactions.size} ${cloud.transactions.size === totalOrders ? "✓" : "✗"}`);
  console.log(`[Soak]   Dead letters: ${deadLetters} ${deadLetters === 0 ? "✓" : "✗"}`);
  console.log(`[Soak]   Queue remaining: ${remaining} ${remaining === 0 ? "✓" : "✗"}`);
  console.log(`[Soak]   Data integrity: ${integrity.match}/${totalOrders} match, ${integrity.mismatch} mismatch ${integrity.mismatch === 0 ? "✓" : "✗"}`);
  if (integrity.mismatch > 0) {
    for (const d of integrity.details.slice(0, 5)) console.log(`[Soak]     ${d}`);
  }
  printPerfMetrics(metrics);

  const passed = cloud.orders.size === totalOrders && cloud.transactions.size === totalOrders && deadLetters === 0 && integrity.mismatch === 0 && remaining === 0;
  console.log(`[Soak] Scenario 2: ${passed ? "PASSED" : "FAILED"}`);
  return passed;
}

async function scenario3(db: Database, cloud: MockCloudState, cloudUrl: string): Promise<boolean> {
  console.log(`[Soak] Scenario 3: Chaos (network toggles + simulated restarts)`);
  const metrics = createPerfMetrics();
  const startTime = Date.now();

  cloud.orders.clear();
  cloud.transactions.clear();
  cloud.isDown = false;

  // 1. Fire 200 settlements
  db.transaction(() => {
    for (let i = 0; i < 200; i++) settleOrder(db, `order-c3-${i}`, `txn-c3-${i}`, 500 + i);
  })();
  recordEnqueueTimes(db, metrics);

  // 2. 10 cycles of chaos
  for (let cycle = 0; cycle < 10; cycle++) {
    // Network down for 5s
    cloud.isDown = true;
    await runSyncCycle(db, cloudUrl, metrics); // will fail
    await Bun.sleep(2000);

    // Network up
    cloud.isDown = false;
    await runSyncCycle(db, cloudUrl, metrics);
    await Bun.sleep(2000);

    // Simulate restart — reset in_flight rows to pending
    db.query(`UPDATE sync_queue SET state = 'pending', last_error = 'restart recovery' WHERE state = 'in_flight'`).run();
    pollMetrics(db, metrics);
  }

  // 3. Fire 200 more
  db.transaction(() => {
    for (let i = 0; i < 200; i++) settleOrder(db, `order-c3b-${i}`, `txn-c3b-${i}`, 700 + i);
  })();
  recordEnqueueTimes(db, metrics);

  // 4. Converge
  const converged = await waitForConvergence(db, cloudUrl, metrics, 180_000);
  const syncTime = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!converged) {
    console.log(`[Soak] Scenario 3: FAILED (timeout)`);
    return false;
  }

  const totalOrders = 400;
  const integrity = verifyDataIntegrity(db, cloud);
  const deadLetters = (db.query(`SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0 AND state = 'dead_letter'`).get() as any).c;
  const remaining = (db.query(`SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0`).get() as any).c;

  console.log(`[Soak]   Sync time: ${syncTime}s`);
  console.log(`[Soak]   Orders in cloud: ${cloud.orders.size} ${cloud.orders.size === totalOrders ? "✓" : "✗"}`);
  console.log(`[Soak]   Transactions in cloud: ${cloud.transactions.size} ${cloud.transactions.size === totalOrders ? "✓" : "✗"}`);
  console.log(`[Soak]   Dead letters: ${deadLetters} ${deadLetters === 0 ? "✓" : "✗"}`);
  console.log(`[Soak]   Data integrity: ${integrity.match}/${totalOrders} match ${integrity.mismatch === 0 ? "✓" : "✗"}`);
  printPerfMetrics(metrics);

  const passed = cloud.orders.size === totalOrders && cloud.transactions.size === totalOrders && deadLetters === 0 && integrity.mismatch === 0 && remaining === 0;
  console.log(`[Soak] Scenario 3: ${passed ? "PASSED" : "FAILED"}`);
  return passed;
}

async function scenario4(db: Database, cloud: MockCloudState, cloudUrl: string): Promise<boolean> {
  console.log(`[Soak] Scenario 4: Offline + crash + restart`);
  const metrics = createPerfMetrics();
  const startTime = Date.now();

  cloud.orders.clear();
  cloud.transactions.clear();

  // 1. Network down
  cloud.isDown = true;

  // 2. Fire 100 settlements
  db.transaction(() => {
    for (let i = 0; i < 100; i++) settleOrder(db, `order-c4-${i}`, `txn-c4-${i}`, 800 + i);
  })();
  recordEnqueueTimes(db, metrics);

  // 3. Simulate crash — claim some rows then "crash" (leave them in_flight)
  await runSyncCycle(db, cloudUrl, metrics); // will fail (network down), rows go to in_flight then back to pending

  // 4. Wait 3 seconds (simulating restart delay)
  await Bun.sleep(3000);

  // 5. Simulate restart — reset in_flight rows to pending
  db.query(`UPDATE sync_queue SET state = 'pending', last_error = 'crash recovery' WHERE state = 'in_flight'`).run();
  console.log(`[Soak]   Simulated crash + restart`);

  // 6. Network up
  cloud.isDown = false;

  // 7. Converge
  const converged = await waitForConvergence(db, cloudUrl, metrics, 120_000);
  const syncTime = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!converged) {
    console.log(`[Soak] Scenario 4: FAILED (timeout)`);
    return false;
  }

  const totalOrders = 100;
  const integrity = verifyDataIntegrity(db, cloud);
  const deadLetters = (db.query(`SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0 AND state = 'dead_letter'`).get() as any).c;
  const remaining = (db.query(`SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0`).get() as any).c;

  console.log(`[Soak]   Sync time: ${syncTime}s`);
  console.log(`[Soak]   Orders in cloud: ${cloud.orders.size} ${cloud.orders.size === totalOrders ? "✓" : "✗"}`);
  console.log(`[Soak]   Transactions in cloud: ${cloud.transactions.size} ${cloud.transactions.size === totalOrders ? "✓" : "✗"}`);
  console.log(`[Soak]   Dead letters: ${deadLetters} ${deadLetters === 0 ? "✓" : "✗"}`);
  console.log(`[Soak]   Queue remaining: ${remaining} ${remaining === 0 ? "✓" : "✗"}`);
  console.log(`[Soak]   Data integrity: ${integrity.match}/${totalOrders} match, ${integrity.mismatch} mismatch ${integrity.mismatch === 0 ? "✓" : "✗"}`);
  if (integrity.mismatch > 0) {
    for (const d of integrity.details.slice(0, 5)) console.log(`[Soak]     ${d}`);
  }
  printPerfMetrics(metrics);

  const passed = cloud.orders.size === totalOrders && cloud.transactions.size === totalOrders && deadLetters === 0 && integrity.mismatch === 0 && remaining === 0;
  console.log(`[Soak] Scenario 4: ${passed ? "PASSED" : "FAILED"}`);
  return passed;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[Soak] Starting soak test — isolated env: ${SOAK_DIR}`);
  console.log(`[Soak] Skip chaos: ${SKIP_CHAOS}`);

  // Setup
  mkdirSync(SOAK_DIR, { recursive: true });
  const db = createTestDb();
  const cloudPort = 18472 + Math.floor(Math.random() * 100);
  const cloud = createMockCloud(cloudPort);
  const cloudUrl = `http://localhost:${cloudPort}`;

  console.log(`[Soak] Mock cloud: ${cloudUrl}`);
  console.log(`[Soak] Test DB: ${DB_PATH}`);

  const results: Array<{ name: string; passed: boolean }> = [];

  try {
    // Run scenarios (fresh DB for each to avoid cross-contamination)
    db.close();
    let db1 = createTestDb("s1");
    results.push({ name: "Scenario 1", passed: await scenario1(db1, cloud, cloudUrl) });
    db1.close();

    let db2 = createTestDb("s2");
    results.push({ name: "Scenario 2", passed: await scenario2(db2, cloud, cloudUrl) });
    db2.close();

    if (!SKIP_CHAOS) {
      let db3 = createTestDb("s3");
      results.push({ name: "Scenario 3", passed: await scenario3(db3, cloud, cloudUrl) });
      db3.close();
    }

    let db4 = createTestDb("s4");
    results.push({ name: "Scenario 4", passed: await scenario4(db4, cloud, cloudUrl) });
    db4.close();
  } finally {
    // Cleanup
    cloud.server?.stop?.();
    try {
      deleteFileWithRetry(DB_PATH);
      deleteFileWithRetry(DB_PATH + "-wal");
      deleteFileWithRetry(DB_PATH + "-shm");
      rmSync(SOAK_DIR, { recursive: true, force: true });
    } catch { /* ignore cleanup errors on Windows */ }
  }

  // Summary
  console.log("");
  console.log(`[Soak] === Summary ===`);
  for (const r of results) {
    console.log(`[Soak]   ${r.name}: ${r.passed ? "PASSED" : "FAILED"}`);
  }
  const allPassed = results.every((r) => r.passed);
  console.log(`[Soak] Overall: ${allPassed ? "ALL PASSED" : "SOME FAILED"}`);

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("[Soak] Fatal error:", err);
  process.exit(1);
});
