import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable, tradeLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "../lib/authMiddleware.js";
import { callCoinswitch, placeOrderForAccount } from "../lib/coinswitchApi.js";
import { decrypt } from "../lib/crypto.js";
import type { Request, Response } from "express";

const router = Router();

// Rate limit for order placement: 20 per minute per account (by IP)
const orderRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many order requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Helper: get and decrypt account keys from DB
async function getAccountWithKeys(accountId: number) {
  const [account] = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId));
  return account ?? null;
}

// POST /orders/open — live open orders
router.post("/open", authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.auth;
  const account = await getAccountWithKeys(accountId);
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  const apiKey = decrypt(account.apiKey);
  const secretKey = decrypt(account.secretKey);

  const body: Record<string, unknown> = { exchange: "EXCHANGE_2", limit: req.body?.limit ?? 50 };
  if (req.body?.symbol) body.symbol = req.body.symbol;

  const data = (await callCoinswitch(
    "POST",
    "/trade/api/v2/futures/orders/open",
    apiKey,
    secretKey,
    body,
  )) as { data: { orders: unknown[] } };

  const rawOrders = data?.data?.orders ?? [];
  res.json({ orders: rawOrders.map(mapOrder) });
});

// POST /orders/closed — live closed/historical orders
router.post("/closed", authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.auth;
  const account = await getAccountWithKeys(accountId);
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  const apiKey = decrypt(account.apiKey);
  const secretKey = decrypt(account.secretKey);

  const body: Record<string, unknown> = { exchange: "EXCHANGE_2", limit: req.body?.limit ?? 50 };
  if (req.body?.symbol) body.symbol = req.body.symbol;
  if (req.body?.status) body.status = req.body.status;
  if (req.body?.fromTime) body.from_time = req.body.fromTime;
  if (req.body?.toTime) body.to_time = req.body.toTime;

  const data = (await callCoinswitch(
    "POST",
    "/trade/api/v2/futures/orders/closed",
    apiKey,
    secretKey,
    body,
  )) as { data: { orders: unknown[] } };

  const rawOrders = data?.data?.orders ?? [];
  res.json({ orders: rawOrders.map(mapOrder) });
});

// POST /orders — place a new order (server-side validation + audit log)
router.post(
  "/",
  authMiddleware,
  orderRateLimit,
  async (req: Request, res: Response): Promise<void> => {
    const { accountId } = req.auth;

    // --- Server-side validation ---
    const { symbol, side, order_type, quantity, price, triggerPrice, reduceOnly, timeInForce, clientOrderId } = req.body ?? {};

    const VALID_SIDES = ["BUY", "SELL"] as const;
    const VALID_TYPES = ["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"] as const;
    const VALID_TIF = ["GTC", "IOC", "FOK"] as const;

    if (!symbol || typeof symbol !== "string" || !/^[A-Za-z0-9_]+$/.test(symbol)) {
      res.status(400).json({ error: "Invalid symbol format" }); return;
    }
    if (!VALID_SIDES.includes(side)) {
      res.status(400).json({ error: "side must be BUY or SELL" }); return;
    }
    if (!VALID_TYPES.includes(order_type)) {
      res.status(400).json({ error: "Invalid order_type" }); return;
    }
    if (order_type !== "STOP_MARKET" && order_type !== "TAKE_PROFIT_MARKET") {
      if (typeof quantity !== "number" || quantity <= 0) {
        res.status(400).json({ error: "quantity must be a positive number" }); return;
      }
    }
    if (order_type === "LIMIT" && (typeof price !== "number" || price <= 0)) {
      res.status(400).json({ error: "price is required for LIMIT orders" }); return;
    }
    if ((order_type === "STOP_MARKET" || order_type === "TAKE_PROFIT_MARKET") &&
      (typeof triggerPrice !== "number" || triggerPrice <= 0)) {
      res.status(400).json({ error: "triggerPrice is required for STOP_MARKET/TAKE_PROFIT_MARKET orders" }); return;
    }
    if (timeInForce && !VALID_TIF.includes(timeInForce)) {
      res.status(400).json({ error: "Invalid timeInForce value" }); return;
    }

    const account = await getAccountWithKeys(accountId);
    if (!account) { res.status(404).json({ error: "Account not found" }); return; }

    // Log audit trail before placing
    req.log.info({ accountId, symbol, side, order_type, quantity }, "order placement attempt");

    try {
      const result = await placeOrderForAccount(account, {
        symbol,
        side,
        order_type,
        quantity: quantity ?? 0,
        price,
        trigger_price: triggerPrice,
        reduce_only: reduceOnly,
        time_in_force: timeInForce,
        client_order_id: clientOrderId,
      });

      // Persist audit log
      await db.insert(tradeLogsTable).values({
        accountId,
        orderId: result.order_id,
        symbol: symbol.toUpperCase(),
        side,
        orderType: order_type,
        quantity: quantity?.toString(),
        price: price?.toString(),
        triggerPrice: triggerPrice?.toString(),
        reduceOnly: !!reduceOnly,
        status: result.status,
        firedVia: "MANUAL",
      });

      req.log.info({ accountId, orderId: result.order_id, status: result.status }, "order placed");
      res.json({ orderId: result.order_id, status: result.status });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Order placement failed";
      req.log.error({ accountId, error: msg }, "order placement failed");

      // Audit log failure
      await db.insert(tradeLogsTable).values({
        accountId,
        symbol: symbol.toUpperCase(),
        side,
        orderType: order_type,
        quantity: quantity?.toString(),
        price: price?.toString(),
        triggerPrice: triggerPrice?.toString(),
        reduceOnly: !!reduceOnly,
        status: "FAILED",
        errorMessage: msg,
        firedVia: "MANUAL",
      }).catch(() => {});

      res.status(500).json({ error: msg });
    }
  },
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapOrder(o: any) {
  return {
    orderId: o.order_id ?? null,
    symbol: o.symbol ?? "",
    side: o.side ?? "",
    orderType: o.order_type ?? "",
    quantity: o.quantity?.toString() ?? null,
    execQuantity: o.exec_quantity?.toString() ?? null,
    price: o.price?.toString() ?? null,
    triggerPrice: o.trigger_price?.toString() ?? null,
    avgExecutionPrice: o.avg_execution_price?.toString() ?? null,
    executionFee: o.execution_fee?.toString() ?? null,
    realisedPnl: o.realised_pnl?.toString() ?? null,
    reduceOnly: o.reduce_only ?? null,
    status: o.status ?? null,
    createdAt: o.created_at ?? null,
  };
}

export default router;
