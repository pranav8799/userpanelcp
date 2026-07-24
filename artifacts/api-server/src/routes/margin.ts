import { Router } from "express";
import { db, accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../lib/authMiddleware.js";
import { addMarginForAccount } from "../lib/coinswitchApi.js";
import type { Request, Response } from "express";

const router = Router();

router.post("/add", authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.auth;
  const { symbol, margin } = req.body ?? {};

  if (!symbol || typeof symbol !== "string") { res.status(400).json({ error: "symbol is required" }); return; }
  if (typeof margin !== "number" || margin <= 0) { res.status(400).json({ error: "margin must be a positive number" }); return; }

  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.id, accountId));
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  try {
    await addMarginForAccount(account, symbol, margin);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Failed to add margin" });
  }
});

export default router;