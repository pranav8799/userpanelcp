---
name: MYSQL_URL not DATABASE_URL
description: This project uses MYSQL_URL instead of DATABASE_URL to avoid collision with Replit's auto-managed PostgreSQL variable.
---

**Rule:** Always use `MYSQL_URL` (not `DATABASE_URL`) for the MySQL connection string in this project.

**Why:** Replit auto-provisions a PostgreSQL database and sets `DATABASE_URL` to a postgres:// URI with `?sslmode=require`. If mysql2 reads that URL, it emits a warning and tries to connect to a PostgreSQL server. Using `MYSQL_URL` as the env var name sidesteps this entirely.

**How to apply:** `lib/db/src/index.ts` and `lib/db/drizzle.config.ts` both read `process.env.MYSQL_URL`. Do not change this to DATABASE_URL.
