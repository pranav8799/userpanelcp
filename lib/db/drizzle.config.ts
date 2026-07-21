import { defineConfig } from "drizzle-kit";
import path from "path";

const mysqlUrl = process.env.MYSQL_URL;
if (!mysqlUrl) {
  throw new Error("MYSQL_URL must be set.");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "mysql",
  dbCredentials: {
    url: mysqlUrl,
  },
});
