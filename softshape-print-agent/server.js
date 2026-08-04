/**
 * SoftShape Print Agent (port 3102) — RETIRED.
 *
 * This standalone Node HTTP server could never print: it runs outside the
 * Tauri webview, so window.__TAURI__ is undefined and every print job
 * failed with "No Tauri runtime available". All print traffic must go to
 * the Edge Server on port 3101, which relays print jobs to the Tauri
 * frontend via WebSocket for physical printing.
 *
 * This stub is kept (not deleted) so old shortcuts/services that still
 * launch `node server.js` don't crash. It responds 410 Gone to all routes.
 */

import http from 'http';
import { URL } from 'url';

const PORT = process.env.PORT || 3102;

const server = http.createServer((req, res) => {
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

  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', service: 'softshape-print-agent', deprecated: true }));
    return;
  }

  res.writeHead(410);
  res.end(JSON.stringify({
    ok: false,
    error: 'This service is retired.',
    message: 'Print agent HTTP server on port 3102 is dead code — it never had printer access. Use the edge server on port 3101 instead, which relays print jobs to the Tauri frontend via WebSocket.',
    redirect: 'http://<lan-ip>:3101/print',
  }));
});

server.listen(PORT, () => {
  console.warn(
    `[DEPRECATED] server.js on port ${PORT} is retired and returns 410 for all requests. ` +
    `All print traffic must go to the edge server on port 3101.`
  );
});
