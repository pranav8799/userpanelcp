import {
  mysqlTable,
  bigint,
  varchar,
  text,
  boolean,
  timestamp,
  mysqlEnum,
} from "drizzle-orm/mysql-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { accountsTable } from "./accounts";

export const notificationTargetTypeEnum = ["ALL", "ACCOUNT"] as const;

export const notificationsTable = mysqlTable("notifications", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement(),
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message").notNull(),
  targetType: mysqlEnum("target_type", notificationTargetTypeEnum)
    .notNull()
    .default("ALL"),
  accountId: bigint("account_id", { mode: "number" }).references(
    () => accountsTable.id
  ),
  createdBy: bigint("created_by", { mode: "number" }), // admins table not in drizzle schema yet — plain bigint, no FK
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertNotificationSchema = createInsertSchema(
  notificationsTable as any
).omit({
  id: true,
  createdAt: true,
});
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notificationsTable.$inferSelect;