# WealthFunds2x User Trading Panel

A personal crypto futures trading panel for individual clients. Each client logs in with their mobile number via OTP, then sees their live balance, open/closed orders, positions, and P&L — all scoped strictly to their own account. They can also place orders from the panel.

## Run & Operate

- `pnpm --filter @workspace/user-panel run dev` — run the frontend (Vite dev server)
- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec

## Required Secrets

Set these in Replit Secrets before the app can connect:

| Secret | Description |
|--------|-------------|
| `MYSQL_URL` | MySQL connection string for the shared database, e.g. `mysql://user:pass@host:3306/dbname` |
| `SMS_AUTH_KEY` | API key for powerstext.in OTP SMS provider |
| `ENCRYPTION_KEY` | AES-256 hex key used to decrypt stored `apiKey`/`secretKey` in the accounts table |
| `SESSION_SECRET` | JWT signing secret (already set) |

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React 19 + Vite + Tailwind CSS v4 + shadcn/ui
- API: Express 5 + Pino logging
- DB: MySQL + Drizzle ORM (connects to existing shared database — **no migrations run**)
- Auth: OTP via mobile number → JWT in httpOnly cookie (30-day session)
- Trading: Live CoinSwitch futures API calls (Ed25519 signed, AES-256 decrypted keys)
- State: TanStack Query (React Query v5)

## Where things live

- `artifacts/user-panel/` — React frontend (pages, components, routing)
- `artifacts/api-server/src/routes/` — Express API routes (auth, balance, orders, positions, summary)
- `artifacts/api-server/src/lib/` — Crypto decrypt, CoinSwitch signing, JWT auth middleware
- `lib/db/src/schema/` — Drizzle schema (accounts, trade_logs, otps — matches existing DB, read-only except otps)
- `lib/api-spec/openapi.yaml` — OpenAPI contract (source of truth for all endpoints)
- `lib/api-client-react/src/generated/` — Generated React Query hooks (do not edit)

## Architecture decisions

- **MYSQL_URL not DATABASE_URL**: Replit auto-provisions a PostgreSQL database at DATABASE_URL. Since this project connects to an existing MySQL database, MYSQL_URL is used to avoid colliding with the Replit-managed variable.
- **Never DB-push on this project**: This project reads from an existing shared database. The `drizzle push` command is present for reference only — running it would alter the admin panel's live database.
- **JWT in httpOnly cookie**: Tokens are set as httpOnly cookies (30-day expiry) with a JSON response also returning the token for memory-only storage. The backend auth middleware checks cookie first, then Authorization header.
- **All data from live CoinSwitch API**: Balance, orders, and positions come from direct CoinSwitch API calls using the account's decrypted keys — not from the trade_logs table. trade_logs is append-only audit storage.
- **Strict account scoping**: Every backend route extracts accountId from the JWT. No client-supplied accountId is ever trusted.

## Gotchas

- **mysql2 + sslmode**: If MYSQL_URL contains `?sslmode=...` (PostgreSQL syntax), strip it and use `?ssl=true` instead. mysql2 uses different SSL params.
- **OTP table shared with admin panel**: The `otps` table has a UNIQUE constraint on `phone`. Admin and client OTP sends for the same phone number will overwrite each other. In practice, admin phones and client mobiles don't overlap, but be aware.
- **Rate limits**: OTP send is limited to 3 per 10 minutes (by IP). Order placement is limited to 20 per minute (by IP).
- **TP/SL orders**: STOP_MARKET and TAKE_PROFIT_MARKET orders must have quantity=0 per CoinSwitch API requirements — handled automatically in placeOrderForAccount.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._
