// src/routes/notifications.ts (user panel API)
import { Router } from "express";
import { db, notificationsTable } from "@workspace/db";
import { eq, and, or, desc } from "drizzle-orm";
import { authMiddleware } from "../lib/authMiddleware.js";
import type { Request, Response } from "express";

const router = Router();

function serialize(n: typeof notificationsTable.$inferSelect) {
  return {
    id: n.id,
    title: n.title,
    message: n.message,
    targetType: n.targetType,
    createdAt: n.createdAt.toISOString(),
  };
}

// GET /notifications — broadcast (ALL) + this account's own (ACCOUNT) notifications
router.get("/", authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.auth;

  const rows = await db
    .select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.isActive, true),
        or(
          eq(notificationsTable.targetType, "ALL"),
          and(
            eq(notificationsTable.targetType, "ACCOUNT"),
            eq(notificationsTable.accountId, accountId)
          )
        )
      )
    )
    .orderBy(desc(notificationsTable.createdAt));

  res.json(rows.map(serialize));
});

export default router;