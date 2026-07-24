import {
  mysqlTable,
  bigint,
  json,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

export const settingsTable = mysqlTable(
  "user_settings",   // ← renamed, was "settings"
  {
    id: bigint("id", { mode: "number" }).primaryKey().autoincrement(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    autoPunchConfig: json("auto_punch_config"),
    watchedSlots: json("watched_slots"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    accountIdUnique: uniqueIndex("user_settings_account_id_unique").on(table.accountId),
  }),
);

export type Settings = typeof settingsTable.$inferSelect;