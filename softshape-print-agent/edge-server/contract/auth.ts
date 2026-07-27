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
]);
