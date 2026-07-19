/**
 * SoftShape Print Agent — Local HTTP print server
 *
 * Runs on the same machine as the Cashier desktop app and accepts print jobs
 * over HTTP so the Cashier app can print offline without going through the
 * backend socket.
 *
 * Endpoints:
 *   POST /print   { jobType, printerName, text, bytes, data }
 *   GET  /health
 *
 * In production this server is typically started by the Tauri sidecar or run
 * manually with `node server.js`. The actual printing is delegated to the
 * printer driver layer (Tauri Rust command, node-escpos, or direct raw socket).
 */

import http from 'http';
import { URL } from 'url';

const PORT = process.env.PORT || 3102;

// ── EventId dedup (Issue 7) ─────────────────────────────────────────────────
// server.js runs as a separate Node process from the Tauri webview (agentSocket.js),
// so it can't share the seenEventIds Set. This prevents duplicate prints when the
// captain retries printLocal() after a failure and the backend also emits via socket.
const SEEN_EVENT_IDS_MAX = 500;
const seenEventIds = new Set();

function isEventIdSeen(eventId) {
  return seenEventIds.has(eventId);
}

function markEventIdSeen(eventId) {
  seenEventIds.add(eventId);
  if (seenEventIds.size > SEEN_EVENT_IDS_MAX) {
    const arr = Array.from(seenEventIds);
    seenEventIds.clear();
    arr.slice(-SEEN_EVENT_IDS_MAX).forEach(id => seenEventIds.add(id));
  }
}

function getTauriInvoke() {
  const t = typeof window !== 'undefined' ? window.__TAURI__ : null;
  if (!t) return null;
  if (typeof t.invoke === 'function') return t.invoke.bind(t);
  if (t.tauri && typeof t.tauri.invoke === 'function') return t.tauri.invoke.bind(t.tauri);
  return null;
}

async function handlePrintJob(body) {
  const { jobType, type, printerName, text, bytes, escposData, data, eventId } = body || {};
  const effectiveType = type || jobType;

  // ── Dedup: skip if already printed (Issue 7) ──
  if (eventId && isEventIdSeen(eventId)) {
    console.log(`[PrintAgent:HTTP] Duplicate eventId skipped: ${eventId}`);
    return { ok: true, queued: false, message: 'Duplicate eventId skipped' };
  }

  if (!effectiveType) {
    return { ok: false, error: 'Missing jobType or type' };
  }

  let rawBytes;
  if (escposData && Array.isArray(escposData) && escposData.length > 0) {
    const rawString = escposData.map((d) => d.data || '').join('');
    rawBytes = Array.from(new TextEncoder().encode(rawString));
  } else if (Array.isArray(bytes) && bytes.length > 0) {
    rawBytes = bytes;
  } else if (text) {
    rawBytes = Array.from(new TextEncoder().encode(text));
  } else {
    return { ok: false, error: 'Missing print payload (escposData, bytes, or text required)' };
  }

  const targetPrinter = printerName || data?.printerName;
  if (!targetPrinter) {
    return { ok: false, error: 'Missing printerName' };
  }

  const invoke = getTauriInvoke();
  if (invoke) {
    try {
      const netMatch = targetPrinter.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/);
      if (netMatch) {
        await invoke('print_network', {
          ip: netMatch[1],
          port: parseInt(netMatch[2], 10),
          bytes: rawBytes,
        });
      } else {
        await invoke('print_raw', {
          printerName: targetPrinter,
          bytes: rawBytes,
        });
      }
      console.log(`[PrintAgent:HTTP] Printed [${effectiveType}] → ${targetPrinter} (${rawBytes.length} bytes)`);
      if (eventId) markEventIdSeen(eventId);
      return { ok: true, queued: false, message: 'Printed' };
    } catch (err) {
      console.error(`[PrintAgent:HTTP] Print failed [${effectiveType}] → ${targetPrinter}:`, err);
      return { ok: false, error: err?.message || String(err) };
    }
  }

  console.error(`[PrintAgent:HTTP] No Tauri available — cannot print [${effectiveType}] → ${targetPrinter} (${rawBytes.length} bytes)`);
  return { ok: false, error: 'No Tauri runtime available — print agent must run inside Tauri webview to print' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', service: 'softshape-print-agent' }));
    return;
  }

  if (url.pathname === '/print' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const result = await handlePrintJob(payload);
        res.writeHead(result.ok ? 200 : 400);
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('[PrintAgent:HTTP] Failed to handle print job:', err);
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON payload' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`[PrintAgent:HTTP] Listening on http://localhost:${PORT}`);
});
