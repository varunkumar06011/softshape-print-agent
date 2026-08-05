// ─────────────────────────────────────────────────────────────────────────────
// handlers/queries.ts — Query handlers for order/KOT/bill reads
// ─────────────────────────────────────────────────────────────────────────────
// Query handlers read from SQLite projections. They are registered with the
// Runtime API query endpoint and are authenticated by the route table.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from "bun:sqlite";
import { getOrder, getOrderItems, getOrderByTable } from "../sqlite/orders.ts";
import { getKot, getKotItems, getKotsForOrder } from "../sqlite/kots.ts";
import { getBill, getBillForOrder } from "../sqlite/bills.ts";

export interface QueryResult {
  ok: true;
  data: unknown;
}

export interface QueryError {
  ok: false;
  error: string;
}

// ── Query dispatch ───────────────────────────────────────────────────────────

export function handleOrderQuery(db: Database, queryName: string, params: URLSearchParams): QueryResult | QueryError {
  switch (queryName) {
    case "order":
      return queryOrder(db, params);
    case "order-items":
      return queryOrderItems(db, params);
    case "order-by-table":
      return queryOrderByTable(db, params);
    case "kot":
      return queryKot(db, params);
    case "kots-for-order":
      return queryKotsForOrder(db, params);
    case "bill":
      return queryBill(db, params);
    case "bill-for-order":
      return queryBillForOrder(db, params);
    default:
      return { ok: false, error: `Unknown query '${queryName}'` };
  }
}

function requireParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  if (!value) return null;
  return value;
}

function queryOrder(db: Database, params: URLSearchParams): QueryResult | QueryError {
  const orderId = requireParam(params, "orderId");
  if (!orderId) return { ok: false, error: "orderId parameter is required" };
  const order = getOrder(db, orderId);
  if (!order) return { ok: false, error: `Order '${orderId}' not found` };
  return { ok: true, data: order };
}

function queryOrderItems(db: Database, params: URLSearchParams): QueryResult | QueryError {
  const orderId = requireParam(params, "orderId");
  if (!orderId) return { ok: false, error: "orderId parameter is required" };
  const items = getOrderItems(db, orderId);
  return { ok: true, data: items };
}

function queryOrderByTable(db: Database, params: URLSearchParams): QueryResult | QueryError {
  const tableId = requireParam(params, "tableId");
  const restaurantId = requireParam(params, "restaurantId");
  if (!tableId || !restaurantId) return { ok: false, error: "tableId and restaurantId parameters are required" };
  const order = getOrderByTable(db, tableId, restaurantId);
  return { ok: true, data: order };
}

function queryKot(db: Database, params: URLSearchParams): QueryResult | QueryError {
  const kotId = requireParam(params, "kotId");
  if (!kotId) return { ok: false, error: "kotId parameter is required" };
  const kot = getKot(db, kotId);
  if (!kot) return { ok: false, error: `KOT '${kotId}' not found` };
  const items = getKotItems(db, kotId);
  return { ok: true, data: { kot, items } };
}

function queryKotsForOrder(db: Database, params: URLSearchParams): QueryResult | QueryError {
  const orderId = requireParam(params, "orderId");
  if (!orderId) return { ok: false, error: "orderId parameter is required" };
  const kots = getKotsForOrder(db, orderId);
  return { ok: true, data: kots };
}

function queryBill(db: Database, params: URLSearchParams): QueryResult | QueryError {
  const billId = requireParam(params, "billId");
  if (!billId) return { ok: false, error: "billId parameter is required" };
  const bill = getBill(db, billId);
  if (!bill) return { ok: false, error: `Bill '${billId}' not found` };
  return { ok: true, data: bill };
}

function queryBillForOrder(db: Database, params: URLSearchParams): QueryResult | QueryError {
  const orderId = requireParam(params, "orderId");
  if (!orderId) return { ok: false, error: "orderId parameter is required" };
  const bill = getBillForOrder(db, orderId);
  return { ok: true, data: bill };
}
