// Imported first by tests that write log lines, so they go to a temporary folder
// instead of the real Softshape log folder.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LOCALAPPDATA = mkdtempSync(join(tmpdir(), "softshape-logs-"));
