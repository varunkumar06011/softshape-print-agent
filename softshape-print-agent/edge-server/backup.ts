// ─────────────────────────────────────────────────────────────────────────────
// backup.ts — Daily SQLite backup, 7-day rotation, 90-day order pruning
// ─────────────────────────────────────────────────────────────────────────────
// Runs on edge server startup and then every 24 hours.
// Backups are stored alongside the main DB file with a date suffix.
// Old backups (>7 days) and old local orders (>90 days) are pruned.
// Cloud retains everything — local storage is bounded.
// ─────────────────────────────────────────────────────────────────────────────

import { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { getDbPath } from "./recovery.ts";

const BACKUP_DIR = join(dirname(getDbPath()), "backups");
const MAX_BACKUP_DAYS = 7;
const ORDER_RETENTION_DAYS = 90;

let lastBackupDate = "";

export function runDailyMaintenance(db: Database): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastBackupDate) return;
  lastBackupDate = today;

  try {
    doBackup(db);
  } catch (err) {
    console.error("[Backup] Failed:", err);
  }

  try {
    pruneOldBackups();
  } catch (err) {
    console.error("[Backup] Prune backups failed:", err);
  }

  try {
    pruneOldOrders(db);
  } catch (err) {
    console.error("[Backup] Prune orders failed:", err);
  }
}

function doBackup(db: Database): void {
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().slice(0, 10);
  const backupPath = join(BACKUP_DIR, `edge-${timestamp}.db`);

  // Use SQLite's online backup API via raw SQL
  // Bun's sqlite doesn't expose backup directly, so use VACUUM INTO
  db.query(`VACUUM INTO '${backupPath}'`).run();
  console.log(`[Backup] Created ${backupPath}`);
}

function pruneOldBackups(): void {
  if (!existsSync(BACKUP_DIR)) return;

  const now = Date.now();
  const maxAgeMs = MAX_BACKUP_DAYS * 24 * 60 * 60 * 1000;

  for (const file of readdirSync(BACKUP_DIR)) {
    if (!file.startsWith("edge-") || !file.endsWith(".db")) continue;
    const filePath = join(BACKUP_DIR, file);
    try {
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        unlinkSync(filePath);
        console.log(`[Backup] Pruned old backup: ${file}`);
      }
    } catch {
      // File may have been deleted — skip
    }
  }
}

function pruneOldOrders(db: Database): void {
  const cutoff = Date.now() - ORDER_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  // Count before pruning (only synced orders — never delete unsynced data)
  const before = db.query("SELECT COUNT(*) as count FROM order_record WHERE created_at < ? AND cloud_synced = 1").get(cutoff) as any;
  if (before.count === 0) return;

  // Delete old order items first (FK)
  db.query("DELETE FROM order_item WHERE order_id IN (SELECT id FROM order_record WHERE created_at < ? AND cloud_synced = 1)").run(cutoff);
  // Delete old KOT items first (FK)
  db.query("DELETE FROM kot_item WHERE kot_id IN (SELECT k.id FROM kot k JOIN order_record o ON k.order_id = o.id WHERE o.created_at < ? AND o.cloud_synced = 1)").run(cutoff);
  // Delete old KOTs
  db.query("DELETE FROM kot WHERE order_id IN (SELECT id FROM order_record WHERE created_at < ? AND cloud_synced = 1)").run(cutoff);
  // Delete old orders
  db.query("DELETE FROM order_record WHERE created_at < ? AND cloud_synced = 1").run(cutoff);

  // Also prune synced sync_queue entries older than retention
  db.query("DELETE FROM sync_queue WHERE synced = 1 AND created_at < ?").run(cutoff);

  console.log(`[Backup] Pruned ${before.count} orders older than ${ORDER_RETENTION_DAYS} days`);
}
