// ─────────────────────────────────────────────────────────────────────────────
// errorReport.ts — send this PC's errors to the cloud so they can be seen remotely
// ─────────────────────────────────────────────────────────────────────────────
// Errors written to the log files (error level), crashes the server survived, and
// KOTs the PC refused are kept in a small local table and uploaded with the normal
// sync. In the superadmin console they show under Audit Logs (action EDGE_ERROR or
// EDGE_EVENT), so a problem at a restaurant can be looked at without a visit.
//
// Never reported: tokens, PINs, passwords, order contents (see contract/logger.ts).
// The same message repeating within a few minutes is counted, not stored again.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from "./db.ts";
import { getBackendUrl, getSessionToken, getRestaurantId, getDeviceId } from "./auth.ts";
import { cloudFetch } from "./cloudFetch.ts";
import { setErrorSink, isLoggerMirroring } from "./contract/logger.ts";
import pkg from "./package.json";

export type ReportSeverity = "error" | "info";

export interface ErrorReportRow {
  id: number;
  kind: string;
  severity: ReportSeverity;
  message: string;
  context: string | null;
  count: number;
  first_at: number;
  last_at: number;
}

const MAX_MESSAGE = 500;
const MAX_CONTEXT = 2000;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_STORED = 500;
const BATCH_SIZE = 50;
const MIN_FLUSH_GAP_MS = 30_000;
const SECRET_KEY = /token|pin|password|secret|authorization|apikey|api_key|escpos|bytes/i;

const preparedDbs = new WeakSet<object>();
let lastFlushAt = 0;

function ensureTable(): ReturnType<typeof getDb> {
  const db = getDb();
  if (!preparedDbs.has(db as object)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS edge_error_report (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL,
        kind        TEXT NOT NULL,
        severity    TEXT NOT NULL DEFAULT 'error',
        message     TEXT NOT NULL,
        context     TEXT,
        count       INTEGER NOT NULL DEFAULT 1,
        first_at    INTEGER NOT NULL,
        last_at     INTEGER NOT NULL,
        sent        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_edge_error_report_pending ON edge_error_report(sent, fingerprint);
    `);
    preparedDbs.add(db as object);
  }
  return db;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Context as short JSON with anything secret-looking removed. */
export function safeContext(context?: Record<string, unknown>): string | null {
  if (!context) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (SECRET_KEY.test(key)) continue;
    if (value instanceof Error) clean[key] = value.message;
    else if (typeof value === "string") clean[key] = clip(value, 300);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) clean[key] = value;
    else {
      try { clean[key] = clip(JSON.stringify(value), 300); } catch { /* skip unserialisable */ }
    }
  }
  if (Object.keys(clean).length === 0) return null;
  return clip(JSON.stringify(clean), MAX_CONTEXT);
}

/** Keep a record of something that went wrong (or was refused) for upload. Never throws. */
export function reportEdgeError(
  kind: string,
  message: string,
  context?: Record<string, unknown>,
  severity: ReportSeverity = "error",
): void {
  try {
    const db = ensureTable();
    const now = Date.now();
    const text = clip(String(message || "unknown"), MAX_MESSAGE);
    // Ids, counts and times differ between otherwise identical errors.
    const fingerprint = `${kind}|${text.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "#").replace(/\d+/g, "#")}`;

    const repeat = db.query(
      "SELECT id FROM edge_error_report WHERE fingerprint = ? AND sent = 0 AND last_at >= ? ORDER BY id DESC LIMIT 1",
    ).get(fingerprint, now - DEDUPE_WINDOW_MS) as { id: number } | null;
    if (repeat) {
      db.query("UPDATE edge_error_report SET count = count + 1, last_at = ? WHERE id = ?").run(now, repeat.id);
      return;
    }

    db.query(
      "INSERT INTO edge_error_report (fingerprint, kind, severity, message, context, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(fingerprint, clip(kind, 60), severity, text, safeContext(context), now, now);

    // Bounded: a PC that cannot reach the cloud for days must not grow this forever.
    db.query(
      "DELETE FROM edge_error_report WHERE id NOT IN (SELECT id FROM edge_error_report ORDER BY id DESC LIMIT ?)",
    ).run(MAX_STORED);
  } catch {
    // Reporting must never break the thing being reported.
  }
}

export function pendingErrorReports(limit = BATCH_SIZE): ErrorReportRow[] {
  try {
    return ensureTable().query(
      "SELECT id, kind, severity, message, context, count, first_at, last_at FROM edge_error_report WHERE sent = 0 ORDER BY id LIMIT ?",
    ).all(limit) as ErrorReportRow[];
  } catch {
    return [];
  }
}

type Sender = (reports: ErrorReportRow[]) => Promise<boolean>;

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

async function sendToCloud(reports: ErrorReportRow[]): Promise<boolean> {
  const backendUrl = getBackendUrl();
  const token = getSessionToken();
  const restaurantId = getRestaurantId();
  if (!backendUrl || !token || !restaurantId) return false;

  const res = await cloudFetch(`${backendUrl}/api/edge/error-reports`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      restaurantId,
      deviceId: getDeviceId(),
      appVersion: pkg.version,
      reports: reports.map((r) => ({
        kind: r.kind,
        severity: r.severity,
        message: r.message,
        context: r.context ? safeParse(r.context) : null,
        count: r.count,
        firstAt: r.first_at,
        lastAt: r.last_at,
      })),
    }),
    timeout: 10_000,
  });
  return res.ok;
}

/**
 * Upload what is waiting. Called from the sync cycle; at most once every 30 seconds
 * and a no-op when nothing is waiting or the cloud cannot be reached.
 */
export async function flushEdgeErrorReports(send: Sender = sendToCloud, now = Date.now()): Promise<number> {
  if (now - lastFlushAt < MIN_FLUSH_GAP_MS) return 0;
  const pending = pendingErrorReports();
  if (pending.length === 0) return 0;
  lastFlushAt = now;
  try {
    if (!(await send(pending))) return 0;
    const db = ensureTable();
    const mark = db.query("UPDATE edge_error_report SET sent = 1 WHERE id = ?");
    for (const row of pending) mark.run(row.id);
    // Uploaded rows are only kept briefly (a repeat of the same error counts afresh).
    db.query("DELETE FROM edge_error_report WHERE sent = 1 AND last_at < ?").run(now - DEDUPE_WINDOW_MS);
    return pending.length;
  } catch {
    return 0;
  }
}

/** Test hook: forget the flush throttle. */
export function resetErrorReportThrottle(): void {
  lastFlushAt = 0;
}

function describeConsoleArgs(args: unknown[]): string {
  return args
    .map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
    .join(" ");
}

let consoleHooked = false;

/**
 * Send every error-level log line, and every plain console.error (backup, database
 * recovery, sync worker, sockets, orders), to the report table.
 */
export function installErrorReporting(): void {
  setErrorSink((file, msg, context) => reportEdgeError(`log:${file}`, msg, context));
  if (consoleHooked) return;
  consoleHooked = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    if (!isLoggerMirroring()) reportEdgeError("console", describeConsoleArgs(args));
  };
}
