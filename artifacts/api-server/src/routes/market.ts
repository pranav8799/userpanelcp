import { Router } from "express";
import { authMiddleware } from "../lib/authMiddleware.js";
import { callCoinswitch } from "../lib/coinswitchApi.js";
import { decrypt } from "../lib/crypto.js";
import { db, accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Request, Response } from "express";

const router = Router();

// GET /api/market/ticker?symbol=XAUUSDT
router.get("/ticker", authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const symbol = req.query.symbol as string;
  if (!symbol) {
    res.status(400).json({ error: "symbol required" });
    return;
  }

  const { accountId } = req.auth;
  const [acc] = await db.select().from(accountsTable).where(eq(accountsTable.id, accountId));
  if (!acc) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  const apiKey = decrypt(acc.apiKey);
  const secretKey = decrypt(acc.secretKey);

  let data: { data: Record<string, Record<string, unknown>> };
  try {
    data = (await callCoinswitch(
      "GET",
      "/trade/api/v2/futures/ticker",
      apiKey,
      secretKey,
      { exchange: "EXCHANGE_2", symbol },
    )) as { data: Record<string, Record<string, unknown>> };
  } catch {
    res.status(502).json({ error: "Failed to reach CoinSwitch" });
    return;
  }

  const ticker = data?.data?.["EXCHANGE_2"];
  if (!ticker) {
    res.status(404).json({ error: "Ticker not found" });
    return;
  }

  res.json({
    symbol: ticker.symbol,
    lastPrice: ticker.last_price,
    markPrice: ticker.mark_price,
    indexPrice: ticker.index_price,
    fundingRate: ticker.funding_rate,
    bestBidPrice: ticker.best_bid_price,
    bestAskPrice: ticker.best_ask_price,
    high24h: ticker.high_price_24h,
    low24h: ticker.low_price_24h,
    priceChangePct24h: ticker.price_24h_pcnt,
  });
});

export default router;