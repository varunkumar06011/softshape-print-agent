# Relay Durability Test Checklist

End-to-end verification for the print-dedup batch (Tasks #1, #3, toast).

## Prerequisites

- [ ] Edge server running on `localhost:3101`
- [ ] Print service running on `localhost:3103`
- [ ] At least one printer configured and reachable from the print service
- [ ] Printer has paper loaded (for physical printout count)

## Automated Test

```bash
cd softshape-print-agent
node dev-scripts/test-relay-durability.js --printer="YourPrinterName"
```

The script will pause at two points requiring manual action:
1. **Step 2**: Kill the print service process (port 3103)
2. **Step 6**: Restart the print service process (port 3103)

## What the script verifies

| Step | What | Expected |
|------|------|----------|
| 0 | Edge + print service health | Both reachable |
| 1 | Job while PS is UP | HTTP 200, `ok:true`, `queued:false`, print_job status=`printed` |
| 2 | Kill print service | PS health check returns false |
| 3 | Job while PS is DOWN | HTTP 200, `ok:true`, `queued:true`, print_job status=`retrying` |
| 4 | Same eventId again | No new row created (dedup via `ON CONFLICT DO NOTHING`) |
| 5 | Two concurrent jobs, same printer | Both accepted (200 ok), both have print_job rows |
| 6 | Restart print service | PS health check returns true |
| 7 | Wait for retry | All 3 pending jobs reach `printed` status |
| 8 | Row count check | Exactly 1 row per eventId, all `printed` |

## Manual physical verification (after script completes)

- [ ] **Exactly 3 printouts** came out of the printer:
  - 1 for the Step-3 job (was queued, printed after retry)
  - 1 for Concurrent-A job
  - 1 for Concurrent-B job
- [ ] **No printout for Step-4** (dedup — same eventId as Step-3)
- [ ] **Concurrent-A and Concurrent-B printouts are NOT garbled/interleaved** (per-printer mutex working)
- [ ] Each printout shows the correct eventId and is legible

## Failure diagnosis

| Symptom | Likely cause |
|---------|-------------|
| 4 printouts instead of 3 | Dedup failed — `ON CONFLICT` not working or eventId mismatch |
| 2 printouts instead of 3 | One concurrent job was lost — check print_job table for `dead_letter` status |
| Garbled text on A or B | Per-printer mutex not serializing — check `with_printer_lock` in `main.rs` |
| Job stuck in `retrying` after PS restart | Background dispatch loop not running — check `setInterval` in `server.ts` |
| HTTP 503 instead of 200 when PS is down | DB write failing — check SQLite `print_job` table exists and is writable |
| `queued:true` but job not in `retrying` | Race between immediate print attempt and background loop — check `claimPrintJob` |
