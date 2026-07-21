---
name: MySQL URL quoting
description: The MYSQL_URL secret was saved with surrounding double-quotes, causing mysql2 ERR_INVALID_URL. Strip them in code.
---

**Rule:** Strip surrounding single/double quotes from MYSQL_URL before passing to mysql2.

**Why:** When users paste a connection string into Replit Secrets, they sometimes include the surrounding quotes. mysql2's `new URL()` parser treats the leading `"` as part of the scheme and throws `ERR_INVALID_URL`.

**How to apply:** In `lib/db/src/index.ts`, always do:
```ts
const mysqlUrl = rawMysqlUrl.replace(/^["']|["']$/g, "");
```
This is already implemented — keep it in place.
