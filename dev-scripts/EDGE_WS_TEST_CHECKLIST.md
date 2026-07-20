# Edge-WS Print Path — Test Checklist

> **Context**: The LAN fast path (edge server → WebSocket → print-agent → physical printer) has never worked in shipped software. The edge-WS integration was ported from the nested copy to the root (shipped) copy on 2025-07-20. This checklist verifies it works end-to-end before pilot rollout.

## Pre-flight (before touching a printer)

- [ ] **P1. Fresh build from root src/**
  - Run: `cd softshape-print-agent && npm run build`
  - Confirm: `dist/assets/index-*.js` is ~65.66 kB (not 61.95 kB — that was the pre-port size)
  - Confirm: build output says `34 modules transformed`
  - **Verified 2025-07-20**: 65.66 kB, 34 modules, exit code 0

- [ ] **P2. Build-guard fires on nested copy**
  - Run: `cd softshape-print-agent/softshape-print-agent && npx vite build`
  - Confirm: exit code 1, message starts with `[DO NOT BUILD]` (not `[DEPRECATED]`)
  - Confirm: no "STALE" in the message
  - **Verified 2025-07-20**: exit code 1, `[DO NOT BUILD]` message, no "STALE"

- [ ] **P3. All three services running on test machine**
  - Print-agent (Tauri app) — check tray icon visible
  - Edge-server (port 3101) — `curl http://localhost:3101/health` returns 200
  - Backend (cloud) — print-agent shows "Connected" status

- [ ] **P4. Physical printer connected**
  - USB or LAN (whichever the pilot uses)
  - Paper loaded
  - Test print from Windows Settings → Printers & scanners confirms hardware works

## Stage 1 — Basic connectivity (no printing)

- [ ] **S1.1. Print-agent opens edge-WS on startup**
  - Launch print-agent fresh
  - Check console (open DevTools via right-click → Inspect): `[EdgeWS] Connected to edge server WebSocket`
  - Check edge-server logs: new WS client connected

- [ ] **S1.2. Reconnect on edge-server kill**
  - Kill edge-server process (Task Manager → edge-server.exe → End task)
  - Confirm print-agent logs: `[EdgeWS] Disconnected from edge server`
  - Wait 5s — confirm print-agent logs reconnect attempt (not a silent hang)
  - If edge-server is still down, confirm 5s retry loop continues

- [ ] **S1.3. Reconnect on edge-server restart**
  - Restart edge-server (relaunch cashier-desktop, which spawns it)
  - Confirm print-agent logs: `[EdgeWS] Connected to edge server WebSocket`
  - Confirm no manual restart of print-agent was needed

- [ ] **S1.4. Keepalive ping sustains idle connection**
  - Wait >30s with no activity
  - Confirm edge-server still shows the WS client as connected
  - Confirm no disconnect/reconnect cycle occurred

## Stage 2 — Single real print job (happy path)

- [ ] **S2.1. Fire one KOT via edge server /print**
  - Run: `node dev-scripts/test-edge-ws-print.js --type=KOT --table=T-42`
  - Confirm print-agent console logs: `[EdgeWS] Printed [KOT] → <printer name>`

- [ ] **S2.2. Correct printer resolved**
  - Check the log shows the printer name from the mapping (e.g. "Kitchen Printer")
  - NOT a fallback or default printer

- [ ] **S2.3. Paper output is correct**
  - Physically inspect the printout
  - Confirm: "TEST PRINT — KOT", "Table: T-42", eventId, timestamp
  - Confirm: not garbled bytes, correct line breaks, clean cut

- [ ] **S2.4. Ack returned within 20s**
  - Check the test script output: `HTTP 200 (XXXms)`
  - Confirm elapsed < 5000ms (should be well under 20s timeout)
  - Check edge-server logs: job marked as successfully delivered

## Stage 3 — Deliberate failure injection

- [ ] **S3.1. Kill print-agent mid-print**
  - Fire a job: `node dev-scripts/test-edge-ws-print.js`
  - Immediately kill print-agent process (before ack returns)
  - Confirm: test script reports timeout or 502
  - Relaunch print-agent
  - **Confirm**: the same job does NOT auto-redeliver and double-print (edge server doesn't retry on its own — it returns 502 to the caller)
  - **Confirm**: no duplicate print appears

- [ ] **S3.2. Duplicate eventId (cross-path dedup)**
  - Fire same eventId twice near-simultaneously:
    `node dev-scripts/test-edge-ws-print.js --dup=2 --event-id=DEDUP-TEST-001`
  - **Confirm**: only ONE physical print occurs
  - Check print-agent console: one job prints, second logs `[EdgeWS] Duplicate print_job skipped (cross-path Rust dedup)`
  - **Confirm**: both HTTP requests get a response (one 200, one may 200 with `deduped` or 502 — check what the edge server returns for a dup)

- [ ] **S3.3. Printer disconnected**
  - Unplug USB printer (or block network to LAN printer)
  - Fire a job: `node dev-scripts/test-edge-ws-print.js`
  - **Confirm**: print-agent logs `[EdgeWS] Print failed [KOT] → <printer>: <error>`
  - **Confirm**: failure ack sent (test script gets 502, not a 20s hang)
  - **Confirm**: retry queue attempts 3 times with 2s delay, then sends final failure ack
  - Reconnect printer

- [ ] **S3.4. Edge-server killed during in-flight job**
  - Fire a job and immediately kill edge-server
  - **Confirm**: print-agent's edge-WS disconnects, job may fail (no ack path)
  - **Confirm**: cloud fallback path (relayPrintViaCloud) is NOT triggered here because LAN client count was >0 when job was dispatched — the job was already in the WS pipeline
  - **Confirm**: no silent loss — failure is logged visibly on both sides
  - Note: this is a known edge case — the edge server already dispatched via WS, so cloud fallback doesn't apply. The job is lost if the edge server dies mid-dispatch. Document this as a known limitation if confirmed.

## Stage 4 — Interaction with Tauri hardening

- [ ] **S4.1. Close-to-tray keeps edge-WS alive**
  - Close print-agent window (X button, not Quit)
  - Confirm: window hides, tray icon remains
  - Fire a job: `node dev-scripts/test-edge-ws-print.js`
  - **Confirm**: job prints even though window is hidden
  - Check console (reopen window from tray): `[EdgeWS] Printed [KOT]...`

- [ ] **S4.2. Autostart on reboot**
  - Reboot the test machine
  - Do NOT manually launch anything
  - **Confirm**: print-agent starts on its own (tray icon appears)
  - **Confirm**: edge-WS connection establishes (check edge-server logs for WS client)
  - **Confirm**: cloud socket connects (tray tooltip shows "Connected")

- [ ] **S4.3. Sleep/wake reconnect**
  - Put machine to sleep (Start → Power → Sleep)
  - Wait 10s
  - Wake machine
  - **Confirm**: print-agent logs immediate reconnect attempt (visibilitychange/online listener)
  - **Confirm**: edge-WS reconnects within seconds, not 30s+
  - Fire a test job to confirm the reconnected path works

- [ ] **S4.4. Single-instance enforcement**
  - With print-agent already running, launch a second instance
  - **Confirm**: second instance does NOT spawn — existing window is focused/shown
  - **Confirm**: no second edge-WS connection appears in edge-server logs
  - **Confirm**: no duplicate print_job handling (only one WS client)

## Stage 5 — Timing comparison

- [ ] **S5.1. LAN path timing**
  - Fire 5 jobs sequentially: `node dev-scripts/test-edge-ws-print.js` (run 5 times)
  - Record elapsed times from the script output
  - Calculate average — should be < 1000ms (tens to hundreds of ms)

- [ ] **S5.2. Cloud path timing**
  - Stop edge-server (so LAN path is unavailable)
  - Wait for print-agent's edge-WS to disconnect
  - Fire jobs via cloud socket (from backend or another test script)
  - Record elapsed times
  - Calculate average — should be noticeably slower than LAN

- [ ] **S5.3. Compare**
  - LAN average should be meaningfully faster than cloud average
  - If LAN is not faster, investigate: WS connection overhead? Printer resolution latency? Edge server processing?
  - **Do not greenlight pilot rollout if LAN is not faster than cloud** — the entire point of this work is the speed benefit

## Sign-off

- [ ] All Stage 3 (failure injection) passed — no double-prints, no silent losses
- [ ] Tested on actual pilot restaurant printer model (USB/LAN — circle one)
- [ ] Observed during off-peak service window with someone physically present
- [ ] Stage 5 timing comparison confirms LAN is meaningfully faster

**Approved for pilot rollout by**: _______________  **Date**: ___________
