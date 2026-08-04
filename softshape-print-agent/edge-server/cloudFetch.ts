/**
 * Shared cloud fetch helper for the edge server.
 * Wraps fetch() with multi-stage timeouts to prevent hung TCP connections
 * from blocking the sync worker or config downloads.
 *
 * Timeout stages:
 *   1. Connect timeout — time to receive response headers (default 15s)
 *   2. Body timeout — time to read the full response body (default 45s)
 *
 * Also captures the server time from the `Date` response header to detect
 * clock skew on the edge machine.
 *
 * Usage:
 *   import { cloudFetch } from './cloudFetch';
 *   const res = await cloudFetch(`${backendUrl}/api/edge/config`, {
 *     method: 'GET',
 *     headers: { Authorization: `Bearer ${token}` },
 *   });
 *
 * Override timeouts:
 *   const res = await cloudFetch(url, { timeout: 60_000 });
 *   // or granular:
 *   const res = await cloudFetch(url, { connectTimeout: 10_000, bodyTimeout: 30_000 });
 */

import { runtimeLog } from "./contract/logger.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_BODY_TIMEOUT_MS = 45_000;
const DEFAULT_TIMEOUT_MS = 30_000;

type CloudFetchOptions = RequestInit & {
  timeout?: number;
  connectTimeout?: number;
  bodyTimeout?: number;
  retries?: number;
};

// ── Server time offset tracking ──────────────────────────────────────────────
// Offset in ms: serverTime - localTime. Positive = local clock is behind.
// Updated on every successful cloud response that includes a Date header.

let _serverTimeOffsetMs = 0;
let _lastOffsetUpdate = 0;
const OFFSET_FRESHNESS_MS = 5 * 60 * 1000; // 5 minutes

export function getServerTimeOffsetMs(): number {
  // If we haven't updated the offset in 5 minutes, don't trust it
  if (Date.now() - _lastOffsetUpdate > OFFSET_FRESHNESS_MS) return 0;
  return _serverTimeOffsetMs;
}

export function getServerTimeOffsetMinutes(): number {
  return Math.round(getServerTimeOffsetMs() / 60000);
}

function captureServerTime(res: Response): void {
  try {
    const dateHeader = res.headers.get("date");
    if (!dateHeader) return;
    const serverTime = new Date(dateHeader).getTime();
    if (isNaN(serverTime)) return;
    const localTime = Date.now();
    const offset = serverTime - localTime;
    // Only update if the offset changed by >30s (avoids jitter from network latency)
    if (Math.abs(offset - _serverTimeOffsetMs) > 30_000 || _lastOffsetUpdate === 0) {
      _serverTimeOffsetMs = offset;
      _lastOffsetUpdate = Date.now();
      if (Math.abs(offset) > 5 * 60 * 1000) {
        runtimeLog.warn("[CloudFetch] Clock skew detected", {
          offsetMinutes: Math.round(Math.abs(offset) / 60000),
          direction: offset > 0 ? "behind" : "ahead",
        });
      }
    }
  } catch { /* ignore */ }
}

// ── Single-attempt fetch with connect + body timeouts ────────────────────────

async function fetchWithTimeouts(
  url: string,
  options: CloudFetchOptions,
  connectTimeoutMs: number,
  bodyTimeoutMs: number,
): Promise<Response> {
  const { timeout: _removed, connectTimeout: _r2, bodyTimeout: _r3, retries: _r4, signal: callerSignal, ...fetchOptions } = options;

  // Stage 1: Connect timeout — covers DNS, TCP handshake, TLS, and waiting for response headers.
  const connectController = new AbortController();
  const connectTimer = setTimeout(() => connectController.abort(), connectTimeoutMs);

  // If caller provided a signal, abort when either fires
  if (callerSignal) {
    if (callerSignal.aborted) connectController.abort();
    else callerSignal.addEventListener("abort", () => connectController.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...fetchOptions,
      signal: connectController.signal,
    });
  } catch (err: any) {
    if (connectController.signal.aborted && (!callerSignal || !callerSignal.aborted)) {
      throw new Error(`Connect timeout: ${url} did not respond within ${connectTimeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(connectTimer);
  }

  // Capture server time for clock skew detection
  captureServerTime(res);

  // Throw on 5xx so the retry loop can retry it.
  // 4xx errors are NOT thrown here — they are permanent client errors
  // (bad token, wrong URL, etc.) and should not be retried.
  if (res.status >= 500 && res.status < 600) {
    let bodyText = "";
    try { bodyText = await res.text(); } catch { /* ignore */ }
    throw new Error(`Server error: ${res.status} ${res.statusText} — ${url} — ${bodyText.slice(0, 200)}`);
  }

  // Stage 2: Body timeout — wraps the response so that consumers calling
  // res.json(), res.text(), etc. are protected against slow body streaming.
  // We patch the response's read methods with an AbortController.
  const bodyController = new AbortController();
  const bodyTimer = setTimeout(() => bodyController.abort(), bodyTimeoutMs);

  if (callerSignal) {
    if (callerSignal.aborted) bodyController.abort();
    else callerSignal.addEventListener("abort", () => bodyController.abort(), { once: true });
  }

  // Wrap the response to enforce body timeout on .json()/.text()/.arrayBuffer()
  const originalJson = res.json.bind(res);
  const originalText = res.text.bind(res);
  const originalArrayBuffer = res.arrayBuffer.bind(res);

  const wrapBodyError = (err: any): Error => {
    if (bodyController.signal.aborted && (!callerSignal || !callerSignal.aborted)) {
      return new Error(`Body timeout: ${url} response body not received within ${bodyTimeoutMs / 1000}s`);
    }
    return err;
  };

  res.json = async (): Promise<any> => {
    try {
      return await Promise.race([
        originalJson(),
        new Promise<never>((_, reject) => {
          bodyController.signal.addEventListener("abort", () => reject(wrapBodyError(new Error("aborted"))), { once: true });
        }),
      ]);
    } catch (err) {
      throw wrapBodyError(err);
    } finally {
      clearTimeout(bodyTimer);
    }
  };

  res.text = async (): Promise<string> => {
    try {
      return await Promise.race([
        originalText(),
        new Promise<never>((_, reject) => {
          bodyController.signal.addEventListener("abort", () => reject(wrapBodyError(new Error("aborted"))), { once: true });
        }),
      ]);
    } catch (err) {
      throw wrapBodyError(err);
    } finally {
      clearTimeout(bodyTimer);
    }
  };

  res.arrayBuffer = async (): Promise<ArrayBuffer> => {
    try {
      return await Promise.race([
        originalArrayBuffer(),
        new Promise<never>((_, reject) => {
          bodyController.signal.addEventListener("abort", () => reject(wrapBodyError(new Error("aborted"))), { once: true });
        }),
      ]);
    } catch (err) {
      throw wrapBodyError(err);
    } finally {
      clearTimeout(bodyTimer);
    }
  };

  return res;
}

// ── Main export: cloudFetch with retry ───────────────────────────────────────

export async function cloudFetch(url: string, options: CloudFetchOptions = {}): Promise<Response> {
  const connectTimeoutMs = options.connectTimeout ?? options.timeout ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const bodyTimeoutMs = options.bodyTimeout ?? options.timeout ?? DEFAULT_BODY_TIMEOUT_MS;
  const maxRetries = options.retries ?? 0;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const baseBackoff = Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
      // Add ±25% jitter to prevent thundering herd when multiple clients
      // retry simultaneously after a shared network outage.
      const jitter = Math.floor(baseBackoff * 0.25 * (Math.random() * 2 - 1));
      const backoffMs = baseBackoff + jitter;
      runtimeLog.info("[CloudFetch] Retrying", { url, attempt, backoffMs });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    try {
      return await fetchWithTimeouts(url, options, connectTimeoutMs, bodyTimeoutMs);
    } catch (err: any) {
      lastError = err;
      const isTimeout = err.message?.includes("timeout");
      const isConnectError = err.message?.includes("Connect timeout") || err.code === "ECONNREFUSED" || err.code === "ENOTFOUND";
      const isServerError = err.message?.includes("Server error");
      // Retry on timeouts, connect errors, and 5xx server errors.
      // Never retry on 4xx — those are permanent (bad token, wrong URL, etc.).
      const shouldRetry = isTimeout || isConnectError || isServerError;

      if (attempt < maxRetries && shouldRetry) {
        runtimeLog.warn("[CloudFetch] Attempt failed, will retry", {
          url,
          attempt: attempt + 1,
          error: err.message,
        });
        continue;
      }

      runtimeLog.error("[CloudFetch] All attempts exhausted", {
        url,
        attempts: attempt + 1,
        error: err.message,
      });
      throw err;
    }
  }

  throw lastError || new Error(`Failed to fetch ${url}`);
}

