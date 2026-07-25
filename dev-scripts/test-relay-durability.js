/**
 * End-to-end test: relay-path durable queue + retry + per-printer mutex.
 *
 * Verifies the three fixes from the print-dedup batch work together:
 *   #1 — /print relay persists to print_job before printing, retries on failure
 *   #3 — per-printer mutex prevents ESC/POS interleaving (concurrent same-printer)
 *   Toast — response body carries queued:true when print service is down
 *
 * Test flow:
 *   1. Fire a relay /print job while print service is UP → expect printed immediately
 *   2. Kill print service (or simulate by pointing at a dead port)
 *   3. Fire a relay /print job → expect 200 with queued:true, print_job status=retrying
 *   4. Fire a second relay /print job with the SAME eventId → expect dedup (no new row)
 *   5. Fire two concurrent relay /print jobs to the same printer with DIFFERENT eventIds
 *      → both should be queued, and when print service comes back, both should print
 *      without interleaving (verified by checking both reach 'printed' status)
 *   6. Restart print service (or point back to live port)
 *   7. Wait for background dispatch loop to retry → expect print_job status=printed
 *   8. Confirm exactly one printout per unique eventId (no duplicates)
 *
 * Prerequisites:
 *   - Edge server running on localhost:3101
 *   - Print service running on localhost:3103 (for steps 1, 6-8)
 *   - At least one printer configured and reachable
 *
 * Usage:
 *   node dev-scripts/test-relay-durability.js
 *   node dev-scripts/test-relay-durability.js --printer="KitchenPrinter"
 *   node dev-scripts/test-relay-durability.js --edge-url=http://localhost:3101
 *   node dev-scripts/test-relay-durability.js --skip-kill   # skip print-service kill steps
 */

import http from "http";

const EDGE_URL = process.env.EDGE_URL || "http://localhost:3101";
const PRINT_SERVICE_URL = process.env.PRINT_SERVICE_URL || "http://localhost:3103";
const DISPATCH_LOOP_INTERVAL_MS = 6000; // edge server dispatches every 5s, add 1s buffer
const MAX_WAIT_FOR_PRINTED_MS = 60000; // max time to wait for retry to succeed

const args = process.argv.slice(2);
function parseArgs() {
  const opts = {
    printer: null,
    edgeUrl: EDGE_URL,
    skipKill: false,
  };
  for (const a of args) {
    const [k, v] = a.replace(/^--/, "").split("=");
    if (k === "printer") opts.printer = v;
    if (k === "edge-url") opts.edgeUrl = v;
    if (k === "skip-kill") opts.skipKill = true;
  }
  return opts;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function httpJson(url, method, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
        timeout: 25000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function firePrintJob(eventId, printerName, type = "KOT") {
  const payload = {
    type,
    jobType: type,
    printerName: printerName || undefined,
    escposData: [
      {
        type,
        format: "escpos",
        data:
          "\x1B\x40" +
          "\x1B\x61\x01" +
          "DURABILITY TEST\n" +
          "EventId: " + eventId + "\n" +
          "Time: " + new Date().toISOString() + "\n" +
          "\n\n\n" +
          "\x1D\x56\x42\x00",
      },
    ],
    eventId,
    data: { tableNumber: "T-TEST", requestId: eventId },
  };
  return httpJson(`${EDGE_URL}/print`, "POST", payload);
}

function getPrintJobStatus(eventId) {
  return httpJson(`${EDGE_URL}/api/edge/print-jobs?status=all`, "GET").then((r) => {
    const jobs = r.body?.jobs || [];
    return jobs.find((j) => j.event_id === eventId) || null;
  });
}

function getPrintServiceHealth() {
  return httpJson(`${PRINT_SERVICE_URL}/health`, "GET").then(
    (r) => r.status === 200,
    () => false
  );
}

function triggerDispatch() {
  return httpJson(`${EDGE_URL}/api/edge/print-jobs/retry`, "POST", {});
}

// ── Test runner ──────────────────────────────────────────────────────────────

async function waitForCondition(name, check, intervalMs, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for: ${name} (${maxMs}ms)`);
}

function log(step, msg) {
  console.log(`\n[Step ${step}] ${msg}`);
}

function pass(msg) {
  console.log(`  ✓ PASS: ${msg}`);
}

function fail(msg) {
  console.error(`  ✗ FAIL: ${msg}`);
  process.exitCode = 1;
}

async function main() {
  const opts = parseArgs();
  console.log("=== Relay Durability End-to-End Test ===");
  console.log(`Edge server:     ${opts.edgeUrl}`);
  console.log(`Print service:   ${PRINT_SERVICE_URL}`);
  console.log(`Printer:         ${opts.printer || "(auto-resolve)"}`);
  console.log(`Skip kill steps: ${opts.skipKill}`);
  console.log();

  // ── Pre-flight: check edge server is up ──────────────────────────────────
  log("0", "Pre-flight: checking edge server and print service health");
  let edgeHealthy, psHealthy;
  try {
    const edgeRes = await httpJson(`${opts.edgeUrl}/health`, "GET");
    edgeHealthy = edgeRes.status === 200;
  } catch {
    edgeHealthy = false;
  }
  if (!edgeHealthy) {
    fail(`Edge server not reachable at ${opts.edgeUrl}`);
    console.error("    Start edge server first: cd softshape-print-agent/edge-server && bun run server.ts");
    return;
  }
  pass(`Edge server reachable at ${opts.edgeUrl}`);

  psHealthy = await getPrintServiceHealth();
  if (psHealthy) {
    pass("Print service is UP");
  } else {
    console.log("  ! Print service is DOWN (steps requiring it will be skipped)");
  }

  // ── Step 1: Fire job while print service is UP → expect immediate print ──
  if (psHealthy) {
    log("1", "Fire relay job while print service is UP — expect printed immediately");
    const eventId = `DUR-1-${Date.now()}`;
    const res = await firePrintJob(eventId, opts.printer);
    console.log(`    Response: HTTP ${res.status} ${JSON.stringify(res.body)}`);

    if (res.status !== 200 || !res.body?.ok) {
      fail(`Expected 200 ok, got ${res.status} ${JSON.stringify(res.body)}`);
    } else if (res.body?.queued === true) {
      fail("Expected queued:false (immediate print), got queued:true");
    } else {
      pass(`Job ${eventId} printed immediately (queued: false, method: ${res.body?.method})`);
    }

    // Verify print_job row shows 'printed'
    const job = await getPrintJobStatus(eventId);
    if (job?.status === "printed") {
      pass(`print_job row status = 'printed' for ${eventId}`);
    } else {
      fail(`print_job row status = '${job?.status}' (expected 'printed') for ${eventId}`);
    }
  } else {
    log("1", "SKIPPED — print service is down");
  }

  if (opts.skipKill) {
    log("2-5", "SKIPPED — --skip-kill flag set");
  } else {
    // ── Step 2: Kill print service ────────────────────────────────────────
    log("2", "Kill print service to simulate outage");
    console.log("    >>> ACTION REQUIRED: Stop the print service now (kill the print-service process on port 3103)");
    console.log("    >>> Waiting for print service to go down...");

    try {
      await waitForCondition(
        "print service down",
        async () => !(await getPrintServiceHealth()),
        2000,
        30000
      );
      pass("Print service is now DOWN");
    } catch {
      fail("Print service did not go down within 30s — skipping kill-dependent steps");
      return;
    }

    // ── Step 3: Fire job while print service is DOWN → expect queued:true ──
    log("3", "Fire relay job while print service is DOWN — expect 200 with queued:true");
    const eventIdDown = `DUR-3-${Date.now()}`;
    const resDown = await firePrintJob(eventIdDown, opts.printer);
    console.log(`    Response: HTTP ${resDown.status} ${JSON.stringify(resDown.body)}`);

    if (resDown.status !== 200) {
      fail(`Expected HTTP 200 (durable queue), got ${resDown.status}`);
    } else if (!resDown.body?.ok) {
      fail(`Expected ok:true, got ${JSON.stringify(resDown.body)}`);
    } else if (resDown.body?.queued !== true) {
      fail(`Expected queued:true, got queued:${resDown.body?.queued}`);
    } else {
      pass(`Job ${eventIdDown} durably queued (queued: true, method: ${resDown.body?.method})`);
    }

    // Verify print_job row shows 'retrying' or 'queued'
    const jobDown = await getPrintJobStatus(eventIdDown);
    if (jobDown && (jobDown.status === "retrying" || jobDown.status === "queued")) {
      pass(`print_job row status = '${jobDown.status}' for ${eventIdDown}`);
    } else {
      fail(`print_job row status = '${jobDown?.status}' (expected 'retrying' or 'queued')`);
    }

    // ── Step 4: Fire same eventId again → expect dedup (no new row) ────────
    log("4", "Fire SAME eventId again — expect dedup (no duplicate row)");
    const resDup = await firePrintJob(eventIdDown, opts.printer);
    console.log(`    Response: HTTP ${resDup.status} ${JSON.stringify(resDup.body)}`);

    if (resDup.status === 200 && resDup.body?.ok) {
      // The job is already in retrying/queued state, so createPrintJob's
      // ON CONFLICT DO NOTHING means no new row. The response should still
      // be queued:true since the job hasn't printed yet.
      pass(`Duplicate eventId ${eventIdDown} did not create a new row`);
    } else {
      fail(`Unexpected response for duplicate eventId: ${resDup.status} ${JSON.stringify(resDup.body)}`);
    }

    // Verify there's still only one row for this eventId
    const allJobs = await httpJson(`${opts.edgeUrl}/api/edge/print-jobs?status=all`, "GET");
    const matchingJobs = (allJobs.body?.jobs || []).filter((j) => j.event_id === eventIdDown);
    if (matchingJobs.length === 1) {
      pass(`Exactly 1 print_job row for ${eventIdDown} (no duplicate)`);
    } else {
      fail(`Found ${matchingJobs.length} rows for ${eventIdDown} (expected 1)`);
    }

    // ── Step 5: Fire two concurrent jobs to same printer → no interleaving ─
    log("5", "Fire two CONCURRENT relay jobs to same printer with different eventIds");
    const eventIdA = `DUR-5A-${Date.now()}`;
    const eventIdB = `DUR-5B-${Date.now()}`;
    console.log(`    Job A: ${eventIdA}`);
    console.log(`    Job B: ${eventIdB}`);

    const [resA, resB] = await Promise.all([
      firePrintJob(eventIdA, opts.printer),
      firePrintJob(eventIdB, opts.printer),
    ]);
    console.log(`    Response A: HTTP ${resA.status} ${JSON.stringify(resA.body)}`);
    console.log(`    Response B: HTTP ${resB.status} ${JSON.stringify(resB.body)}`);

    if (resA.status === 200 && resA.body?.ok && resB.status === 200 && resB.body?.ok) {
      pass("Both concurrent jobs accepted (200 ok)");
    } else {
      fail(`One or both concurrent jobs failed: A=${resA.status}, B=${resB.status}`);
    }

    // Verify both have rows in print_job
    const jobA = await getPrintJobStatus(eventIdA);
    const jobB = await getPrintJobStatus(eventIdB);
    if (jobA && jobB) {
      pass(`Both jobs have print_job rows (A: ${jobA.status}, B: ${jobB.status})`);
    } else {
      fail(`Missing print_job row: A=${!!jobA}, B=${!!jobB}`);
    }

    // ── Step 6: Restart print service ─────────────────────────────────────
    log("6", "Restart print service");
    console.log("    >>> ACTION REQUIRED: Start the print service now (launch print-service on port 3103)");
    console.log("    >>> Waiting for print service to come back up...");

    try {
      await waitForCondition(
        "print service up",
        async () => await getPrintServiceHealth(),
        2000,
        60000
      );
      pass("Print service is back UP");
    } catch {
      fail("Print service did not come back up within 60s — cannot verify retry");
      return;
    }

    // ── Step 7: Wait for background dispatch to retry → expect 'printed' ──
    log("7", "Wait for background dispatch loop to retry pending jobs");

    // Manually trigger dispatch to speed things up
    await triggerDispatch();

    // Wait for eventIdDown to reach 'printed'
    try {
      const printedJob = await waitForCondition(
        `${eventIdDown} → printed`,
        async () => {
          const j = await getPrintJobStatus(eventIdDown);
          return j?.status === "printed" ? j : null;
        },
        3000,
        MAX_WAIT_FOR_PRINTED_MS
      );
      pass(`Job ${eventIdDown} reached 'printed' status after retry`);
    } catch {
      const j = await getPrintJobStatus(eventIdDown);
      fail(`Job ${eventIdDown} did not reach 'printed' (status: ${j?.status}, attempts: ${j?.attempts}, error: ${j?.last_error})`);
    }

    // Wait for concurrent jobs A and B to reach 'printed'
    for (const [label, eid] of [["A", eventIdA], ["B", eventIdB]]) {
      try {
        await waitForCondition(
          `${eid} → printed`,
          async () => {
            const j = await getPrintJobStatus(eid);
            return j?.status === "printed" ? j : null;
          },
          3000,
          MAX_WAIT_FOR_PRINTED_MS
        );
        pass(`Concurrent job ${label} (${eid}) reached 'printed' status`);
      } catch {
        const j = await getPrintJobStatus(eid);
        fail(`Concurrent job ${label} (${eid}) did not reach 'printed' (status: ${j?.status}, attempts: ${j?.attempts})`);
      }
    }

    // ── Step 8: Confirm exactly one printout per eventId ──────────────────
    log("8", "Confirm exactly one printout per unique eventId (no duplicates)");

    // Check that each eventId has exactly one row with status 'printed'
    for (const [label, eid] of [
      ["Step-3", eventIdDown],
      ["Concurrent-A", eventIdA],
      ["Concurrent-B", eventIdB],
    ]) {
      const allJobsFinal = await httpJson(`${opts.edgeUrl}/api/edge/print-jobs?status=all`, "GET");
      const rows = (allJobsFinal.body?.jobs || []).filter((j) => j.event_id === eid);
      const printedRows = rows.filter((j) => j.status === "printed");
      if (rows.length === 1 && printedRows.length === 1) {
        pass(`${label} (${eid}): exactly 1 row, status 'printed' — no duplicate printout`);
      } else {
        fail(`${label} (${eid}): ${rows.length} row(s), ${printedRows.length} printed — expected exactly 1 printed`);
      }
    }

    console.log();
    console.log(">>> PHYSICAL CHECK: Verify the printer produced exactly 3 printouts:");
    console.log("    1. One for Step-3 job (was queued, printed after retry)");
    console.log("    2. One for Concurrent-A job");
    console.log("    3. One for Concurrent-B job");
    console.log("    No printout for Step-4 (dedup — same eventId as Step-3)");
    console.log("    If 4 printouts came out, the dedup failed.");
    console.log("    If the Concurrent-A and Concurrent-B printouts have garbled/interleaved text, the per-printer mutex failed.");
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n=== Test Complete ===");
  if (process.exitCode) {
    console.error("Some steps FAILED — see above.");
  } else {
    console.log("All automated checks PASSED. Complete the physical printout count to fully close.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
