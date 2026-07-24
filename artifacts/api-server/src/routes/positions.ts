import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../lib/authMiddleware.js";
import { callCoinswitch } from "../lib/coinswitchApi.js";
import { decrypt } from "../lib/crypto.js";
import type { Request, Response } from "express";

const router = Router();

// GET /positions — live open positions
router.get("/", authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.auth;

  const [account] = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId));

  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  const apiKey = decrypt(account.apiKey);
  const secretKey = decrypt(account.secretKey);


  const params: Record<string, string> = { exchange: "EXCHANGE_2" };

  const data = (await callCoinswitch(
  "GET",
  "/trade/api/v2/futures/positions",
  apiKey,
  secretKey,
  params,
)) as { data: unknown[] };
const rawPositions = data?.data ?? [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const positions = rawPositions.map((p: any) => ({
    positionId: p.position_id ?? null,
    symbol: p.symbol ?? "",
    positionSide: p.position_side ?? null,
    leverage: p.leverage?.toString() ?? null,
    positionSize: p.position_size?.toString() ?? null,
    positionValue: p.position_value?.toString() ?? null,
    positionMargin: p.position_margin?.toString() ?? null,
    maintMargin: p.maint_margin?.toString() ?? null,
    avgEntryPrice: p.avg_entry_price?.toString() ?? null,
    markPrice: p.mark_price?.toString() ?? null,
    lastPrice: p.last_price?.toString() ?? null,
    unrealisedPnl: p.unrealised_pnl?.toString() ?? null,
    liquidationPrice: p.liquidation_price?.toString() ?? null,
    marginType: p.margin_type ?? null,
    status: p.status ?? null,
  }));
  res.set("Cache-Control", "no-store");
  res.json({ positions });
});

export default router;
