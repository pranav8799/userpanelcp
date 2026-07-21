import {
  mysqlTable,
  bigint,
  varchar,
  text,
  boolean,
  timestamp,
  decimal,
} from "drizzle-orm/mysql-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const accountsTable = mysqlTable("accounts", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement(),
  name: varchar("name", { length: 100 }).notNull(),
  mobileNumber: varchar("mobile_number", { length: 20 }).notNull(),
  apiKey: text("api_key").notNull(),
  secretKey: text("secret_key").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  lastBalance: decimal("last_balance", { precision: 20, scale: 8 }),
  currentBalance: decimal("current_balance", { precision: 20, scale: 8 }),
  balanceUpdatedAt: timestamp("balance_updated_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertAccountSchema = createInsertSchema(accountsTable as any).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accountsTable.$inferSelect;
