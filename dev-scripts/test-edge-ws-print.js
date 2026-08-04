/**
 * Test helper: fire a print job via the edge server's /print HTTP endpoint.
 *
 * Usage:
 *   node dev-scripts/test-edge-ws-print.js                    # single KOT job
 *   node dev-scripts/test-edge-ws-print.js --type=BILL        # bill job
 *   node dev-scripts/test-edge-ws-print.js --dup=2            # fire same eventId twice
 *   node dev-scripts/test-edge-ws-print.js --event-id=TEST-001 # custom eventId
 *
 * Requires: edge-server running on localhost:3101
 */

const http = require("http");

const EDGE_URL = process.env.EDGE_URL || "http://localhost:3101";
const args = process.argv.slice(2);

function parseArgs() {
  const opts = { type: "KOT", dup: 1, eventId: null, tableNumber: "T-42" };
  for (const a of args) {
    const [k, v] = a.replace(/^--/, "").split("=");
    if (k === "type") opts.type = v;
    if (k === "dup") opts.dup = parseInt(v, 10);
    if (k === "event-id") opts.eventId = v;
    if (k === "table") opts.tableNumber = v;
  }
  return opts;
}

function firePrintJob(eventId, type, tableNumber) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      type,
      jobType: type,
      printerName: null, // let print-agent resolve from its mapping
      escposData: [
        {
          type,
          format: "escpos",
          data:
            "\x1B\x40" + // init
            "\x1B\x61\x01" + // center align
            "TEST PRINT — " + type + "\n" +
            "Table: " + tableNumber + "\n" +
            "EventId: " + eventId + "\n" +
            "Time: " + new Date().toISOString() + "\n" +
            "\n\n\n" +
            "\x1D\x56\x42\x00", // partial cut
        },
      ],
      eventId,
      data: { tableNumber, requestId: eventId },
    });

    const url = new URL(EDGE_URL + "/print");
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 25000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          const elapsed = Date.now() - startTime;
          console.log(`[${eventId}] HTTP ${res.statusCode} (${elapsed}ms): ${body}`);
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body), elapsed });
          } catch {
            resolve({ status: res.statusCode, body, elapsed });
          }
        });
      }
    );

    req.on("error", (err) => {
      const elapsed = Date.now() - startTime;
      console.error(`[${eventId}] Request failed (${elapsed}ms): ${err.message}`);
      reject(err);
    });

    req.on("timeout", () => {
      const elapsed = Date.now() - startTime;
      console.error(`[${eventId}] Request timed out (${elapsed}ms)`);
      req.destroy();
      reject(new Error("timeout"));
    });

    const startTime = Date.now();
    req.write(payload);
    req.end();
  });
}

async function main() {
  const opts = parseArgs();
  const baseEventId = opts.eventId || `TEST-${type}-${Date.now()}`;

  console.log(`\n=== Edge-WS Print Test ===`);
  console.log(`Edge server: ${EDGE_URL}`);
  console.log(`Job type: ${opts.type}`);
  console.log(`Table: ${opts.tableNumber}`);
  console.log(`Duplicates: ${opts.dup}`);
  console.log(`Base eventId: ${baseEventId}`);
  console.log();

  // Fire all jobs (for dup test, fire near-simultaneously)
  const promises = [];
  for (let i = 0; i < opts.dup; i++) {
    const eventId = opts.dup > 1 ? `${baseEventId}` : baseEventId;
    if (i > 0) {
      // Small delay for second copy to simulate near-simultaneous delivery
      promises.push(
        new Promise((r) => setTimeout(r, 50)).then(() => firePrintJob(eventId, opts.type, opts.tableNumber))
      );
    } else {
      promises.push(firePrintJob(eventId, opts.type, opts.tableNumber));
    }
  }

  const results = await Promise.allSettled(promises);

  console.log(`\n=== Results ===`);
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      const ok_flag = r.value.status === 200 && r.value.body?.ok;
      console.log(`  Job ${i + 1}: ${ok_flag ? "PASS" : "FAIL"} — ${r.value.status} (${r.value.elapsed}ms)`);
      if (ok_flag) ok++;
      else fail++;
    } else {
      console.log(`  Job ${i + 1}: FAIL — ${r.reason?.message || r.reason}`);
      fail++;
    }
  }

  console.log(`\n${ok} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
