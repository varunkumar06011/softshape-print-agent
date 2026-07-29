// ─────────────────────────────────────────────────────────────────────────────
// orderService.ts — Local order creation + KOT printing (the hot path)
// ─────────────────────────────────────────────────────────────────────────────
// This is the Petpooja-style fast path:
//   1. Write to local SQLite (1 transaction, 4-5 queries, ~2ms)
//   2. Build ESC/POS bytes (pure string ops, ~1ms)
//   3. Print directly via Tauri USB (~10-30ms)
//   4. Return HTTP response to captain (~1ms over LAN)
//   5. Sync to cloud in background (fire-and-forget)
//
// Total: 15-40ms from button press to printer starting.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, getNextKotNumber, enqueueSync, getKolkataDateString, createPrintJob, updatePrintJobStatus, getPendingPrintJobs, claimPrintJob, reclaimStalePrintingJobs, getPrintJobByEventId, lookupCommand, recordCommand, nextTableRevision, nextOrderRevision } from "./db.ts";
import { buildFoodKOT, buildLiquorKOT, buildCancelKOT, buildBill, type PrintItem, type OrderData } from "./escpos.ts";
import { resolvePrinterName, printToPrinter } from "./printer.ts";
import { lanBroadcast } from "./lanBroadcast.ts";

// ─── Phase 1: Command metadata + durable idempotency ─────────────────────────
// Every edge business command carries CommandMeta for idempotency and optimistic
// concurrency control. The command_log table stores the original result so a
// replay of the same (restaurantId, requestId, commandType) returns the original
// response without reapplying side effects.

export interface CommandMeta {
  requestId?: string;
  deviceId?: string;
  expectedRevision?: number;
  isExtraTable?: boolean;
  tableNumber?: string;
}

export interface RevisionResponse {
  revision?: number;
  tableRevision?: number;
}

function checkCommandIdempotency<T>(
  restaurantId: string,
  meta: CommandMeta | undefined,
  commandType: string,
  entityId: string,
): { replay: boolean; result?: T } {
  if (!meta?.requestId) return { replay: false };
  const entry = lookupCommand(restaurantId, meta.requestId, commandType);
  if (!entry) return { replay: false };
  if (entry.status === "applied" && entry.response_json) {
    try {
      const result = JSON.parse(entry.response_json) as T;
      return { replay: true, result };
    } catch {
      return { replay: false };
    }
  }
  // Rejected/failed commands are NOT replayed — the transaction was rolled back
  // (nothing was written), so retrying with the same requestId is safe and
  // should be allowed to re-attempt the operation.
  return { replay: false };
}

function recordCommandResult(
  restaurantId: string,
  meta: CommandMeta | undefined,
  commandType: string,
  entityType: string,
  entityId: string,
  status: "applied" | "rejected" | "failed",
  response: any,
  resultingRevision?: number | null,
  errorMessage?: string | null,
): void {
  if (!meta?.requestId) return;
  recordCommand({
    restaurant_id: restaurantId,
    request_id: meta.requestId,
    command_type: commandType,
    entity_type: entityType,
    entity_id: entityId,
    device_id: meta.deviceId ?? null,
    command_ts: Date.now(),
    expected_revision: meta.expectedRevision ?? null,
    resulting_revision: resultingRevision ?? null,
    status,
    response_json: JSON.stringify(response),
    error_message: errorMessage ?? null,
  });
}

// ─── Print dispatch via HTTP bridge ───────────────────────────────────────────
// The edge server (Bun process) does NOT have window.__TAURI__. It sends print
// jobs to the cashier-desktop's print bridge (HTTP POST to port 3102), which
// runs inside the Tauri Rust core and calls print_raw / print_network directly.
// If the bridge is unreachable (cashier app not running), falls back to cloud
// relay via the cloud WebSocket socket.

interface PrintGroup {
  printerName: string | null;
  escposData: any[];
  type: string;
}

async function printWithLanFallback(
  groups: PrintGroup[],
  requestId?: string,
): Promise<any[]> {
  const results: any[] = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (group.escposData.length === 0) {
      results.push({ ok: false, printerName: group.printerName || "unknown", bytes: 0, error: "No print data", method: "noop" });
      continue;
    }

    const eventId = `${group.type}-${requestId || Date.now()}-${i}`;

    // Try the print service first (isolated Rust process on :3103)
    if (group.printerName) {
      const result = await printToPrinter(group.printerName, group.escposData, eventId, group.type);
      if (result.ok) {
        results.push({ ok: true, printerName: group.printerName, bytes: result.bytes, method: "print_service", eventId });
        continue;
      }
      console.warn(`[Print] Print service failed for ${group.type} → ${group.printerName}: ${result.error} — trying cloud relay`);
    }

    // R5: Cloud relay removed — SQLite queue retry loop handles failures.
    results.push({
      ok: false,
      printerName: group.printerName || null,
      bytes: 0,
      error: "Print service unavailable",
      method: "noop",
      eventId,
    });
  }

  return results;
}

async function printSingleWithLanFallback(
  printerName: string | null,
  escposData: any[],
  type: string,
  requestId?: string,
): Promise<any> {
  const eventId = `${type}-${requestId || Date.now()}`;

  // Try the print service first (isolated Rust process on :3103)
  if (printerName) {
    const result = await printToPrinter(printerName, escposData, eventId, type);
    if (result.ok) {
      return { ok: true, printerName, bytes: result.bytes, method: "print_service", eventId };
    }
    console.warn(`[Print] Print service failed for ${type} → ${printerName}: ${result.error} — trying cloud relay`);
  }

  // R5: Cloud relay removed — SQLite queue retry loop handles failures.
  return { ok: false, printerName, bytes: 0, error: "Print service unavailable", method: "noop", eventId };
}

// ─── Durable print queue integration ──────────────────────────────────────────
// persistAndDispatchPrints stores each print group as a print_job row in SQLite
// (idempotent via event_id) BEFORE attempting to print. This ensures that if the
// edge server crashes between order creation and printing, the background dispatch
// loop can retry the pending jobs. After dispatch, the print_job status is updated
// based on the ack result.

// ─── Print intent preparation (pure computation, no side effects) ───────────
// Splits the old persistAndDispatchPrints into a prepare phase (pure) and a
// dispatch phase (async). This allows print intents to be persisted inside
// the same SQLite transaction as the order/KOT, guaranteeing atomicity.

interface PrintIntent {
  eventId: string;
  group: PrintGroup;
  skip: boolean;              // true if escposData is empty
  alreadyPrintedLocally: boolean; // true if captain already printed this group
}

type KotEventIdEntry = string | { type: string; eventId: string };

function preparePrintIntents(
  groups: PrintGroup[],
  requestId: string | undefined,
  kotEventIds: KotEventIdEntry[] | null | undefined,
): PrintIntent[] {
  // Build a type→eventId lookup from captain-provided kotEventIds.
  //
  // Supports two formats:
  // 1. Legacy: string[] with suffix-matching (-food, -liquor, -bill, -cancel)
  // 2. Structured: { type: string, eventId: string }[] — explicit type mapping
  //
  // The structured format is preferred because it works with any eventId format
  // (including UUIDs from generateIntentId()), fixing the latent dedup bug
  // where UUID-format event IDs didn't match any suffix pattern.
  const eventIdByType: Record<string, string> = {};
  const locallyPrintedEventIds = new Set<string>();
  if (kotEventIds && kotEventIds.length > 0) {
    for (const entry of kotEventIds) {
      if (typeof entry === "string") {
        // Legacy format: suffix matching
        const id = entry;
        locallyPrintedEventIds.add(id);
        if (id.endsWith("-food")) eventIdByType["KOT"] = id;
        else if (id.endsWith("-liquor")) eventIdByType["BAR_KOT"] = id;
        else if (id.endsWith("-bill")) eventIdByType["BILL"] = id;
        else if (id.endsWith("-cancel")) eventIdByType["CANCEL_KOT"] = id;
      } else if (entry && typeof entry === "object" && entry.type && entry.eventId) {
        // Structured format: explicit type→eventId mapping
        eventIdByType[entry.type] = entry.eventId;
        locallyPrintedEventIds.add(entry.eventId);
      }
    }
  }

  return groups.map((group, i) => {
    if (group.escposData.length === 0) {
      return { eventId: "", group, skip: true, alreadyPrintedLocally: false };
    }
    const eventId = eventIdByType[group.type] || `${group.type}-${requestId || Date.now()}-${i}`;
    const alreadyPrintedLocally = locallyPrintedEventIds.has(eventId);
    return { eventId, group, skip: false, alreadyPrintedLocally };
  });
}

// Persist print intents inside a transaction (synchronous, no dispatch).
function persistPrintIntentsInTx(
  intents: PrintIntent[],
  restaurantId: string,
  orderId: string,
  kotId: string,
  kotNumber: number,
  tableId: string,
  captainName: string | undefined,
): void {
  for (const intent of intents) {
    if (intent.skip || intent.alreadyPrintedLocally) continue;
    createPrintJob({
      eventId: intent.eventId,
      restaurantId,
      orderId,
      kotId,
      kotNumber,
      tableId,
      printerName: intent.group.printerName,
      jobType: intent.group.type,
      escposData: intent.group.escposData,
      itemSummary: [],
      captainName: captainName || null,
    });
  }
}

// Dispatch print intents after the transaction commits.
// Uses bounded-wait (3s timeout) to return actual print status instead of fire-and-forget.
export async function awaitDispatchBounded(
  eventId: string,
  group: PrintGroup,
  requestId?: string,
  timeoutMs = 5000,
): Promise<any> {
  let dispatchPromise: Promise<any>;
  try {
    dispatchPromise = dispatchSinglePrintJob(eventId, group, requestId);
  } catch (err: any) {
    return { ok: false, printerName: group.printerName || "unknown", bytes: 0, error: err?.message || "Dispatch threw synchronously", method: "durable_queued", eventId };
  }
  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve("timeout"), timeoutMs));
  let result: any;
  try {
    result = await Promise.race([dispatchPromise, timeoutPromise]);
  } catch (err: any) {
    return { ok: false, printerName: group.printerName || "unknown", bytes: 0, error: err?.message || "Dispatch failed", method: "durable_queued", eventId };
  }

  if (result === "timeout") {
    // Don't cancel the underlying print — just stop awaiting.
    // The background loop will handle retry if needed.
    return { ok: null, printerName: group.printerName, bytes: 0, method: "durable_queued", eventId, pending: true };
  }

  // Dispatch completed within timeout — check actual status
  try {
    const job = getPrintJobByEventId(eventId);
    if (job?.status === "printed") {
      return { ok: true, printerName: group.printerName, bytes: 0, method: job.acked_via || "print_service", eventId };
    } else {
      return { ok: false, printerName: group.printerName || "unknown", bytes: 0, error: job?.last_error || "Print failed — will retry automatically", method: "durable_queued", eventId };
    }
  } catch {
    return { ok: false, printerName: group.printerName || "unknown", bytes: 0, error: "Failed to read print job status", method: "durable_queued", eventId };
  }
}

function dispatchPrintIntents(
  intents: PrintIntent[],
  requestId?: string,
): Promise<any>[] {
  return intents.map((intent) => {
    if (intent.skip) {
      return Promise.resolve({ ok: false, printerName: intent.group.printerName || "unknown", bytes: 0, error: "No print data", method: "noop" });
    }
    if (intent.alreadyPrintedLocally) {
      return Promise.resolve({ ok: true, printerName: intent.group.printerName || "unknown", bytes: 0, method: "skipped_local_print", eventId: intent.eventId });
    }
    return awaitDispatchBounded(intent.eventId, intent.group, requestId);
  });
}

export async function dispatchSinglePrintJob(
  eventId: string,
  group: PrintGroup,
  requestId?: string,
): Promise<void> {
  if (!claimPrintJob(eventId)) {
    return;
  }

  try {
    // Try the print service first (isolated Rust process on :3103)
    if (group.printerName) {
      const result = await printToPrinter(group.printerName, group.escposData, eventId, group.type);
      if (result.ok) {
        updatePrintJobStatus(eventId, "printed", null, "local");
        console.log(`[Print] Job ${eventId} → ${group.printerName} ✓`);
        return;
      }
      console.warn(`[Print] Job ${eventId} → ${group.printerName} print service failed: ${result.error}`);
      updatePrintJobStatus(eventId, "retrying", result.error || "Print service call failed");
      return;
    }

    // No printer mapped for this group — not a print-service outage.
    // This means resolvePrinterName() returned undefined for the item's
    // printer_target / category_printer_target. The fix is in printer config,
    // not in restarting the print service.
    const mappingError = `No printer mapped for ${group.type} group (printerName is null)`;
    console.warn(`[Print] Job ${eventId} — ${mappingError}`);
    updatePrintJobStatus(eventId, "retrying", mappingError);
  } catch (err: any) {
    updatePrintJobStatus(eventId, "retrying", err?.message || String(err));
    console.error(`[Print] Job ${eventId} dispatch error:`, err);
  }
}

// ─── Background dispatch loop for pending print jobs ──────────────────────────
// Called periodically by server.ts. Picks up print_job rows in 'queued' or
// 'retrying' status and re-dispatches them. Dispatches up to MAX_PER_PRINTER
// jobs per printer per cycle. The Rust print-service has per-printer mutex
// serialization (PRINTER_LOCKS), so concurrent dispatches to the same printer
// are queued by the mutex. The cap prevents unbounded thread accumulation if
// a printer jams (no lock timeout in the Rust service).

let _dispatchRunning = false;
const MAX_PER_PRINTER = 3;

export async function dispatchPendingPrintJobs(): Promise<{ dispatched: number; remaining: number }> {
  if (_dispatchRunning) return { dispatched: 0, remaining: 0 };
  _dispatchRunning = true;

  try {
    const reclaimed = reclaimStalePrintingJobs();
    if (reclaimed > 0) {
      console.log(`[PrintDispatch] Reclaimed ${reclaimed} stale printing job(s)`);
    }

    const pending = getPendingPrintJobs(50);
    if (pending.length === 0) return { dispatched: 0, remaining: 0 };

    // Group by printer_name and dispatch up to MAX_PER_PRINTER per printer per cycle
    const printerJobCounts = new Map<string, number>();
    let dispatched = 0;

    for (const job of pending) {
      const printerKey = job.printer_name || "__auto__";
      const count = printerJobCounts.get(printerKey) || 0;
      if (count >= MAX_PER_PRINTER) continue;
      printerJobCounts.set(printerKey, count + 1);

      let escposData: any[];
      try {
        escposData = JSON.parse(job.escpos_data);
      } catch {
        updatePrintJobStatus(job.event_id, "failed", "Corrupted escpos_data in print_job row");
        continue;
      }

      const group: PrintGroup = {
        printerName: job.printer_name,
        escposData,
        type: job.job_type,
      };

      // Dispatch without blocking — fire and forget per printer
      try {
        dispatchSinglePrintJob(job.event_id, group, undefined);
        dispatched++;
      } catch (e: any) {
        updatePrintJobStatus(job.event_id, "retrying", `Background dispatch threw: ${e?.message || e}`);
      }
    }

    return { dispatched, remaining: pending.length - dispatched };
  } finally {
    _dispatchRunning = false;
  }
}

// ─── Shared KOT print group builder ─────────────────────────────────────────
// Consolidates the KOT grouping logic used by both createOrder and updateOrderItems.
// Groups items by resolved printer name, with legacy menuType fallback.

interface EdgeKotItem {
  name: string;
  quantity: number;
  price: number | string;
  notes?: string | null;
  menuType?: string;
  printerName?: string | null;
  printerTarget?: string | null;
}

function buildKotPrintGroups(
  mappedItems: EdgeKotItem[],
  kotOrderData: OrderData,
  table: any,
  printerConfig: Record<string, any>,
): Array<{ printerName: string | null; escposData: any[]; type: string }> {
  const groupedByPrinter = new Map<string | null | undefined, EdgeKotItem[]>();
  for (const item of mappedItems) {
    const key = item.printerName;
    if (!groupedByPrinter.has(key)) groupedByPrinter.set(key, []);
    groupedByPrinter.get(key)!.push(item);
  }

  const printGroups: Array<{ printerName: string | null; escposData: any[]; type: string }> = [];

  for (const [printerName, groupItems] of groupedByPrinter) {
    if (!printerName) {
      // Legacy fallback: split by menuType
      const kitchenItems = groupItems.filter((i) => i.printerTarget !== "BAR_PRINTER" && i.menuType !== "LIQUOR");
      const barItems = groupItems.filter((i) => i.printerTarget === "BAR_PRINTER" || i.menuType === "LIQUOR");

      if (kitchenItems.length > 0) {
        const kitchenPrintItems = kitchenItems.map((i) => ({
          name: i.name, quantity: i.quantity, price: Number(i.price), notes: i.notes ?? null, type: "food" as const,
        }));
        const escpos = buildFoodKOT({ ...kotOrderData, items: kitchenPrintItems });
        if (escpos.length > 0) {
          const fallbackPrinter = table.kot_printer_name || resolvePrinterName(null, "KOT_PRINTER", null, printerConfig);
          // Don't drop if no fallback printer — Tauri frontend will resolve from its local mapping
          printGroups.push({ printerName: fallbackPrinter || null, escposData: escpos, type: "KOT" });
        }
      }
      if (barItems.length > 0) {
        const barPrintItems = barItems.map((i) => ({
          name: i.name, quantity: i.quantity, price: Number(i.price), notes: i.notes ?? null, type: "liquor" as const,
        }));
        const escpos = buildLiquorKOT({ ...kotOrderData, items: barPrintItems });
        if (escpos.length > 0) {
          const fallbackPrinter = resolvePrinterName(null, "BAR_PRINTER", null, printerConfig);
          // Don't drop if no fallback printer — Tauri frontend will resolve from its local mapping
          printGroups.push({ printerName: fallbackPrinter || null, escposData: escpos, type: "BAR_KOT" });
        }
      }
    } else {
      // Precise printer routing
      const isAllLiquor = groupItems.every((i) => i.menuType === "LIQUOR");
      const builder = isAllLiquor ? buildLiquorKOT : buildFoodKOT;
      const printItems = groupItems.map((i) => ({
        name: i.name, quantity: i.quantity, price: Number(i.price), notes: i.notes ?? null,
        type: (i.menuType === "LIQUOR" ? "liquor" : "food") as "food" | "liquor",
      }));
      const escpos = builder({ ...kotOrderData, items: printItems });
      if (escpos.length > 0) {
        printGroups.push({ printerName, escposData: escpos, type: isAllLiquor ? "BAR_KOT" : "KOT" });
      }
    }
  }

  return printGroups;
}

// ─── Active order statuses ───────────────────────────────────────────────────

const ACTIVE_ORDER_STATUSES = ["PENDING", "CONFIRMED", "PREPARING", "READY", "BILLING_REQUESTED"];

// ─── Server-side price resolution (Bug 1 fix) ───────────────────────────────
// Mirrors the cloud buildVenuePriceMap: resolves the venue's price profile
// from local SQLite and returns a map of menuItemId → resolved price.
// Falls back to menu_item.base_price, then default variant price.

function buildEdgePriceMap(venueId: string | null | undefined, restaurantId: string): Map<string, number> {
  const db = getDb();
  const priceMap = new Map<string, number>();

  if (!venueId) return priceMap;

  // 1. Look up venue → priceProfileId
  const venue = db.query("SELECT price_profile_id FROM venue WHERE id = ?").get(venueId) as any;
  if (!venue?.price_profile_id) return priceMap;

  // 2. Load all price profile items for this profile
  const profileItems = db.query("SELECT menu_item_id, price FROM price_profile_item WHERE price_profile_id = ?").all(venue.price_profile_id) as any[];
  for (const pi of profileItems) {
    priceMap.set(pi.menu_item_id, Number(pi.price));
  }

  return priceMap;
}

// Resolve a single item's price: priceMap → base_price → default variant price → client fallback
function resolveItemPrice(
  menuItemId: string,
  priceMap: Map<string, number>,
  menuItemMap: Map<string, any>,
  clientPrice: number,
): number {
  const resolved = priceMap.get(menuItemId);
  if (resolved != null && resolved > 0) return resolved;

  const mi = menuItemMap.get(menuItemId);
  if (mi) {
    const base = Number(mi.base_price ?? 0);
    if (base > 0) return base;
  }

  // Try default variant
  if (mi) {
    const db = getDb();
    const variant = db.query("SELECT price FROM menu_item_variant WHERE menu_item_id = ? AND is_default = 1 LIMIT 1").get(menuItemId) as any;
    if (variant && Number(variant.price) > 0) return Number(variant.price);
  }

  // Last resort: client-sent price (already validated as >= 0)
  return Number(clientPrice);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CreateOrderInput {
  tableId: string;
  items: Array<{
    menuItemId: string;
    name: string;
    price: number;
    quantity: number;
    notes?: string | null;
    menuType?: string;
  }>;
  captainId?: string;
  captainName?: string;
  createdByUserId?: string;
  platform?: string;
  requestId?: string;
  orderByRole?: string;
  localPrinted?: boolean;
  preReservedKotNumber?: number | null;
  kotEventIds?: KotEventIdEntry[] | null;
  deviceId?: string;
  expectedRevision?: number;
  isExtraTable?: boolean;
  tableNumber?: string;
}

export interface CreateOrderResult {
  success: boolean;
  orderId?: string;
  kotNumber?: number;
  kotId?: string;
  table?: any;
  order?: any;
  printResults?: any[];
  error?: string;
  statusCode?: number;
  revision?: number;
  tableRevision?: number;
}

// ─── Helper: Safe JSON parse ──────────────────────────────────────────────────

function safeParseJson<T>(raw: any, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ─── Helper: Get outlet settings from local DB ───────────────────────────────

function getOutlet(restaurantId: string): any | null {
  const db = getDb();
  const row = db.query("SELECT * FROM outlet WHERE id = ?").get(restaurantId) as any | null;
  if (!row) return null;
  return {
    ...row,
    printerConfig: safeParseJson(row.printer_config, {}),
    enabledModules: safeParseJson(row.enabled_modules, {}),
    pricesIncludeGst: !!row.prices_include_gst,
    gstRegistered: !!row.gst_registered,
  };
}

// ─── Helper: Get table with section info ─────────────────────────────────────

function getTableWithSection(tableId: string): any | null {
  const db = getDb();
  const row = db.query(`
    SELECT t.*, s.name as section_name, s.venue_id, s.floor_id,
           v.name as venue_name, v.venue_type, v.kot_enabled, v.kot_printer_name, v.bill_printer_name,
           v.price_profile_id, v.tax_profile_id
    FROM "table" t
    LEFT JOIN section s ON t.section_id = s.id
    LEFT JOIN venue v ON s.venue_id = v.id
    WHERE t.id = ?
  `).get(tableId) as any | null;
  return row;
}

// ─── Helper: Get menu item with category for printer routing ─────────────────

function getMenuItemsWithCategories(menuItemIds: string[]): Map<string, any> {
  const db = getDb();
  const map = new Map<string, any>();

  if (menuItemIds.length === 0) return map;

  const placeholders = menuItemIds.map(() => "?").join(",");
  const rows = db.query(`
    SELECT m.*, c.name as category_name, c.printer_target as category_printer_target
    FROM menu_item m
    LEFT JOIN category c ON m.category_id = c.id
    WHERE m.id IN (${placeholders})
  `).all(...menuItemIds) as any[];

  for (const row of rows) {
    map.set(row.id, {
      ...row,
      is_veg: !!row.is_veg,
      is_available: !!row.is_available,
      is_deleted: !!row.is_deleted,
      gst_enabled: !!row.gst_enabled,
    });
  }

  return map;
}

// ─── Helper: Format table number for display ─────────────────────────────────

function formatTableNumber(table: any): string {
  const sectionTag = table?.section_tag;
  const sectionName = table?.section_name;
  const venueType = table?.venue_type;

  if (sectionTag && sectionTag.startsWith("venue-")) {
    return table.label || String(table.number);
  }

  // Bar outlet: B prefix, Restaurant: T prefix
  if (venueType === "BAR" || (sectionTag && sectionTag.includes("bar"))) {
    return `B${table.number}`;
  }
  return `T${table.number}`;
}

// ─── Helper: Build KOT history entry ─────────────────────────────────────────

function buildKotHistoryEntry(kotNumber: number, items: any[]): any {
  return {
    id: String(kotNumber),
    time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }),
    items: items.map((i) => ({
      id: i.menuItemId,
      n: i.name,
      p: Number(i.price),
      q: i.quantity,
      s: "KOT Sent",
      orderItemId: i.orderItemId,
      notes: i.notes,
    })),
  };
}

// ─── Create Order (the hot path) ─────────────────────────────────────────────

export async function createOrder(
  restaurantId: string,
  input: CreateOrderInput
): Promise<CreateOrderResult> {
  const { tableId, items, captainId, captainName, createdByUserId, platform, requestId, orderByRole, localPrinted, preReservedKotNumber } = input;

  if (!items || items.length === 0) {
    return { success: false, error: "No items in order", statusCode: 400 };
  }

  // ── Validate item data — reject negative prices or quantities ──────────────
  for (const item of items) {
    if (!item.menuItemId || !item.name) {
      return { success: false, error: "Each item must have menuItemId and name", statusCode: 400 };
    }
    if (Number(item.price) < 0 || Number(item.quantity) <= 0) {
      return { success: false, error: `Invalid price/quantity for item: ${item.name}`, statusCode: 400 };
    }
  }

  const db = getDb();

  // ── Phase 1: Durable idempotency check via command_log ────────────────────
  // If this requestId was already processed for createOrder, return the original
  // result without reapplying any side effects (no duplicate KOTs, items, prints).
  const idem = checkCommandIdempotency<CreateOrderResult>(restaurantId, input, "createOrder", tableId);
  if (idem.replay && idem.result) {
    return idem.result;
  }

  // ── Legacy idempotency check: if requestId already exists, return existing order ──
  if (requestId) {
    const existing = db.query("SELECT * FROM order_record WHERE last_request_id = ?").get(requestId) as any;
    if (existing) {
      // Return the existing order — duplicate request
      const existingItems = db.query("SELECT * FROM order_item WHERE order_id = ?").all(existing.id) as any[];
      const replayResult: CreateOrderResult = {
        success: true,
        orderId: existing.id,
        kotNumber: 0, // Already created before
        order: { ...existing, items: existingItems },
        revision: existing.revision ?? 1,
        error: "Duplicate request — returning existing order",
      };
      recordCommandResult(restaurantId, input, "createOrder", "table", tableId, "applied", replayResult, existing.revision ?? 1);
      return replayResult;
    }
  }

  // ── Check for active order on table (skip for extra tables) ───────────────
  if (!input.isExtraTable) {
    const activeOrder = db.query(
      `SELECT * FROM order_record WHERE table_id = ? AND restaurant_id = ? AND status IN (${ACTIVE_ORDER_STATUSES.map(() => "?").join(",")}) AND is_deleted = 0`
    ).get(tableId, restaurantId, ...ACTIVE_ORDER_STATUSES) as any;

    if (activeOrder) {
      const rejectResult = {
        success: false,
        error: "Table already has an active order — use update items instead",
        statusCode: 409,
        orderId: activeOrder.id,
      };
      recordCommandResult(restaurantId, input, "createOrder", "table", tableId, "rejected", rejectResult, null, rejectResult.error);
      return rejectResult;
    }
  }

  // ── Get table + outlet info ────────────────────────────────────────────────
  const table = getTableWithSection(tableId);
  if (!table) {
    const rejectResult = { success: false, error: "Table not found", statusCode: 404 };
    recordCommandResult(restaurantId, input, "createOrder", "table", tableId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  const outlet = getOutlet(restaurantId);
  if (!outlet) {
    const rejectResult = { success: false, error: "Outlet not found in local DB", statusCode: 404 };
    recordCommandResult(restaurantId, input, "createOrder", "table", tableId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  // ── Get menu items with categories for printer routing ─────────────────────
  const menuItemIds = items.map((i) => i.menuItemId).filter(Boolean);
  const menuItemMap = getMenuItemsWithCategories(menuItemIds);

  // ── Validate menu item availability — reject unavailable or deleted items ──
  for (const item of items) {
    const mi = menuItemMap.get(item.menuItemId);
    if (!mi) {
      const rejectResult = { success: false, error: `Menu item not found: ${item.name}`, statusCode: 400 };
      recordCommandResult(restaurantId, input, "createOrder", "table", tableId, "rejected", rejectResult, null, rejectResult.error);
      return rejectResult;
    }
    if (mi.is_deleted) {
      const rejectResult = { success: false, error: `Menu item deleted: ${item.name}`, statusCode: 400 };
      recordCommandResult(restaurantId, input, "createOrder", "table", tableId, "rejected", rejectResult, null, rejectResult.error);
      return rejectResult;
    }
    if (!mi.is_available) {
      const rejectResult = { success: false, error: `Menu item not available: ${item.name}`, statusCode: 400 };
      recordCommandResult(restaurantId, input, "createOrder", "table", tableId, "rejected", rejectResult, null, rejectResult.error);
      return rejectResult;
    }
  }

  // ── Server-side price resolution (Bug 1 fix) ──────────────────────────────
  // Never trust client-sent prices — resolve from local SQLite price profiles.
  const venueId = table.venue_id ?? null;
  const priceMap = buildEdgePriceMap(venueId, restaurantId);
  const resolvedItems = items.map((i) => ({
    ...i,
    price: resolveItemPrice(i.menuItemId, priceMap, menuItemMap, Number(i.price)),
  }));

  // ── Calculate total using resolved prices ───────────────────────────────────
  const totalAmount = resolvedItems.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);

  // ── Generate IDs ───────────────────────────────────────────────────────────
  const orderId = crypto.randomUUID();
  const kotId = crypto.randomUUID();
  const kotNumber = typeof preReservedKotNumber === 'number' && preReservedKotNumber > 0 ? preReservedKotNumber : getNextKotNumber(restaurantId);

  // ── Build print groups BEFORE transaction (pure computation) ───────────────
  // Print intents are persisted inside the transaction to guarantee atomicity.
  const formattedTableNumber = input.isExtraTable && input.tableNumber
    ? input.tableNumber
    : formatTableNumber(table);
  const restaurantName = outlet.receipt_header || outlet.name;
  const sectionName = table.section_name || "Main Hall";
  const sectionTag = table.section_tag;
  const printerConfig = outlet.printerConfig || {};
  const mappedItems = resolvedItems.map((i) => {
    const cat = menuItemMap.get(i.menuItemId) || {};
    const resolvedPrinterName = resolvePrinterName(
      cat.printer_name || null,
      cat.printer_target || null,
      cat.category_printer_target || null,
      printerConfig
    );
    return {
      ...i,
      printerName: resolvedPrinterName,
      printerTarget: cat.printer_target || cat.category_printer_target,
    };
  });
  const kotOrderData: OrderData = {
    tableNumber: formattedTableNumber,
    orderId,
    items: mappedItems.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      price: Number(i.price),
      notes: i.notes ?? null,
      type: (i.menuType === "LIQUOR" ? "liquor" : "food") as "food" | "liquor",
    })),
    restaurantName,
    kotId: String(kotNumber),
    sectionName,
    captainName: captainName || "Captain",
    orderByRole: orderByRole || "CAPTAIN",
    sectionTag: sectionTag || undefined,
  };
  // Gate KOT printing on venue kot_enabled setting
  // NULL or undefined kot_enabled means the venue has no KOT preference —
  // default to ENABLED (same as pre-gating behavior).
  const venueKotEnabled = table.kot_enabled !== 0;
  if (!venueKotEnabled) {
    console.warn(`[createOrder] KOT printing DISABLED for table ${tableId} — venue kot_enabled=${table.kot_enabled}, venue_id=${table.venue_id}`);
  }
  const printGroups = venueKotEnabled ? buildKotPrintGroups(mappedItems, kotOrderData, table, printerConfig) : [];
  // CRITICAL: When localPrinted=true, printIntents is empty — no print jobs
  // are created or dispatched. This short-circuit also masks a latent dedup
  // bug in preparePrintIntents() (see comment there). Do not change this to
  // conditionally create print jobs without fixing the eventId suffix matching.
  const printIntents = localPrinted ? [] : preparePrintIntents(printGroups, requestId, input.kotEventIds);
  console.log(`[createOrder] Print dispatch: localPrinted=${localPrinted}, venueKotEnabled=${venueKotEnabled}, printGroups=${printGroups.length}, printIntents=${printIntents.length}`);

  // ── Transaction: create order + items + KOT + print intents + update table ──
  const tx = db.transaction(() => {
    const now = Date.now();

    // 1. Create order
    db.query(`INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, captain_id, platform, created_by_user_id, last_request_id, created_at, updated_at, cloud_synced, is_extra_table)
      VALUES (?, ?, ?, 'PREPARING', ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(orderId, tableId, restaurantId, totalAmount, captainId || null, platform || "DINE_IN", createdByUserId || null, requestId || null, now, now, input.isExtraTable ? 1 : 0);

    // 2. Create order items (using resolved prices)
    for (const item of resolvedItems) {
      const orderItemId = crypto.randomUUID();
      db.query(`INSERT INTO order_item (id, order_id, menu_item_id, name, price, quantity, notes, menu_type, cloud_synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(orderItemId, orderId, item.menuItemId, item.name, Number(item.price), item.quantity, item.notes || null, item.menuType || "FOOD");
    }

    // 3. Create KOT
    db.query(`INSERT INTO kot (id, restaurant_id, table_id, order_id, kot_number, created_at, cloud_synced)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(kotId, restaurantId, tableId, orderId, kotNumber, now);

    // 4. Create KOT items
    const orderItems = db.query("SELECT * FROM order_item WHERE order_id = ?").all(orderId) as any[];
    for (const oi of orderItems) {
      const kotItemId = crypto.randomUUID();
      db.query(`INSERT INTO kot_item (id, kot_id, order_item_id, menu_item_id, name, quantity, price, notes, status, created_at, cloud_synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, 0)
      `).run(kotItemId, kotId, oi.id, oi.menu_item_id, oi.name, oi.quantity, oi.price, oi.notes, now);
    }

    // 5. Update table status + increment table revision (skip for extra tables)
    let newTableRev: number | undefined;
    if (!input.isExtraTable) {
      newTableRev = nextTableRevision(tableId);
      db.query(`UPDATE "table" SET status = 'OCCUPIED', workflow_status = 'Preparing', current_bill = current_bill + ?, revision = ?, last_command_id = ?, updated_at = ? WHERE id = ?`)
        .run(totalAmount, newTableRev, requestId || null, now, tableId);

      // 6. Update KOT history on table (safe parse — corrupted JSON should not crash the transaction)
      let currentHistory: any[] = [];
      try {
        currentHistory = JSON.parse(table.kot_history || "[]") as any[];
        if (!Array.isArray(currentHistory)) currentHistory = [];
      } catch {
        currentHistory = [];
      }
      // Map by index to handle duplicate menuItemIds correctly
      const kotEntry = buildKotHistoryEntry(kotNumber, resolvedItems.map((i, idx) => ({ ...i, orderItemId: orderItems[idx]?.id })));
      currentHistory.push(kotEntry);
      db.query(`UPDATE "table" SET kot_history = ? WHERE id = ?`).run(JSON.stringify(currentHistory), tableId);
    }

    // 7. Enqueue sync records for cloud push
    enqueueSync("order", orderId, "insert");
    enqueueSync("kot", kotId, "insert");
    if (!input.isExtraTable) {
      enqueueSync("table", tableId, "update");
    }

    // 8. Persist print intents in the same transaction (atomicity guarantee)
    persistPrintIntentsInTx(printIntents, restaurantId, orderId, kotId, kotNumber, tableId, captainName);

    // 9. Set order revision = 1 (new aggregate) and last_command_id
    db.query("UPDATE order_record SET revision = 1, last_command_id = ? WHERE id = ?")
      .run(requestId || null, orderId);

    // Return the new revisions from the transaction scope
    return { newTableRev };
  });

  let newTableRev = 1;
  try {
    const txResult = tx();
    newTableRev = (txResult as any)?.newTableRev ?? 1;
  } catch (err: any) {
    // UNIQUE constraint violation — could be kot.UNIQUE(restaurant_id, kot_number) or order_record.UNIQUE(last_request_id)
    if (err.message && err.message.includes("UNIQUE")) {
      const isKotConstraint = err.message.includes("kot") || err.message.includes("kot_number");
      const constraintName = isKotConstraint ? "kot.UNIQUE(restaurant_id, kot_number)" : "order_record.UNIQUE(last_request_id)";
      console.error(`[createOrder] UNIQUE constraint violation: ${constraintName}`, {
        tableId,
        requestId,
        error: err.message,
      });
      const rejectResult: CreateOrderResult = { success: false, error: "Duplicate request — order already exists", statusCode: 409 };
      recordCommandResult(restaurantId, input, "createOrder", "table", tableId, "rejected", rejectResult, null, rejectResult.error);
      return rejectResult;
    }
    throw err;
  }

  // ── Dispatch print intents (bounded-wait — 3s timeout per job) ────────────
  // Print jobs were already persisted inside the transaction above.
  const printResults = localPrinted ? [] : await Promise.all(dispatchPrintIntents(printIntents, requestId));

  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("order:created", { order: { id: orderId, tableId, kotNumber, totalAmount, revision: 1 }, tableId, requestId, revision: 1, tableRevision: newTableRev, commandId: requestId, isExtraTable: !!input.isExtraTable });
  if (!input.isExtraTable) {
    lanBroadcast("table:updated", { table: { id: tableId, status: "OCCUPIED", workflowStatus: "Preparing", revision: newTableRev }, tableId, requestId, tableRevision: newTableRev, commandId: requestId });
  }

  // ── Return result ──────────────────────────────────────────────────────────
  const updatedTable = db.query(`
    SELECT t.*, s.name as section_name
    FROM "table" t LEFT JOIN section s ON t.section_id = s.id WHERE t.id = ?
  `).get(tableId) as any;

  const orderItems = db.query("SELECT * FROM order_item WHERE order_id = ?").all(orderId) as any[];

  const result: CreateOrderResult = {
    success: true,
    orderId,
    kotNumber,
    kotId: kotId,
    revision: 1,
    tableRevision: newTableRev,
    order: {
      id: orderId,
      tableId,
      status: "PREPARING",
      totalAmount,
      items: orderItems,
      captainId,
      platform: platform || "DINE_IN",
    },
    table: {
      ...updatedTable,
      kot_history: safeParseKotHistory(updatedTable.kot_history),
    },
    printResults,
  };

  recordCommandResult(restaurantId, input, "createOrder", "order", orderId, "applied", result, 1);
  return result;
}

// ─── Helper: safe-parse kot_history JSON ─────────────────────────────────────

function safeParseKotHistory(raw: any): any[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─── Update Order Items (add items to existing order) ────────────────────────

export interface UpdateOrderItemsInput {
  orderId: string;
  tableId?: string;
  items: Array<{
    menuItemId: string;
    name: string;
    price: number;
    quantity: number;
    notes?: string | null;
    menuType?: string;
  }>;
  captainId?: string;
  captainName?: string;
  createdByUserId?: string;
  platform?: string;
  requestId?: string;
  orderByRole?: string;
  localPrinted?: boolean;
  preReservedKotNumber?: number | null;
  kotEventIds?: KotEventIdEntry[] | null;
  deviceId?: string;
  expectedRevision?: number;
  isExtraTable?: boolean;
  tableNumber?: string;
}

export interface UpdateOrderItemsResult {
  success: boolean;
  orderId?: string;
  kotNumber?: number;
  kotId?: string;
  table?: any;
  order?: any;
  printResults?: any[];
  error?: string;
  statusCode?: number;
  revision?: number;
  tableRevision?: number;
}

export async function updateOrderItems(
  restaurantId: string,
  input: UpdateOrderItemsInput
): Promise<UpdateOrderItemsResult> {
  const { orderId, tableId, items, captainId, captainName, createdByUserId, platform, requestId, orderByRole, localPrinted, preReservedKotNumber } = input;

  if (!items || items.length === 0) {
    return { success: false, error: "No items to add", statusCode: 400 };
  }

  // Validate item data — reject negative prices or quantities
  for (const item of items) {
    if (!item.menuItemId || !item.name) {
      return { success: false, error: "Each item must have menuItemId and name", statusCode: 400 };
    }
    if (Number(item.price) < 0 || Number(item.quantity) <= 0) {
      return { success: false, error: `Invalid price/quantity for item: ${item.name}`, statusCode: 400 };
    }
  }

  const db = getDb();

  // ── Phase 1: Durable idempotency check via command_log ────────────────────
  const idem = checkCommandIdempotency<UpdateOrderItemsResult>(restaurantId, input, "updateOrderItems", orderId);
  if (idem.replay && idem.result) {
    return idem.result;
  }

  // ── Idempotency check — scoped to the target order to avoid matching other orders ──
  if (requestId) {
    const existing = db.query("SELECT * FROM order_record WHERE id = ? AND last_request_id = ?").get(orderId, requestId) as any;
    if (existing) {
      const existingItems = db.query("SELECT * FROM order_item WHERE order_id = ?").all(existing.id) as any[];
      const replayResult: UpdateOrderItemsResult = {
        success: true,
        orderId: existing.id,
        kotNumber: 0,
        order: { ...existing, items: existingItems },
        revision: existing.revision ?? 1,
        error: "Duplicate request — returning existing order",
      };
      recordCommandResult(restaurantId, input, "updateOrderItems", "order", orderId, "applied", replayResult, existing.revision ?? 1);
      return replayResult;
    }
  }

  // ── Look up existing order ──────────────────────────────────────────────────
  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    const rejectResult = { success: false, error: "Order not found", statusCode: 404 };
    recordCommandResult(restaurantId, input, "updateOrderItems", "order", orderId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  // ── Resolve tableId: fall back to order.table_id if not provided ──────────
  // The frontend may omit tableId or pass the table number instead of the UUID
  // in edge-local mode. Without this fallback, updateOrderItems would skip
  // the edge path in orderApi.js and fall through to the cloud backend,
  // which rejects the edge-local token with "Invalid or expired token".
  let effectiveTableId = tableId || order.table_id;

  // ── Get table + outlet info ────────────────────────────────────────────────
  let table = getTableWithSection(effectiveTableId);
  if (!table && tableId && tableId !== order.table_id) {
    // The provided tableId didn't match any table (e.g. table number passed
    // instead of UUID). Retry with the order's actual table_id.
    effectiveTableId = order.table_id;
    table = getTableWithSection(effectiveTableId);
  }
  if (!table) {
    const rejectResult = { success: false, error: "Table not found", statusCode: 404 };
    recordCommandResult(restaurantId, input, "updateOrderItems", "order", orderId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  const outlet = getOutlet(restaurantId);
  if (!outlet) {
    const rejectResult = { success: false, error: "Outlet not found in local DB", statusCode: 404 };
    recordCommandResult(restaurantId, input, "updateOrderItems", "order", orderId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  // ── Get menu items with categories for printer routing ─────────────────────
  const menuItemIds = items.map((i) => i.menuItemId).filter(Boolean);
  const menuItemMap = getMenuItemsWithCategories(menuItemIds);

  // ── Validate menu item availability — reject unavailable or deleted items ──
  for (const item of items) {
    const mi = menuItemMap.get(item.menuItemId);
    if (!mi) {
      const rejectResult = { success: false, error: `Menu item not found: ${item.name}`, statusCode: 400 };
      recordCommandResult(restaurantId, input, "updateOrderItems", "order", orderId, "rejected", rejectResult, null, rejectResult.error);
      return rejectResult;
    }
    if (mi.is_deleted) {
      const rejectResult = { success: false, error: `Menu item deleted: ${item.name}`, statusCode: 400 };
      recordCommandResult(restaurantId, input, "updateOrderItems", "order", orderId, "rejected", rejectResult, null, rejectResult.error);
      return rejectResult;
    }
    if (!mi.is_available) {
      const rejectResult = { success: false, error: `Menu item not available: ${item.name}`, statusCode: 400 };
      recordCommandResult(restaurantId, input, "updateOrderItems", "order", orderId, "rejected", rejectResult, null, rejectResult.error);
      return rejectResult;
    }
  }

  // ── Server-side price resolution (Bug 1 fix) ──────────────────────────────
  const venueId = table.venue_id ?? null;
  const priceMap = buildEdgePriceMap(venueId, restaurantId);
  const resolvedItems = items.map((i) => ({
    ...i,
    price: resolveItemPrice(i.menuItemId, priceMap, menuItemMap, Number(i.price)),
  }));

  // ── Calculate additional total using resolved prices ──────────────────────────
  const additionalAmount = resolvedItems.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);

  // ── Generate new KOT for just the new items ─────────────────────────────────
  const kotId = crypto.randomUUID();
  const kotNumber = typeof preReservedKotNumber === 'number' && preReservedKotNumber > 0 ? preReservedKotNumber : getNextKotNumber(restaurantId);

  // ── Build print groups BEFORE transaction (pure computation) ───────────────
  const formattedTableNumber = input.isExtraTable && input.tableNumber
    ? input.tableNumber
    : formatTableNumber(table);
  const restaurantName = outlet.receipt_header || outlet.name;
  const sectionName = table.section_name || "Main Hall";
  const sectionTag = table.section_tag;
  const printerConfig = outlet.printerConfig || {};
  const mappedItems = resolvedItems.map((i) => {
    const cat = menuItemMap.get(i.menuItemId) || {};
    const resolvedPrinterName = resolvePrinterName(
      cat.printer_name || null,
      cat.printer_target || null,
      cat.category_printer_target || null,
      printerConfig
    );
    return {
      ...i,
      printerName: resolvedPrinterName,
      printerTarget: cat.printer_target || cat.category_printer_target,
    };
  });
  const kotOrderData: OrderData = {
    tableNumber: formattedTableNumber,
    orderId,
    items: mappedItems.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      price: Number(i.price),
      notes: i.notes ?? null,
      type: (i.menuType === "LIQUOR" ? "liquor" : "food") as "food" | "liquor",
    })),
    restaurantName,
    kotId: String(kotNumber),
    sectionName,
    captainName: captainName || "Captain",
    orderByRole: orderByRole || "CASHIER",
    sectionTag: sectionTag || undefined,
  };
  // Gate KOT printing on venue kot_enabled setting
  // NULL or undefined kot_enabled means the venue has no KOT preference —
  // default to ENABLED (same as pre-gating behavior).
  const venueKotEnabled = table.kot_enabled !== 0;
  if (!venueKotEnabled) {
    console.warn(`[updateOrderItems] KOT printing DISABLED for table ${effectiveTableId} — venue kot_enabled=${table.kot_enabled}, venue_id=${table.venue_id}`);
  }
  const printGroups = venueKotEnabled ? buildKotPrintGroups(mappedItems, kotOrderData, table, printerConfig) : [];
  // CRITICAL: When localPrinted=true, printIntents is empty — no print jobs
  // are created or dispatched. This short-circuit also masks a latent dedup
  // bug in preparePrintIntents() (see comment there). Do not change this to
  // conditionally create print jobs without fixing the eventId suffix matching.
  const printIntents = localPrinted ? [] : preparePrintIntents(printGroups, requestId, input.kotEventIds);
  console.log(`[updateOrderItems] Print dispatch: localPrinted=${localPrinted}, venueKotEnabled=${venueKotEnabled}, printGroups=${printGroups.length}, printIntents=${printIntents.length}`);

  // ── Transaction: insert new items + new KOT + print intents + update order ──
  const tx = db.transaction(() => {
    const now = Date.now();

    const newOrderItemIds: string[] = [];

    // 1. Insert new order items (using resolved prices)
    for (const item of resolvedItems) {
      const orderItemId = crypto.randomUUID();
      newOrderItemIds.push(orderItemId);
      db.query(`INSERT INTO order_item (id, order_id, menu_item_id, name, price, quantity, notes, menu_type, cloud_synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(orderItemId, orderId, item.menuItemId, item.name, Number(item.price), item.quantity, item.notes || null, item.menuType || "FOOD");
    }

    // 2. Create new KOT for the new items
    db.query(`INSERT INTO kot (id, restaurant_id, table_id, order_id, kot_number, created_at, cloud_synced)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(kotId, restaurantId, effectiveTableId, orderId, kotNumber, now);

    // 3. Create KOT items for just the new items (using resolved prices)
    for (let i = 0; i < resolvedItems.length; i++) {
      const kotItemId = crypto.randomUUID();
      db.query(`INSERT INTO kot_item (id, kot_id, order_item_id, menu_item_id, name, quantity, price, notes, status, created_at, cloud_synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, 0)
      `).run(kotItemId, kotId, newOrderItemIds[i], resolvedItems[i].menuItemId, resolvedItems[i].name, resolvedItems[i].quantity, Number(resolvedItems[i].price), resolvedItems[i].notes || null, now);
    }

    // 4. Bump order total + increment order revision + update timestamp
    const newOrderRev = nextOrderRevision(orderId);
    const newTotal = Number(order.total_amount) + additionalAmount;
    db.query("UPDATE order_record SET total_amount = ?, updated_at = ?, last_request_id = ?, revision = ?, last_command_id = ? WHERE id = ?")
      .run(newTotal, now, requestId || null, newOrderRev, requestId || null, orderId);

    // 5. Update table current_bill + increment table revision (skip for extra tables)
    let newTableRev: number | undefined;
    if (!input.isExtraTable) {
      newTableRev = nextTableRevision(effectiveTableId);
      db.query(`UPDATE "table" SET current_bill = current_bill + ?, revision = ?, last_command_id = ?, updated_at = ? WHERE id = ?`)
        .run(additionalAmount, newTableRev, requestId || null, now, effectiveTableId);

      // 6. Update KOT history on table (safe parse — corrupted JSON should not crash the transaction)
      let currentHistory: any[] = [];
      try {
        currentHistory = JSON.parse(table.kot_history || "[]") as any[];
        if (!Array.isArray(currentHistory)) currentHistory = [];
      } catch {
        currentHistory = [];
      }
      const kotEntry = buildKotHistoryEntry(kotNumber, resolvedItems.map((i, idx) => ({ ...i, orderItemId: newOrderItemIds[idx] })));
      currentHistory.push(kotEntry);
      db.query(`UPDATE "table" SET kot_history = ? WHERE id = ?`).run(JSON.stringify(currentHistory), effectiveTableId);
    }

    // 7. Enqueue sync records
    enqueueSync("order", orderId, "update");
    enqueueSync("kot", kotId, "insert");
    if (!input.isExtraTable) {
      enqueueSync("table", effectiveTableId, "update");
    }
    for (const oiId of newOrderItemIds) {
      enqueueSync("order_item", oiId, "insert");
    }

    // 8. Persist print intents in the same transaction (atomicity guarantee)
    persistPrintIntentsInTx(printIntents, restaurantId, orderId, kotId, kotNumber, effectiveTableId, captainName);

    return { newOrderRev, newTableRev };
  });

  let newOrderRev = 1, newTableRev = 1;
  try {
    const txResult = tx();
    newOrderRev = (txResult as any)?.newOrderRev ?? 1;
    newTableRev = (txResult as any)?.newTableRev ?? 1;
  } catch (err: any) {
    if (err.message && err.message.includes("UNIQUE")) {
      const isKotConstraint = err.message.includes("kot") || err.message.includes("kot_number");
      const constraintName = isKotConstraint ? "kot.UNIQUE(restaurant_id, kot_number)" : "order_record.UNIQUE(last_request_id)";
      console.error(`[updateOrderItems] UNIQUE constraint violation: ${constraintName}`, {
        orderId,
        requestId,
        kotNumber,
        error: err.message,
      });
      const rejectResult: UpdateOrderItemsResult = { success: false, error: "Duplicate request — order already updated", statusCode: 409 };
      recordCommandResult(restaurantId, input, "updateOrderItems", "order", orderId, "rejected", rejectResult, null, rejectResult.error);
      return rejectResult;
    }
    throw err;
  }

  // ── Dispatch print intents (bounded-wait — 3s timeout per job) ────────────
  // Print jobs were already persisted inside the transaction above.
  const printResults = localPrinted ? [] : await Promise.all(dispatchPrintIntents(printIntents, requestId));

  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("order:updated", { orderId, tableId: effectiveTableId, kotNumber, requestId, revision: newOrderRev, tableRevision: newTableRev, commandId: requestId, isExtraTable: !!input.isExtraTable });
  if (!input.isExtraTable) {
    lanBroadcast("table:updated", { table: { id: effectiveTableId, revision: newTableRev }, tableId: effectiveTableId, requestId, tableRevision: newTableRev, commandId: requestId });
  }

  // ── Return result ──────────────────────────────────────────────────────────
  const updatedTable = db.query(`
    SELECT t.*, s.name as section_name
    FROM "table" t LEFT JOIN section s ON t.section_id = s.id WHERE t.id = ?
  `).get(effectiveTableId) as any;

  const orderItems = db.query("SELECT * FROM order_item WHERE order_id = ?").all(orderId) as any[];
  const updatedOrder = db.query("SELECT * FROM order_record WHERE id = ?").get(orderId) as any;

  const result: UpdateOrderItemsResult = {
    success: true,
    orderId,
    kotNumber,
    kotId,
    revision: newOrderRev,
    tableRevision: newTableRev,
    order: {
      id: orderId,
      tableId: effectiveTableId,
      status: updatedOrder.status,
      totalAmount: Number(updatedOrder.total_amount),
      items: orderItems,
      captainId,
      platform: platform || "DINE_IN",
    },
    table: {
      ...updatedTable,
      kot_history: safeParseKotHistory(updatedTable.kot_history),
    },
    printResults,
  };

  recordCommandResult(restaurantId, input, "updateOrderItems", "order", orderId, "applied", result, newOrderRev);
  return result;
}

// ─── Cancel KOT Item ─────────────────────────────────────────────────────────

export interface CancelItemInput {
  orderId: string;
  restaurantId: string;
  orderItemId: string;
  cancelQuantity?: number;
  cancelledBy: string;
  tableNumber?: string;
  requestId?: string;
  localPrinted?: boolean;
  deviceId?: string;
  expectedRevision?: number;
  isExtraTable?: boolean;
}

export async function cancelKotItem(input: CancelItemInput): Promise<{ success: boolean; error?: string; printResult?: any; revision?: number; tableRevision?: number }> {
  const db = getDb();
  const { orderId, restaurantId, orderItemId, cancelQuantity, cancelledBy, localPrinted } = input;

  // ── Phase 1: Durable idempotency check via command_log ────────────────────
  const idem = checkCommandIdempotency<{ success: boolean; error?: string; printResult?: any; revision?: number; tableRevision?: number }>(restaurantId, input, "cancelKotItem", orderItemId);
  if (idem.replay && idem.result) {
    return idem.result;
  }

  // Scope by restaurantId to prevent cross-tenant access
  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    const rejectResult = { success: false, error: "Order not found" };
    recordCommandResult(restaurantId, input, "cancelKotItem", "order", orderId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  const orderItem = db.query("SELECT * FROM order_item WHERE id = ? AND order_id = ?").get(orderItemId, orderId) as any;
  if (!orderItem) {
    const rejectResult = { success: false, error: "Order item not found" };
    recordCommandResult(restaurantId, input, "cancelKotItem", "order_item", orderItemId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  const qtyToCancel = cancelQuantity || orderItem.quantity;
  const newCancelledQty = (orderItem.cancelled_quantity || 0) + qtyToCancel;
  const cancelAmount = Number(orderItem.price) * qtyToCancel;
  const now = Date.now();

  const isFullCancel = newCancelledQty >= orderItem.quantity;

  // Wrap all DB updates in a transaction so order total, table bill, KOT item
  // status, and table status are atomic. If any step fails, none are applied.
  const tx = db.transaction(() => {
    // 1. Update cancelled_quantity on the order item
    db.query("UPDATE order_item SET cancelled_quantity = ? WHERE id = ?")
      .run(newCancelledQty, orderItem.id);

    // 2. Mark the KOT item as CANCELLED so KDS stops showing it as active
    //    Capture affected kot_item IDs and kot_ids first so we can sync them.
    let cancelledKotItemIds: string[] = [];
    let cancelledKotIds: string[] = [];
    if (isFullCancel) {
      const kotItems = db.query("SELECT id, kot_id FROM kot_item WHERE order_item_id = ?").all(orderItem.id) as any[];
      cancelledKotItemIds = kotItems.map((ki) => ki.id);
      cancelledKotIds = [...new Set(kotItems.map((ki) => ki.kot_id))];
      db.query("UPDATE kot_item SET status = 'CANCELLED' WHERE order_item_id = ?")
        .run(orderItem.id);
    }

    // 3. Reduce order total_amount + increment order revision
    const newOrderRev = nextOrderRevision(orderId);
    db.query("UPDATE order_record SET total_amount = MAX(0, total_amount - ?), updated_at = ?, revision = ?, last_command_id = ? WHERE id = ?")
      .run(cancelAmount, now, newOrderRev, input.requestId || null, orderId);

    // 4. Check if all items on this order are now fully cancelled
    const remainingItems = db.query(
      "SELECT COUNT(*) as cnt FROM order_item WHERE order_id = ? AND (cancelled_quantity IS NULL OR cancelled_quantity < quantity)"
    ).get(orderId) as { cnt: number };

    const allCancelled = remainingItems.cnt === 0;

    // 5. Reduce table current_bill; free the table if everything is cancelled (skip for extra tables)
    let newTableRev: number | undefined;
    if (!input.isExtraTable) {
      newTableRev = nextTableRevision(order.table_id);
      if (allCancelled) {
        db.query(`UPDATE "table" SET status = 'AVAILABLE', workflow_status = 'Free', current_bill = 0, captain_id = NULL, guests = 0, session_started_at = NULL, kot_history = '[]', discount = NULL, revision = ?, last_command_id = ?, updated_at = ? WHERE id = ?`)
          .run(newTableRev, input.requestId || null, now, order.table_id);
      } else {
        db.query(`UPDATE "table" SET current_bill = MAX(0, current_bill - ?), revision = ?, last_command_id = ?, updated_at = ? WHERE id = ?`)
          .run(cancelAmount, newTableRev, input.requestId || null, now, order.table_id);
      }
    }

    // 6. Enqueue sync records
    enqueueSync("order_item", orderItemId, "update");
    enqueueSync("order", orderId, "update");
    if (!input.isExtraTable) {
      enqueueSync("table", order.table_id, "update");
    }
    for (const kotItemId of cancelledKotItemIds) {
      enqueueSync("kot_item", kotItemId, "update");
    }
    for (const kotId of cancelledKotIds) {
      enqueueSync("kot", kotId, "update");
    }

    return { newOrderRev, newTableRev };
  });

  let newOrderRev = 1, newTableRev = 1;
  try {
    const txResult = tx();
    newOrderRev = (txResult as any)?.newOrderRev ?? 1;
    newTableRev = (txResult as any)?.newTableRev ?? 1;
  } catch (err: any) {
    const failResult = { success: false, error: `Cancel failed: ${err.message}` };
    recordCommandResult(restaurantId, input, "cancelKotItem", "order", orderId, "failed", failResult, null, failResult.error);
    throw err;
  }

  // Get table + outlet for print context
  const table = getTableWithSection(order.table_id);
  const outlet = getOutlet(restaurantId);

  if (!table || !outlet) {
    const noPrintResult = { success: true, revision: newOrderRev, tableRevision: newTableRev };
    recordCommandResult(restaurantId, input, "cancelKotItem", "order", orderId, "applied", noPrintResult, newOrderRev);
    return noPrintResult; // Cancelled in DB but can't print
  }

  // ── Broadcast to LAN clients ──────────────────────────────────────────────
  lanBroadcast("order:updated", { orderId, tableId: order.table_id, requestId: input.requestId, revision: newOrderRev, tableRevision: newTableRev, commandId: input.requestId, isExtraTable: !!input.isExtraTable });
  if (!input.isExtraTable) {
    lanBroadcast("table:updated", { table: { id: order.table_id, revision: newTableRev }, tableId: order.table_id, requestId: input.requestId, tableRevision: newTableRev, commandId: input.requestId });
  }

  // Build cancel KOT
  const formattedTableNumber = input.isExtraTable && input.tableNumber
    ? String(input.tableNumber)
    : formatTableNumber(table);
  const cancelItem = {
    name: orderItem.name,
    quantity: qtyToCancel,
    menuType: orderItem.menu_type === "LIQUOR" ? "BAR" : "FOOD",
  };

  const escposData = buildCancelKOT({
    tableNumber: formattedTableNumber,
    cancelledBy,
    timestamp: new Date().toISOString(),
    items: [cancelItem],
    sectionName: table.section_name || "Main Hall",
    sectionTag: table.section_tag,
    restaurant: {
      name: outlet.name,
      receiptHeader: outlet.receipt_header,
      receiptSubHeader: outlet.receipt_sub_header,
      address: outlet.address,
      phone: outlet.phone,
      gstin: outlet.gstin,
    },
  });

  // Resolve printer for the cancelled item
  const menuItem = db.query("SELECT * FROM menu_item WHERE id = ?").get(orderItem.menu_item_id) as any;
  const category = menuItem ? db.query("SELECT * FROM category WHERE id = ?").get(menuItem.category_id) as any : null;
  const printerConfig = outlet.printerConfig || {};
  const printerName = resolvePrinterName(
    menuItem?.printer_name || null,
    menuItem?.printer_target || null,
    category?.printer_target || null,
    printerConfig
  );

  let printResult: any = null;
  if (!localPrinted) {
    printResult = await printSingleWithLanFallback(printerName || null, escposData, "CANCEL_KOT");
  }

  const result = { success: true, printResult, revision: newOrderRev, tableRevision: newTableRev };
  recordCommandResult(restaurantId, input, "cancelKotItem", "order", orderId, "applied", result, newOrderRev);
  return result;
}

// ─── Reprint KOT ─────────────────────────────────────────────────────────────

export interface ReprintKotInput {
  orderId: string;
  restaurantId: string;
  kotNumber?: number;
}

export async function reprintKot(input: ReprintKotInput): Promise<{ success: boolean; error?: string; printResults?: any[] }> {
  const db = getDb();
  const { orderId, restaurantId } = input;

  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    return { success: false, error: "Order not found" };
  }

  const table = getTableWithSection(order.table_id);
  const outlet = getOutlet(restaurantId);
  if (!table || !outlet) {
    return { success: false, error: "Table or outlet not found" };
  }

  // Get all KOT items for this order
  const kots = db.query("SELECT * FROM kot WHERE order_id = ? ORDER BY kot_number").all(orderId) as any[];
  if (kots.length === 0) {
    return { success: false, error: "No KOTs found for this order" };
  }

  // Get all order items
  const orderItems = db.query("SELECT * FROM order_item WHERE order_id = ? AND (cancelled_quantity IS NULL OR cancelled_quantity < quantity)").all(orderId) as any[];

  const formattedTableNumber = formatTableNumber(table);
  const restaurantName = outlet.receipt_header || outlet.name;
  const sectionName = table.section_name || "Main Hall";
  const sectionTag = table.section_tag;
  const printerConfig = outlet.printerConfig || {};

  // Build print items from order items
  const printItems = orderItems.map((oi) => {
    const menuItem = db.query("SELECT * FROM menu_item WHERE id = ?").get(oi.menu_item_id) as any;
    const category = menuItem ? db.query("SELECT * FROM category WHERE id = ?").get(menuItem.category_id) as any : null;
    const printerName = resolvePrinterName(
      menuItem?.printer_name || null,
      menuItem?.printer_target || null,
      category?.printer_target || null,
      printerConfig
    );
    return {
      name: oi.name,
      quantity: oi.quantity - (oi.cancelled_quantity || 0),
      price: Number(oi.price),
      notes: oi.notes,
      menuType: oi.menu_type,
      printerName,
      printerTarget: menuItem?.printer_target || category?.printer_target,
    };
  });

  // Group by printer and print (same logic as createOrder)
  const groupedByPrinter = new Map<string | null | undefined, typeof printItems>();
  for (const item of printItems) {
    const key = item.printerName;
    if (!groupedByPrinter.has(key)) groupedByPrinter.set(key, []);
    groupedByPrinter.get(key)!.push(item);
  }

  const kotOrderData: OrderData = {
    tableNumber: formattedTableNumber,
    orderId,
    items: printItems.map((i) => ({
      name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null,
      type: (i.menuType === "LIQUOR" ? "liquor" : "food") as "food" | "liquor",
    })),
    restaurantName,
    kotId: String(kots[kots.length - 1].kot_number),
    sectionName,
    sectionTag: sectionTag || undefined,
  };

  const printGroups: Array<{ printerName: string | null; escposData: any[]; type: string }> = [];

  for (const [printerName, groupItems] of groupedByPrinter) {
    if (!printerName) {
      const kitchenItems = groupItems.filter((i) => i.menuType !== "LIQUOR");
      const barItems = groupItems.filter((i) => i.menuType === "LIQUOR");

      if (kitchenItems.length > 0) {
        const escpos = buildFoodKOT({ ...kotOrderData, items: kitchenItems.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null, type: "food" as const })) });
        const fallback = table.kot_printer_name || resolvePrinterName(null, "KOT_PRINTER", null, printerConfig);
        if (escpos.length > 0) {
          printGroups.push({ printerName: fallback || null, escposData: escpos, type: "KOT" });
        }
      }
      if (barItems.length > 0) {
        const escpos = buildLiquorKOT({ ...kotOrderData, items: barItems.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null, type: "liquor" as const })) });
        const fallback = resolvePrinterName(null, "BAR_PRINTER", null, printerConfig);
        if (escpos.length > 0) {
          printGroups.push({ printerName: fallback || null, escposData: escpos, type: "BAR_KOT" });
        }
      }
    } else {
      const isAllLiquor = groupItems.every((i) => i.menuType === "LIQUOR");
      const builder = isAllLiquor ? buildLiquorKOT : buildFoodKOT;
      const escpos = builder({
        ...kotOrderData,
        items: groupItems.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, notes: i.notes ?? null, type: (i.menuType === "LIQUOR" ? "liquor" : "food") as "food" | "liquor" })),
      });
      if (escpos.length > 0) printGroups.push({ printerName, escposData: escpos, type: isAllLiquor ? "BAR_KOT" : "KOT" });
    }
  }

  const printResults: any[] = [];
  for (let i = 0; i < printGroups.length; i++) {
    const group = printGroups[i];
    if (group.escposData.length === 0) {
      printResults.push({ ok: false, printerName: group.printerName || "unknown", bytes: 0, error: "No print data", method: "noop" });
      continue;
    }
    const eventId = `REPRINT-${group.type}-${orderId}-${Date.now()}-${i}`;
    createPrintJob({
      eventId,
      restaurantId,
      orderId,
      kotId: null,
      kotNumber: kots[kots.length - 1]?.kot_number || null,
      tableId: order.table_id,
      printerName: group.printerName,
      jobType: group.type,
      escposData: group.escposData,
      itemSummary: [],
      captainName: null,
    });
    let result: any;
    try {
      result = await awaitDispatchBounded(eventId, group, undefined);
    } catch (e: any) {
      result = { ok: false, printerName: group.printerName || "unknown", bytes: 0, error: e?.message || "Dispatch threw", method: "durable_queued", eventId };
    }
    printResults.push({
      ok: result.ok ?? false,
      printerName: result.printerName || group.printerName || "unknown",
      bytes: result.bytes || 0,
      error: result.error,
      method: result.method || "durable_queued",
      eventId,
    });
  }
  return { success: true, printResults };
}

// ─── Get next bill number (local counter, atomic) ─────────────────────────────

function getNextBillNumber(restaurantId: string): string {
  const db = getDb();
  const today = getKolkataDateString();

  db.query("INSERT INTO daily_counter (id, restaurant_id, counter_date, bill_count) VALUES (?, ?, ?, 0) ON CONFLICT(restaurant_id, counter_date) DO NOTHING")
    .run(crypto.randomUUID(), restaurantId, today);

  const row = db.query("UPDATE daily_counter SET bill_count = bill_count + 1 WHERE restaurant_id = ? AND counter_date = ? RETURNING bill_count")
    .get(restaurantId, today) as { bill_count: number };

  return String(row.bill_count);
}

// ─── Request Billing (mark order as billing requested) ────────────────────────

export async function requestBillingEdge(
  restaurantId: string,
  orderId: string,
  meta?: CommandMeta,
): Promise<{ success: boolean; error?: string; order?: any; revision?: number; tableRevision?: number }> {
  const db = getDb();

  // ── Phase 1: Durable idempotency check via command_log ────────────────────
  const idem = checkCommandIdempotency<{ success: boolean; error?: string; order?: any; revision?: number; tableRevision?: number }>(restaurantId, meta, "requestBilling", orderId);
  if (idem.replay && idem.result) {
    return idem.result;
  }

  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    const rejectResult = { success: false, error: "Order not found" };
    recordCommandResult(restaurantId, meta, "requestBilling", "order", orderId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  const now = Date.now();
  let newOrderRev = order.revision ?? 1;
  let newTableRev: number | undefined;
  const tx = db.transaction(() => {
    newOrderRev = nextOrderRevision(orderId);
    db.query("UPDATE order_record SET billing_requested = 1, billing_requested_at = ?, updated_at = ?, status = 'BILLING_REQUESTED', revision = ?, last_command_id = ? WHERE id = ?")
      .run(now, now, newOrderRev, meta?.requestId || null, orderId);

    if (!meta?.isExtraTable) {
      newTableRev = nextTableRevision(order.table_id);
      db.query(`UPDATE "table" SET workflow_status = 'Waiting Bill', revision = ?, last_command_id = ?, updated_at = ? WHERE id = ?`)
        .run(newTableRev, meta?.requestId || null, now, order.table_id);
    }

    enqueueSync("order", orderId, "update");
    if (!meta?.isExtraTable) {
      enqueueSync("table", order.table_id, "update");
    }

    return { newOrderRev, newTableRev };
  });

  try {
    const txResult = tx();
    newOrderRev = (txResult as any)?.newOrderRev ?? newOrderRev;
    newTableRev = (txResult as any)?.newTableRev ?? newTableRev;
  } catch (err: any) {
    const failResult = { success: false, error: `Billing request failed: ${err.message}` };
    recordCommandResult(restaurantId, meta, "requestBilling", "order", orderId, "failed", failResult, null, failResult.error);
    throw err;
  }

  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("order:updated", { orderId, status: "BILLING_REQUESTED", requestId: meta?.requestId, revision: newOrderRev, tableRevision: newTableRev, commandId: meta?.requestId, isExtraTable: !!meta?.isExtraTable });
  if (!meta?.isExtraTable) {
    lanBroadcast("table:updated", { table: { id: order.table_id, workflowStatus: "Waiting Bill", revision: newTableRev }, tableId: order.table_id, requestId: meta?.requestId, tableRevision: newTableRev, commandId: meta?.requestId });
  }

  const result = { success: true, order: { id: orderId, status: "BILLING_REQUESTED" }, revision: newOrderRev, tableRevision: newTableRev };
  recordCommandResult(restaurantId, meta, "requestBilling", "order", orderId, "applied", result, newOrderRev);
  return result;
}

// ─── Print Bill (assign bill number + print) ──────────────────────────────────

export interface PrintBillInput {
  orderId: string;
  restaurantId: string;
  tableNumber?: string;
  discountPercent?: number;
  kotNumbers?: string;
  localPrinted?: boolean;
  billEventId?: string;
  requestId?: string;
  deviceId?: string;
  expectedRevision?: number;
  isExtraTable?: boolean;
}

export async function printBillEdge(input: PrintBillInput): Promise<{ success: boolean; error?: string; billNumber?: string; printResults?: any[]; printPending?: boolean; revision?: number }> {
  const db = getDb();
  const { orderId, restaurantId, discountPercent, localPrinted } = input;

  // ── Phase 1: Durable idempotency check via command_log ────────────────────
  const idem = checkCommandIdempotency<{ success: boolean; error?: string; billNumber?: string; printResults?: any[]; printPending?: boolean; revision?: number }>(restaurantId, input, "printBill", orderId);
  if (idem.replay && idem.result) {
    return idem.result;
  }

  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    const rejectResult = { success: false, error: "Order not found" };
    recordCommandResult(restaurantId, input, "printBill", "order", orderId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  // Assign bill number if not already assigned + increment order revision
  let billNumber = order.bill_number;
  let newOrderRev = order.revision ?? 1;
  if (!billNumber) {
    billNumber = getNextBillNumber(restaurantId);
    newOrderRev = nextOrderRevision(orderId);
    db.query("UPDATE order_record SET bill_number = ?, updated_at = ?, revision = ?, last_command_id = ? WHERE id = ?")
      .run(billNumber, Date.now(), newOrderRev, input.requestId || null, orderId);
  }
  // Always enqueue sync after bill print so the cloud receives the bill_number,
  // even if a prior sync cycle pushed the order before the number was assigned.
  enqueueSync("order", orderId, "update");

  // If the frontend already printed locally, skip edge printing — just assign bill number + sync
  if (localPrinted) {
    const result = { success: true, billNumber, printResults: [] as any[], revision: newOrderRev };
    recordCommandResult(restaurantId, input, "printBill", "order", orderId, "applied", result, newOrderRev);
    return result;
  }

  // Get table + outlet for print context
  const table = getTableWithSection(order.table_id);
  const outlet = getOutlet(restaurantId);
  if (!table || !outlet) {
    console.error(`[printBillEdge] Cannot print bill for order ${orderId} — table or outlet not found in local DB`);
    const failResult = { success: false, error: "Table or outlet not found — cannot print bill", billNumber };
    recordCommandResult(restaurantId, input, "printBill", "order", orderId, "failed", failResult, newOrderRev, failResult.error);
    return failResult;
  }

  // Resolve discount: prefer explicit input, fall back to table's stored discount
  const effectiveDiscountPercent = (!!order.is_extra_table || input.isExtraTable)
    ? (discountPercent ?? 0)
    : (discountPercent != null ? discountPercent : (table.discount != null ? Number(table.discount) : 0));

  // Get order items with gst_enabled from menu_item (excluding fully cancelled and removed from bill)
  const orderItems = db.query(
    `SELECT oi.*, mi.gst_enabled as menu_gst_enabled
     FROM order_item oi
     LEFT JOIN menu_item mi ON oi.menu_item_id = mi.id
     WHERE oi.order_id = ?
       AND (oi.cancelled_quantity IS NULL OR oi.cancelled_quantity < oi.quantity)
       AND (oi.removed_from_bill IS NULL OR oi.removed_from_bill = 0)`
  ).all(orderId) as any[];

  const formattedTableNumber = input.tableNumber
    ? String(input.tableNumber)
    : formatTableNumber(table);
  const sectionTag = table.section_tag;
  const serviceChargePercent = outlet.service_charge_percent || 0;

  // Build bill ESC/POS
  const billItems = orderItems.map(oi => ({
    name: oi.name,
    quantity: oi.quantity - (oi.cancelled_quantity || 0),
    price: Number(oi.price),
    menuType: oi.menu_type === "LIQUOR" ? "LIQUOR" as const : "FOOD" as const,
    gstEnabled: oi.menu_gst_enabled !== 0,
  }));

  const escposData = buildBill({
    tableNumber: formattedTableNumber,
    items: billItems,
    totalAmount: 0,
    restaurant: {
      name: outlet.name,
      receiptHeader: outlet.receipt_header,
      receiptSubHeader: outlet.receipt_sub_header,
      address: outlet.address,
      phone: outlet.phone,
      gstin: outlet.gstin,
    },
    sectionTag,
    gstCategory: outlet.gst_category,
    gstRate: outlet.gst_rate,
    gstRegistered: outlet.gst_registered,
    pricesIncludeGst: outlet.prices_include_gst,
    discountPercent: effectiveDiscountPercent,
    serviceChargePercent,
    billNumber,
  });

  // Resolve bill printer — use per-venue override from table if available (same pattern as KOT path)
  const printerConfig = outlet.printerConfig || {};
  const billPrinterName = table.bill_printer_name || resolvePrinterName(null, "BILL_PRINTER", null, printerConfig);

  // Use the durable print queue (same as KOT path) so bill prints survive
  // edge server crashes and are retried by the background dispatch loop.
  // Use billEventId directly as the event_id for idempotent deduplication
  // (ON CONFLICT DO NOTHING on the print_job table).
  const billGroup: PrintGroup = { printerName: billPrinterName || null, escposData, type: "BILL" };
  const eventId = input.billEventId || `BILL-${orderId}-${Date.now()}`;

  const printResults: any[] = [];
  if (escposData.length === 0) {
    printResults.push({ ok: false, printerName: billPrinterName || "unknown", bytes: 0, error: "No print data", method: "noop" });
  } else {
    createPrintJob({
      eventId,
      restaurantId,
      orderId,
      kotId: null,
      kotNumber: null,
      tableId: order.table_id,
      printerName: billPrinterName,
      jobType: "BILL",
      escposData,
      itemSummary: [],
      captainName: null,
    });
    // Use awaitDispatchBounded (same as KOT) — 3s timeout, returns actual status.
    // If print service is ready, this is instant (HTTP POST to :3103).
    // If it times out or fails, the job stays in SQLite queue and the background
    // loop retries automatically. We still return success=true because the bill
    // number is assigned and the print WILL happen.
    let result: any;
    try {
      result = await awaitDispatchBounded(eventId, billGroup, input.requestId);
    } catch (e: any) {
      result = { ok: false, printerName: billPrinterName || "unknown", bytes: 0, error: e?.message || "Dispatch threw", method: "durable_queued", eventId };
    }
    printResults.push({
      ok: result.ok ?? false,
      printerName: result.printerName || billPrinterName || "unknown",
      bytes: result.bytes || 0,
      error: result.error,
      method: result.method || "durable_queued",
      eventId,
      pending: result.pending,
    });
  }

  // Bill number is assigned + print job is persisted in SQLite queue.
  // Always return success=true — the print will complete (either instantly
  // or via background retry). Never block the cashier with a print error.
  const result = { success: true, billNumber, printResults, revision: newOrderRev };
  recordCommandResult(restaurantId, input, "printBill", "order", orderId, "applied", result, newOrderRev);
  return result;
}

// ─── Settle Order (mark as settled, free the table) ───────────────────────────

export interface SettleOrderInput {
  orderId: string;
  restaurantId: string;
  paymentMethod?: string;
  cashAmount?: number;
  cardAmount?: number;
  tipAmount?: number;
  cashTipAmount?: number;
  cardTipAmount?: number;
  discountPercent?: number;
  subtotal?: number;
  discountAmount?: number;
  cgst?: number;
  sgst?: number;
  serviceChargeAmount?: number;
  grandTotal?: number;
  roundOff?: number;
  localTxnId?: string;
  requestId?: string;
  deviceId?: string;
  expectedRevision?: number;
  isExtraTable?: boolean;
  items?: any[];
}

export async function settleOrderEdge(input: SettleOrderInput): Promise<{ success: boolean; error?: string; order?: any; table?: any; transaction?: any; statusCode?: number; revision?: number; tableRevision?: number }> {
  const db = getDb();
  const { orderId, restaurantId, paymentMethod, requestId } = input;
  // Always generate a localTxnId — this ensures a transaction sync record is
  // always enqueued so the cloud receives the settlement payment.
  const localTxnId = input.localTxnId || `edge-txn-${orderId}-${Date.now()}`;

  // ── Phase 1: Durable idempotency check via command_log ────────────────────
  const idem = checkCommandIdempotency<{ success: boolean; error?: string; order?: any; table?: any; transaction?: any; statusCode?: number; revision?: number; tableRevision?: number }>(restaurantId, input, "settleOrder", orderId);
  if (idem.replay && idem.result) {
    return idem.result;
  }

  // Idempotency check — scoped to the target order to avoid matching other orders
  if (requestId) {
    const existing = db.query("SELECT * FROM order_record WHERE id = ? AND last_request_id = ?").get(orderId, requestId) as any;
    if (existing && existing.status === "SETTLED") {
      // Try to find the previously stored transaction data for this requestId
      // so the replay returns the original transaction, not just the order.
      let existingTxn: any = null;
      try {
        const rows = db.query("SELECT value FROM edge_config WHERE key LIKE 'settle:%'").all() as any[];
        for (const row of rows) {
          const data = JSON.parse(row.value);
          if (data.requestId === requestId) {
            existingTxn = {
              id: data.localTxnId,
              orderId,
              restaurantId,
              paymentMethod: data.paymentMethod || "CASH",
              billNumber: existing.bill_number || null,
              paidAt: new Date(data.settledAt).toISOString(),
              grandTotal: data.grandTotal ?? null,
            };
            break;
          }
        }
      } catch { /* ignore parse errors */ }
      const replayResult = { success: true, order: existing, transaction: existingTxn, error: "Duplicate request — already settled", revision: existing.revision ?? 1 };
      recordCommandResult(restaurantId, input, "settleOrder", "order", orderId, "applied", replayResult, existing.revision ?? 1);
      return replayResult;
    }
  }

  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    const rejectResult = { success: false, error: "Order not found" };
    recordCommandResult(restaurantId, input, "settleOrder", "order", orderId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  // Guard: if the order is already settled by a different requestId, return success
  // with alreadySettled flag instead of creating a duplicate transaction. This closes
  // the gap where a second settlement with a new requestId passes both the command_log
  // idempotency check and the cloud's ProcessedRequest check (both keyed on requestId).
  // Returns success:true (not 409) so drainSettlementQueue removes the queued action
  // and handlePayment doesn't rollback the optimistic UI.
  if (order.status === 'SETTLED') {
    let existingTxn: any = null;
    try {
      const rows = db.query("SELECT value FROM edge_config WHERE key LIKE 'settle:%'").all() as any[];
      for (const row of rows) {
        const data = JSON.parse(row.value);
        if (data.orderId === orderId) {
          existingTxn = {
            id: data.localTxnId,
            orderId,
            restaurantId,
            paymentMethod: data.paymentMethod || "CASH",
            billNumber: order.bill_number || null,
            paidAt: new Date(data.settledAt).toISOString(),
            grandTotal: data.grandTotal ?? null,
          };
          break;
        }
      }
    } catch { /* ignore parse errors */ }
    const replayResult = { success: true, alreadySettled: true, order, transaction: existingTxn, error: "Order already settled", revision: order.revision ?? 1 };
    recordCommandResult(restaurantId, input, "settleOrder", "order", orderId, "applied", replayResult, order.revision ?? 1);
    return replayResult;
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    // Mark order as settled + increment order revision
    const newOrderRev = nextOrderRevision(orderId);
    db.query("UPDATE order_record SET status = 'SETTLED', paid_at = ?, updated_at = ?, last_request_id = ?, revision = ?, last_command_id = ? WHERE id = ?")
      .run(now, now, requestId || null, newOrderRev, requestId || null, orderId);

    // Free the table + increment table revision (skip for extra tables)
    let newTableRev: number | undefined;
    if (!input.isExtraTable) {
      newTableRev = nextTableRevision(order.table_id);
      db.query(`UPDATE "table" SET status = 'AVAILABLE', workflow_status = 'Free', captain_id = NULL, guests = 0, session_started_at = NULL, current_bill = 0, kot_history = '[]', discount = NULL, revision = ?, last_command_id = ?, updated_at = ? WHERE id = ?`)
        .run(newTableRev, requestId || null, now, order.table_id);
    }

    // Store payment details for sync worker to create cloud transaction.
    // Always store — even if paymentMethod is missing, default to CASH.
    const paymentKey = `settle:${localTxnId}`;
    const paymentData = JSON.stringify({
      orderId,
      restaurantId,
      paymentMethod: paymentMethod || "CASH",
      cashAmount: input.cashAmount,
      cardAmount: input.cardAmount,
      tipAmount: input.tipAmount,
      cashTipAmount: input.cashTipAmount,
      cardTipAmount: input.cardTipAmount,
      discountPercent: input.discountPercent,
      subtotal: input.subtotal,
      discountAmount: input.discountAmount,
      cgst: input.cgst,
      sgst: input.sgst,
      serviceChargeAmount: input.serviceChargeAmount,
      grandTotal: input.grandTotal,
      roundOff: input.roundOff,
      localTxnId,
      requestId,
      settledAt: now,
      isExtraTable: input.isExtraTable ?? false,
      items: input.items,
    });
    db.query("INSERT INTO edge_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?")
      .run(paymentKey, paymentData, now, paymentData, now);

    // Enqueue sync — always enqueue a transaction record so the cloud
    // receives the settlement payment and creates a cloud Transaction.
    enqueueSync("order", orderId, "update");
    if (!input.isExtraTable) {
      enqueueSync("table", order.table_id, "update");
    }
    enqueueSync("transaction", localTxnId, "insert");

    return { newOrderRev, newTableRev };
  });

  let newOrderRev = 1, newTableRev = 1;
  try {
    const txResult = tx();
    newOrderRev = (txResult as any)?.newOrderRev ?? 1;
    newTableRev = (txResult as any)?.newTableRev ?? 1;
  } catch (err: any) {
    if (err.message && err.message.includes("UNIQUE")) {
      const rejectResult = { success: false, error: "Duplicate settle request", statusCode: 409 };
      recordCommandResult(restaurantId, input, "settleOrder", "order", orderId, "rejected", rejectResult, null, rejectResult.error);
      return rejectResult;
    }
    const failResult = { success: false, error: `Settle failed: ${err.message}` };
    recordCommandResult(restaurantId, input, "settleOrder", "order", orderId, "failed", failResult, null, failResult.error);
    throw err;
  }

  const updatedOrder = db.query("SELECT * FROM order_record WHERE id = ?").get(orderId) as any;
  const updatedTable = db.query(`SELECT t.*, s.name as section_name FROM "table" t LEFT JOIN section s ON t.section_id = s.id WHERE t.id = ?`).get(order.table_id) as any;

  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("order:settled", { orderId, tableId: order.table_id, requestId, revision: newOrderRev, tableRevision: newTableRev, commandId: requestId, isExtraTable: !!input.isExtraTable });
  if (!input.isExtraTable) {
    lanBroadcast("table:updated", { table: { id: order.table_id, status: "AVAILABLE", workflowStatus: "Free", revision: newTableRev }, tableId: order.table_id, requestId, tableRevision: newTableRev, commandId: requestId });
  }

  // Fetch order items so the transaction object has complete data for the
  // cashier UI (items list, itemCount) — matches listTransactionsEdge output.
  const settleItems = db.query("SELECT name, quantity, cancelled_quantity, price, menu_type FROM order_item WHERE order_id = ? AND removed_from_bill = 0 AND quantity > 0 AND (cancelled_quantity IS NULL OR cancelled_quantity < quantity)").all(orderId) as any[];

  // Build a local transaction object so the cashier UI can display it
  // immediately without synthesizing its own.
  const transaction = {
    id: localTxnId,
    orderId,
    restaurantId,
    paymentMethod: paymentMethod || "CASH",
    cashAmount: input.cashAmount ?? null,
    cardAmount: input.cardAmount ?? null,
    tipAmount: input.tipAmount ?? 0,
    discountPercent: input.discountPercent ?? 0,
    subtotal: input.subtotal ?? null,
    discountAmount: input.discountAmount ?? null,
    cgst: input.cgst ?? null,
    sgst: input.sgst ?? null,
    serviceChargeAmount: input.serviceChargeAmount ?? null,
    grandTotal: input.grandTotal ?? null,
    roundOff: input.roundOff ?? null,
    billNumber: updatedOrder.bill_number || null,
    paidAt: new Date(now).toISOString(),
    settledAt: now,
    tableNumber: updatedTable.number ?? null,
    sectionTag: updatedTable.section_tag || null,
    itemCount: settleItems.length,
    items: settleItems.map(i => ({ name: i.name, quantity: i.quantity - Number(i.cancelled_quantity || 0), price: i.price })),
  };

  const result = {
    success: true,
    order: updatedOrder,
    table: { ...updatedTable, kot_history: safeParseKotHistory(updatedTable.kot_history) },
    transaction,
    revision: newOrderRev,
    tableRevision: newTableRev,
  };

  recordCommandResult(restaurantId, input, "settleOrder", "order", orderId, "applied", result, newOrderRev);
  return result;
}

// ─── Swap Table (move order from one table to another) ────────────────────────

export async function swapTableEdge(
  restaurantId: string,
  sourceTableId: string,
  targetTableId: string,
  swappedBy: string,
  meta?: CommandMeta,
): Promise<{ success: boolean; error?: string; sourceTable?: any; targetTable?: any; sourceTableRevision?: number; targetTableRevision?: number; orderRevision?: number }> {
  const db = getDb();

  // ── Phase 1: Durable idempotency check via command_log ────────────────────
  const idem = checkCommandIdempotency<{ success: boolean; error?: string; sourceTable?: any; targetTable?: any; sourceTableRevision?: number; targetTableRevision?: number; orderRevision?: number }>(restaurantId, meta, "swapTable", `${sourceTableId}->${targetTableId}`);
  if (idem.replay && idem.result) {
    return idem.result;
  }

  const sourceTable = db.query(`SELECT * FROM "table" WHERE id = ? AND restaurant_id = ?`).get(sourceTableId, restaurantId) as any;
  const targetTable = db.query(`SELECT * FROM "table" WHERE id = ? AND restaurant_id = ?`).get(targetTableId, restaurantId) as any;

  if (!sourceTable || !targetTable) {
    const rejectResult = { success: false, error: "Source or target table not found" };
    recordCommandResult(restaurantId, meta, "swapTable", "table", sourceTableId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  // Find active orders on source table — use the full active status list
  const activeOrders = db.query(
    `SELECT * FROM order_record WHERE table_id = ? AND restaurant_id = ? AND status IN (${ACTIVE_ORDER_STATUSES.map(() => "?").join(",")}) AND is_deleted = 0`
  ).all(sourceTableId, restaurantId, ...ACTIVE_ORDER_STATUSES) as any[];

  if (activeOrders.length > 1) {
    const rejectResult = { success: false, error: "Cannot swap table with multiple active orders (extra tables)" };
    recordCommandResult(restaurantId, meta, "swapTable", "table", sourceTableId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  const activeOrder = activeOrders[0];

  const now = Date.now();
  let newSourceTableRev = 1, newTargetTableRev = 1, newOrderRev: number | undefined;
  const tx = db.transaction(() => {
    if (activeOrder) {
      // Move order to target table + increment order revision
      newOrderRev = nextOrderRevision(activeOrder.id);
      db.query("UPDATE order_record SET table_id = ?, updated_at = ?, revision = ?, last_command_id = ? WHERE id = ?")
        .run(targetTableId, now, newOrderRev, meta?.requestId || null, activeOrder.id);
      enqueueSync("order", activeOrder.id, "update");
    }

    // Swap table statuses, captain, guests, kot history, current bill + increment revisions
    newSourceTableRev = nextTableRevision(sourceTableId);
    newTargetTableRev = nextTableRevision(targetTableId);
    db.query(`UPDATE "table" SET status = ?, workflow_status = ?, captain_id = ?, guests = ?, session_started_at = ?, current_bill = ?, kot_history = ?, discount = ?, revision = ?, last_command_id = ?, updated_at = ? WHERE id = ?`)
      .run(targetTable.status, targetTable.workflow_status, targetTable.captain_id, targetTable.guests, targetTable.session_started_at, targetTable.current_bill, targetTable.kot_history, targetTable.discount, newSourceTableRev, meta?.requestId || null, now, sourceTableId);
    db.query(`UPDATE "table" SET status = ?, workflow_status = ?, captain_id = ?, guests = ?, session_started_at = ?, current_bill = ?, kot_history = ?, discount = ?, revision = ?, last_command_id = ?, updated_at = ? WHERE id = ?`)
      .run(sourceTable.status, sourceTable.workflow_status, sourceTable.captain_id, sourceTable.guests, sourceTable.session_started_at, sourceTable.current_bill, sourceTable.kot_history, sourceTable.discount, newTargetTableRev, meta?.requestId || null, now, targetTableId);

    enqueueSync("table", sourceTableId, "update");
    enqueueSync("table", targetTableId, "update");
    return { newSourceTableRev, newTargetTableRev, newOrderRev };
  });

  try {
    const txResult = tx();
    newSourceTableRev = (txResult as any)?.newSourceTableRev ?? newSourceTableRev;
    newTargetTableRev = (txResult as any)?.newTargetTableRev ?? newTargetTableRev;
    newOrderRev = (txResult as any)?.newOrderRev ?? newOrderRev;
  } catch (err: any) {
    const failResult = { success: false, error: `Swap failed: ${err.message}` };
    recordCommandResult(restaurantId, meta, "swapTable", "table", sourceTableId, "failed", failResult, null, failResult.error);
    throw err;
  }

  const updatedSource = db.query(`SELECT t.*, s.name as section_name FROM "table" t LEFT JOIN section s ON t.section_id = s.id WHERE t.id = ?`).get(sourceTableId) as any;
  const updatedTarget = db.query(`SELECT t.*, s.name as section_name FROM "table" t LEFT JOIN section s ON t.section_id = s.id WHERE t.id = ?`).get(targetTableId) as any;

  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("table:updated", { table: { id: sourceTableId, revision: newSourceTableRev }, tableId: sourceTableId, requestId: meta?.requestId, tableRevision: newSourceTableRev, commandId: meta?.requestId });
  lanBroadcast("table:updated", { table: { id: targetTableId, revision: newTargetTableRev }, tableId: targetTableId, requestId: meta?.requestId, tableRevision: newTargetTableRev, commandId: meta?.requestId });

  const result = {
    success: true,
    sourceTable: { ...updatedSource, kot_history: safeParseKotHistory(updatedSource.kot_history) },
    targetTable: { ...updatedTarget, kot_history: safeParseKotHistory(updatedTarget.kot_history) },
    sourceTableRevision: newSourceTableRev,
    targetTableRevision: newTargetTableRev,
    orderRevision: newOrderRev,
  };
  recordCommandResult(restaurantId, meta, "swapTable", "table", sourceTableId, "applied", result, newSourceTableRev);
  return result;
}

// ─── Transfer Items (move items between tables) ───────────────────────────────

export async function transferItemsEdge(
  restaurantId: string,
  sourceTableId: string,
  targetTableId: string,
  orderItemIds: string[],
  transferredBy: string,
  meta?: CommandMeta,
): Promise<{ success: boolean; error?: string; sourceTable?: any; targetTable?: any; sourceOrderRevision?: number; targetOrderRevision?: number; sourceTableRevision?: number; targetTableRevision?: number }> {
  const db = getDb();

  // ── Phase 1: Durable idempotency check via command_log ────────────────────
  const idem = checkCommandIdempotency<{ success: boolean; error?: string; sourceTable?: any; targetTable?: any; sourceOrderRevision?: number; targetOrderRevision?: number; sourceTableRevision?: number; targetTableRevision?: number }>(restaurantId, meta, "transferItems", `${sourceTableId}->${targetTableId}`);
  if (idem.replay && idem.result) {
    return idem.result;
  }

  if (!orderItemIds || orderItemIds.length === 0) {
    const rejectResult = { success: false, error: "No items to transfer" };
    recordCommandResult(restaurantId, meta, "transferItems", "table", sourceTableId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  // Find active orders on both tables — use the full active status list
  const sourceOrders = db.query(
    `SELECT * FROM order_record WHERE table_id = ? AND restaurant_id = ? AND status IN (${ACTIVE_ORDER_STATUSES.map(() => "?").join(",")}) AND is_deleted = 0`
  ).all(sourceTableId, restaurantId, ...ACTIVE_ORDER_STATUSES) as any[];
  if (sourceOrders.length === 0) {
    const rejectResult = { success: false, error: "No active order on source table" };
    recordCommandResult(restaurantId, meta, "transferItems", "table", sourceTableId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }
  if (sourceOrders.length > 1) {
    const rejectResult = { success: false, error: "Cannot transfer from table with multiple active orders (extra tables)" };
    recordCommandResult(restaurantId, meta, "transferItems", "table", sourceTableId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }
  const sourceOrder = sourceOrders[0];

  let targetOrder: any = db.query(
    `SELECT * FROM order_record WHERE table_id = ? AND restaurant_id = ? AND status IN (${ACTIVE_ORDER_STATUSES.map(() => "?").join(",")}) AND is_deleted = 0`
  ).all(targetTableId, restaurantId, ...ACTIVE_ORDER_STATUSES) as any[];
  if (targetOrder.length > 1) {
    const rejectResult = { success: false, error: "Cannot transfer to table with multiple active orders (extra tables)" };
    recordCommandResult(restaurantId, meta, "transferItems", "table", sourceTableId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }
  targetOrder = targetOrder[0];

  const now = Date.now();
  let newSourceOrderRev = 1, newTargetOrderRev = 1, newSourceTableRev = 1, newTargetTableRev = 1;
  const tx = db.transaction(() => {
    // Create target order if it doesn't exist
    if (!targetOrder) {
      const newOrderId = crypto.randomUUID();
      db.query("INSERT INTO order_record (id, table_id, restaurant_id, status, total_amount, created_at, updated_at, cloud_synced, revision, last_command_id) VALUES (?, ?, ?, 'PREPARING', 0, ?, ?, 0, 1, ?)")
        .run(newOrderId, targetTableId, restaurantId, now, now, meta?.requestId || null);
      enqueueSync("order", newOrderId, "insert");
      targetOrder = { id: newOrderId, table_id: targetTableId, total_amount: 0 };
    }

    // Move items
    let transferredAmount = 0;
    for (const itemId of orderItemIds) {
      const item = db.query("SELECT * FROM order_item WHERE id = ? AND order_id = ?").get(itemId, sourceOrder.id) as any;
      if (!item) continue;

      const effectiveQty = item.quantity - (item.cancelled_quantity || 0);
      if (effectiveQty <= 0) continue;

      // Create new order item on target order with the effective quantity
      const newItemId = crypto.randomUUID();
      db.query("INSERT INTO order_item (id, order_id, menu_item_id, name, price, quantity, notes, menu_type, cloud_synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)")
        .run(newItemId, targetOrder.id, item.menu_item_id, item.name, item.price, effectiveQty, item.notes, item.menu_type);

      // Mark original item as removed
      db.query("UPDATE order_item SET removed_from_bill = 1, removed_by = ?, removed_at = ? WHERE id = ?")
        .run(transferredBy, now, itemId);

      transferredAmount += Number(item.price) * effectiveQty;
      enqueueSync("order_item", newItemId, "insert");
      enqueueSync("order_item", itemId, "update");
    }

    // Update order totals + increment order revisions
    newSourceOrderRev = nextOrderRevision(sourceOrder.id);
    newTargetOrderRev = nextOrderRevision(targetOrder.id);
    db.query("UPDATE order_record SET total_amount = total_amount - ?, updated_at = ?, revision = ?, last_command_id = ? WHERE id = ?")
      .run(transferredAmount, now, newSourceOrderRev, meta?.requestId || null, sourceOrder.id);
    db.query("UPDATE order_record SET total_amount = total_amount + ?, updated_at = ?, revision = ?, last_command_id = ? WHERE id = ?")
      .run(transferredAmount, now, newTargetOrderRev, meta?.requestId || null, targetOrder.id);

    // Update table current bills + increment table revisions
    newSourceTableRev = nextTableRevision(sourceTableId);
    newTargetTableRev = nextTableRevision(targetTableId);
    db.query(`UPDATE "table" SET current_bill = MAX(0, current_bill - ?), revision = ?, last_command_id = ?, updated_at = ? WHERE id = ?`)
      .run(transferredAmount, newSourceTableRev, meta?.requestId || null, now, sourceTableId);
    db.query(`UPDATE "table" SET current_bill = current_bill + ?, revision = ?, last_command_id = ?, updated_at = ? WHERE id = ?`)
      .run(transferredAmount, newTargetTableRev, meta?.requestId || null, now, targetTableId);

    enqueueSync("order", sourceOrder.id, "update");
    enqueueSync("order", targetOrder.id, "update");
    enqueueSync("table", sourceTableId, "update");
    enqueueSync("table", targetTableId, "update");
    return { newSourceOrderRev, newTargetOrderRev, newSourceTableRev, newTargetTableRev };
  });

  try {
    const txResult = tx();
    newSourceOrderRev = (txResult as any)?.newSourceOrderRev ?? newSourceOrderRev;
    newTargetOrderRev = (txResult as any)?.newTargetOrderRev ?? newTargetOrderRev;
    newSourceTableRev = (txResult as any)?.newSourceTableRev ?? newSourceTableRev;
    newTargetTableRev = (txResult as any)?.newTargetTableRev ?? newTargetTableRev;
  } catch (err: any) {
    const failResult = { success: false, error: `Transfer failed: ${err.message}` };
    recordCommandResult(restaurantId, meta, "transferItems", "table", sourceTableId, "failed", failResult, null, failResult.error);
    throw err;
  }

  const updatedSource = db.query(`SELECT t.*, s.name as section_name FROM "table" t LEFT JOIN section s ON t.section_id = s.id WHERE t.id = ?`).get(sourceTableId) as any;
  const updatedTarget = db.query(`SELECT t.*, s.name as section_name FROM "table" t LEFT JOIN section s ON t.section_id = s.id WHERE t.id = ?`).get(targetTableId) as any;

  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("table:updated", { table: { id: sourceTableId, revision: newSourceTableRev }, tableId: sourceTableId, requestId: meta?.requestId, tableRevision: newSourceTableRev, commandId: meta?.requestId });
  lanBroadcast("table:updated", { table: { id: targetTableId, revision: newTargetTableRev }, tableId: targetTableId, requestId: meta?.requestId, tableRevision: newTargetTableRev, commandId: meta?.requestId });

  const result = {
    success: true,
    sourceTable: { ...updatedSource, kot_history: safeParseKotHistory(updatedSource.kot_history) },
    targetTable: { ...updatedTarget, kot_history: safeParseKotHistory(updatedTarget.kot_history) },
    sourceOrderRevision: newSourceOrderRev,
    targetOrderRevision: newTargetOrderRev,
    sourceTableRevision: newSourceTableRev,
    targetTableRevision: newTargetTableRev,
  };
  recordCommandResult(restaurantId, meta, "transferItems", "table", sourceTableId, "applied", result, newSourceTableRev);
  return result;
}

// ─── Edit Bill (remove items, edit quantities before settlement) ──────────────

export async function editBillEdge(
  restaurantId: string,
  orderId: string,
  edits: { removedItemIds?: string[]; editQuantities?: Record<string, number>; addedItems?: any[]; editedBy?: string; meta?: CommandMeta },
): Promise<{ success: boolean; error?: string; order?: any; printResults?: any[]; revision?: number; tableRevision?: number }> {
  const db = getDb();
  const { removedItemIds, editQuantities, addedItems, editedBy, meta } = edits;

  // ── Phase 1: Durable idempotency check via command_log ────────────────────
  const idem = checkCommandIdempotency<{ success: boolean; error?: string; order?: any; printResults?: any[]; revision?: number; tableRevision?: number }>(restaurantId, meta, "editBill", orderId);
  if (idem.replay && idem.result) {
    return idem.result;
  }

  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    const rejectResult = { success: false, error: "Order not found" };
    recordCommandResult(restaurantId, meta, "editBill", "order", orderId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  // ── Bug 1: Resolve prices for added items server-side ──────────────────────
  let resolvedAddedItems: any[] = [];
  let addedMenuItemMap = new Map<string, any>();
  if (addedItems && addedItems.length > 0) {
    const table = getTableWithSection(order.table_id);
    const addedMenuItemIds = addedItems.map((i) => i.menuItemId || i.id).filter(Boolean);
    addedMenuItemMap = getMenuItemsWithCategories(addedMenuItemIds);
    const venueId = table?.venue_id ?? null;
    const priceMap = buildEdgePriceMap(venueId, restaurantId);
    resolvedAddedItems = addedItems.map((i) => {
      const miId = i.menuItemId || i.id;
      return {
        ...i,
        menuItemId: miId,
        price: resolveItemPrice(miId, priceMap, addedMenuItemMap, Number(i.price)),
      };
    });
  }

  // Track new order item IDs for post-tx KOT printing (Bug 3)
  const addedOrderItemIds: string[] = [];
  let addedKotId: string | null = null;
  let addedKotNumber: number | null = null;

  const now = Date.now();
  const tx = db.transaction(() => {
    let billDelta = 0;

    // Remove items
    if (removedItemIds && removedItemIds.length > 0) {
      for (const itemId of removedItemIds) {
        const item = db.query("SELECT * FROM order_item WHERE id = ? AND order_id = ?").get(itemId, orderId) as any;
        if (!item) continue;
        const effectiveQty = item.quantity - (item.cancelled_quantity || 0);
        billDelta -= Number(item.price) * effectiveQty;
        db.query("UPDATE order_item SET removed_from_bill = 1, removed_by = ?, removed_at = ? WHERE id = ? AND order_id = ?")
          .run(editedBy || "Cashier", now, itemId, orderId);
        enqueueSync("order_item", itemId, "update");
      }
    }

    // Edit quantities
    if (editQuantities) {
      for (const [itemId, newQty] of Object.entries(editQuantities)) {
        const item = db.query("SELECT * FROM order_item WHERE id = ? AND order_id = ?").get(itemId, orderId) as any;
        if (!item) continue;
        const oldQty = item.quantity;
        const qtyDiff = newQty - oldQty;
        billDelta += Number(item.price) * qtyDiff;
        db.query("UPDATE order_item SET quantity = ?, edited_quantity = ? WHERE id = ?")
          .run(newQty, newQty, itemId);
        // Adjust order total
        db.query("UPDATE order_record SET total_amount = total_amount + ?, updated_at = ? WHERE id = ?")
          .run(Number(item.price) * qtyDiff, now, orderId);
        enqueueSync("order_item", itemId, "update");
      }
    }

    // Add new items (Bug 1: using resolved prices; Bug 3: create KOT + KOT items)
    if (resolvedAddedItems.length > 0) {
      // Bug 3: Generate a new KOT for the cashier-added items
      addedKotId = crypto.randomUUID();
      addedKotNumber = getNextKotNumber(restaurantId);
      db.query(`INSERT INTO kot (id, restaurant_id, table_id, order_id, kot_number, created_at, cloud_synced)
        VALUES (?, ?, ?, ?, ?, ?, 0)
      `).run(addedKotId, restaurantId, order.table_id, orderId, addedKotNumber, now);

      for (const item of resolvedAddedItems) {
        const newItemId = crypto.randomUUID();
        addedOrderItemIds.push(newItemId);
        const itemTotal = Number(item.price) * (item.quantity || 1);
        billDelta += itemTotal;
        db.query("INSERT INTO order_item (id, order_id, menu_item_id, name, price, quantity, notes, menu_type, added_by_cashier, cloud_synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)")
          .run(newItemId, orderId, item.menuItemId || item.id || null, item.name, Number(item.price), item.quantity || 1, item.notes || null, item.menuType || "FOOD");

        // Bug 3: Create KOT item for this added item
        const kotItemId = crypto.randomUUID();
        db.query(`INSERT INTO kot_item (id, kot_id, order_item_id, menu_item_id, name, quantity, price, notes, status, created_at, cloud_synced)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, 0)
        `).run(kotItemId, addedKotId, newItemId, item.menuItemId || item.id || null, item.name, item.quantity || 1, Number(item.price), item.notes || null, now);

        db.query("UPDATE order_record SET total_amount = total_amount + ?, updated_at = ? WHERE id = ?")
          .run(itemTotal, now, orderId);
        enqueueSync("order_item", newItemId, "insert");
      }

      // Bug 3: Update KOT history on table (skip for extra tables)
      if (!meta?.isExtraTable) {
        const tableRow = db.query(`SELECT kot_history FROM "table" WHERE id = ?`).get(order.table_id) as any;
        let currentHistory: any[] = [];
        try {
          currentHistory = JSON.parse(tableRow?.kot_history || "[]") as any[];
          if (!Array.isArray(currentHistory)) currentHistory = [];
        } catch { currentHistory = []; }
        const kotEntry = buildKotHistoryEntry(addedKotNumber, resolvedAddedItems.map((i, idx) => ({ ...i, orderItemId: addedOrderItemIds[idx] })));
        currentHistory.push(kotEntry);
        db.query(`UPDATE "table" SET kot_history = ? WHERE id = ?`).run(JSON.stringify(currentHistory), order.table_id);
      }

      enqueueSync("kot", addedKotId, "insert");
    }

    // Sync table current_bill with the net bill delta + increment table revision (skip for extra tables)
    let newTableRev: number | undefined;
    if (billDelta !== 0 && !meta?.isExtraTable) {
      newTableRev = nextTableRevision(order.table_id);
      db.query(`UPDATE "table" SET current_bill = MAX(0, current_bill + ?), revision = ?, last_command_id = ?, updated_at = ? WHERE id = ?`)
        .run(billDelta, newTableRev, meta?.requestId || null, now, order.table_id);
      enqueueSync("table", order.table_id, "update");
    }

    // Increment order revision + update timestamp
    const newOrderRev = nextOrderRevision(orderId);
    db.query("UPDATE order_record SET updated_at = ?, revision = ?, last_command_id = ? WHERE id = ?").run(now, newOrderRev, meta?.requestId || null, orderId);
    enqueueSync("order", orderId, "update");
    return { newOrderRev, newTableRev };
  });

  let newOrderRev = 1, newTableRev: number | undefined;
  try {
    const txResult = tx();
    newOrderRev = (txResult as any)?.newOrderRev ?? 1;
    newTableRev = (txResult as any)?.newTableRev;
  } catch (err: any) {
    const failResult = { success: false, error: `Edit bill failed: ${err.message}` };
    recordCommandResult(restaurantId, meta, "editBill", "order", orderId, "failed", failResult, null, failResult.error);
    throw err;
  }

  // ── Bug 3: Print KOT for cashier-added items ────────────────────────────────
  let printResults: any[] = [];
  if (resolvedAddedItems.length > 0 && addedKotId && addedKotNumber != null) {
    const table = getTableWithSection(order.table_id);
    const outlet = getOutlet(restaurantId);
    if (table && outlet) {
      const printerConfig = outlet.printerConfig || {};
      const mappedAddedItems = resolvedAddedItems.map((i) => {
        const cat = addedMenuItemMap.get(i.menuItemId || i.id) || {};
        const resolvedPrinterName = resolvePrinterName(
          cat.printer_name || null,
          cat.printer_target || null,
          cat.category_printer_target || null,
          printerConfig
        );
        return {
          name: i.name,
          quantity: i.quantity || 1,
          price: Number(i.price),
          notes: i.notes ?? null,
          menuType: i.menuType || "FOOD",
          printerName: resolvedPrinterName,
          printerTarget: cat.printer_target || cat.category_printer_target,
        } as EdgeKotItem;
      });

      const formattedTableNumber = meta?.isExtraTable && meta?.tableNumber
        ? meta.tableNumber
        : formatTableNumber(table);
      const kotOrderData: OrderData = {
        tableNumber: formattedTableNumber,
        orderId,
        items: mappedAddedItems.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          price: Number(i.price),
          notes: i.notes ?? null,
          type: (i.menuType === "LIQUOR" ? "liquor" : "food") as "food" | "liquor",
        })),
        restaurantName: outlet.receipt_header || outlet.name,
        kotId: String(addedKotNumber),
        sectionName: table.section_name || "Main Hall",
        captainName: editedBy || "Cashier",
        orderByRole: "CASHIER",
        sectionTag: table.section_tag || undefined,
      };

      const venueKotEnabled = table.kot_enabled !== 0;
      if (venueKotEnabled) {
        const printGroups = buildKotPrintGroups(mappedAddedItems, kotOrderData, table, printerConfig);
        printResults = await printWithLanFallback(printGroups);
      }
    }
  }

  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("order:updated", { orderId, tableId: order.table_id, addedItems: resolvedAddedItems.length, requestId: meta?.requestId, revision: newOrderRev, tableRevision: newTableRev, commandId: meta?.requestId, isExtraTable: !!meta?.isExtraTable });
  if (!meta?.isExtraTable) {
    lanBroadcast("table:updated", { table: { id: order.table_id, revision: newTableRev }, tableId: order.table_id, requestId: meta?.requestId, tableRevision: newTableRev, commandId: meta?.requestId });
  }

  const updatedOrder = db.query("SELECT * FROM order_record WHERE id = ?").get(orderId) as any;
  const result = { success: true, order: updatedOrder, printResults, revision: newOrderRev, tableRevision: newTableRev };
  recordCommandResult(restaurantId, meta, "editBill", "order", orderId, "applied", result, newOrderRev);
  return result;
}

// ─── Confirm Payment (record payment for a settled order) ─────────────────────

export async function confirmPaymentEdge(
  restaurantId: string,
  transactionId: string,
  paymentDetails: { paymentMethod?: string; cashAmount?: number; cardAmount?: number; tipAmount?: number; cashTipAmount?: number; cardTipAmount?: number },
  meta?: CommandMeta,
): Promise<{ success: boolean; error?: string }> {
  const db = getDb();

  // ── Phase 1: Durable idempotency check via command_log ────────────────────
  const idem = checkCommandIdempotency<{ success: boolean; error?: string }>(restaurantId, meta, "confirmPayment", transactionId);
  if (idem.replay && idem.result) {
    return idem.result;
  }

  // Store payment details in edge_config for sync to cloud
  const paymentKey = `payment:${transactionId}`;
  const paymentData = JSON.stringify({ ...paymentDetails, restaurantId, confirmedAt: Date.now() });
  db.query("INSERT INTO edge_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?")
    .run(paymentKey, paymentData, Date.now(), paymentData, Date.now());

  // Enqueue sync for the payment confirmation
  enqueueSync("transaction", transactionId, "update");

  const result = { success: true };
  recordCommandResult(restaurantId, meta, "confirmPayment", "transaction", transactionId, "applied", result);
  return result;
}

// ─── Update Order Status ──────────────────────────────────────────────────────

export async function updateOrderStatusEdge(
  restaurantId: string,
  orderId: string,
  status: string,
  meta?: CommandMeta,
): Promise<{ success: boolean; error?: string; order?: any; revision?: number; tableRevision?: number }> {
  const db = getDb();

  // ── Phase 1: Durable idempotency check via command_log ────────────────────
  const idem = checkCommandIdempotency<{ success: boolean; error?: string; order?: any; revision?: number; tableRevision?: number }>(restaurantId, meta, "updateOrderStatus", orderId);
  if (idem.replay && idem.result) {
    return idem.result;
  }

  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    const rejectResult = { success: false, error: "Order not found" };
    recordCommandResult(restaurantId, meta, "updateOrderStatus", "order", orderId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  const now = Date.now();
  let newOrderRev = order.revision ?? 1;
  let newTableRev: number | undefined;
  const tx = db.transaction(() => {
    newOrderRev = nextOrderRevision(orderId);
    db.query("UPDATE order_record SET status = ?, updated_at = ?, revision = ?, last_command_id = ? WHERE id = ?")
      .run(status, now, newOrderRev, meta?.requestId || null, orderId);

    // Update table workflow status to match
    const workflowMap: Record<string, string> = {
      "PREPARING": "Preparing",
      "READY": "Prepared",
      "BILLING_REQUESTED": "Waiting Bill",
      "SETTLED": "Free",
    };
    const workflowStatus = workflowMap[status];
    if (workflowStatus) {
      newTableRev = nextTableRevision(order.table_id);
      db.query(`UPDATE "table" SET workflow_status = ?, revision = ?, last_command_id = ?, updated_at = ? WHERE id = ?`)
        .run(workflowStatus, newTableRev, meta?.requestId || null, now, order.table_id);
      enqueueSync("table", order.table_id, "update");
    }

    enqueueSync("order", orderId, "update");
    return { newOrderRev, newTableRev };
  });

  try {
    const txResult = tx();
    newOrderRev = (txResult as any)?.newOrderRev ?? newOrderRev;
    newTableRev = (txResult as any)?.newTableRev ?? newTableRev;
  } catch (err: any) {
    const failResult = { success: false, error: `Status update failed: ${err.message}` };
    recordCommandResult(restaurantId, meta, "updateOrderStatus", "order", orderId, "failed", failResult, null, failResult.error);
    throw err;
  }

  const updatedOrder = db.query("SELECT * FROM order_record WHERE id = ?").get(orderId) as any;
  // ── Broadcast to LAN clients (Bug 2 fix) ────────────────────────────────────
  lanBroadcast("order:updated", { orderId, status: updatedOrder?.status, requestId: meta?.requestId, revision: newOrderRev, tableRevision: newTableRev, commandId: meta?.requestId });
  lanBroadcast("table:updated", { table: { id: order.table_id, revision: newTableRev }, tableId: order.table_id, requestId: meta?.requestId, tableRevision: newTableRev, commandId: meta?.requestId });
  const result = { success: true, order: updatedOrder, revision: newOrderRev, tableRevision: newTableRev };
  recordCommandResult(restaurantId, meta, "updateOrderStatus", "order", orderId, "applied", result, newOrderRev);
  return result;
}

// ─── Mark Order Paid (simple status update, no settlement) ───────────────────

export async function markOrderPaidEdge(
  restaurantId: string,
  orderId: string,
  paymentMethod: string = "CASH",
  meta?: CommandMeta,
): Promise<{ success: boolean; error?: string; order?: any; revision?: number }> {
  const db = getDb();

  // ── Phase 1: Durable idempotency check via command_log ────────────────────
  const idem = checkCommandIdempotency<{ success: boolean; error?: string; order?: any; revision?: number }>(restaurantId, meta, "markOrderPaid", orderId);
  if (idem.replay && idem.result) {
    return idem.result;
  }

  const order = db.query("SELECT * FROM order_record WHERE id = ? AND restaurant_id = ?").get(orderId, restaurantId) as any;
  if (!order) {
    const rejectResult = { success: false, error: "Order not found" };
    recordCommandResult(restaurantId, meta, "markOrderPaid", "order", orderId, "rejected", rejectResult, null, rejectResult.error);
    return rejectResult;
  }

  const now = Date.now();
  let newOrderRev = order.revision ?? 1;
  const tx = db.transaction(() => {
    newOrderRev = nextOrderRevision(orderId);
    db.query("UPDATE order_record SET status = 'PAID', paid_at = ?, updated_at = ?, revision = ?, last_command_id = ? WHERE id = ?")
      .run(now, now, newOrderRev, meta?.requestId || null, orderId);
    enqueueSync("order", orderId, "update");
    return { newOrderRev };
  });

  try {
    const txResult = tx();
    newOrderRev = (txResult as any)?.newOrderRev ?? newOrderRev;
  } catch (err: any) {
    const failResult = { success: false, error: `Mark paid failed: ${err.message}` };
    recordCommandResult(restaurantId, meta, "markOrderPaid", "order", orderId, "failed", failResult, null, failResult.error);
    throw err;
  }

  const updatedOrder = db.query("SELECT * FROM order_record WHERE id = ?").get(orderId) as any;
  // ── Broadcast to LAN clients ──────────────────────────────────────────────
  lanBroadcast("order:updated", { orderId, status: "PAID", requestId: meta?.requestId, revision: newOrderRev, commandId: meta?.requestId });
  const result = { success: true, order: updatedOrder, revision: newOrderRev };
  recordCommandResult(restaurantId, meta, "markOrderPaid", "order", orderId, "applied", result, newOrderRev);
  return result;
}

// ─── Save Walk-in Transaction (no order, no table) ───────────────────────────

export async function saveTransactionEdge(
  restaurantId: string,
  txnData: {
    orderId?: string | null;
    tableNumber?: number | null;
    captainId?: string | null;
    amount?: number;
    method?: string;
    itemCount?: number;
    items?: any[];
    subtotal?: number;
    discountPercent?: number;
    discountAmount?: number;
    cgst?: number;
    sgst?: number;
    grandTotal?: number;
    roundOff?: number;
    tipAmount?: number;
    sectionId?: string | null;
    sectionTag?: string | null;
    billNumber?: string | null;
    platform?: string;
  },
  meta?: CommandMeta,
): Promise<{ success: boolean; transaction?: any; error?: string }> {
  const db = getDb();

  // ── Phase 1: Durable idempotency check via command_log ────────────────────
  const idem = checkCommandIdempotency<{ success: boolean; transaction?: any; error?: string }>(restaurantId, meta, "saveTransaction", meta?.requestId || `walkin-${Date.now()}`);
  if (idem.replay && idem.result) {
    return idem.result;
  }

  const localId = `edge-txn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const txnDate = getKolkataDateString();

  const fullTxnData = {
    localId,
    restaurantId,
    orderId: txnData.orderId || null,
    tableNumber: txnData.tableNumber || null,
    captainId: txnData.captainId || null,
    amount: Number(txnData.amount || 0),
    method: (txnData.method || "CASH").toUpperCase(),
    itemCount: Number(txnData.itemCount || 0),
    items: txnData.items || [],
    subtotal: Number(txnData.subtotal || 0),
    discountPercent: Number(txnData.discountPercent || 0),
    discountAmount: Number(txnData.discountAmount || 0),
    cgst: Number(txnData.cgst || 0),
    sgst: Number(txnData.sgst || 0),
    grandTotal: Number(txnData.grandTotal || 0),
    roundOff: Number(txnData.roundOff || 0),
    tipAmount: Number(txnData.tipAmount || 0),
    sectionId: txnData.sectionId || null,
    sectionTag: txnData.sectionTag || null,
    billNumber: txnData.billNumber || null,
    platform: txnData.platform || "CASHIER",
    txnDate,
    createdAt: now,
  };

  const txnKey = `walkin_txn:${localId}`;
  db.query("INSERT INTO edge_config (key, value, updated_at) VALUES (?, ?, ?)")
    .run(txnKey, JSON.stringify(fullTxnData), now);

  enqueueSync("walkin_transaction", localId, "insert");

  const result = {
    success: true,
    transaction: {
      id: localId,
      ...fullTxnData,
      paidAt: new Date(now).toISOString(),
    },
  };

  recordCommandResult(restaurantId, meta, "saveTransaction", "transaction", localId, "applied", result);
  return result;
}

// ─── List Transactions (for edge-local Past Transactions) ───────────────────
// Returns settled orders + walk-in transactions from local SQLite.
// Mirrors the cloud /api/transactions response shape so the frontend
// can use the same mapping logic.

export async function listTransactionsEdge(
  restaurantId: string,
  opts: { date?: string | null; month?: string | null; limit?: number } = {},
): Promise<any[]> {
  const db = getDb();
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 2000;
  const txns: any[] = [];

  // 1. Settled orders with payment details from edge_config
  let orderQuery = `SELECT o.*, t.number as table_number, t.section_tag, s.name as section_name
    FROM order_record o
    LEFT JOIN "table" t ON o.table_id = t.id
    LEFT JOIN section s ON t.section_id = s.id
    WHERE o.restaurant_id = ? AND o.status = 'SETTLED'
    AND NOT EXISTS (SELECT 1 FROM edge_config WHERE key = 'txn_deleted:' || o.id)`;
  const orderParams: any[] = [restaurantId];

  if (opts.date) {
    // Filter by IST date: paid_at is epoch ms
    const dayStart = new Date(opts.date + "T00:00:00+05:30").getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    orderQuery += ` AND o.paid_at >= ? AND o.paid_at < ?`;
    orderParams.push(dayStart, dayEnd);
  } else if (opts.month) {
    // Filter by IST month
    const monthStart = new Date(opts.month + "-01T00:00:00+05:30").getTime();
    const monthEnd = new Date(opts.month + "-31T23:59:59+05:30").getTime();
    orderQuery += ` AND o.paid_at >= ? AND o.paid_at <= ?`;
    orderParams.push(monthStart, monthEnd);
  }

  orderQuery += ` ORDER BY o.paid_at DESC LIMIT ?`;
  orderParams.push(limit);

  const settledOrders = db.query(orderQuery).all(...orderParams) as any[];

  for (const order of settledOrders) {
    // Look up payment details from edge_config
    const paymentRow = db.query("SELECT value FROM edge_config WHERE key LIKE 'settle:%' AND json_extract(value, '$.orderId') = ?").get(order.id) as any;
    let paymentData: any = {};
    if (paymentRow?.value) {
      try { paymentData = JSON.parse(paymentRow.value); } catch {}
    }

    // Get items for this order
    const items = db.query("SELECT name, quantity, cancelled_quantity, price, menu_type FROM order_item WHERE order_id = ? AND removed_from_bill = 0 AND quantity > 0 AND (cancelled_quantity IS NULL OR cancelled_quantity < quantity)").all(order.id) as any[];

    txns.push({
      id: `edge-txn-${order.id}`,
      orderId: order.id,
      txnNumber: null,
      billNumber: order.bill_number || null,
      paidAt: order.paid_at ? new Date(order.paid_at).toISOString() : new Date(order.created_at).toISOString(),
      amount: Number(paymentData.grandTotal ?? order.total_amount ?? 0),
      grandTotal: Number(paymentData.grandTotal ?? order.total_amount ?? 0),
      subtotal: Number(paymentData.subtotal ?? order.total_amount ?? 0),
      discountPercent: Number(paymentData.discountPercent ?? 0),
      discountAmount: Number(paymentData.discountAmount ?? 0),
      cgst: Number(paymentData.cgst ?? 0),
      sgst: Number(paymentData.sgst ?? 0),
      roundOff: Number(paymentData.roundOff ?? 0),
      tipAmount: Number(paymentData.tipAmount ?? 0),
      itemCount: items.length,
      items: items.map(i => ({ name: i.name, quantity: i.quantity - Number(i.cancelled_quantity || 0), price: i.price })),
      captainId: order.captain_id || "CASHIER",
      captainName: "Head Cashier",
      method: paymentData.paymentMethod || "CASH",
      tableNumber: order.table_number || null,
      sectionTag: order.section_tag || null,
      sectionId: null,
      status: "COMPLETED",
    });
  }

  // 2. Walk-in transactions from edge_config
  let walkinQuery = `SELECT key, value FROM edge_config WHERE key LIKE 'walkin_txn:%'`;
  const walkinRows = db.query(walkinQuery).all() as any[];

  for (const row of walkinRows) {
    try {
      const txn = JSON.parse(row.value);
      if (txn.restaurantId !== restaurantId) continue;

      if (opts.date) {
        const txnDate = new Date(txn.paidAt || txn.createdAt).toISOString().slice(0, 10);
        if (txnDate !== opts.date) continue;
      } else if (opts.month) {
        const txnMonth = String(txn.paidAt || txn.createdAt || "").slice(0, 7);
        if (txnMonth !== opts.month) continue;
      }

      txns.push({
        id: txn.id || row.key,
        orderId: txn.orderId || null,
        txnNumber: txn.txnNumber || null,
        billNumber: txn.billNumber || null,
        paidAt: txn.paidAt ? new Date(txn.paidAt).toISOString() : new Date(txn.createdAt).toISOString(),
        amount: Number(txn.grandTotal ?? txn.amount ?? 0),
        grandTotal: Number(txn.grandTotal ?? txn.amount ?? 0),
        subtotal: Number(txn.subtotal ?? 0),
        discountPercent: Number(txn.discountPercent ?? 0),
        discountAmount: Number(txn.discountAmount ?? 0),
        cgst: Number(txn.cgst ?? 0),
        sgst: Number(txn.sgst ?? 0),
        roundOff: Number(txn.roundOff ?? 0),
        tipAmount: Number(txn.tipAmount ?? 0),
        itemCount: txn.itemCount || (Array.isArray(txn.items) ? txn.items.length : 0),
        items: txn.items || [],
        captainId: txn.captainId || "CASHIER",
        captainName: "Head Cashier",
        method: txn.method || "OTHER",
        tableNumber: null,
        sectionTag: txn.sectionTag || null,
        sectionId: txn.sectionId || null,
        status: "COMPLETED",
      });
    } catch {}
  }

  // Sort by paidAt descending
  txns.sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime());

  // Apply limit
  return txns.slice(0, limit);
}

// ─── List Items Sold (for edge-local Item Analytics) ─────────────────────────
// Aggregates item-level sales from settled orders in local SQLite.
// Mirrors the cloud /api/analytics/items-sold response shape so the frontend
// ItemAnalytics component can use the same mapping logic.

const EDGE_BAR_LIKE_VENUE_TYPES = ["BAR", "PDR", "CONFERENCE", "BANQUET", "ROOM_SERVICE", "BAR_LOUNGE", "BREWERY", "PUB", "LOUNGE", "NIGHTCLUB", "WINE_BAR", "COCKTAIL_BAR"];

const EDGE_BEVERAGE_KEYWORDS = [
  "water", "sprite", "thums up", "thumsup", "tin thums", "soda", "cola", "coke", "pepsi",
  "limca", "fanta", "mirinda", "7up", "pulpy orange", "fresh lime", "mojitho", "mojito",
  "moctail", "mocktail", "fruit punch", "lassi", "butter milk", "buttermilk", "milk shake",
  "milkshake", "monster", "charged", "red bull", "coolberg", "juice",
];

function edgeNormalizeBeverageName(name: string): string {
  let normalized = String(name || "").toLowerCase();
  normalized = normalized
    .replace(/\b(bottle|can|tin|glass|cup|ml|ltr|liter|litre)\b/g, " ")
    .replace(/\s+\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const aliases: Record<string, string> = {
    "thumsup": "thums up",
    "thums": "thums up",
    "tin thums": "thums up",
    "butter milk": "buttermilk",
    "milk shake": "milkshake",
    "moctail": "mocktail",
    "mojitho": "mojito",
  };
  return aliases[normalized] || normalized;
}

function edgeGetAnalyticsType(item: any): "food" | "liquor" | "beverages" {
  const rawType = String(item?.menuType || item?.menu_type || item?.type || "").toUpperCase();
  if (rawType === "LIQUOR") return "liquor";
  const normalizedName = edgeNormalizeBeverageName(String(item?.name || ""));
  if (EDGE_BEVERAGE_KEYWORDS.some((k) => normalizedName.includes(k))) return "beverages";
  return "food";
}

export async function listItemsSoldEdge(
  restaurantId: string,
  opts: { startDate?: string | null; endDate?: string | null; sectionName?: string | null; outletType?: string | null } = {},
): Promise<{ items: any[]; summary: any; dateRange: any }> {
  const db = getDb();
  const today = getKolkataDateString();
  const start = opts.startDate || today;
  const end = opts.endDate || today;

  // Resolve section filter to table IDs
  let sectionTableIds: string[] = [];
  let sectionIds: string[] = [];

  if (opts.sectionName) {
    const sections = db.query("SELECT id FROM section WHERE restaurant_id = ? AND LOWER(name) = LOWER(?)").all(restaurantId, opts.sectionName) as any[];
    sectionIds = sections.map(s => s.id);
    if (sectionIds.length > 0) {
      const placeholders = sectionIds.map(() => "?").join(",");
      const tables = db.query(`SELECT id FROM "table" WHERE section_id IN (${placeholders})`).all(...sectionIds) as any[];
      sectionTableIds = tables.map(t => t.id);
    }
    if (sectionTableIds.length === 0) {
      return { items: [], summary: { totalItems: 0, totalQuantity: 0, totalRevenue: 0 }, dateRange: { startDate: start, endDate: end } };
    }
  } else if (opts.outletType) {
    const isBarOutlet = String(opts.outletType).toUpperCase() === "BAR";
    const placeholders = EDGE_BAR_LIKE_VENUE_TYPES.map(() => "?").join(",");
    const venueSections = isBarOutlet
      ? db.query(`SELECT s.id FROM section s JOIN venue v ON s.venue_id = v.id WHERE s.restaurant_id = ? AND UPPER(v.venue_type) IN (${placeholders})`).all(restaurantId, ...EDGE_BAR_LIKE_VENUE_TYPES) as any[]
      : db.query(`SELECT s.id FROM section s JOIN venue v ON s.venue_id = v.id WHERE s.restaurant_id = ? AND UPPER(v.venue_type) NOT IN (${placeholders})`).all(restaurantId, ...EDGE_BAR_LIKE_VENUE_TYPES) as any[];
    sectionIds = venueSections.map(s => s.id);
    if (sectionIds.length > 0) {
      const placeholders2 = sectionIds.map(() => "?").join(",");
      const tables = db.query(`SELECT id FROM "table" WHERE section_id IN (${placeholders2})`).all(...sectionIds) as any[];
      sectionTableIds = tables.map(t => t.id);
    }
  }

  // Build query for settled orders in date range
  const dayStart = new Date(start + "T00:00:00+05:30").getTime();
  const dayEnd = new Date(end + "T23:59:59+05:30").getTime();

  let orderQuery = `SELECT o.id, o.paid_at, o.bill_number, t.number as table_number, t.section_id, t.section_tag
    FROM order_record o
    LEFT JOIN "table" t ON o.table_id = t.id
    WHERE o.restaurant_id = ? AND o.status = 'SETTLED' AND o.paid_at >= ? AND o.paid_at <= ?
    AND NOT EXISTS (SELECT 1 FROM edge_config WHERE key = 'txn_deleted:' || o.id)`;
  const orderParams: any[] = [restaurantId, dayStart, dayEnd];

  if (sectionTableIds.length > 0) {
    const placeholders = sectionTableIds.map(() => "?").join(",");
    orderQuery += ` AND (t.section_id IN (${sectionIds.length ? sectionIds.map(() => "?").join(",") : "''"}) OR o.table_id IN (${placeholders}))`;
    if (sectionIds.length > 0) orderParams.push(...sectionIds);
    orderParams.push(...sectionTableIds);
  }

  const settledOrders = db.query(orderQuery).all(...orderParams) as any[];

  // Fetch liquor menu item names for historical type correction
  const liquorItems = db.query("SELECT LOWER(name) as name FROM menu_item WHERE restaurant_id = ? AND UPPER(menu_type) = 'LIQUOR'").all(restaurantId) as any[];
  const liquorKeywords = liquorItems.map(m => m.name);

  // Aggregate items
  const itemMap = new Map<string, { name: string; quantity: number; revenue: number; type: string; orderCount: number }>();

  for (const order of settledOrders) {
    const items = db.query("SELECT name, quantity, cancelled_quantity, price, menu_type FROM order_item WHERE order_id = ? AND removed_from_bill = 0 AND quantity > 0 AND (cancelled_quantity IS NULL OR cancelled_quantity < quantity)").all(order.id) as any[];

    for (const item of items) {
      const name = String(item.name || "Unknown").trim();
      const key = name.toLowerCase().replace(/\s+/g, " ").trim();
      const quantity = Number(item.quantity || 0) - Number(item.cancelled_quantity || 0);
      const price = Number(item.price || 0);
      const revenue = Math.round(price * quantity * 100) / 100;

      let type = edgeGetAnalyticsType(item);
      if (type === "food" || type === "beverages") {
        const lowerName = name.toLowerCase();
        if (liquorKeywords.some(keyword => lowerName.startsWith(keyword))) {
          type = "liquor";
        }
      }

      if (itemMap.has(key)) {
        const existing = itemMap.get(key)!;
        existing.quantity += quantity;
        existing.revenue += revenue;
        existing.orderCount += 1;
      } else {
        itemMap.set(key, { name, quantity, revenue, type, orderCount: 1 });
      }
    }
  }

  const itemsData = Array.from(itemMap.entries())
    .map(([_, data]) => ({
      name: data.name,
      quantity: data.quantity,
      revenue: Math.round(data.revenue * 100) / 100,
      type: data.type,
      orderCount: data.orderCount,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const totalQuantity = itemsData.reduce((sum, item) => sum + item.quantity, 0);
  const totalRevenue = itemsData.reduce((sum, item) => sum + item.revenue, 0);

  return {
    items: itemsData,
    summary: {
      totalItems: itemsData.length,
      totalQuantity,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
    },
    dateRange: { startDate: start, endDate: end },
  };
}
