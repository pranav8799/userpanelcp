import { mysqlTable, bigint, varchar, timestamp } from "drizzle-orm/mysql-core";

export const otpsTable = mysqlTable("otps", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement(),
  phone: varchar("phone", { length: 15 }).notNull().unique(),
  otp: varchar("otp", { length: 6 }).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
