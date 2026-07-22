/**
 * Shared cloud fetch helper for the edge server.
 * Wraps fetch() with AbortSignal.timeout() to prevent hung TCP connections
 * from blocking the sync worker or config downloads.
 *
 * Also captures the server time from the `Date` response header to detect
 * clock skew on the edge machine. The offset is used by getKolkataDateString()
 * to ensure KOT/bill counters reset at the correct IST midnight even if the
 * local clock is wrong.
 *
 * Usage:
 *   import { cloudFetch } from './cloudFetch';
 *   const res = await cloudFetch(`${backendUrl}/api/edge/config`, {
 *     method: 'GET',
 *     headers: { Authorization: `Bearer ${token}` },
 *   });
 *
 * The default timeout is 30 seconds. Override with the `timeout` option:
 *   const res = await cloudFetch(url, { timeout: 60_000 });
 */

const DEFAULT_TIMEOUT_MS = 30_000;

type CloudFetchOptions = RequestInit & { timeout?: number };

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
        console.warn(`[CloudFetch] Clock skew detected: local clock is ${offset > 0 ? 'behind' : 'ahead'} by ${Math.round(Math.abs(offset) / 60000)}min. KOT/bill counters will use server time.`);
      }
    }
  } catch { /* ignore */ }
}

export async function cloudFetch(url: string, options: CloudFetchOptions = {}): Promise<Response> {
  const timeoutMs = options.timeout || DEFAULT_TIMEOUT_MS;

  const { timeout: _removed, signal: callerSignal, ...fetchOptions } = options;

  // Use AbortController+setTimeout instead of AbortSignal.timeout().
  // AbortSignal.timeout() can fail to fire in compiled Bun binaries,
  // causing fetch to hang indefinitely (root cause of config download timeouts).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // If caller provided a signal, abort when either fires
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });

    // Capture server time for clock skew detection
    captureServerTime(res);

    return res;
  } catch (err: any) {
    if (controller.signal.aborted && (!callerSignal || !callerSignal.aborted)) {
      throw new Error(`Request to ${url} timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
