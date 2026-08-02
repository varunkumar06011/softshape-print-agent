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
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync, rmSync } from "node:fs";
import { getDbPath } from "./recovery.ts";

const BACKUP_DIR = join(dirname(getDbPath()), "backups");
const MAX_BACKUP_DAYS = 7;
const ORDER_RETENTION_DAYS = 90;

let lastBackupDate = "";

// ── Periodic backup (every 30 minutes) ───────────────────────────────────────
// Creates a VACUUM INTO backup without the full maintenance prune.
// Reduces the data loss window from 24h to 30min in case of DB corruption.

let lastPeriodicBackupAt = 0;
const PERIODIC_BACKUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_PERIODIC_BACKUPS = 48; // 48 × 30min = 24h of periodic backups

export function runPeriodicBackup(db: Database): void {
  const now = Date.now();
  if (now - lastPeriodicBackupAt < PERIODIC_BACKUP_INTERVAL_MS) return;
  lastPeriodicBackupAt = now;

  try {
    if (!existsSync(BACKUP_DIR)) {
      mkdirSync(BACKUP_DIR, { recursive: true });
    }
    const backupPath = join(BACKUP_DIR, `edge-periodic-${now}.db`);
    db.query(`VACUUM INTO '${backupPath}'`).run();
    console.log(`[Backup] Periodic backup created: ${backupPath}`);

    // Prune old periodic backups (keep only the most recent MAX_PERIODIC_BACKUPS)
    const periodicFiles = readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith("edge-periodic-") && f.endsWith(".db"))
      .map(f => ({ name: f, path: join(BACKUP_DIR, f), mtime: 0 }))
      .sort((a, b) => b.name.localeCompare(a.name)); // newest first (timestamp in name)

    for (let i = 0; i < periodicFiles.length; i++) {
      if (i >= MAX_PERIODIC_BACKUPS) {
        try { unlinkSync(periodicFiles[i].path); } catch { /* skip */ }
      }
    }
  } catch (err) {
    console.warn("[Backup] Periodic backup failed (non-fatal):", err);
  }
}

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

  // VACUUM INTO refuses to overwrite an existing file — delete it first
  // (happens when the server restarts on the same day)
  if (existsSync(backupPath)) {
    try { rmSync(backupPath); } catch { /* ignore */ }
  }

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

  // Count before pruning. Never remove a synced order while any related
  // settlement is still unsynced: the transaction retry path may need the
  // order to exist in the cloud before it can be acknowledged.
  const protectedOrderClause = `
    AND NOT EXISTS (
      SELECT 1 FROM transaction_record tr
      WHERE tr.order_id = order_record.id AND tr.cloud_synced = 0
    )`;
  const before = db.query(
    `SELECT COUNT(*) as count FROM order_record
     WHERE created_at < ? AND cloud_synced = 1${protectedOrderClause}`,
  ).get(cutoff) as any;
  if (before.count === 0) return;

  // Delete old order items first (FK), excluding orders with unsynced
  // transaction records.
  db.query(
    `DELETE FROM order_item WHERE order_id IN (
       SELECT o.id FROM order_record o
       WHERE o.created_at < ? AND o.cloud_synced = 1
         AND NOT EXISTS (
           SELECT 1 FROM transaction_record tr
           WHERE tr.order_id = o.id AND tr.cloud_synced = 0
         )
     )`,
  ).run(cutoff);
  // Delete old KOT items first (FK)
  db.query(
    `DELETE FROM kot_item WHERE kot_id IN (
       SELECT k.id FROM kot k JOIN order_record o ON k.order_id = o.id
       WHERE o.created_at < ? AND o.cloud_synced = 1
         AND NOT EXISTS (
           SELECT 1 FROM transaction_record tr
           WHERE tr.order_id = o.id AND tr.cloud_synced = 0
         )
     )`,
  ).run(cutoff);
  // Delete old KOTs
  db.query(
    `DELETE FROM kot WHERE order_id IN (
       SELECT o.id FROM order_record o
       WHERE o.created_at < ? AND o.cloud_synced = 1
         AND NOT EXISTS (
           SELECT 1 FROM transaction_record tr
           WHERE tr.order_id = o.id AND tr.cloud_synced = 0
         )
     )`,
  ).run(cutoff);
  // Delete old orders
  db.query(
    `DELETE FROM order_record
     WHERE created_at < ? AND cloud_synced = 1${protectedOrderClause}`,
  ).run(cutoff);

  // Also prune synced sync_queue entries older than retention
  // (synced rows are now deleted immediately in markSynced(), but this
  // catches any stragglers from before that change was deployed)
  db.query("DELETE FROM sync_queue WHERE synced = 1 AND created_at < ?").run(cutoff);

  // Reclaim free pages from deleted rows — keeps the DB file from growing
  // unbounded. incremental_vacuum is non-blocking unlike full VACUUM.
  try {
    db.query("PRAGMA incremental_vacuum").run();
  } catch {
    // Non-fatal — can fail if auto_vacuum is not enabled
  }

  console.log(`[Backup] Pruned ${before.count} orders older than ${ORDER_RETENTION_DAYS} days`);
}
