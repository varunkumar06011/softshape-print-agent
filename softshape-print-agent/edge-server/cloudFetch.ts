/**
 * Shared cloud fetch helper for the edge server.
 * Wraps fetch() with AbortSignal.timeout() to prevent hung TCP connections
 * from blocking the sync worker or config downloads.
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

export async function cloudFetch(url: string, options: CloudFetchOptions = {}): Promise<Response> {
  const timeoutMs = options.timeout || DEFAULT_TIMEOUT_MS;

  // If caller already provided a signal, use it; otherwise create a timeout signal
  let signal: AbortSignal;
  if (options.signal) {
    signal = options.signal;
  } else {
    signal = AbortSignal.timeout(timeoutMs);
  }

  const { timeout: _removed, ...fetchOptions } = options;

  return fetch(url, {
    ...fetchOptions,
    signal,
  });
}
