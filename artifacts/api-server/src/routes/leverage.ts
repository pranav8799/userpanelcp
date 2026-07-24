import { Router } from "express";
import { db, accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../lib/authMiddleware.js";
import { getLeverageForAccount, setLeverageForAccount } from "../lib/coinswitchApi.js";
import type { Request, Response } from "express";

const router = Router();

async function getAccount(accountId: number) {
  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.id, accountId));
  return account ?? null;
}

// GET /leverage?symbol=XAUUSDT
router.get("/", authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.auth;
  const symbol = req.query.symbol as string | undefined;
  if (!symbol) { res.status(400).json({ error: "symbol is required" }); return; }

  const account = await getAccount(accountId);
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  try {
    const result = await getLeverageForAccount(account, symbol);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch leverage" });
  }
});

// POST /leverage — { symbol, leverage }
router.post("/", authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.auth;
  const { symbol, leverage } = req.body ?? {};

  if (!symbol || typeof symbol !== "string") { res.status(400).json({ error: "symbol is required" }); return; }
  if (typeof leverage !== "number" || leverage <= 0) { res.status(400).json({ error: "leverage must be a positive number" }); return; }

  const account = await getAccount(accountId);
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  try {
    await setLeverageForAccount(account, symbol, leverage);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Failed to set leverage" });
  }
});

export default router;