import {
  mysqlTable,
  bigint,
  varchar,
  text,
  boolean,
  timestamp,
  decimal,
  mysqlEnum,
} from "drizzle-orm/mysql-core";
import { accountsTable } from "./accounts";

export const tradeLogsTable = mysqlTable("trade_logs", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement(),
  accountId: bigint("account_id", { mode: "number" })
    .notNull()
    .references(() => accountsTable.id),
  orderId: varchar("order_id", { length: 100 }),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  side: mysqlEnum("side", ["BUY", "SELL"]).notNull(),
  orderType: varchar("order_type", { length: 30 }).notNull(),
  quantity: decimal("quantity", { precision: 20, scale: 8 }),
  price: decimal("price", { precision: 20, scale: 8 }),
  triggerPrice: decimal("trigger_price", { precision: 20, scale: 8 }),
  reduceOnly: boolean("reduce_only").default(false),
  status: varchar("status", { length: 30 }),
  errorMessage: text("error_message"),
  firedVia: mysqlEnum("fired_via", ["MANUAL", "WEBHOOK"]).default("MANUAL"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type TradeLog = typeof tradeLogsTable.$inferSelect;
