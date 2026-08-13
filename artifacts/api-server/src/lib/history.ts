// src/lib/history.ts
//
// Central place for writing/reading repunch_history rows. Import
// `repunchHistoryTable` from wherever you added it in schema.ts.

import { db, repunchHistoryTable } from "@workspace/db";
import { eq, and, gte, lte, like, desc, sql, type SQL } from "drizzle-orm";

export type RepunchEventType =
  | "entry_placed"
  | "queued"
  | "queued_activated"
  | "entry_filled"
  | "tp_placed"
  | "tp_filled"
  | "repunched"
  | "shifted"
  | "demoted"
  | "trimmed"
  | "rebalanced"
  | "stopped"
  | "resumed"
  | "removed_manual"
  | "ladder_reset";

export interface HistoryEventInput {
  accountId: number;
  slotId: string;
  batchId?: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  eventType: RepunchEventType;
  limitPrice?: number | null;
  tpPrice?: number | null;
  quantity?: number | null;
  repunchCountAtEvent: number;
  orderId?: string | null;
  note?: string | null;
}

/**
 * Fire-and-forget-safe insert. Callers in the engine should NOT let a
 * history-write failure abort the actual trading logic — logging errors
 * here rather than throwing, since a missed history row is much less bad
 * than a stuck ladder.
 */
export async function logHistoryEvent(event: HistoryEventInput): Promise<void> {
  try {
    await db.insert(repunchHistoryTable).values({
      accountId: event.accountId,
      slotId: event.slotId,
      batchId: event.batchId ?? null,
      symbol: event.symbol,
      side: event.side,
      eventType: event.eventType,
      limitPrice: event.limitPrice != null ? String(event.limitPrice) : null,
      tpPrice: event.tpPrice != null ? String(event.tpPrice) : null,
      quantity: event.quantity != null ? String(event.quantity) : null,
      repunchCountAtEvent: event.repunchCountAtEvent,
      orderId: event.orderId ?? null,
      note: event.note ?? null,
    } as any);
  } catch (err) {
    console.error("[history] failed to log event", event.eventType, event.slotId, err);
  }
}

export async function logHistoryEvents(events: HistoryEventInput[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await db.insert(repunchHistoryTable).values(
      events.map((event) => ({
        accountId: event.accountId,
        slotId: event.slotId,
        batchId: event.batchId ?? null,
        symbol: event.symbol,
        side: event.side,
        eventType: event.eventType,
        limitPrice: event.limitPrice != null ? String(event.limitPrice) : null,
        tpPrice: event.tpPrice != null ? String(event.tpPrice) : null,
        quantity: event.quantity != null ? String(event.quantity) : null,
        repunchCountAtEvent: event.repunchCountAtEvent,
        orderId: event.orderId ?? null,
        note: event.note ?? null,
      })) as any,
    );
  } catch (err) {
    console.error("[history] failed to log batch events", err);
  }
}

export interface HistoryQueryFilters {
  accountId?: number;
  symbol?: string;
  side?: "BUY" | "SELL";
  eventType?: RepunchEventType;
  batchId?: string;
  slotId?: string;
  dateFrom?: string; // ISO date
  dateTo?: string;   // ISO date
  minQty?: number;
  maxQty?: number;
  minRepunchCount?: number;
  maxRepunchCount?: number;
  search?: string;   // matches symbol or note
  page?: number;
  pageSize?: number;
  sortBy?: "createdAt" | "quantity" | "repunchCountAtEvent" | "limitPrice";
  sortDir?: "asc" | "desc";
}

export async function queryHistory(filters: HistoryQueryFilters) {
  const conditions: SQL[] = [];

  if (filters.accountId != null) conditions.push(eq(repunchHistoryTable.accountId, filters.accountId));
  if (filters.symbol) conditions.push(eq(repunchHistoryTable.symbol, filters.symbol.toUpperCase()));
  if (filters.side) conditions.push(eq(repunchHistoryTable.side, filters.side));
  if (filters.eventType) conditions.push(eq(repunchHistoryTable.eventType, filters.eventType));
  if (filters.batchId) conditions.push(eq(repunchHistoryTable.batchId, filters.batchId));
  if (filters.slotId) conditions.push(eq(repunchHistoryTable.slotId, filters.slotId));
  if (filters.dateFrom) conditions.push(gte(repunchHistoryTable.createdAt, new Date(filters.dateFrom)));
  if (filters.dateTo) conditions.push(lte(repunchHistoryTable.createdAt, new Date(filters.dateTo)));
  if (filters.minQty != null) conditions.push(gte(repunchHistoryTable.quantity, String(filters.minQty)));
  if (filters.maxQty != null) conditions.push(lte(repunchHistoryTable.quantity, String(filters.maxQty)));
  if (filters.minRepunchCount != null) conditions.push(gte(repunchHistoryTable.repunchCountAtEvent, filters.minRepunchCount));
  if (filters.maxRepunchCount != null) conditions.push(lte(repunchHistoryTable.repunchCountAtEvent, filters.maxRepunchCount));
  if (filters.search) {
    conditions.push(
      sql`(${repunchHistoryTable.symbol} LIKE ${`%${filters.search}%`} OR ${repunchHistoryTable.note} LIKE ${`%${filters.search}%`})`,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const page = filters.page && filters.page > 0 ? filters.page : 1;
  const pageSize = filters.pageSize && filters.pageSize > 0 ? Math.min(filters.pageSize, 500) : 25;
  const offset = (page - 1) * pageSize;

  const sortColumn = {
    createdAt: repunchHistoryTable.createdAt,
    quantity: repunchHistoryTable.quantity,
    repunchCountAtEvent: repunchHistoryTable.repunchCountAtEvent,
    limitPrice: repunchHistoryTable.limitPrice,
  }[filters.sortBy ?? "createdAt"];

  const orderExpr = filters.sortDir === "asc" ? sortColumn : desc(sortColumn);

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(repunchHistoryTable)
      .where(where)
      .orderBy(orderExpr)
      .limit(pageSize)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(repunchHistoryTable)
      .where(where),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * Distinct symbols that have ever appeared in history, for populating the
 * symbol filter dropdown without hardcoding the list.
 */
export async function getHistorySymbols(accountId?: number): Promise<string[]> {
  const where = accountId != null ? eq(repunchHistoryTable.accountId, accountId) : undefined;
  const rows = await db
    .selectDistinct({ symbol: repunchHistoryTable.symbol })
    .from(repunchHistoryTable)
    .where(where);
  return rows.map((r) => r.symbol);
}