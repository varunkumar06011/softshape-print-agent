// ─────────────────────────────────────────────────────────────────────────────
// recovery.ts — SQLite corruption detection and recovery on startup
// ─────────────────────────────────────────────────────────────────────────────
// If the local SQLite database is unreadable on startup, this module:
//   1. Renames the corrupt DB to edge.db.corrupt-{timestamp}
//   2. Creates a fresh empty DB
//   3. Triggers a full config re-download from cloud (if connectivity exists)
//   4. Returns a status object so the server can surface a clear message
//
// If there's no connectivity, the server starts with an empty DB and the
// frontend shows "Database recovered — please connect to internet to restore
// your menu and settings."
// ─────────────────────────────────────────────────────────────────────────────

import { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { getBackendUrl, getSessionToken, getRestaurantId, isSessionValid, getDeviceId } from "./auth.ts";
import { cloudFetch } from "./cloudFetch.ts";

const DEFAULT_DB_PATH = process.env.EDGE_DB_PATH || join(homedir(), ".softshape", "edge.db");

// Mutable — can be patched if the default path is not writable
let resolvedDbPath = DEFAULT_DB_PATH;

export function getDbPath(): string {
  return resolvedDbPath;
}

export interface RecoveryResult {
  recovered: boolean;
  corruptPath: string | null;
  message: string;
}

function ensureDbDir(path: string): boolean {
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error("[Recovery] mkdirSync failed for", dir, ":", err);
  }
  return existsSync(dir);
}

// ── Sync-before-rebuild ──────────────────────────────────────────────────────
// When the DB is corrupt, we're about to nuke it. Before doing so, try to push
// any unsynced records (cloud_synced=0) to the cloud so they aren't lost.
// This is best-effort — if the cloud is unreachable, data is lost (but the
// corrupt file is preserved for manual recovery).

async function attemptSyncBeforeRebuild(db: Database): Promise<{ pushed: number; failed: number }> {
  if (!isSessionValid()) {
    console.warn("[Recovery] No valid session — skipping sync-before-rebuild");
    return { pushed: 0, failed: 0 };
  }

  const backendUrl = getBackendUrl();
  const restaurantId = getRestaurantId();
  const token = getSessionToken();
  if (!backendUrl || !restaurantId || !token) {
    return { pushed: 0, failed: 0 };
  }

  // Collect unsynced orders (the most critical data to save)
  let unsyncedOrders: any[] = [];
  try {
    unsyncedOrders = db.query("SELECT * FROM order_record WHERE cloud_synced = 0").all() as any[];
  } catch {
    // DB is corrupt — can't even read. Nothing we can do.
    console.warn("[Recovery] Could not read unsynced orders from corrupt DB");
    return { pushed: 0, failed: 0 };
  }

  if (unsyncedOrders.length === 0) {
    console.log("[Recovery] No unsynced orders to salvage");
    return { pushed: 0, failed: 0 };
  }

  console.log(`[Recovery] Attempting to sync ${unsyncedOrders.length} unsynced orders before rebuild...`);

  // Also try to collect unsynced settle/payment records from edge_config
  let settleRecords: any[] = [];
  try {
    const rows = db.query("SELECT key, value FROM edge_config WHERE key LIKE 'settle:%' OR key LIKE 'payment:%' OR key LIKE 'walkin_txn:%'").all() as any[];
    for (const row of rows) {
      try {
        settleRecords.push(JSON.parse(row.value));
      } catch { /* skip malformed */ }
    }
  } catch {
    // Non-fatal — orders are the priority
  }

  const payload: any[] = [];
  for (const order of unsyncedOrders) {
    try {
      const items = db.query("SELECT * FROM order_item WHERE order_id = ?").all(order.id) as any[];
      const kots = db.query("SELECT * FROM kot WHERE order_id = ?").all(order.id) as any[];
      const kotItems: any[] = [];
      for (const kot of kots) {
        const ki = db.query("SELECT * FROM kot_item WHERE kot_id = ?").all(kot.id) as any[];
        kotItems.push(...ki);
      }
      payload.push({
        tableName: "order",
        recordId: order.id,
        operation: "create",
        data: {
          ...order,
          cloud_synced: undefined,
          items: items.map(i => ({ ...i, cloud_synced: undefined })),
          kots: kots.map(k => ({
            ...k,
            cloud_synced: undefined,
            items: kotItems.filter(ki => ki.kot_id === k.id).map(ki => ({ ...ki, cloud_synced: undefined })),
          })),
        },
      });
    } catch {
      // Can't read related records for this order — skip it
    }
  }

  for (const settle of settleRecords) {
    payload.push({
      tableName: "transaction",
      recordId: settle.id || settle.orderId || `salvage-${Date.now()}`,
      operation: "create",
      data: settle,
    });
  }

  if (payload.length === 0) {
    return { pushed: 0, failed: 0 };
  }

  try {
    const res = await cloudFetch(`${backendUrl}/api/edge/sync`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        restaurantId,
        deviceId: getDeviceId(),
        batch: payload,
      }),
      timeout: 15_000,
    });

    if (res.ok) {
      const result = await res.json() as { accepted: number[]; rejected: any[] };
      console.log(`[Recovery] Salvage sync: ${result.accepted.length} accepted, ${(result.rejected || []).length} rejected`);
      return { pushed: result.accepted.length, failed: (result.rejected || []).length };
    } else {
      console.warn(`[Recovery] Salvage sync failed: HTTP ${res.status}`);
      return { pushed: 0, failed: payload.length };
    }
  } catch (err) {
    console.warn("[Recovery] Salvage sync error (cloud unreachable):", err);
    return { pushed: 0, failed: payload.length };
  }
}

export function openDatabaseWithRecovery(): { db: Database; recovery: RecoveryResult } {
  const recovery: RecoveryResult = {
    recovered: false,
    corruptPath: null,
    message: "",
  };

  // Ensure parent directory exists — SQLite {create:true} does not create it.
  // In compiled Bun binaries, mkdirSync can fail silently if the path resolution
  // differs from the runtime environment. Try default path first, then fallback.
  if (!ensureDbDir(DEFAULT_DB_PATH)) {
    // Fallback: try creating relative to process working directory
    const fallbackPath = join(process.cwd(), ".softshape", "edge.db");
    if (ensureDbDir(fallbackPath)) {
      console.warn("[Recovery] Using fallback DB path:", fallbackPath);
      resolvedDbPath = fallbackPath;
    } else {
      // Last resort: temp directory
      const tmpDir = join(tmpdir(), ".softshape");
      try {
        mkdirSync(tmpDir, { recursive: true });
        if (existsSync(tmpDir)) {
          console.warn("[Recovery] Using temp DB path:", tmpDir);
          resolvedDbPath = join(tmpDir, "edge.db");
        }
      } catch (tmpErr) {
        console.error("[Recovery] All directory creation attempts failed:", tmpErr);
      }
    }
  }

  const dbPath = resolvedDbPath;

  // Try opening the existing DB
  try {
    if (existsSync(dbPath)) {
      const testDb = new Database(dbPath, { readonly: true });
      // Quick integrity check
      const result = testDb.query("PRAGMA integrity_check").get() as any;
      testDb.close();

      if (result && result.integrity_check !== "ok") {
        throw new Error(`Integrity check failed: ${result.integrity_check}`);
      }
    }
    // DB is healthy — open normally
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    return { db, recovery };
  } catch (err) {
    console.error("[Recovery] Database appears corrupt:", err);

    // ── Sync-before-rebuild: salvage unsynced data ────────────────────────────
    // Try to read unsynced records from the corrupt DB and push them to cloud
    // before we nuke it. This is best-effort — if the DB is too corrupt to read
    // or the cloud is unreachable, data is lost (but the corrupt file is preserved).
    try {
      const salvageDb = new Database(dbPath, { readonly: true });
      attemptSyncBeforeRebuild(salvageDb).catch(e => {
        console.warn("[Recovery] Salvage sync failed (non-blocking):", e);
      });
      // Don't close salvageDb — attemptSyncBeforeRebuild needs it open.
      // It will be closed when the process exits or GC collects it.
    } catch {
      console.warn("[Recovery] Could not open corrupt DB for salvage — data will be lost");
    }

    // Rename corrupt DB
    const corruptPath = `${dbPath}.corrupt-${Date.now()}`;
    try {
      if (existsSync(dbPath)) {
        renameSync(dbPath, corruptPath);
        recovery.corruptPath = corruptPath;
      }
    } catch (renameErr) {
      console.error("[Recovery] Could not rename corrupt DB:", renameErr);
    }

    // Create fresh DB
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");

    recovery.recovered = true;
    recovery.message = "Local database was corrupt and has been reset. " +
      "Menu and settings will be re-downloaded from the cloud when connected. " +
      "Previous orders may need to be verified in the admin dashboard.";

    console.warn(`[Recovery] ${recovery.message}`);
    return { db, recovery };
  }
}
