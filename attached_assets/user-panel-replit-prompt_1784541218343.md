# Prompt for Replit — Client/User Trading Panel (separate project, shared database)

## 1. Context

I already have a working **Admin Panel** for a copy-trading platform (React + Vite + TypeScript frontend, Express + Drizzle ORM backend, MySQL database). It manages multiple client trading **accounts** and logs every trade in a **trade_logs** table.

I now want a **brand-new, separate Replit project** — a **User/Client Panel** — that:
- Has its **own codebase**, completely separate from the admin panel repo.
- Connects to the **same MySQL database** (I will provide the connection string / env vars).
- Talks to the **same CoinSwitch futures API** the admin panel uses, but each client only ever acts through **their own account's stored API key/secret** — never anyone else's.
- Lets each client **log in, view their own live balance/orders/positions, and place their own orders** — with zero visibility into or effect on any other client's account.

Do not scaffold an admin dashboard, account-creation UI, or anything that touches or lists other clients' accounts. This is strictly a **personal, single-account view + trade panel** for each logged-in client, scoped entirely to their own `accountId`.

## 2. Tech stack (match the admin panel's stack, but independent project)

- Frontend: React + TypeScript + Vite + Tailwind CSS + shadcn/ui components
- Backend: Node.js + Express + TypeScript
- ORM: Drizzle ORM (MySQL dialect)
- Auth: JWT-based session, issued after OTP verification
- State/data fetching: TanStack Query (React Query)
- Icons: lucide-react

## 3. Database — connect to existing schema, don't recreate it

I will provide the existing Drizzle schema files for these tables (copy them in as-is, do not redesign them):
- `accounts` — one row per client. Includes `id`, `name`, `mobileNumber`, and broker connection fields. **This table represents "users" — there is no separate users table.**
- `trade_logs` — one row per order/trade, linked via `accountId` to `accounts.id`. This is the "Orders" data.
- `otps` — used for mobile OTP send/verify. Currently only wired to admin login; we're extending its use to client login (see below).

Set up Drizzle to point at the same database via environment variables (`DATABASE_URL` or equivalent host/user/pass/db vars). **Do not run migrations that alter these tables** — this project only reads from `accounts` and `trade_logs`, and reads/writes to `otps` for its own login flow. If you need a new field (e.g., to mark an OTP row as "client-purpose" vs "admin-purpose"), add a nullable column rather than changing existing columns.

## 4. Authentication — OTP login by mobile number, scoped per account

- Login screen: client enters their **mobile number** (the same number stored in `accounts.mobileNumber`).
- Backend checks the number exists in `accounts`. If not found, show a clear "No account found with this number" error — do not reveal whether it's a formatting issue vs truly not found.
- Send a 4-digit OTP via SMS using the **exact same provider as the admin panel** — powerstext.in — see the real working code in Appendix A below. Reuse it as-is, just swap `adminsTable` for `accountsTable` and `admin.phone` for `account.mobileNumber`.
- On verify, issue a JWT containing `accountId` (not an admin ID). This JWT is the client's entire identity for every subsequent request.
- All backend routes for this project must extract `accountId` from the JWT and **filter every query by it** — never trust an `accountId` passed in the request body/query params.
- Note: the shared `otps` table has a `UNIQUE` constraint on `phone`, and is already used by the admin login flow. Since admin phone numbers and client mobile numbers should not collide in practice, this is safe to share — but be aware an admin and a client with the *same* number would overwrite each other's OTP. Flag this to me if it becomes a real issue; for now, reuse the table as-is.
- OTP expiry is 10 minutes (matching the admin flow — see Appendix A).
- Add rate limiting on OTP send (e.g., max 3 requests per number per 10 minutes).
- Session should persist (refresh token or long-lived JWT with silent re-auth) so users aren't asked to OTP-login every visit, but must expire after a reasonable inactivity period.

## 5. Where the data actually comes from — live CoinSwitch calls, not just the DB

Important architecture point: the admin panel doesn't store live order/position/balance state in MySQL — it calls **CoinSwitch's futures API directly**, using each account's stored (encrypted) `apiKey`/`secretKey`, every time it needs current data. `trade_logs` is more of an internal fire log, not the live order book.

**Do the same here.** For the logged-in client's account: decrypt their `apiKey`/`secretKey` from the `accounts` row (see Appendix B for the decrypt function and the exact AES scheme used), then call CoinSwitch directly for balance, open orders, closed orders, and positions. This gives real-time accuracy instead of a possibly-stale DB snapshot. Use `trade_logs` only as a secondary/audit source if you want an "activity history" feel, not as the source of truth for current state.

All CoinSwitch calls need a valid Ed25519-signed request (method + path + epoch, signed with the account's secret key) — the exact signing code is in Appendix B (`signRequest.ts`). Reuse it byte-for-byte; don't try to reimplement CoinSwitch's auth scheme from scratch.

## 6. Backend API (all scoped to the logged-in account's own CoinSwitch keys)

- `POST /api/auth/send-otp` — body: `{ mobileNumber }`
- `POST /api/auth/verify-otp` — body: `{ mobileNumber, otp }` → returns JWT
- `GET /api/me` — returns the logged-in client's account info (name, masked mobile number, `isActive`) — never return `apiKey`/`secretKey` even encrypted
- `GET /api/balance` — live call to CoinSwitch wallet balance for this account only (see Appendix B `balances.ts` reference)
- `POST /api/orders/open` — live call to CoinSwitch open orders for this account only
- `POST /api/orders/closed` — live call to CoinSwitch closed/order-history for this account only; this response includes `realised_pnl` per order — use it for P&L, don't compute it yourself
- `GET /api/positions` — live call to CoinSwitch positions for this account only
- `POST /api/orders` — **place a new order** for this account only, using `placeOrderForAccount` (Appendix B). Validate `symbol`, `side`, `order_type`, `quantity`, `price`/`trigger_price` server-side before calling CoinSwitch — never forward the client's raw body unchecked.
- `GET /api/summary` — a lightweight aggregate built from the above (today/week/month realised P&L) — compute this in your backend from the `orders/closed` response, don't add a new derivation off `trade_logs`
- `POST /api/auth/logout`

## 7. Frontend pages

1. **Login** — mobile number entry → OTP entry (auto-focus digit boxes, resend timer, clear error states)
2. **Dashboard** — greeting with client name, live balance card (available + total), quick P&L summary (today/overall), a few most recent orders, quick links to Orders/Positions/Place Order
3. **Place Order** — symbol select (fetch tradable symbols the same way the admin panel does, or a simple text input if that's out of scope for now), side (Buy/Sell toggle), order type (Market/Limit/Stop-Market/Take-Profit-Market), quantity, price/trigger price fields shown conditionally by order type, reduce-only toggle, and a **confirmation step** before it actually fires — show a summary and require an explicit "Confirm" tap, since this places a real order with real money
4. **Orders** — tabbed or filterable list: Open / Closed; each row shows symbol, side, quantity, price, realised P&L (closed only), timestamp, status badge; tap/click to open order detail
5. **Order Detail** — full breakdown of a single order
6. **Positions** — currently open positions with live P&L, mark price, liquidation price; refresh button
7. **Reports / P&L History** — simple chart (line or bar) of realised P&L over time, built from the closed-orders data, filterable by date range
8. **Profile** — client name, masked mobile number, account status (read-only), logout button

## 8. Design requirements — responsiveness is the top priority

- **Mobile-first.** Design and build for a ~375–428px phone viewport first, then scale up to tablet (~768px) and desktop (~1280px+) with Tailwind breakpoints (`sm`, `md`, `lg`, `xl`).
- **Navigation:** bottom tab bar (Dashboard / Orders / Positions / Reports / Profile) on mobile and tablet; convert to a left sidebar nav on desktop (`lg:` breakpoint). No hamburger-menu-hides-everything pattern — key nav must always be one tap away.
- **No horizontal scrolling ever**, at any breakpoint. Tables must convert to stacked cards on small screens instead of shrinking columns unreadably.
- **Touch targets** at least 44x44px on mobile; adequate spacing between tappable rows.
- **Typography:** fluid/responsive type scale — readable on small screens without zooming (base 16px minimum for body text).
- **Visual style:** modern fintech aesthetic — clean cards with soft shadows/borders, a confident accent color (e.g., a deep blue or teal) against a neutral background, clear green/red for profit/loss, generous whitespace, rounded corners (8–12px), subtle micro-interactions (hover/tap states, smooth transitions ~150–200ms).
- **Dark mode** support (toggle in Profile), since traders often check panels at odd hours.
- **Loading states:** skeleton loaders for cards/lists, never a blank flash.
- **Empty states:** friendly illustrations/messages when no orders/positions exist yet.
- **Error states:** clear, non-technical error messages with a retry action.
- Use a pull-to-refresh or a visible refresh button on Orders/Positions/Dashboard, since data changes from the admin side.

## 9. Security constraints (non-negotiable)

- Every single data-returning or order-placing endpoint must resolve the account **only** from the `accountId` extracted from the verified JWT — never by a client-supplied `accountId` or account row lookup by anything else.
- The order-placement endpoint must decrypt and use **only the logged-in client's own** `apiKey`/`secretKey` — never accept or look up another account's keys, ever, under any input.
- Never return `apiKey`/`secretKey` — encrypted or decrypted — in any API response, even to the owning client.
- Validate every order field server-side (symbol format, side is BUY/SELL, order_type is one of the allowed enum values, quantity > 0, price/trigger_price required when the order type needs them) before calling CoinSwitch — don't just forward the client's request body.
- Rate-limit order placement per account (e.g., a sane max like 20/minute) to guard against a runaway client or bug from hammering CoinSwitch.
- Log every order placement attempt (account, payload, success/failure, CoinSwitch response) server-side for audit purposes — this matters more once real orders are involved.
- Mask the mobile number in the UI (e.g., `98••••••10`) except where the client needs to confirm it during login.
- HTTPS-only cookies or secure JWT storage (avoid `localStorage` for the token if feasible; prefer httpOnly cookie).
- CORS locked to this app's own domain.
- Never log decrypted `apiKey`/`secretKey` values, even in debug/console output.

## 10. Build order (do this step by step)

1. Scaffold the project structure (frontend + backend, or a unified Vite+Express setup) and get the DB connection to the shared MySQL database working — confirm you can read from `accounts` and `trade_logs`.
2. Build the OTP login flow end-to-end (send, verify, JWT issuance, protected route middleware).
3. Build `GET /api/me`, `/api/orders`, `/api/positions`, `/api/summary` with strict `accountId` scoping.
4. Build the Login page and confirm a real client can log in with their real mobile number and OTP.
5. Build Dashboard, Orders, Order Detail, Positions, Reports, Profile pages in that order, mobile-first, then verify each at tablet and desktop widths.
6. Add loading/empty/error states and dark mode.
7. Final pass: test on actual mobile width in the browser dev tools at 375px, 768px, 1024px, and 1440px, and fix any overflow or cramped layouts before calling it done.

---

## Appendix A — real schema & auth code from the admin panel (copy these in, don't reinvent them)

Set `DATABASE_URL` and `SMS_AUTH_KEY` as Replit **Secrets** — I'll give you the actual values separately, don't ask me to paste them in plain chat.

### `db/schema/accounts.ts` (this table = your "users")

```ts
import { mysqlTable, bigint, varchar, text, boolean, timestamp, decimal } from "drizzle-orm/mysql-core";
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
```

> **Never return `apiKey` or `secretKey` to the frontend, even for the owning account.** Strip them out in every response.

### `db/schema/trade_logs.ts` (this table = "orders")

```ts
import { mysqlTable, bigint, int, varchar, text, boolean, timestamp, decimal, mysqlEnum } from "drizzle-orm/mysql-core";
import { accountsTable } from "./accounts";

export const tradeLogsTable = mysqlTable("trade_logs", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement(),
  accountId: bigint("account_id", { mode: "number" }).notNull().references(() => accountsTable.id),
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
```

Note there's no separate `pnl` or `exitPrice` column — P&L / open-vs-closed status has to be derived from `status`, `side`, `price`, and `quantity` across rows sharing the same `orderId` or `symbol`. Inspect real data once connected and confirm your derivation logic with me before trusting it for the Reports page.

### `db/schema/otps.ts`

```ts
import { mysqlTable, bigint, varchar, timestamp } from "drizzle-orm/mysql-core";

export const otpsTable = mysqlTable("otps", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement(),
  phone: varchar("phone", { length: 15 }).notNull().unique(),
  otp: varchar("otp", { length: 6 }).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

### `db/index.ts` (connection setup)

```ts
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

export const pool = mysql.createPool(process.env.DATABASE_URL);
export const db = drizzle(pool, { schema, mode: "default" });

export * from "./schema";
```

### Working OTP send/verify logic to adapt (from the admin panel's `auth.ts`)

This is the **real, working** SMS-sending code. Copy the `sendSms` helper exactly. For the routes, adapt `adminsTable` → `accountsTable` and `.phone` → `.mobileNumber`, and issue a JWT with `{ accountId }` instead of an admin id:

```ts
import { db } from "@workspace/db";
import { accountsTable, otpsTable } from "@workspace/db"; // adapted from adminsTable
import { eq } from "drizzle-orm";
import http from "http";

// ── Helper: send SMS via powerstext.in ───────────────────────────────
async function sendSms(phone: string, message: string): Promise<void> {
  const authenticKey = process.env.SMS_AUTH_KEY ?? "";
  const senderid = "DSAENT";
  const templateid = "1607100000000367692"; // confirm with me if a client-specific template is needed

  const params = new URLSearchParams({
    "authentic-key": authenticKey,
    senderid,
    route: "1",
    number: phone,
    message,
    templateid,
  });

  const url = `http://sms1.powerstext.in/http-tokenkeyapi.php?${params.toString()}`;

  await new Promise<void>((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`SMS API failed (${res.statusCode}): ${body}`));
      });
    }).on("error", reject);
  });
}

// POST /api/auth/send-otp — Body: { phone: string }
router.post("/auth/send-otp", async (req, res): Promise<void> => {
  const phone = (req.body?.phone ?? "").toString().trim();

  if (!/^\d{10}$/.test(phone)) {
    res.status(400).json({ error: "Enter a valid 10-digit phone number" });
    return;
  }

  // adapted: look up in accountsTable by mobileNumber, not adminsTable by phone
  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.mobileNumber, phone));

  if (!account || !account.isActive) {
    res.status(404).json({ error: "No account found with this mobile number" });
    return;
  }

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await db.delete(otpsTable).where(eq(otpsTable.phone, phone));
  await db.insert(otpsTable).values({ phone, otp, expiresAt });

  const message = `Use this verification code ${otp} to verify your mobile number on WealthFunds2x DE`;

  try {
    await sendSms(phone, message);
    res.json({ success: true, message: "OTP sent successfully" });
  } catch (err: any) {
    res.status(500).json({ error: "SMS service unavailable. Please try again." });
  }
});

// POST /api/auth/verify-otp — Body: { phone: string, otp: string }
router.post("/auth/verify-otp", async (req, res): Promise<void> => {
  const phone = (req.body?.phone ?? "").toString().trim();
  const otp = (req.body?.otp ?? "").toString().trim();

  if (!phone || !otp) {
    res.status(400).json({ error: "Phone and OTP are required" });
    return;
  }

  const [record] = await db.select().from(otpsTable).where(eq(otpsTable.phone, phone));

  if (!record) {
    res.status(401).json({ error: "No OTP found. Please request a new one." });
    return;
  }
  if (new Date() > record.expiresAt) {
    await db.delete(otpsTable).where(eq(otpsTable.phone, phone));
    res.status(401).json({ error: "OTP expired. Please request a new one." });
    return;
  }
  if (record.otp !== otp) {
    res.status(401).json({ error: "Invalid OTP. Please try again." });
    return;
  }

  await db.delete(otpsTable).where(eq(otpsTable.phone, phone));

  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.mobileNumber, phone));

  // adapted: JWT carries accountId, not adminId
  const token = generateToken(account.id);
  res.json({
    token,
    account: { id: account.id, name: account.name, mobileNumber: account.mobileNumber },
  });
});
```

Use this as the source of truth for exact field names (`mobileNumber` not `mobile_number` in JS, `accountId` not `account_id`, etc.) so there's no drift between the two codebases talking to the same database.

---

## Appendix B — real CoinSwitch integration code (signing, balance, positions, orders, placing orders)

This is the actual working integration from the admin panel. Copy it in and adapt only where noted (single-account scoping instead of looping every account). **Don't try to re-derive CoinSwitch's Ed25519 signing scheme from docs — this code already works, use it as-is.**

You'll need a third Secret: `ENCRYPTION_KEY` (the AES-256 key used to decrypt each account's stored `apiKey`/`secretKey`) — same value the admin panel uses, since it's decrypting the same encrypted columns.

### `lib/crypto.ts` — decrypt stored API keys

```ts
import crypto from "crypto";

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;
const IV_LENGTH = 16;

export function decrypt(text: string): string {
  const [ivHex, encryptedHex] = text.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    Buffer.from(ENCRYPTION_KEY, "hex"),
    iv,
  );
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString();
}
```

### `lib/signRequest.ts` — CoinSwitch's Ed25519 request signing (copy verbatim)

```ts
import crypto from "crypto";

const BASE_URL = process.env.COINSWITCH_BASE_URL || "https://coinswitch.co";

// PKCS#8 DER header for a raw 32-byte Ed25519 private key
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

function createEd25519PrivateKey(rawHexKey: string): crypto.KeyObject {
  const rawBytes = Buffer.from(rawHexKey, "hex");
  if (rawBytes.length !== 32) {
    throw new Error(`Ed25519 secret key must be 32 bytes (64 hex chars), got ${rawBytes.length}`);
  }
  const pkcs8Der = Buffer.concat([ED25519_PKCS8_PREFIX, rawBytes]);
  return crypto.createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
}

export function signRequest(
  method: string,
  endpoint: string,
  params: object = {},
  apiKey: string,
  secretKey: string,
): { headers: Record<string, string>; path: string; fullUrl: string } {
  const epoch = Date.now().toString();

  const queryString =
    method === "GET" && Object.keys(params).length > 0
      ? "?" + new URLSearchParams(params as Record<string, string>).toString()
      : "";
  const path = endpoint + queryString;

  // Signed message = METHOD + path_with_query (URL-decoded) + epoch
  const pathForSigning = decodeURIComponent(path);
  const signaturePayload = method + pathForSigning + epoch;

  const privateKey = createEd25519PrivateKey(secretKey);
  const signatureBytes = crypto.sign(null, Buffer.from(signaturePayload, "utf8"), privateKey);
  const signature = signatureBytes.toString("hex");

  return {
    headers: {
      "Content-Type": "application/json",
      "X-AUTH-SIGNATURE": signature,
      "X-AUTH-APIKEY": apiKey,
      "X-AUTH-EPOCH": epoch,
    },
    path,
    fullUrl: BASE_URL + path,
  };
}

export { BASE_URL };
```

### `lib/coinswitchApi.ts` — generic call helper + order placement (copy verbatim, this is account-agnostic already)

```ts
import axios from "axios";
import { signRequest, BASE_URL } from "./signRequest";
import { decrypt } from "./crypto";

export interface OrderPayload {
  symbol: string;
  side: "BUY" | "SELL";
  order_type: "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  quantity: number;
  price?: number;
  trigger_price?: number;
  reduce_only?: boolean;
  time_in_force?: "GTC" | "IOC" | "FOK";
  client_order_id?: string;
}

export async function callCoinswitch(
  method: "GET" | "POST" | "DELETE",
  endpoint: string,
  apiKey: string,
  secretKey: string,
  paramsOrBody: object = {},
): Promise<unknown> {
  const { headers, path } = signRequest(method, endpoint, method === "GET" ? paramsOrBody : {}, apiKey, secretKey);

  if (method === "GET") {
    const response = await axios.get(`${BASE_URL}${path}`, { headers });
    return response.data;
  } else if (method === "DELETE") {
    const response = await axios.delete(`${BASE_URL}${path}`, { headers, data: paramsOrBody });
    return response.data;
  } else {
    const response = await axios.post(`${BASE_URL}${path}`, paramsOrBody, { headers });
    return response.data;
  }
}

// Places ONE order for ONE account — perfect fit for the user panel (no looping over accounts needed)
export async function placeOrderForAccount(
  account: { id: number; name: string; apiKey: string; secretKey: string },
  payload: OrderPayload,
): Promise<{ order_id: string; status: string }> {
  const apiKey = decrypt(account.apiKey);
  const secretKey = decrypt(account.secretKey);

  const isTpSl = payload.order_type === "TAKE_PROFIT_MARKET" || payload.order_type === "STOP_MARKET";

  const body: Record<string, unknown> = {
    exchange: "EXCHANGE_2",
    symbol: payload.symbol.toUpperCase(),
    side: payload.side,
    order_type: payload.order_type,
    quantity: isTpSl ? 0 : payload.quantity, // TP/SL orders must have quantity=0
  };

  if (payload.order_type === "LIMIT" && payload.price != null) {
    body.price = payload.price;
    body.time_in_force = payload.time_in_force ?? "GTC";
  }
  if (isTpSl) {
    if (payload.trigger_price == null) {
      throw new Error(`trigger_price is required for ${payload.order_type} orders`);
    }
    body.trigger_price = payload.trigger_price;
    body.reduce_only = true;
  } else {
    if (payload.reduce_only != null) body.reduce_only = payload.reduce_only;
  }
  if (payload.order_type !== "LIMIT" && payload.time_in_force) {
    body.time_in_force = payload.time_in_force;
  }
  if (payload.client_order_id) body.client_order_id = payload.client_order_id;

  const { headers, path } = signRequest("POST", "/trade/api/v2/futures/order", {}, apiKey, secretKey);
  try {
    const response = await axios.post(`${BASE_URL}${path}`, body, { headers });
    return response.data.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      throw new Error(`CoinSwitch ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}
```

### Reference: how the admin panel calls balance/positions/orders (adapt to single-account, JWT-scoped)

These loop over *all* accounts in the admin panel — for the user panel, strip the loop and just use the one account resolved from the JWT's `accountId`. Real endpoint paths and response shapes below are exact, don't guess them:

```ts
// Balance — GET /api/balance (adapted, single account)
router.get("/balance", authMiddleware, async (req, res) => {
  const accountId = req.auth.accountId; // from JWT, never from req
  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.id, accountId));
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  const apiKey = decrypt(account.apiKey);
  const secretKey = decrypt(account.secretKey);

  const data = (await callCoinswitch(
    "GET",
    "/trade/api/v2/futures/wallet_balance",
    apiKey,
    secretKey,
    { exchange: "EXCHANGE_2" },
  )) as { data: { base_asset_balances: Array<{ balances: { total_available_balance: string; total_balance: string } }> } };

  const balances = data?.data?.base_asset_balances?.[0]?.balances;
  res.json({
    availableBalance: balances?.total_available_balance ?? null,
    totalBalance: balances?.total_balance ?? null,
  });
});

// Positions — GET /api/positions (adapted, single account)
// endpoint: GET /trade/api/v2/futures/positions, params: { exchange: "EXCHANGE_2", symbol? }
// response fields to map: position_id, symbol, position_side, leverage, position_size, position_value,
// position_margin, maint_margin, avg_entry_price, mark_price, last_price, unrealised_pnl, liquidation_price, margin_type, status

// Open orders — POST /api/orders/open (adapted, single account)
// endpoint: POST /trade/api/v2/futures/orders/open, body: { exchange: "EXCHANGE_2", limit: 50, symbol? }
// response: data.orders[] with order_id, symbol, side, order_type, quantity, exec_quantity, price,
// trigger_price, avg_execution_price, execution_fee, realised_pnl, reduce_only, status, created_at

// Closed orders — POST /api/orders/closed (adapted, single account)
// endpoint: POST /trade/api/v2/futures/orders/closed, body: { exchange: "EXCHANGE_2", limit: 50, symbol?, status?, from_time?, to_time? }
// same response shape as open orders — realised_pnl here is your P&L source for the Reports page
```

---

I'll provide the actual `DATABASE_URL`, `SMS_AUTH_KEY`, and `ENCRYPTION_KEY` values as Replit Secrets once the project is created — don't hardcode them anywhere in the code.
