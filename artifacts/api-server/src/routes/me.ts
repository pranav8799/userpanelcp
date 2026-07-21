import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../lib/authMiddleware.js";
import type { Request, Response } from "express";

const router = Router();

// GET /me — returns logged-in client's account info (no keys ever returned)
router.get("/", authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.auth;

  const [account] = await db
    .select({
      id: accountsTable.id,
      name: accountsTable.name,
      mobileNumber: accountsTable.mobileNumber,
      isActive: accountsTable.isActive,
    })
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId));

  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  const masked = account.mobileNumber.slice(0, 2) + "••••••" + account.mobileNumber.slice(-2);

  res.json({
    id: account.id,
    name: account.name,
    maskedMobileNumber: masked,
    isActive: account.isActive,
  });
});

export default router;
