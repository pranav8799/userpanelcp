import { db, settingsTable, accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { callCoinswitch, placeOrderForAccount, cancelOrderForAccount } from "../lib/coinswitchApi.js";
import { decrypt } from "../lib/crypto.js";
import { logHistoryEvent } from "../lib/history.js";

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
  batchId?: string;
  stepSize?: number;
  doubleQtyEnabled?: boolean;
  baseQty?: number;
  totalLegs?: number;
  // Multiplier (1–5) on stepSize — how far price is allowed to run away
  // from the topmost tracked leg, while nothing in the batch is `watching`,
  // before the whole ladder is scrapped and rebuilt closer to market.
  stepSizeIncrement?: number;
}

// Mirrors CONCURRENT_LIMIT in place-order.tsx — how many ladder legs stay
// live/resting at once; the rest sit queued. Kept in sync manually since
// the frontend and engine don't share a constants file.
const CONCURRENT_LIMIT = 2;

function computeQtyForRank(
  next: WatchedSlot[],
  batchId: string,
  side: "BUY" | "SELL",
  targetPrice: number,
  doubleQtyEnabled: boolean | undefined,
  baseQty: number,
  totalLegs: number,
  rankBoost = 0,
): number {
  if (!doubleQtyEnabled) return baseQty;
  if (!totalLegs || totalLegs <= 0) return baseQty;

  const prices = next
    .filter((s) => s.batchId === batchId && !s.stopped)
    .map((s) => s.limitPrice);
  if (!prices.includes(targetPrice)) prices.push(targetPrice);

  const sorted = side === "BUY"
    ? prices.sort((a, b) => b - a)
    : prices.sort((a, b) => a - b);

  const idx = sorted.indexOf(targetPrice) + rankBoost;
  const baseCount = Math.ceil(totalLegs / 2);
  return idx < baseCount ? baseQty : baseQty * 2;
}

function getBatchQtyConfig(
  next: WatchedSlot[],
  batchId: string,
): { doubleQtyEnabled: boolean; baseQty: number; totalLegs: number } | null {
  for (const s of next) {
    if (s.batchId === batchId && !s.stopped && s.totalLegs && s.baseQty != null) {
      return { doubleQtyEnabled: !!s.doubleQtyEnabled, baseQty: s.baseQty, totalLegs: s.totalLegs };
    }
  }
  return null;
}

/**
 * Pulls stepSize/stepSizeIncrement from ANY sibling leg in the batch, same
 * resilience reasoning as getBatchQtyConfig — a single leg losing its stamp
 * shouldn't take down the whole batch's shift/reset behavior.
 */
function getBatchLadderConfig(
  next: WatchedSlot[],
  batchId: string,
): { stepSize: number; stepSizeIncrement: number } | null {
  for (const s of next) {
    if (s.batchId === batchId && !s.stopped && s.stepSize) {
      return { stepSize: s.stepSize, stepSizeIncrement: s.stepSizeIncrement && s.stepSizeIncrement > 0 ? s.stepSizeIncrement : 1 };
    }
  }
  return null;
}

const POLL_INTERVAL_MS = 8_000;
let running = false;

function parseSlots(value: unknown): WatchedSlot[] {
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

interface SettingsRow {
  settingsId: number;
  accountId: number;
  slots: WatchedSlot[];
}

async function loadAllSettingsRows(): Promise<SettingsRow[]> {
  const rows = await db.select().from(settingsTable);
  return rows
    .map((row) => ({
      settingsId: row.id,
      accountId: row.accountId,
      slots: parseSlots((row as any).watchedSlots),
    }))
    .filter((r) => r.slots.length > 0);
}

async function saveSlots(settingsId: number, slots: WatchedSlot[]) {
  await db.update(settingsTable).set({ watchedSlots: slots } as any).where(eq(settingsTable.id, settingsId));
}

async function getAccount(accountId: number) {
  const [acc] = await db.select().from(accountsTable).where(eq(accountsTable.id, accountId)).limit(1);
  return acc ?? null;
}

async function fetchOpenOrderIds(accountId: number): Promise<Set<string> | null> {
  const acc = await getAccount(accountId);
  if (!acc) return null;
  try {
    const apiKey = decrypt(acc.apiKey);
    const secretKey = decrypt(acc.secretKey);
    const data = (await callCoinswitch("POST", "/trade/api/v2/futures/orders/open", apiKey, secretKey, {
      exchange: "EXCHANGE_2",
      limit: 50,
    })) as { data: { orders: Array<{ order_id: string }> } };
    const orders = data?.data?.orders ?? [];
    return new Set(orders.map((o) => o.order_id));
  } catch (err) {
    console.error(`[repunch] fetchOpenOrderIds failed for account ${accountId}`, err);
    return null;
  }
}

async function hasOpenPosition(accountId: number, symbol: string, expectedSide: "LONG" | "SHORT"): Promise<boolean | null> {
  const acc = await getAccount(accountId);
  if (!acc) return null;
  try {
    const apiKey = decrypt(acc.apiKey);
    const secretKey = decrypt(acc.secretKey);
    const data = (await callCoinswitch("GET", "/trade/api/v2/futures/positions", apiKey, secretKey, {
      exchange: "EXCHANGE_2",
      symbol,
    })) as { data: unknown[] };
    const positions = Array.isArray(data?.data) ? data.data : [];
    return positions.some((p: any) => p.position_side === expectedSide);
  } catch (err) {
    console.error(`[repunch] hasOpenPosition failed for account ${accountId}`, err);
    return null;
  }
}

/**
 * Live last-traded price for a symbol, fetched the same way market.ts does
 * for the UI ticker — direct CoinSwitch call using this account's own keys,
 * since the engine already holds `acc` and shouldn't loop back through its
 * own HTTP API. Returns null on any failure so callers can just skip the
 * reset check for this tick rather than crash the whole tick.
 */
async function fetchMarkPrice(acc: any, symbol: string): Promise<number | null> {
  try {
    const apiKey = decrypt(acc.apiKey);
    const secretKey = decrypt(acc.secretKey);
    const data = (await callCoinswitch("GET", "/trade/api/v2/futures/ticker", apiKey, secretKey, {
      exchange: "EXCHANGE_2",
      symbol,
    })) as { data: Record<string, Record<string, unknown>> };
    const ticker = data?.data?.["EXCHANGE_2"];
    const raw = ticker?.last_price ?? ticker?.mark_price;
    const price = raw != null ? parseFloat(String(raw)) : NaN;
    return isNaN(price) ? null : price;
  } catch (err) {
    console.error(`[repunch] fetchMarkPrice failed for ${symbol}`, err);
    return null;
  }
}

async function activateNextQueued(acc: any, accountId: number, next: WatchedSlot[], batchId: string): Promise<string | null> {
  const idx = next.findIndex((s) => s.batchId === batchId && s.status === "pending_fill" && !s.orderId && !s.stopped);
  if (idx === -1) return null;
  const slot = next[idx];
  const batchCfg = getBatchQtyConfig(next, batchId);
  const qty = batchCfg
    ? computeQtyForRank(next, batchId, slot.side, slot.limitPrice, batchCfg.doubleQtyEnabled, batchCfg.baseQty, batchCfg.totalLegs)
    : slot.quantity;
  try {
    const result = await placeOrderForAccount(acc, {
      symbol: slot.symbol,
      side: slot.side,
      order_type: "LIMIT",
      quantity: qty,
      price: slot.limitPrice,
    });
    next[idx] = { ...slot, status: "pending_fill", orderId: result.order_id, seenOpen: false, quantity: qty };

    void logHistoryEvent({
      accountId, slotId: slot.id, batchId, symbol: slot.symbol, side: slot.side,
      eventType: "queued_activated", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
      quantity: qty, repunchCountAtEvent: slot.repunchCount, orderId: result.order_id,
    });

    return slot.id;
  } catch (err) {
    console.error(`[repunch] failed to activate queued slot ${slot.id}`, err);
    void logHistoryEvent({
      accountId, slotId: slot.id, batchId, symbol: slot.symbol, side: slot.side,
      eventType: "queued_activated", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
      quantity: qty, repunchCountAtEvent: slot.repunchCount,
      note: `FAILED: ${(err as Error)?.message ?? "unknown error"}`,
    });
    return null;
  }
}

function computeShiftTarget(
  next: WatchedSlot[],
  batchId: string,
  triggerSlot: WatchedSlot,
): { newPrice: number; newTp: number; willCollide: boolean } | null {
  const stepSize = triggerSlot.stepSize;
  if (!stepSize || stepSize <= 0) return null;

  const dir = triggerSlot.side === "BUY" ? 1 : -1;
  const tpOffset = Math.abs(triggerSlot.tpPrice - triggerSlot.limitPrice);
  const newPrice = triggerSlot.limitPrice + dir * stepSize;
  const newTp = newPrice + dir * tpOffset;
  const willCollide = next.some((s) => s.batchId === batchId && !s.stopped && s.limitPrice === newPrice);

  return { newPrice, newTp, willCollide };
}

async function shiftDemoteTrim(
  acc: any,
  accountId: number,
  next: WatchedSlot[],
  triggerSlot: WatchedSlot,
  batchId: string,
): Promise<{ trimmedIndex: number | null }> {
  const dir = triggerSlot.side === "BUY" ? 1 : -1;
  const target = computeShiftTarget(next, batchId, triggerSlot);
  if (!target) {
    console.error(`[repunch] slot ${triggerSlot.id} has no stepSize — skipping shift/demote/trim`);
    return { trimmedIndex: null };
  }
  const { newPrice, newTp, willCollide } = target;

  if (willCollide) {
    console.warn(`[repunch] shift skipped for batch ${batchId}: price ${newPrice} already tracked (anchor ${triggerSlot.id})`);
    return { trimmedIndex: null };
  }

  const batchCfg = getBatchQtyConfig(next, batchId);
  const shiftQty = batchCfg
    ? computeQtyForRank(next, batchId, triggerSlot.side, newPrice, batchCfg.doubleQtyEnabled, batchCfg.baseQty, batchCfg.totalLegs)
    : triggerSlot.quantity;
  let shiftLegId: string;
  try {
    const result = await placeOrderForAccount(acc, {
      symbol: triggerSlot.symbol, side: triggerSlot.side, order_type: "LIMIT",
      quantity: shiftQty, price: newPrice,
    });
    shiftLegId = `${triggerSlot.symbol}-${triggerSlot.side}-${newPrice}-${Date.now()}-shift`;
    next.push({
      id: shiftLegId, symbol: triggerSlot.symbol, side: triggerSlot.side,
      limitPrice: newPrice, tpPrice: newTp, quantity: shiftQty, repunchCount: 0,
      status: "pending_fill", orderId: result.order_id, seenOpen: false, batchId,
      stepSize: triggerSlot.stepSize,
      stepSizeIncrement: triggerSlot.stepSizeIncrement,
      doubleQtyEnabled: batchCfg?.doubleQtyEnabled ?? triggerSlot.doubleQtyEnabled,
      baseQty: batchCfg?.baseQty ?? triggerSlot.baseQty ?? triggerSlot.quantity,
      totalLegs: batchCfg?.totalLegs ?? triggerSlot.totalLegs,
    });

    void logHistoryEvent({
      accountId, slotId: shiftLegId, batchId, symbol: triggerSlot.symbol, side: triggerSlot.side,
      eventType: "shifted", limitPrice: newPrice, tpPrice: newTp, quantity: shiftQty,
      repunchCountAtEvent: 0, orderId: result.order_id,
      note: `shifted from anchor ${triggerSlot.id} @ ${triggerSlot.limitPrice}`,
    });
  } catch (err) {
    console.error(`[repunch] shift failed for batch ${batchId} (anchor ${triggerSlot.id})`, err);
    void logHistoryEvent({
      accountId, slotId: `${triggerSlot.id}-shift-failed`, batchId, symbol: triggerSlot.symbol,
      side: triggerSlot.side, eventType: "shifted", limitPrice: newPrice, tpPrice: newTp,
      quantity: shiftQty, repunchCountAtEvent: 0,
      note: `FAILED: ${(err as Error)?.message ?? "unknown error"}`,
    });
    return { trimmedIndex: null };
  }

  const isLiveResting = (s: WatchedSlot) =>
    s.batchId === batchId && s.status === "pending_fill" && !!s.orderId && !s.stopped && s.id !== shiftLegId;

  let demoteIdx = -1;
  for (let j = 0; j < next.length; j++) {
    if (!isLiveResting(next[j])) continue;
    if (demoteIdx === -1) { demoteIdx = j; continue; }
    const isFurther = dir === 1
      ? next[j].limitPrice < next[demoteIdx].limitPrice
      : next[j].limitPrice > next[demoteIdx].limitPrice;
    if (isFurther) demoteIdx = j;
  }

  if (demoteIdx !== -1) {
    const demoteSlot = next[demoteIdx];
    try {
      await cancelOrderForAccount(acc, demoteSlot.orderId!);
      next[demoteIdx] = { ...demoteSlot, orderId: undefined, seenOpen: false };
      void logHistoryEvent({
        accountId, slotId: demoteSlot.id, batchId, symbol: demoteSlot.symbol, side: demoteSlot.side,
        eventType: "demoted", limitPrice: demoteSlot.limitPrice, tpPrice: demoteSlot.tpPrice,
        quantity: demoteSlot.quantity, repunchCountAtEvent: demoteSlot.repunchCount,
      });
    } catch (err) {
      console.error(`[repunch] demote cancel failed for slot ${demoteSlot.id}`, err);
    }
  }

  let bottomIdx = -1;
  for (let j = 0; j < next.length; j++) {
    const s = next[j];
    if (s.batchId !== batchId || s.stopped) continue;
    if (bottomIdx === -1) { bottomIdx = j; continue; }
    const isLower = dir === 1
      ? s.limitPrice < next[bottomIdx].limitPrice
      : s.limitPrice > next[bottomIdx].limitPrice;
    if (isLower) bottomIdx = j;
  }

  let trimmedIndex: number | null = null;

  if (bottomIdx !== -1) {
    const bottomSlot = next[bottomIdx];
    if (bottomSlot.status === "pending_fill") {
      if (bottomSlot.orderId) {
        try {
          await cancelOrderForAccount(acc, bottomSlot.orderId);
        } catch (err) {
          console.error(`[repunch] trim cancel failed for slot ${bottomSlot.id}`, err);
        }
      }
      void logHistoryEvent({
        accountId, slotId: bottomSlot.id, batchId, symbol: bottomSlot.symbol, side: bottomSlot.side,
        eventType: "trimmed", limitPrice: bottomSlot.limitPrice, tpPrice: bottomSlot.tpPrice,
        quantity: bottomSlot.quantity, repunchCountAtEvent: bottomSlot.repunchCount,
        note: "removed to keep ladder size constant",
      });
      next.splice(bottomIdx, 1);
      trimmedIndex = bottomIdx;
    }
  }

  if (batchCfg?.doubleQtyEnabled) {
    for (let j = 0; j < next.length; j++) {
      const s = next[j];
      if (s.batchId !== batchId || s.stopped) continue;
      if (s.status !== "pending_fill" || !s.orderId) continue;
      if (s.id === shiftLegId) continue;

      const correctQty = computeQtyForRank(next, batchId, s.side, s.limitPrice, batchCfg.doubleQtyEnabled, batchCfg.baseQty, batchCfg.totalLegs);
      if (correctQty === s.quantity) continue;

      try {
        await cancelOrderForAccount(acc, s.orderId);
        const result = await placeOrderForAccount(acc, {
          symbol: s.symbol, side: s.side, order_type: "LIMIT", quantity: correctQty, price: s.limitPrice,
        });
        const oldQty = s.quantity;
        next[j] = { ...s, orderId: result.order_id, seenOpen: false, quantity: correctQty };
        void logHistoryEvent({
          accountId, slotId: s.id, batchId, symbol: s.symbol, side: s.side,
          eventType: "rebalanced", limitPrice: s.limitPrice, tpPrice: s.tpPrice, quantity: correctQty,
          repunchCountAtEvent: s.repunchCount, orderId: result.order_id,
          note: `qty corrected ${oldQty} → ${correctQty} (rank crossed base/double boundary)`,
        });
      } catch (err) {
        console.error(`[repunch] rebalance re-place failed for slot ${s.id}`, err);
      }
    }
  }

  return { trimmedIndex };
}

/**
 * PHASE 0 — ladder reset ("chase") check.
 *
 * Only relevant while a batch has ZERO legs in `watching` status (i.e. no
 * open position from this batch right now) — the moment anything fills,
 * this stops entirely and normal shift/demote/trim behavior takes over.
 *
 * While nothing is open: if the live market price has run further from the
 * topmost (closest-to-market) tracked leg than stepSize * stepSizeIncrement,
 * the entire chain for that batch is scrapped — every live order cancelled,
 * every tracked leg (resting or queued) dropped — and rebuilt from scratch
 * starting at (marketPrice ∓ stepSize*stepSizeIncrement), same spacing,
 * same total leg count, same batchId, same qty config. This can fire
 * repeatedly if price keeps running after a reset.
 *
 * Mutates `next` in place. Returns true if a reset happened (so the caller
 * knows to mark the row dirty / persist).
 */
async function resetChainIfNeeded(
  acc: any,
  accountId: number,
  next: WatchedSlot[],
  batchId: string,
): Promise<boolean> {
  const batchLegs = next.filter((s) => s.batchId === batchId && !s.stopped);
  if (batchLegs.length === 0) return false;

  // If ANY leg in this batch is currently an open position, the chase
  // mechanism is dormant — normal engine behavior owns this batch.
  if (batchLegs.some((s) => s.status === "watching")) return false;

  const ladderCfg = getBatchLadderConfig(next, batchId);
  if (!ladderCfg || ladderCfg.stepSizeIncrement <= 1) return false; // no increment configured — nothing to do

  const anchor = batchLegs[0];
  const threshold = ladderCfg.stepSize * ladderCfg.stepSizeIncrement;

  const markPrice = await fetchMarkPrice(acc, anchor.symbol);
  if (markPrice == null) return false; // couldn't get a price this tick — try again next tick

  // Topmost = closest-to-market tracked leg: highest price for BUY, lowest for SELL.
  const topmostLeg = batchLegs.reduce((top, s) =>
    anchor.side === "BUY"
      ? (s.limitPrice > top.limitPrice ? s : top)
      : (s.limitPrice < top.limitPrice ? s : top),
  );

  const gap = anchor.side === "BUY"
    ? markPrice - topmostLeg.limitPrice
    : topmostLeg.limitPrice - markPrice;

  if (gap <= threshold) return false; // still within normal range — no reset needed

  // ── RESET ────────────────────────────────────────────────────────────
  const batchCfg = getBatchQtyConfig(next, batchId);
  const totalLegs = batchCfg?.totalLegs ?? batchLegs.length;
  const baseQty = batchCfg?.baseQty ?? topmostLeg.quantity;
  const doubleQtyEnabled = batchCfg?.doubleQtyEnabled ?? false;
  const stepSize = ladderCfg.stepSize;
  const tpOffset = Math.abs(anchor.tpPrice - anchor.limitPrice);
  const dir = anchor.side === "BUY" ? 1 : -1;

  console.warn(
    `[repunch] ladder reset for batch ${batchId}: gap ${gap.toFixed(4)} > threshold ${threshold.toFixed(4)} ` +
    `(mark ${markPrice}, old top ${topmostLeg.limitPrice}) — rebuilding from ${(markPrice - dir * threshold).toFixed(4)}`,
  );

  // 1) Cancel every live order in this batch, then drop every tracked leg
  //    (resting or queued) for this batch from `next`. Log each removed
  //    leg's FINAL repunchCount before it disappears from live state.
  for (const s of batchLegs) {
    if (s.status === "pending_fill" && s.orderId) {
      try {
        await cancelOrderForAccount(acc, s.orderId);
      } catch (err) {
        console.error(`[repunch] reset: cancel failed for slot ${s.id}`, err);
      }
    }
    void logHistoryEvent({
      accountId, slotId: s.id, batchId, symbol: s.symbol, side: s.side,
      eventType: "ladder_reset", limitPrice: s.limitPrice, tpPrice: s.tpPrice,
      quantity: s.quantity, repunchCountAtEvent: s.repunchCount, orderId: s.orderId,
      note: `chain reset — market ran to ${markPrice}, gap ${gap.toFixed(4)} exceeded threshold ${threshold.toFixed(4)}`,
    });
  }
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].batchId === batchId && !next[i].stopped) next.splice(i, 1);
  }

  // 2) Rebuild the ladder from (markPrice ∓ threshold), same spacing,
  //    same total leg count, same batchId — mirrors runAutoPunch's
  //    original creation logic (first CONCURRENT_LIMIT legs live, rest queued).
  const newTop = markPrice - dir * threshold;
  const rebuilt: WatchedSlot[] = [];

  for (let rank = 0; rank < totalLegs; rank++) {
    const legPrice = newTop - dir * stepSize * rank;
    const legTp = legPrice + dir * tpOffset;
    const qty = computeQtyForRank(
      [...next, ...rebuilt], batchId, anchor.side, legPrice, doubleQtyEnabled, baseQty, totalLegs,
    );
    const legId = `${anchor.symbol}-${anchor.side}-${legPrice}-${Date.now()}-reset${rank}`;

    if (rank < CONCURRENT_LIMIT) {
      try {
        const result = await placeOrderForAccount(acc, {
          symbol: anchor.symbol, side: anchor.side, order_type: "LIMIT", quantity: qty, price: legPrice,
        });
        rebuilt.push({
          id: legId, symbol: anchor.symbol, side: anchor.side, limitPrice: legPrice, tpPrice: legTp,
          quantity: qty, repunchCount: 0, status: "pending_fill", orderId: result.order_id, seenOpen: false,
          batchId, stepSize, stepSizeIncrement: ladderCfg.stepSizeIncrement,
          doubleQtyEnabled, baseQty, totalLegs,
        });
        void logHistoryEvent({
          accountId, slotId: legId, batchId, symbol: anchor.symbol, side: anchor.side,
          eventType: "entry_placed", limitPrice: legPrice, tpPrice: legTp, quantity: qty,
          repunchCountAtEvent: 0, orderId: result.order_id, note: "placed by ladder reset",
        });
      } catch (err) {
        console.error(`[repunch] reset: failed to place rebuilt leg at ${legPrice}`, err);
      }
    } else {
      rebuilt.push({
        id: legId, symbol: anchor.symbol, side: anchor.side, limitPrice: legPrice, tpPrice: legTp,
        quantity: qty, repunchCount: 0, status: "pending_fill", batchId,
        stepSize, stepSizeIncrement: ladderCfg.stepSizeIncrement,
        doubleQtyEnabled, baseQty, totalLegs,
      });
      void logHistoryEvent({
        accountId, slotId: legId, batchId, symbol: anchor.symbol, side: anchor.side,
        eventType: "queued", limitPrice: legPrice, tpPrice: legTp, quantity: qty,
        repunchCountAtEvent: 0, note: "queued by ladder reset",
      });
    }
  }

  next.push(...rebuilt);
  return true;
}

async function tickForAccount(row: SettingsRow) {
  const { settingsId, accountId } = row;
  const next = [...row.slots];
  let changed = false;

  const acc = await getAccount(accountId);
  if (!acc) return;

  // ── PHASE 0: ladder reset check, once per unique batch ─────────────────
  const batchIds = Array.from(new Set(next.filter((s) => s.batchId && !s.stopped).map((s) => s.batchId!)));
  for (const batchId of batchIds) {
    const didReset = await resetChainIfNeeded(acc, accountId, next, batchId);
    if (didReset) changed = true;
  }

  const needsOrders = next.some((s) => s.status === "pending_fill" || s.status === "watching");
  const openIds = needsOrders ? await fetchOpenOrderIds(accountId) : null;

  const activatedThisTick = new Set<string>();

  // Phase 1: entry limit filled → place TP exit limit
  for (let i = 0; i < next.length; i++) {
    const slot = next[i];
    if (slot.stopped) continue;
    if (activatedThisTick.has(slot.id)) continue;
    if (slot.status !== "pending_fill" || !slot.orderId) continue;
    if (!openIds) continue;

    if (openIds.has(slot.orderId)) {
      if (!slot.seenOpen) { next[i] = { ...slot, seenOpen: true }; changed = true; }
      continue;
    }

    const expectedSide = slot.side === "BUY" ? "LONG" : "SHORT";
    const filled = await hasOpenPosition(accountId, slot.symbol, expectedSide);
    if (filled === null) continue;

    if (!filled) {
      if (!slot.seenOpen) continue;
      void logHistoryEvent({
        accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
        eventType: "trimmed", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice, quantity: slot.quantity,
        repunchCountAtEvent: slot.repunchCount, orderId: slot.orderId,
        note: "cancelled/rejected on exchange (order disappeared without a fill)",
      });
      next.splice(i, 1); i--; changed = true;
      continue;
    }

    try {
      const result = await placeOrderForAccount(acc, {
        symbol: slot.symbol, side: slot.side === "BUY" ? "SELL" : "BUY", order_type: "LIMIT",
        quantity: slot.quantity, price: slot.tpPrice, reduce_only: true,
      });
      next[i] = { ...slot, status: "watching", tpOrderId: result.order_id, tpSeenOpen: false, orderId: undefined, seenOpen: false };
      changed = true;

      void logHistoryEvent({
        accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
        eventType: "entry_filled", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice, quantity: slot.quantity,
        repunchCountAtEvent: slot.repunchCount, orderId: result.order_id,
      });

      if (slot.batchId) {
        const activatedId = await activateNextQueued(acc, accountId, next, slot.batchId);
        if (activatedId) { changed = true; activatedThisTick.add(activatedId); }
      }
    } catch (err) {
      console.error(`[repunch] failed to place TP for slot ${slot.id} (account ${accountId})`, err);
    }
  }

  // Phase 2: TP exit filled → repunch + shift + demote + trim + rebalance
  for (let i = 0; i < next.length; i++) {
    const slot = next[i];
    if (slot.stopped) continue;
    if (slot.status !== "watching" || !slot.tpOrderId) continue;
    if (!openIds) continue;

    if (openIds.has(slot.tpOrderId)) {
      if (!slot.tpSeenOpen) { next[i] = { ...slot, tpSeenOpen: true }; changed = true; }
      continue;
    }
    if (!slot.tpSeenOpen) continue;

    try {
      const shiftTarget = slot.batchId ? computeShiftTarget(next, slot.batchId, slot) : null;
      const willShift = !!shiftTarget && !shiftTarget.willCollide;
      const batchCfg = slot.batchId ? getBatchQtyConfig(next, slot.batchId) : null;
      const repunchQty = batchCfg
        ? computeQtyForRank(next, slot.batchId ?? "", slot.side, slot.limitPrice, batchCfg.doubleQtyEnabled, batchCfg.baseQty, batchCfg.totalLegs, willShift ? 1 : 0)
        : slot.quantity;

      const result = await placeOrderForAccount(acc, {
        symbol: slot.symbol, side: slot.side, order_type: "LIMIT", quantity: repunchQty, price: slot.limitPrice,
      });
      const repunchedSlot: WatchedSlot = {
        ...slot, status: "pending_fill", orderId: result.order_id, seenOpen: false,
        tpOrderId: undefined, tpSeenOpen: false, repunchCount: slot.repunchCount + 1, quantity: repunchQty,
      };
      next[i] = repunchedSlot;
      changed = true;

      void logHistoryEvent({
        accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
        eventType: "tp_filled", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice, quantity: slot.quantity,
        repunchCountAtEvent: slot.repunchCount, orderId: slot.tpOrderId,
      });
      void logHistoryEvent({
        accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
        eventType: "repunched", limitPrice: repunchedSlot.limitPrice, tpPrice: repunchedSlot.tpPrice,
        quantity: repunchQty, repunchCountAtEvent: repunchedSlot.repunchCount, orderId: result.order_id,
      });

      if (slot.batchId) {
        const { trimmedIndex } = await shiftDemoteTrim(acc, accountId, next, repunchedSlot, slot.batchId);
        changed = true;
        if (trimmedIndex !== null && trimmedIndex <= i) i--;
      }
    } catch (err) {
      console.error(`[repunch] repunch failed for slot ${slot.id} (account ${accountId})`, err);
    }
  }

  if (changed) await saveSlots(settingsId, next);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const rows = await loadAllSettingsRows();
    for (const row of rows) {
      await tickForAccount(row);
    }
  } catch (err) {
    console.error("[repunch] tick failed", err);
  } finally {
    running = false;
  }
}

export function startRepunchEngine() {
  console.log(`[repunch] engine started — polling every ${POLL_INTERVAL_MS}ms`);
  setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
}







// **************************************************************10/08/2026*************************************************************


















// import { db, settingsTable, accountsTable } from "@workspace/db";
// import { eq } from "drizzle-orm";
// import { callCoinswitch, placeOrderForAccount } from "../lib/coinswitchApi.js";
// import { decrypt } from "../lib/crypto.js";

// export interface WatchedSlot {
//   id: string;
//   symbol: string;
//   side: "BUY" | "SELL";
//   limitPrice: number;
//   tpPrice: number;
//   quantity: number;
//   repunchCount: number;
//   status: "pending_fill" | "placing_tp" | "watching" | "repunching";
//   orderId?: string;
//   seenOpen?: boolean;
//   tpOrderId?: string;
//   tpSeenOpen?: boolean;
//   stopped?: boolean;
//   batchId?: string;
// }

// const POLL_INTERVAL_MS = 8_000;
// let running = false;

// function parseSlots(value: unknown): WatchedSlot[] {
//   if (Array.isArray(value)) return value as WatchedSlot[];
//   if (typeof value === "string") {
//     try {
//       const parsed = JSON.parse(value);
//       return Array.isArray(parsed) ? parsed : [];
//     } catch {
//       return [];
//     }
//   }
//   return [];
// }

// interface SettingsRow {
//   settingsId: number;
//   accountId: number;
//   slots: WatchedSlot[];
// }

// async function loadAllSettingsRows(): Promise<SettingsRow[]> {
//   const rows = await db.select().from(settingsTable);
//   return rows
//     .map((row) => ({
//       settingsId: row.id,
//       accountId: row.accountId,
//       slots: parseSlots((row as any).watchedSlots),
//     }))
//     .filter((r) => r.slots.length > 0);
// }

// async function saveSlots(settingsId: number, slots: WatchedSlot[]) {
//   await db.update(settingsTable).set({ watchedSlots: slots } as any).where(eq(settingsTable.id, settingsId));
// }

// async function getAccount(accountId: number) {
//   const [acc] = await db.select().from(accountsTable).where(eq(accountsTable.id, accountId)).limit(1);
//   return acc ?? null;
// }

// async function fetchOpenOrderIds(accountId: number): Promise<Set<string> | null> {
//   const acc = await getAccount(accountId);
//   if (!acc) return null;
//   try {
//     const apiKey = decrypt(acc.apiKey);
//     const secretKey = decrypt(acc.secretKey);
//     const data = (await callCoinswitch("POST", "/trade/api/v2/futures/orders/open", apiKey, secretKey, {
//       exchange: "EXCHANGE_2",
//       limit: 50,
//     })) as { data: { orders: Array<{ order_id: string }> } };
//     const orders = data?.data?.orders ?? [];
//     return new Set(orders.map((o) => o.order_id));
//   } catch (err) {
//     console.error(`[repunch] fetchOpenOrderIds failed for account ${accountId}`, err);
//     return null;
//   }
// }

// async function hasOpenPosition(accountId: number, symbol: string, expectedSide: "LONG" | "SHORT"): Promise<boolean | null> {
//   const acc = await getAccount(accountId);
//   if (!acc) return null;
//   try {
//     const apiKey = decrypt(acc.apiKey);
//     const secretKey = decrypt(acc.secretKey);
//     const data = (await callCoinswitch("GET", "/trade/api/v2/futures/positions", apiKey, secretKey, {
//       exchange: "EXCHANGE_2",
//       symbol,
//     })) as { data: unknown[] };
//     const positions = Array.isArray(data?.data) ? data.data : [];
//     return positions.some((p: any) => p.position_side === expectedSide);
//   } catch (err) {
//     console.error(`[repunch] hasOpenPosition failed for account ${accountId}`, err);
//     return null;
//   }
// }

// /**
//  * Activates the next queued ladder leg in the same batch (concurrency window).
//  * Called right after an active leg's entry fills, so exactly N legs stay
//  * resting on the book at a time (N = CONCURRENT_LIMIT set on the frontend).
//  * Mutates `next` in place. Returns true if a slot was activated.
//  */
// async function activateNextQueued(acc: any, next: WatchedSlot[], batchId: string): Promise<string | null> {
//   // A "queued" leg is a pending_fill slot with no orderId yet — this avoids
//   // needing a status enum value the settings schema doesn't recognize.
//   const idx = next.findIndex((s) => s.batchId === batchId && s.status === "pending_fill" && !s.orderId && !s.stopped);
//   if (idx === -1) return null;
//   const slot = next[idx];
//   try {
//     const result = await placeOrderForAccount(acc, {
//       symbol: slot.symbol,
//       side: slot.side,
//       order_type: "LIMIT",
//       quantity: slot.quantity,
//       price: slot.limitPrice,
//     });
//     next[idx] = { ...slot, status: "pending_fill", orderId: result.order_id, seenOpen: false };
//     return slot.id; // caller uses this to skip re-checking it in the same tick
//   } catch (err) {
//     console.error(`[repunch] failed to activate queued slot ${slot.id}`, err);
//     return null;
//   }
// }

// async function tickForAccount(row: SettingsRow) {
//   const { settingsId, accountId } = row;
//   const next = [...row.slots];
//   let changed = false;

//   const acc = await getAccount(accountId);
//   if (!acc) return;

//   const needsOrders = next.some((s) => s.status === "pending_fill" || s.status === "watching");
//   const openIds = needsOrders ? await fetchOpenOrderIds(accountId) : null;

//   // Slots activated by activateNextQueued during this tick — skip re-checking
//   // them below, since a brand-new order can never legitimately be "filled"
//   // in the same tick it was placed. Without this guard, a pre-existing open
//   // position for the same symbol/side (e.g. from the entry leg already
//   // having filled) gets misread as proof the new order filled instantly.
//   const activatedThisTick = new Set<string>();

//   // Phase 1: entry limit filled → place TP exit limit
//   for (let i = 0; i < next.length; i++) {
//     const slot = next[i];
//     if (slot.stopped) continue;
//     if (activatedThisTick.has(slot.id)) continue;
//     if (slot.status !== "pending_fill" || !slot.orderId) continue;
//     if (!openIds) continue; // fetch failed this tick, retry next tick

//     if (openIds.has(slot.orderId)) {
//       if (!slot.seenOpen) { next[i] = { ...slot, seenOpen: true }; changed = true; }
//       continue;
//     }

//     // Order isn't resting on the book anymore. Check the position FIRST,
//     // regardless of seenOpen — an order can fill instantly before we ever
//     // get a chance to observe it resting open. Only fall back to seenOpen
//     // to decide "cancelled" vs "still being placed", never to decide "filled".
//     const expectedSide = slot.side === "BUY" ? "LONG" : "SHORT";
//     const filled = await hasOpenPosition(accountId, slot.symbol, expectedSide);
//     if (filled === null) continue; // fetch failed, retry next tick

//     if (!filled) {
//       if (!slot.seenOpen) continue; // never seen open + no position — might not be registered yet, wait
//       next.splice(i, 1); i--; changed = true; // was open, now gone, no position — cancelled/rejected
//       continue;
//     }

//     try {
//       const result = await placeOrderForAccount(acc, {
//         symbol: slot.symbol,
//         side: slot.side === "BUY" ? "SELL" : "BUY",
//         order_type: "LIMIT",
//         quantity: slot.quantity,
//         price: slot.tpPrice,
//         reduce_only: true,
//       });
//       next[i] = { ...slot, status: "watching", tpOrderId: result.order_id, tpSeenOpen: false, orderId: undefined, seenOpen: false };
//       changed = true;

//       // This entry just filled — release the next queued ladder leg in the same batch, if any.
//       if (slot.batchId) {
//         const activatedId = await activateNextQueued(acc, next, slot.batchId);
//         if (activatedId) { changed = true; activatedThisTick.add(activatedId); }
//       }
//     } catch (err) {
//       console.error(`[repunch] failed to place TP for slot ${slot.id} (account ${accountId})`, err);
//     }
//   }

//   // Phase 2: TP exit filled → repunch a fresh entry limit
//   for (let i = 0; i < next.length; i++) {
//     const slot = next[i];
//     if (slot.stopped) continue;
//     if (slot.status !== "watching" || !slot.tpOrderId) continue;
//     if (!openIds) continue;

//     if (openIds.has(slot.tpOrderId)) {
//       if (!slot.tpSeenOpen) { next[i] = { ...slot, tpSeenOpen: true }; changed = true; }
//       continue;
//     }
//     if (!slot.tpSeenOpen) continue;

//     try {
//       const result = await placeOrderForAccount(acc, {
//         symbol: slot.symbol,
//         side: slot.side,
//         order_type: "LIMIT",
//         quantity: slot.quantity,
//         price: slot.limitPrice,
//       });
//       next[i] = {
//         ...slot,
//         status: "pending_fill",
//         orderId: result.order_id,
//         seenOpen: false,
//         tpOrderId: undefined,
//         tpSeenOpen: false,
//         repunchCount: slot.repunchCount + 1,
//       };
//       changed = true;
//     } catch (err) {
//       console.error(`[repunch] repunch failed for slot ${slot.id} (account ${accountId})`, err);
//     }
//   }

//   if (changed) await saveSlots(settingsId, next);
// }

// async function tick() {
//   if (running) return;
//   running = true;
//   try {
//     const rows = await loadAllSettingsRows();
//     // Run accounts sequentially to avoid hammering CoinSwitch with bursts
//     // across many accounts at once; each account's own calls are already
//     // sequential within tickForAccount.
//     for (const row of rows) {
//       await tickForAccount(row);
//     }
//   } catch (err) {
//     console.error("[repunch] tick failed", err);
//   } finally {
//     running = false;
//   }
// }

// export function startRepunchEngine() {
//   console.log(`[repunch] engine started — polling every ${POLL_INTERVAL_MS}ms`);
//   setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
// }









// import { db, settingsTable, accountsTable } from "@workspace/db";
// import { eq } from "drizzle-orm";
// import { callCoinswitch, placeOrderForAccount } from "../lib/coinswitchApi.js";
// import { decrypt } from "../lib/crypto.js";

// export interface WatchedSlot {
//   id: string;
//   symbol: string;
//   side: "BUY" | "SELL";
//   limitPrice: number;
//   tpPrice: number;
//   quantity: number;
//   repunchCount: number;
//   status: "pending_fill" | "placing_tp" | "watching" | "repunching";
//   orderId?: string;
//   seenOpen?: boolean;
//   tpOrderId?: string;
//   tpSeenOpen?: boolean;
//   stopped?: boolean;
// }

// const POLL_INTERVAL_MS = 8_000;
// let running = false;

// function parseSlots(value: unknown): WatchedSlot[] {
//   if (Array.isArray(value)) return value as WatchedSlot[];
//   if (typeof value === "string") {
//     try {
//       const parsed = JSON.parse(value);
//       return Array.isArray(parsed) ? parsed : [];
//     } catch {
//       return [];
//     }
//   }
//   return [];
// }

// interface SettingsRow {
//   settingsId: number;
//   accountId: number;
//   slots: WatchedSlot[];
// }

// async function loadAllSettingsRows(): Promise<SettingsRow[]> {
//   const rows = await db.select().from(settingsTable);
//   return rows
//     .map((row) => ({
//       settingsId: row.id,
//       accountId: row.accountId,
//       slots: parseSlots((row as any).watchedSlots),
//     }))
//     .filter((r) => r.slots.length > 0);
// }

// async function saveSlots(settingsId: number, slots: WatchedSlot[]) {
//   await db.update(settingsTable).set({ watchedSlots: slots } as any).where(eq(settingsTable.id, settingsId));
// }

// async function getAccount(accountId: number) {
//   const [acc] = await db.select().from(accountsTable).where(eq(accountsTable.id, accountId)).limit(1);
//   return acc ?? null;
// }

// async function fetchOpenOrderIds(accountId: number): Promise<Set<string> | null> {
//   const acc = await getAccount(accountId);
//   if (!acc) return null;
//   try {
//     const apiKey = decrypt(acc.apiKey);
//     const secretKey = decrypt(acc.secretKey);
//     const data = (await callCoinswitch("POST", "/trade/api/v2/futures/orders/open", apiKey, secretKey, {
//       exchange: "EXCHANGE_2",
//       limit: 50,
//     })) as { data: { orders: Array<{ order_id: string }> } };
//     const orders = data?.data?.orders ?? [];
//     return new Set(orders.map((o) => o.order_id));
//   } catch (err) {
//     console.error(`[repunch] fetchOpenOrderIds failed for account ${accountId}`, err);
//     return null;
//   }
// }

// async function hasOpenPosition(accountId: number, symbol: string, expectedSide: "LONG" | "SHORT"): Promise<boolean | null> {
//   const acc = await getAccount(accountId);
//   if (!acc) return null;
//   try {
//     const apiKey = decrypt(acc.apiKey);
//     const secretKey = decrypt(acc.secretKey);
//     const data = (await callCoinswitch("GET", "/trade/api/v2/futures/positions", apiKey, secretKey, {
//       exchange: "EXCHANGE_2",
//       symbol,
//     })) as { data: unknown[] };
//     const positions = Array.isArray(data?.data) ? data.data : [];
//     return positions.some((p: any) => p.position_side === expectedSide);
//   } catch (err) {
//     console.error(`[repunch] hasOpenPosition failed for account ${accountId}`, err);
//     return null;
//   }
// }

// async function tickForAccount(row: SettingsRow) {
//   const { settingsId, accountId } = row;
//   const next = [...row.slots];
//   let changed = false;

//   const acc = await getAccount(accountId);
//   if (!acc) return;

//   const needsOrders = next.some((s) => s.status === "pending_fill" || s.status === "watching");
//   const openIds = needsOrders ? await fetchOpenOrderIds(accountId) : null;

//   // Phase 1: entry limit filled → place TP exit limit
//   for (let i = 0; i < next.length; i++) {
//     const slot = next[i];
//     if (slot.stopped) continue;
//     if (slot.status !== "pending_fill" || !slot.orderId) continue;
//     if (!openIds) continue; // fetch failed this tick, retry next tick

//     if (openIds.has(slot.orderId)) {
//       if (!slot.seenOpen) { next[i] = { ...slot, seenOpen: true }; changed = true; }
//       continue;
//     }

//     // Order isn't resting on the book anymore. Check the position FIRST,
//     // regardless of seenOpen — an order can fill instantly before we ever
//     // get a chance to observe it resting open. Only fall back to seenOpen
//     // to decide "cancelled" vs "still being placed", never to decide "filled".
//     const expectedSide = slot.side === "BUY" ? "LONG" : "SHORT";
//     const filled = await hasOpenPosition(accountId, slot.symbol, expectedSide);
//     if (filled === null) continue; // fetch failed, retry next tick

//     if (!filled) {
//       if (!slot.seenOpen) continue; // never seen open + no position — might not be registered yet, wait
//       next.splice(i, 1); i--; changed = true; // was open, now gone, no position — cancelled/rejected
//       continue;
//     }

//     try {
//       const result = await placeOrderForAccount(acc, {
//         symbol: slot.symbol,
//         side: slot.side === "BUY" ? "SELL" : "BUY",
//         order_type: "LIMIT",
//         quantity: slot.quantity,
//         price: slot.tpPrice,
//         reduce_only: true,
//       });
//       next[i] = { ...slot, status: "watching", tpOrderId: result.order_id, tpSeenOpen: false, orderId: undefined, seenOpen: false };
//       changed = true;
//     } catch (err) {
//       console.error(`[repunch] failed to place TP for slot ${slot.id} (account ${accountId})`, err);
//     }
//   }

//   // Phase 2: TP exit filled → repunch a fresh entry limit
//   for (let i = 0; i < next.length; i++) {
//     const slot = next[i];
//     if (slot.stopped) continue;
//     if (slot.status !== "watching" || !slot.tpOrderId) continue;
//     if (!openIds) continue;

//     if (openIds.has(slot.tpOrderId)) {
//       if (!slot.tpSeenOpen) { next[i] = { ...slot, tpSeenOpen: true }; changed = true; }
//       continue;
//     }
//     if (!slot.tpSeenOpen) continue;

//     try {
//       const result = await placeOrderForAccount(acc, {
//         symbol: slot.symbol,
//         side: slot.side,
//         order_type: "LIMIT",
//         quantity: slot.quantity,
//         price: slot.limitPrice,
//       });
//       next[i] = {
//         ...slot,
//         status: "pending_fill",
//         orderId: result.order_id,
//         seenOpen: false,
//         tpOrderId: undefined,
//         tpSeenOpen: false,
//         repunchCount: slot.repunchCount + 1,
//       };
//       changed = true;
//     } catch (err) {
//       console.error(`[repunch] repunch failed for slot ${slot.id} (account ${accountId})`, err);
//     }
//   }

//   if (changed) await saveSlots(settingsId, next);
// }

// async function tick() {
//   if (running) return;
//   running = true;
//   try {
//     const rows = await loadAllSettingsRows();
//     // Run accounts sequentially to avoid hammering CoinSwitch with bursts
//     // across many accounts at once; each account's own calls are already
//     // sequential within tickForAccount.
//     for (const row of rows) {
//       await tickForAccount(row);
//     }
//   } catch (err) {
//     console.error("[repunch] tick failed", err);
//   } finally {
//     running = false;
//   }
// }

// export function startRepunchEngine() {
//   console.log(`[repunch] engine started — polling every ${POLL_INTERVAL_MS}ms`);
//   setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
// }