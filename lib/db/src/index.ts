import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema";

const rawMysqlUrl = process.env.MYSQL_URL;
if (!rawMysqlUrl) {
  throw new Error("MYSQL_URL must be set. Point it at the shared MySQL database (mysql://user:pass@host/db).");
}
// Strip accidental surrounding quotes that some secret managers add
const mysqlUrl = rawMysqlUrl.replace(/^["']|["']$/g, "");

export const pool = mysql.createPool(mysqlUrl);
export const db = drizzle(pool, { schema, mode: "default" });

export * from "./schema";
