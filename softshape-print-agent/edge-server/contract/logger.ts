// ─────────────────────────────────────────────────────────────────────────────
// contract/logger.ts — Structured JSON logging with rotation (v1)
// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — log file names, format, and rotation policy are stable.
// Support tooling depends on these paths and format.
//
// Log directory: %LOCALAPPDATA%\Softshape\logs\ (Windows)
//                ~/.softshape/logs/ (other platforms)
//
// Files:
//   runtime.log  — startup, shutdown, watchdog, supervisor, health, state transitions
//   edge.log     — order engine, KOT routing, bill generation, settlement
//   printer.log  — print jobs, results, errors, print service health
//   sync.log     — cloud sync push/pull, socket events, dead letters, retries
//   updater.log  — update checks, downloads, swaps, restarts
//
// Format: JSON lines — one JSON object per line
// Rotation: 10 MB max per file, 5 rotated files, 7-day retention
//
// What NOT to log:
//   - Full order data at INFO (log order IDs and counts, not contents)
//   - Tokens, PINs, passwords — ever
//   - Printer raw bytes (log byte counts and printer names, not ESC/POS payload)
// ─────────────────────────────────────────────────────────────────────────────

import { mkdirSync, appendFileSync, statSync, existsSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

// ── Configuration ────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATED_FILES = 5;
const RETENTION_DAYS = 7;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFile = "runtime" | "edge" | "printer" | "sync" | "updater";

// ── Log directory resolution ─────────────────────────────────────────────────

function getLogDir(): string {
  if (platform() === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(localAppData, "Softshape", "logs");
  }
  return join(homedir(), ".softshape", "logs");
}

const LOG_DIR = getLogDir();

// Ensure log directory exists on module load
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // If we can't create the log dir, fall back to console-only
}

// ── Log entry interface ──────────────────────────────────────────────────────

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  context?: Record<string, unknown>;
}

// ── Timezone-aware timestamp ─────────────────────────────────────────────────

function timestamp(): string {
  const now = new Date();
  const offset = -now.getTimezoneOffset() * 60000;
  const iso = new Date(now.getTime() + offset).toISOString();
  // Convert ISO (Z) to local offset format: 2026-07-22T22:45:00+05:30
  const tzMin = Math.abs(now.getTimezoneOffset());
  const tzSign = now.getTimezoneOffset() <= 0 ? "+" : "-";
  const tzH = String(Math.floor(tzMin / 60)).padStart(2, "0");
  const tzM = String(tzMin % 60).padStart(2, "0");
  return iso.replace("Z", `${tzSign}${tzH}:${tzM}`);
}

// ── Rotation ─────────────────────────────────────────────────────────────────

function rotateIfNeeded(filePath: string): void {
  try {
    if (!existsSync(filePath)) return;
    const stats = statSync(filePath);
    if (stats.size < MAX_FILE_SIZE) return;

    // Rotate: file.5 → delete, file.4 → file.5, ... file → file.1
    for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
      const older = `${filePath}.${i}`;
      if (i === MAX_ROTATED_FILES) {
        if (existsSync(older)) unlinkSync(older);
      } else {
        const newer = `${filePath}.${i}`;
        if (existsSync(newer)) renameSync(newer, older);
      }
    }
    renameSync(filePath, `${filePath}.1`);
  } catch {
    // Rotation failure is non-fatal — we'll just keep appending
  }
}

// ── Retention cleanup (old rotated files) ────────────────────────────────────

function cleanupOldLogs(): void {
  try {
    const files = readdirSync(LOG_DIR);
    const now = Date.now();
    const maxAge = RETENTION_DAYS * 24 * 60 * 60 * 1000;

    for (const file of files) {
      const filePath = join(LOG_DIR, file);
      const stats = statSync(filePath);
      if (now - stats.mtimeMs > maxAge) {
        unlinkSync(filePath);
      }
    }
  } catch {
    // Cleanup failure is non-fatal
  }
}

// Run retention cleanup on startup, then every hour
cleanupOldLogs();
setInterval(cleanupOldLogs, 60 * 60 * 1000).unref?.();

// ── Core log function ────────────────────────────────────────────────────────

function log(file: LogFile, level: LogLevel, msg: string, context?: Record<string, unknown>): void {
  const entry: LogEntry = {
    ts: timestamp(),
    level,
    msg,
    ...(context && Object.keys(context).length > 0 ? { context } : {}),
  };

  const line = JSON.stringify(entry) + "\n";
  const filePath = join(LOG_DIR, `${file}.log`);

  try {
    rotateIfNeeded(filePath);
    appendFileSync(filePath, line, "utf8");
  } catch {
    // If file write fails, fall back to console
    console.error(`[${file}] ${line.trim()}`);
  }

  // Also mirror to console for development visibility
  if (level === "error") {
    console.error(`[${file}] ${msg}`, context ?? "");
  } else if (level === "warn") {
    console.warn(`[${file}] ${msg}`, context ?? "");
  }
}

// ── Public logger factory ────────────────────────────────────────────────────

export interface Logger {
  debug(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
}

export function createLogger(file: LogFile): Logger {
  return {
    debug: (msg, context) => log(file, "debug", msg, context),
    info: (msg, context) => log(file, "info", msg, context),
    warn: (msg, context) => log(file, "warn", msg, context),
    error: (msg, context) => log(file, "error", msg, context),
  };
}

// ── Pre-created loggers ──────────────────────────────────────────────────────

export const runtimeLog = createLogger("runtime");
export const edgeLog = createLogger("edge");
export const printerLog = createLogger("printer");
export const syncLog = createLogger("sync");
export const updaterLog = createLogger("updater");

// ── Log directory accessor (for testing/inspection) ──────────────────────────

export function getLogDirectory(): string {
  return LOG_DIR;
}
