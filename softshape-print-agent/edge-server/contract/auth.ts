// ─────────────────────────────────────────────────────────────────────────────
// contract/auth.ts — Runtime token authentication (v1)
// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — the token mechanism is stable.
//
// On first boot, the Runtime generates a 256-bit token stored in edge_config.
// Every HTTP request and WebSocket connection must include it as a Bearer token.
// Token is per-Runtime (per-restaurant-PC), not per-user.
// User-level auth (PIN login) happens on top of the runtime token.
//
// Rotation: POST /runtime/rotate-token (admin-only) generates a new token,
// invalidates the old, and disconnects all clients.
// ─────────────────────────────────────────────────────────────────────────────

import { getConfig, setConfig, getDb } from "../db.ts";

const RUNTIME_TOKEN_KEY = "runtime_token";
const RUNTIME_TOKEN_GENERATED_AT_KEY = "runtime_token_generated_at";

// ── Token generation ─────────────────────────────────────────────────────────

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Get or create the runtime token ──────────────────────────────────────────

export function getOrCreateRuntimeToken(): string {
  const existing = getConfig(RUNTIME_TOKEN_KEY);
  if (existing) return existing;

  const token = generateToken();
  setConfig(RUNTIME_TOKEN_KEY, token);
  setConfig(RUNTIME_TOKEN_GENERATED_AT_KEY, String(Date.now()));
  console.log("[Auth] Generated new runtime token");
  return token;
}

// ── Get the current runtime token (null if not yet created) ──────────────────

export function getRuntimeToken(): string | null {
  return getConfig(RUNTIME_TOKEN_KEY) ?? null;
}

// ── Validate a bearer token against the stored runtime token ─────────────────

export function validateRuntimeToken(authHeader: string | null): boolean {
  if (!authHeader) return false;
  if (!authHeader.startsWith("Bearer ")) return false;

  const provided = authHeader.slice(7);
  const stored = getRuntimeToken();
  if (!stored) return false;

  return timingSafeEqual(provided, stored);
}

// ── Rotate the runtime token ─────────────────────────────────────────────────
// Returns the new token. All existing clients must re-authenticate.

export function rotateRuntimeToken(): string {
  const token = generateToken();
  setConfig(RUNTIME_TOKEN_KEY, token);
  setConfig(RUNTIME_TOKEN_GENERATED_AT_KEY, String(Date.now()));
  console.log("[Auth] Runtime token rotated");
  return token;
}

// ── Check if a runtime token exists ──────────────────────────────────────────

export function hasRuntimeToken(): boolean {
  return getConfig(RUNTIME_TOKEN_KEY) !== null;
}

// ── Timing-safe string comparison ────────────────────────────────────────────
// Prevents timing attacks on token validation. Falls back to simple comparison
// if the lengths differ (which leaks length info but not content).

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

// ── Extract token from Authorization header ──────────────────────────────────

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

// ── Public/unauthenticated paths ─────────────────────────────────────────────
// Only truly public routes belong here. All POS operation routes require auth.

export const PUBLIC_PATHS = new Set<string>([
  "/health",
  "/api/edge/register",
  "/api/edge/auth/pin",
  "/api/edge/staff",
  "/api/edge/runtime-token",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Staff tokens — user-bound, short-lived tokens issued on offline PIN login.
// Separate from the device-wide runtime token so that cashier-specific
// authorization (e.g. menuAdd permission) can be enforced on edge writes.
// ─────────────────────────────────────────────────────────────────────────────

const STAFF_TOKEN_TTL_SECONDS = 8 * 60 * 60; // 8 hours (typical shift)

export interface StaffTokenPayload {
  userId: string;
  role: string;
  outletId: string;
  permissions: Record<string, any>;
  expiresAt: number;
}

// Issue a new staff token for the given user. Stores the token in SQLite.
export function issueStaffToken(payload: Omit<StaffTokenPayload, "expiresAt">): string {
  const token = generateToken();
  const expiresAt = Math.floor(Date.now() / 1000) + STAFF_TOKEN_TTL_SECONDS;
  const db = getDb();
  db.query(
    `INSERT INTO staff_tokens (token, user_id, role, outlet_id, permissions, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    token,
    payload.userId,
    payload.role,
    payload.outletId,
    JSON.stringify(payload.permissions || {}),
    expiresAt
  );
  return token;
}

// Validate a staff bearer token and return the payload, or null if invalid/expired.
export function validateStaffToken(authHeader: string | null): StaffTokenPayload | null {
  const token = extractBearerToken(authHeader);
  if (!token) return null;
  const db = getDb();
  const row = db.query(
    `SELECT user_id, role, outlet_id, permissions, expires_at FROM staff_tokens WHERE token = ?`
  ).get(token) as
    | { user_id: string; role: string; outlet_id: string; permissions: string | null; expires_at: number }
    | null;
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at <= now) {
    // Expired — clean up and reject.
    db.query(`DELETE FROM staff_tokens WHERE token = ?`).run(token);
    return null;
  }
  let permissions: Record<string, any> = {};
  try { permissions = row.permissions ? JSON.parse(row.permissions) : {}; } catch { permissions = {}; }
  return {
    userId: row.user_id,
    role: row.role,
    outletId: row.outlet_id,
    permissions,
    expiresAt: row.expires_at,
  };
}

// Revoke a specific staff token (on logout).
export function revokeStaffToken(authHeader: string | null): void {
  const token = extractBearerToken(authHeader);
  if (!token) return;
  const db = getDb();
  db.query(`DELETE FROM staff_tokens WHERE token = ?`).run(token);
}

// Purge all expired staff tokens (call periodically).
export function purgeExpiredStaffTokens(): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.query(`DELETE FROM staff_tokens WHERE expires_at <= ?`).run(now);
}

// Check whether a staff token grants a specific permission.
// OWNER and ADMIN always pass (full access). Other roles require the
// permission key to be truthy in the token's permissions JSON.
export function staffHasPermission(payload: StaffTokenPayload | null, permissionKey: string): boolean {
  if (!payload) return false;
  const role = (payload.role || "").toUpperCase();
  if (role === "OWNER" || role === "ADMIN") return true;
  return !!payload.permissions?.[permissionKey];
}
