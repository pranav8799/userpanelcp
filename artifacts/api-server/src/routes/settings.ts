import { Router } from "express";
import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../lib/authMiddleware.js";
import type { Request, Response } from "express";

const router = Router();

type AutoPunchConfig = { orderCount: number; stepSize: number; tpPoints: number };

export interface WatchedSlot {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  limitPrice: number;
  tpPrice: number;
  quantity: number;
  repunchCount: number;
  status: "pending_fill" | "placing_tp" | "watching" | "repunching";
  orderId?: string;
  seenOpen?: boolean;
  tpOrderId?: string;
  tpSeenOpen?: boolean;
  stopped?: boolean;
}

const AUTO_PUNCH_DEFAULTS: AutoPunchConfig = { orderCount: 6, stepSize: 30, tpPoints: 60 };
const VALID_SLOT_STATUSES = new Set(["pending_fill", "placing_tp", "watching", "repunching"]);

async function getOrCreateSettings(accountId: number) {
  const [existing] = await db.select().from(settingsTable).where(eq(settingsTable.accountId, accountId));
  if (existing) return existing;
  await db.insert(settingsTable).values({ accountId });
  const [created] = await db.select().from(settingsTable).where(eq(settingsTable.accountId, accountId));
  return created;
}

function parseAutoPunchConfig(value: unknown): AutoPunchConfig {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (typeof v.orderCount === "number" && typeof v.stepSize === "number" && typeof v.tpPoints === "number") {
      return { orderCount: v.orderCount, stepSize: v.stepSize, tpPoints: v.tpPoints };
    }
  }
  return AUTO_PUNCH_DEFAULTS;
}

function isValidAutoPunchConfig(value: unknown): value is AutoPunchConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.orderCount === "number" && v.orderCount >= 1 && v.orderCount <= 20 &&
    typeof v.stepSize === "number" && v.stepSize >= 1 &&
    typeof v.tpPoints === "number" && v.tpPoints >= 1
  );
}

// ✅ fixed version — put this in routes/settings.ts
function parseWatchedSlots(value: unknown): WatchedSlot[] {
  if (Array.isArray(value)) return value as WatchedSlot[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
function isValidWatchedSlot(v: unknown): v is WatchedSlot {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.symbol === "string" &&
    (s.side === "BUY" || s.side === "SELL") &&
    typeof s.limitPrice === "number" &&
    typeof s.tpPrice === "number" &&
    typeof s.quantity === "number" &&
    typeof s.repunchCount === "number" &&
    typeof s.status === "string" && VALID_SLOT_STATUSES.has(s.status as string)
  );
}

function isValidWatchedSlots(value: unknown): value is WatchedSlot[] {
  return Array.isArray(value) && value.every(isValidWatchedSlot);
}

router.get("/", authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.auth;
  const settings = await getOrCreateSettings(accountId);
  res.json({
    autoPunchConfig: parseAutoPunchConfig((settings as any).autoPunchConfig),
    watchedSlots: parseWatchedSlots((settings as any).watchedSlots),
  });
});

router.put("/", authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.auth;
  const rawAutoPunch = (req.body as Record<string, unknown>)?.autoPunchConfig;
  const rawWatchedSlots = (req.body as Record<string, unknown>)?.watchedSlots;

  if (rawAutoPunch !== undefined && !isValidAutoPunchConfig(rawAutoPunch)) {
    res.status(400).json({ error: "Invalid autoPunchConfig: orderCount(1-20), stepSize(≥1), tpPoints(≥1) required." });
    return;
  }
  if (rawWatchedSlots !== undefined && !isValidWatchedSlots(rawWatchedSlots)) {
    res.status(400).json({ error: "Invalid watchedSlots payload." });
    return;
  }

  const settings = await getOrCreateSettings(accountId);
  const updates: Record<string, unknown> = {};
  if (rawAutoPunch !== undefined) updates.autoPunchConfig = rawAutoPunch;
  if (rawWatchedSlots !== undefined) updates.watchedSlots = rawWatchedSlots;

  if (Object.keys(updates).length > 0) {
    await db.update(settingsTable).set(updates).where(eq(settingsTable.id, settings.id));
  }

  const updated = await getOrCreateSettings(accountId);
  res.json({
    autoPunchConfig: parseAutoPunchConfig((updated as any).autoPunchConfig),
    watchedSlots: parseWatchedSlots((updated as any).watchedSlots),
  });
});

export default router;