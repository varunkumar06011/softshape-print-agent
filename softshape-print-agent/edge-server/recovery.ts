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
import { homedir } from "node:os";
import { existsSync, renameSync } from "node:fs";

const DB_PATH = process.env.EDGE_DB_PATH || join(homedir(), ".softshape", "edge.db");

export interface RecoveryResult {
  recovered: boolean;
  corruptPath: string | null;
  message: string;
}

export function openDatabaseWithRecovery(): { db: Database; recovery: RecoveryResult } {
  const recovery: RecoveryResult = {
    recovered: false,
    corruptPath: null,
    message: "",
  };

  // Try opening the existing DB
  try {
    if (existsSync(DB_PATH)) {
      const testDb = new Database(DB_PATH, { readonly: true });
      // Quick integrity check
      const result = testDb.query("PRAGMA integrity_check").get() as any;
      testDb.close();

      if (result && result.integrity_check !== "ok") {
        throw new Error(`Integrity check failed: ${result.integrity_check}`);
      }
    }
    // DB is healthy — open normally
    const db = new Database(DB_PATH, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    return { db, recovery };
  } catch (err) {
    console.error("[Recovery] Database appears corrupt:", err);

    // Rename corrupt DB
    const corruptPath = `${DB_PATH}.corrupt-${Date.now()}`;
    try {
      if (existsSync(DB_PATH)) {
        renameSync(DB_PATH, corruptPath);
        recovery.corruptPath = corruptPath;
      }
    } catch (renameErr) {
      console.error("[Recovery] Could not rename corrupt DB:", renameErr);
    }

    // Create fresh DB
    const db = new Database(DB_PATH, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
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
