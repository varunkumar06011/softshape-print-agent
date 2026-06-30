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

const PORT = process.env.PORT || 3100;

async function handlePrintJob(body) {
  const { jobType, printerName, text, bytes, data } = body || {};
  if (!jobType || (!text && !Array.isArray(bytes))) {
    return { ok: false, error: 'Missing jobType or print payload' };
  }

  // TODO: wire this to the actual printer driver (Tauri command, node-escpos,
  // or raw network printer). For now we accept the job and return success so
  // the Cashier app can complete the offline print flow.
  console.log('[PrintAgent:HTTP] Print job received:', { jobType, printerName, textLength: text?.length, bytesLength: bytes?.length });

  return { ok: true, queued: true, message: 'Print job accepted by Print Agent' };
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
