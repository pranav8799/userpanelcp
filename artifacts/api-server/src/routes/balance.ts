import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../lib/authMiddleware.js";
import { callCoinswitch } from "../lib/coinswitchApi.js";
import { decrypt } from "../lib/crypto.js";
import type { Request, Response } from "express";

const router = Router();

// GET /balance — live wallet balance scoped to JWT account
router.get("/", authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.auth;

  const [account] = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId));

  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  const apiKey = decrypt(account.apiKey);
  const secretKey = decrypt(account.secretKey);

  const data = (await callCoinswitch(
    "GET",
    "/trade/api/v2/futures/wallet_balance",
    apiKey,
    secretKey,
    { exchange: "EXCHANGE_2" },
  )) as {
    data: {
      base_asset_balances: Array<{
        balances: { total_available_balance: string; total_balance: string };
      }>;
    };
  };

  const balances = data?.data?.base_asset_balances?.[0]?.balances;
  res.json({
    availableBalance: balances?.total_available_balance ?? null,
    totalBalance: balances?.total_balance ?? null,
  });
});

export default router;
