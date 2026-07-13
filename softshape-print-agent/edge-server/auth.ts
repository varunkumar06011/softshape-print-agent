// ─────────────────────────────────────────────────────────────────────────────
// auth.ts — Session token validation for the edge server
// ─────────────────────────────────────────────────────────────────────────────
// Validates the agent session token against the cloud backend.
// The session token is obtained during the print agent registration flow
// (POST /api/print/agent-register) and stored in localStorage + edge_config.
//
// The edge server accepts requests from captain/cashier apps on the LAN.
// Auth is lightweight — we trust the LAN (same as Petpooja's local server).
// The session token is used for cloud sync, not for LAN API auth.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, getConfig, setConfig } from "./db.ts";

interface StoredSession {
  sessionToken: string;
  restaurantId: string;
  restaurantName: string;
  restaurantCode: string;
  backendUrl: string;
  expiresAt: number;
}

let cachedSession: StoredSession | null = null;

export function loadSession(): StoredSession | null {
  if (cachedSession) return cachedSession;

  const token = getConfig("session_token");
  const restaurantId = getConfig("restaurant_id");
  const restaurantName = getConfig("restaurant_name");
  const restaurantCode = getConfig("restaurant_code");
  const backendUrl = getConfig("backend_url");
  const expiresAt = getConfig("session_expires_at");

  if (!token || !restaurantId || !backendUrl) return null;

  cachedSession = {
    sessionToken: token,
    restaurantId,
    restaurantName: restaurantName || "",
    restaurantCode: restaurantCode || "",
    backendUrl,
    expiresAt: expiresAt ? parseInt(expiresAt, 10) : 0,
  };
  return cachedSession;
}

export function saveSession(session: StoredSession): void {
  setConfig("session_token", session.sessionToken);
  setConfig("restaurant_id", session.restaurantId);
  setConfig("restaurant_name", session.restaurantName);
  setConfig("restaurant_code", session.restaurantCode);
  setConfig("backend_url", session.backendUrl);
  setConfig("session_expires_at", String(session.expiresAt));
  cachedSession = session;
}

export function clearSession(): void {
  const db = getDb();
  db.query("DELETE FROM edge_config WHERE key IN ('session_token', 'restaurant_id', 'restaurant_name', 'restaurant_code', 'backend_url', 'session_expires_at')").run();
  cachedSession = null;
}

export function isSessionValid(): boolean {
  const session = loadSession();
  if (!session) return false;
  if (session.expiresAt && Date.now() > session.expiresAt) return false;
  return true;
}

export function getBackendUrl(): string | null {
  const session = loadSession();
  return session?.backendUrl ?? null;
}

export function getRestaurantId(): string | null {
  const session = loadSession();
  return session?.restaurantId ?? null;
}

export function getSessionToken(): string | null {
  const session = loadSession();
  return session?.sessionToken ?? null;
}

// ── Device identity ──────────────────────────────────────────────────────────
// Each edge server instance gets a unique deviceId on first launch.
// Persisted in edge_config, used to tag sync pushes so the cloud can track
// which device originated each change and which bill-number series it owns.

let cachedDeviceId: string | null = null;

export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;

  const stored = getConfig("device_id");
  if (stored) {
    cachedDeviceId = stored;
    return stored;
  }

  // Generate a new deviceId — crypto.randomUUID if available, fallback to timestamp+random
  const newId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `edge-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  setConfig("device_id", newId);
  cachedDeviceId = newId;
  console.log(`[Auth] Generated new device ID: ${newId}`);
  return newId;
}
