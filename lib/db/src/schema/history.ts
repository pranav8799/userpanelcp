// ─────────────────────────────────────────────────────────────────────────
// PASTE THIS INTO YOUR EXISTING schema.ts (alongside accountsTable, settingsTable, etc.)
// Adjust the import of mysqlTable/bigint/varchar/decimal/timestamp/int/boolean
// to match whatever you already import at the top of that file — these names
// match the standard drizzle-orm/mysql-core exports.
// ─────────────────────────────────────────────────────────────────────────

import {
  mysqlTable,
  bigint,
  varchar,
  decimal,
  timestamp,
  int,
  boolean,
} from "drizzle-orm/mysql-core";

/**
 * One row per lifecycle event for a repunch/auto-trade leg.
 *
 * This is intentionally append-only — nothing is ever updated or deleted
 * here, even when the corresponding WatchedSlot is trimmed/removed from
 * settings.watched_slots. That's the whole point: the live ladder state in
 * `settings.watched_slots` only reflects what's CURRENTLY tracked, but this
 * table is the permanent record of everything that ever happened, including
 * legs that got trimmed away — so "how many times did this leg repunch
 * before it was removed" stays answerable forever.
 */
export const repunchHistoryTable = mysqlTable("repunch_history", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),

  // Which account/leg/batch this event belongs to
  accountId: bigint("account_id", { mode: "number" }).notNull(),
  slotId: varchar("slot_id", { length: 191 }).notNull(),
  batchId: varchar("batch_id", { length: 191 }),

  // Trade identity at the time of this event
  symbol: varchar("symbol", { length: 20 }).notNull(),
  side: varchar("side", { length: 4 }).notNull(), // "BUY" | "SELL"

  // What happened
  // entry_placed | entry_filled | tp_placed | tp_filled | repunched |
  // shifted | demoted | trimmed | queued_activated | stopped | resumed |
  // removed_manual | rebalanced
  eventType: varchar("event_type", { length: 30 }).notNull(),

  // Snapshot of the leg's numbers at the moment of this event
  limitPrice: decimal("limit_price", { precision: 20, scale: 8 }),
  tpPrice: decimal("tp_price", { precision: 20, scale: 8 }),
  quantity: decimal("quantity", { precision: 20, scale: 8 }),

  // Running counters at the moment of this event, so you never have to
  // reconstruct "how many times did this repunch" from anything else
  repunchCountAtEvent: int("repunch_count_at_event").notNull().default(0),

  // Exchange order id involved in this event, if any (entry orderId or
  // tpOrderId depending on eventType) — useful for cross-referencing
  // against trade_logs.order_id
  orderId: varchar("order_id", { length: 100 }),

  // Free-text context, e.g. "collision at 4368, skipped" or an error message
  note: varchar("note", { length: 500 }),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});