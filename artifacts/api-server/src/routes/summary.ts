import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../lib/authMiddleware.js";
import { callCoinswitch } from "../lib/coinswitchApi.js";
import { decrypt } from "../lib/crypto.js";
import type { Request, Response } from "express";

const router = Router();

// GET /summary — P&L summary computed from closed orders
router.get("/", authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.auth;

  const [account] = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId));

  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  const apiKey = decrypt(account.apiKey);
  const secretKey = decrypt(account.secretKey);

  // Fetch enough closed orders to compute summaries (limit 200)
  const data = (await callCoinswitch(
    "POST",
    "/trade/api/v2/futures/orders/closed",
    apiKey,
    secretKey,
    { exchange: "EXCHANGE_2", limit: 200 },
  )) as { data: { orders: Array<{ realised_pnl?: string | number; created_at?: string | number }> } };

  const orders = data?.data?.orders ?? [];

  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const weekMs = now - 7 * 24 * 60 * 60 * 1000;
  const monthMs = now - 30 * 24 * 60 * 60 * 1000;

  let todayPnl = 0;
  let weekPnl = 0;
  let monthPnl = 0;
  let totalPnl = 0;
  let tradeCount = 0;

  for (const order of orders) {
    const pnl = parseFloat(String(order.realised_pnl ?? "0")) || 0;
    // created_at may be epoch ms or ISO string
    const rawTs = order.created_at;
    const ts = rawTs
      ? typeof rawTs === "number"
        ? rawTs
        : new Date(rawTs).getTime()
      : 0;

    totalPnl += pnl;
    tradeCount++;

    if (ts >= todayMs) todayPnl += pnl;
    if (ts >= weekMs) weekPnl += pnl;
    if (ts >= monthMs) monthPnl += pnl;
  }

  res.json({
    todayPnl: round(todayPnl),
    weekPnl: round(weekPnl),
    monthPnl: round(monthPnl),
    totalPnl: round(totalPnl),
    tradeCount,
  });
});

function round(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

export default router;
