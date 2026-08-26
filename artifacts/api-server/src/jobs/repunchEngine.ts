import { db, settingsTable, accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  callCoinswitch,
  placeOrderForAccount,
  cancelOrderForAccount,
  getOrderStatusForAccount,
  type OrderStatus,
} from "../lib/coinswitchApi.js";
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
  // "tearing_down": batch is being cancelled + verified flat ahead of a full
  // rebuild. Durable/persisted checkpoint state — see progressBatchTeardown.
  status: "pending_fill" | "placing_tp" | "watching" | "repunching" | "tearing_down";
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
  // Multiplier (1–100) on stepSize — how far price is allowed to run away
  // from the topmost tracked leg (chase case), or how far the rebuild
  // anchor sits from mark price (TP-fill teardown case), before/when the
  // ladder gets rebuilt.
  stepSizeIncrement?: number;
  // Master on/off for ladder reset behavior. When false: chase reset
  // (resetChainIfNeeded) never fires, and a rank-0 TP fill does an
  // individual re-punch instead of tearing down + rebuilding the batch.
  // Undefined/missing is treated as true (back-compat with existing slots).
  ladderResetEnabled?: boolean;
  // Rank 0 = entry / first order. Only rank-0 TP fill may trigger a full
  // batch rebuild. Other ranks do an individual re-punch of that leg only.
  rank?: number;
}
// Mirrors CONCURRENT_LIMIT in place-order.tsx — how many ladder legs stay
// live/resting at once; the rest sit queued. Kept in sync manually since
// the frontend and engine don't share a constants file.
const CONCURRENT_LIMIT = 2;

/**
 * Every limit/TP price here is derived via float add/subtract (entry ±
 * stepSize, limit ± tpOffset). With small step sizes (e.g. 0.01) that
 * arithmetic routinely lands on 64.80999999999999 instead of 64.81, which
 * then fails a strict `===` collision check against a sibling leg — and a
 * duplicate leg gets created at what looks like the same price. Every
 * computed price is rounded through this before being stored or compared.
 */
function roundPrice(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

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
 * Pulls stepSize/stepSizeIncrement from ANY sibling leg in the batch —
 * a single leg losing its stamp shouldn't take down the whole batch's
 * rebuild behavior.
 */
function getBatchLadderConfig(
  next: WatchedSlot[],
  batchId: string,
): { stepSize: number; stepSizeIncrement: number; ladderResetEnabled: boolean } | null {
  for (const s of next) {
    if (s.batchId === batchId && !s.stopped && s.stepSize) {
      return {
        stepSize: s.stepSize,
        stepSizeIncrement: s.stepSizeIncrement && s.stepSizeIncrement > 0 ? s.stepSizeIncrement : 1,
        ladderResetEnabled: s.ladderResetEnabled !== false,
      };
    }
  }
  return null;
}

/** True only for the entry / first order (rank 0). Missing rank is treated as non-first. */
function isFirstOrder(slot: WatchedSlot): boolean {
  return slot.rank === 0;
}

// Faster polling so rapid fill → TP is caught before the UI sticks on "Trade".
const POLL_INTERVAL_MS = 2_000;
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

async function fetchPositionSize(accountId: number, symbol: string, expectedSide: "LONG" | "SHORT"): Promise<number | null> {
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
    const pos = positions.find((p: any) => p.position_side === expectedSide);
    if (!pos) return 0;
    const size = parseFloat(String((pos as any).position_size ?? 0));
    return isNaN(size) ? 0 : Math.abs(size);
  } catch (err) {
    console.error(`[repunch] fetchPositionSize failed for account ${accountId}`, err);
    return null;
  }
}

/**
 * Live last-traded price for a symbol. Returns null on failure so callers
 * skip the check for this tick rather than crash the whole tick.
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

/* ════════════════════════════════════════════════════════════════════════
 * Cancel + fill verification helpers.
 * ════════════════════════════════════════════════════════════════════════ */

interface CancelVerifyResult {
  outcome: "clear" | "filled" | "unknown";
  execQty: number;
  status: OrderStatus | null;
}

/**
 * Attempts to cancel `orderId`, then ALWAYS re-verifies via order status.
 * Used only for non-reduce-only entry limits — never for TP (reduce-only).
 */
async function cancelAndVerify(acc: any, orderId: string): Promise<CancelVerifyResult> {
  try {
    await cancelOrderForAccount(acc, orderId);
  } catch {
    // Ignore — could be already gone. Verified below.
  }
  const status = await getOrderStatusForAccount(acc, orderId);
  if (!status) return { outcome: "unknown", execQty: 0, status: null };

  const execQty = parseFloat(status.exec_quantity || "0");
  if (!isNaN(execQty) && execQty > 1e-9) {
    return { outcome: "filled", execQty, status };
  }
  if (status.status === "OPEN" || status.status === "PARTIALLY_FILLED") {
    return { outcome: "unknown", execQty: 0, status };
  }
  return { outcome: "clear", execQty: 0, status };
}

/**
 * Ground-truth check for an order that already left the open-orders book.
 * Distinguishes real fill vs cancelled/rejected with no fill.
 */
async function checkAlreadyGoneOrder(acc: any, orderId: string): Promise<{ filled: boolean; execQty: number; status: OrderStatus | null }> {
  const status = await getOrderStatusForAccount(acc, orderId);
  if (!status) return { filled: false, execQty: 0, status: null };
  const execQty = parseFloat(status.exec_quantity || "0");
  return { filled: !isNaN(execQty) && execQty > 1e-9, execQty: isNaN(execQty) ? 0 : execQty, status };
}

/* ════════════════════════════════════════════════════════════════════════
 * Shared rebuild core
 * ════════════════════════════════════════════════════════════════════════ */

interface LadderAnchorConfig {
  symbol: string;
  side: "BUY" | "SELL";
  stepSize: number;
  stepSizeIncrement: number;
  totalLegs: number;
  baseQty: number;
  doubleQtyEnabled: boolean;
  ladderResetEnabled: boolean;
  tpOffset: number;
}

/**
 * Places a fresh ladder of `cfg.totalLegs` legs anchored at
 * (markPrice ∓ stepSize*stepSizeIncrement). Rank 0 is stamped as first order.
 */
async function placeRebuiltLadder(
  acc: any,
  accountId: number,
  next: WatchedSlot[],
  batchId: string,
  cfg: LadderAnchorConfig,
  markPrice: number,
  eventNote: string,
): Promise<WatchedSlot[]> {
  const dir = cfg.side === "BUY" ? 1 : -1;
  const threshold = cfg.stepSize * cfg.stepSizeIncrement;
  const newTop = roundPrice(markPrice - dir * threshold);

  console.warn(
    `[repunch] rebuilding batch ${batchId}: anchor ${newTop} (mark ${markPrice}, threshold ${threshold.toFixed(8)}) — ${eventNote}`,
  );

  const rebuilt: WatchedSlot[] = [];

  for (let rank = 0; rank < cfg.totalLegs; rank++) {
    const legPrice = roundPrice(newTop - dir * cfg.stepSize * rank);
    const legTp = roundPrice(legPrice + dir * cfg.tpOffset);
    const qty = computeQtyForRank(
      [...next, ...rebuilt], batchId, cfg.side, legPrice, cfg.doubleQtyEnabled, cfg.baseQty, cfg.totalLegs,
    );
    const legId = `${cfg.symbol}-${cfg.side}-${legPrice}-${Date.now()}-rebuild${rank}`;

    if (rank < CONCURRENT_LIMIT) {
      try {
        const result = await placeOrderForAccount(acc, {
          symbol: cfg.symbol, side: cfg.side, order_type: "LIMIT", quantity: qty, price: legPrice,
        });
        rebuilt.push({
          id: legId, symbol: cfg.symbol, side: cfg.side, limitPrice: legPrice, tpPrice: legTp,
          quantity: qty, repunchCount: 0, status: "pending_fill", orderId: result.order_id, seenOpen: false,
          batchId, stepSize: cfg.stepSize, stepSizeIncrement: cfg.stepSizeIncrement,
          doubleQtyEnabled: cfg.doubleQtyEnabled, ladderResetEnabled: cfg.ladderResetEnabled,
          baseQty: cfg.baseQty, totalLegs: cfg.totalLegs,
          rank,
        });
        void logHistoryEvent({
          accountId, slotId: legId, batchId, symbol: cfg.symbol, side: cfg.side,
          eventType: "entry_placed", limitPrice: legPrice, tpPrice: legTp, quantity: qty,
          repunchCountAtEvent: 0, orderId: result.order_id, note: `placed by rebuild — ${eventNote}`,
        });
      } catch (err) {
        console.error(`[repunch] rebuild: failed to place live leg at ${legPrice} (rank ${rank})`, err);
        rebuilt.push({
          id: legId, symbol: cfg.symbol, side: cfg.side, limitPrice: legPrice, tpPrice: legTp,
          quantity: qty, repunchCount: 0, status: "pending_fill", batchId,
          stepSize: cfg.stepSize, stepSizeIncrement: cfg.stepSizeIncrement,
          doubleQtyEnabled: cfg.doubleQtyEnabled, ladderResetEnabled: cfg.ladderResetEnabled,
          baseQty: cfg.baseQty, totalLegs: cfg.totalLegs,
          rank,
        });
        void logHistoryEvent({
          accountId, slotId: legId, batchId, symbol: cfg.symbol, side: cfg.side,
          eventType: "queued", limitPrice: legPrice, tpPrice: legTp, quantity: qty,
          repunchCountAtEvent: 0, note: `rebuild: live placement FAILED, queued instead — ${(err as Error)?.message ?? "unknown error"}`,
        });
      }
    } else {
      rebuilt.push({
        id: legId, symbol: cfg.symbol, side: cfg.side, limitPrice: legPrice, tpPrice: legTp,
        quantity: qty, repunchCount: 0, status: "pending_fill", batchId,
        stepSize: cfg.stepSize, stepSizeIncrement: cfg.stepSizeIncrement,
        doubleQtyEnabled: cfg.doubleQtyEnabled, ladderResetEnabled: cfg.ladderResetEnabled,
        baseQty: cfg.baseQty, totalLegs: cfg.totalLegs,
        rank,
      });
      void logHistoryEvent({
        accountId, slotId: legId, batchId, symbol: cfg.symbol, side: cfg.side,
        eventType: "queued", limitPrice: legPrice, tpPrice: legTp, quantity: qty,
        repunchCountAtEvent: 0, note: `queued by rebuild — ${eventNote}`,
      });
    }
  }

  return rebuilt;
}

/**
 * Individual re-punch for a non-first leg: TP filled → place the same limit
 * again at the same price. Does NOT touch any sibling leg or reduce-only order.
 */
async function individualRepunch(
  acc: any,
  accountId: number,
  next: WatchedSlot[],
  idx: number,
): Promise<boolean> {
  const slot = next[idx];
  if (!slot || slot.stopped) return false;

  const qty = slot.quantity;
  try {
    const result = await placeOrderForAccount(acc, {
      symbol: slot.symbol,
      side: slot.side,
      order_type: "LIMIT",
      quantity: qty,
      price: slot.limitPrice,
    });
    next[idx] = {
      ...slot,
      status: "pending_fill",
      orderId: result.order_id,
      seenOpen: false,
      tpOrderId: undefined,
      tpSeenOpen: false,
      repunchCount: (slot.repunchCount ?? 0) + 1,
    };
    void logHistoryEvent({
      accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
      eventType: "entry_placed", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
      quantity: qty, repunchCountAtEvent: next[idx].repunchCount, orderId: result.order_id,
      note: "individual re-punch after non-first TP fill",
    });
    return true;
  } catch (err) {
    console.error(`[repunch] individual re-punch failed for slot ${slot.id}`, err);
    void logHistoryEvent({
      accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
      eventType: "entry_placed", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
      quantity: qty, repunchCountAtEvent: slot.repunchCount,
      note: `individual re-punch FAILED: ${(err as Error)?.message ?? "unknown error"}`,
    });
    return false;
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * PHASE 3 — teardown → rebuild, ONLY after first-order (rank 0) TP fill.
 *
 * CRITICAL RULES:
 * 1. We NEVER cancel reduce-only (TP) orders. We wait until they fill.
 * 2. We only cancel non-reduce-only entry limits.
 * 3. Rebuild runs only when every entry is clear AND every TP has filled
 *    AND live position size for symbol+side is zero.
 * ════════════════════════════════════════════════════════════════════════ */
async function progressBatchTeardown(
  acc: any,
  accountId: number,
  next: WatchedSlot[],
  batchId: string,
): Promise<boolean> {
  let changed = false;

  const legIds = next
    .filter((s) => s.batchId === batchId && s.status === "tearing_down" && !s.stopped)
    .map((s) => s.id);
  if (legIds.length === 0) return false;

  let allClear = true;

  for (const id of legIds) {
    let idx = next.findIndex((s) => s.id === id);
    if (idx === -1) continue;

    // ── Entry limit (non-reduce-only): allowed to cancel + verify ────────
    if (next[idx].orderId) {
      const orderId = next[idx].orderId!;
      const result = await cancelAndVerify(acc, orderId);
      idx = next.findIndex((s) => s.id === id);

      if (result.outcome === "filled") {
        // Filled during teardown — place protective TP and leave watching;
        // do NOT rebuild until that TP also fills and position is flat.
        const slot = next[idx];
        const filledQty = result.execQty > 0 ? result.execQty : slot.quantity;
        try {
          const tpResult = await placeOrderForAccount(acc, {
            symbol: slot.symbol, side: slot.side === "BUY" ? "SELL" : "BUY",
            order_type: "LIMIT", quantity: filledQty, price: slot.tpPrice, reduce_only: true,
          });
          next[idx] = {
            ...slot, status: "watching", orderId: undefined, seenOpen: false,
            tpOrderId: tpResult.order_id, tpSeenOpen: false, quantity: filledQty,
          };
          void logHistoryEvent({
            accountId, slotId: slot.id, batchId, symbol: slot.symbol, side: slot.side,
            eventType: "entry_filled", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
            quantity: filledQty, repunchCountAtEvent: slot.repunchCount, orderId: tpResult.order_id,
            note: "filled during teardown — protected with TP, rebuild deferred",
          });
        } catch (err) {
          console.error(`[repunch] teardown: failed to protect unexpected fill for slot ${slot.id}`, err);
          void logHistoryEvent({
            accountId, slotId: slot.id, batchId, symbol: slot.symbol, side: slot.side,
            eventType: "entry_filled", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
            quantity: filledQty, repunchCountAtEvent: slot.repunchCount,
            note: `FAILED to place protective TP after fill during teardown: ${(err as Error)?.message ?? "unknown error"} — retrying next tick`,
          });
        }
        changed = true;
        allClear = false;
        continue;
      }

      if (result.outcome === "unknown") { allClear = false; continue; }

      next[idx] = { ...next[idx], orderId: undefined };
      changed = true;
    }

    idx = next.findIndex((s) => s.id === id);
    if (idx === -1) continue;

    // ── TP (reduce-only): NEVER cancel. Wait until it fills on its own. ──
    if (next[idx].tpOrderId) {
      const tpOrderId = next[idx].tpOrderId!;
      // Only check status — do not call cancel.
      const { filled, execQty, status } = await checkAlreadyGoneOrder(acc, tpOrderId);
      idx = next.findIndex((s) => s.id === id);
      const slot = next[idx];

      if (filled) {
        next[idx] = { ...slot, tpOrderId: undefined, tpSeenOpen: false };
        changed = true;
        void logHistoryEvent({
          accountId, slotId: slot.id, batchId, symbol: slot.symbol, side: slot.side,
          eventType: "tp_filled", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
          quantity: execQty > 0 ? execQty : slot.quantity, repunchCountAtEvent: slot.repunchCount,
          orderId: tpOrderId, note: "TP filled naturally during teardown (never cancelled)",
        });
      } else if (status && (status.status === "OPEN" || status.status === "PARTIALLY_FILLED")) {
        // Still live on the book — we refuse to cancel; wait another tick.
        allClear = false;
      } else if (!status) {
        // Could not verify this tick — wait.
        allClear = false;
      } else {
        // CANCELLED / REJECTED with zero exec — treat as clear (rare if we never cancel).
        next[idx] = { ...slot, tpOrderId: undefined, tpSeenOpen: false };
        changed = true;
      }
    }
  }

  if (!allClear) return changed; // retry next tick — do not rebuild yet

  const anchorLeg = next.find((s) => s.batchId === batchId && s.status === "tearing_down" && !s.stopped);
  if (!anchorLeg) return changed;
  const expectedSide = anchorLeg.side === "BUY" ? "LONG" : "SHORT";
  const positionSize = await fetchPositionSize(accountId, anchorLeg.symbol, expectedSide);
  if (positionSize === null) return changed;
  if (positionSize > 1e-9) {
    console.warn(`[repunch] teardown: batch ${batchId} still shows an open position (${positionSize}) — waiting (reduce-only must fill first)`);
    return changed;
  }

  const markPrice = await fetchMarkPrice(acc, anchorLeg.symbol);
  if (markPrice == null) {
    console.warn(`[repunch] teardown: mark price unavailable for ${anchorLeg.symbol} — retrying rebuild next tick`);
    return changed;
  }

  const stepSize = anchorLeg.stepSize;
  if (!stepSize || stepSize <= 0) {
    console.error(`[repunch] teardown: batch ${batchId} has no stepSize — cannot rebuild, leaving batch cleared`);
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].batchId === batchId && next[i].status === "tearing_down") next.splice(i, 1);
    }
    return true;
  }

  const stepSizeIncrement = anchorLeg.stepSizeIncrement && anchorLeg.stepSizeIncrement > 0 ? anchorLeg.stepSizeIncrement : 1;
  const totalLegs = anchorLeg.totalLegs ?? next.filter((s) => s.batchId === batchId && s.status === "tearing_down").length;
  const baseQty = anchorLeg.baseQty ?? anchorLeg.quantity;
  const doubleQtyEnabled = !!anchorLeg.doubleQtyEnabled;
  const ladderResetEnabled = anchorLeg.ladderResetEnabled !== false;
  const tpOffset = Math.abs(anchorLeg.tpPrice - anchorLeg.limitPrice);

  const doomed = next.filter((s) => s.batchId === batchId && s.status === "tearing_down");
  for (const s of doomed) {
    void logHistoryEvent({
      accountId, slotId: s.id, batchId, symbol: s.symbol, side: s.side,
      eventType: "ladder_reset", limitPrice: s.limitPrice, tpPrice: s.tpPrice,
      quantity: s.quantity, repunchCountAtEvent: s.repunchCount,
      note: "batch confirmed flat — all reduce-only TPs filled; rebuilding after FIRST-order TP",
    });
  }
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].batchId === batchId && next[i].status === "tearing_down") next.splice(i, 1);
  }

  const rebuilt = await placeRebuiltLadder(
    acc, accountId, next, batchId,
    { symbol: anchorLeg.symbol, side: anchorLeg.side, stepSize, stepSizeIncrement, totalLegs, baseQty, doubleQtyEnabled, ladderResetEnabled, tpOffset },
    markPrice,
    "first-order TP fill teardown",
  );
  next.push(...rebuilt);

  return true;
}

/**
 * PHASE 0 — chase reset: price runs away while NOTHING in the batch has
 * filled yet. Never cancels reduce-only (there are none in this state).
 */
async function resetChainIfNeeded(
  acc: any,
  accountId: number,
  next: WatchedSlot[],
  batchId: string,
): Promise<boolean> {
  const batchLegs = next.filter((s) => s.batchId === batchId && !s.stopped);
  if (batchLegs.length === 0) return false;

  if (batchLegs.some((s) => s.status === "watching" || s.status === "tearing_down")) return false;

  const ladderCfg = getBatchLadderConfig(next, batchId);
  if (!ladderCfg || !ladderCfg.ladderResetEnabled || ladderCfg.stepSizeIncrement <= 1) return false;

  const anchor = batchLegs[0];
  const threshold = ladderCfg.stepSize * ladderCfg.stepSizeIncrement;

  const markPrice = await fetchMarkPrice(acc, anchor.symbol);
  if (markPrice == null) return false;

  const topmostLeg = batchLegs.reduce((top, s) =>
    anchor.side === "BUY"
      ? (s.limitPrice > top.limitPrice ? s : top)
      : (s.limitPrice < top.limitPrice ? s : top),
  );

  const gap = anchor.side === "BUY"
    ? markPrice - topmostLeg.limitPrice
    : topmostLeg.limitPrice - markPrice;

  if (gap <= threshold) return false;

  const batchCfg = getBatchQtyConfig(next, batchId);
  const totalLegs = batchCfg?.totalLegs ?? batchLegs.length;
  const baseQty = batchCfg?.baseQty ?? topmostLeg.quantity;
  const doubleQtyEnabled = batchCfg?.doubleQtyEnabled ?? false;
  const tpOffset = Math.abs(anchor.tpPrice - anchor.limitPrice);

  console.warn(
    `[repunch] chase reset for batch ${batchId}: gap ${gap.toFixed(4)} > threshold ${threshold.toFixed(4)} (mark ${markPrice}, old top ${topmostLeg.limitPrice})`,
  );

  let anyUnclear = false;
  for (const s of batchLegs) {
    if (s.status !== "pending_fill" || !s.orderId) continue;
    const result = await cancelAndVerify(acc, s.orderId);
    if (result.outcome === "filled") {
      const idx = next.findIndex((x) => x.id === s.id);
      if (idx !== -1) {
        try {
          const tpResult = await placeOrderForAccount(acc, {
            symbol: s.symbol, side: s.side === "BUY" ? "SELL" : "BUY",
            order_type: "LIMIT", quantity: result.execQty > 0 ? result.execQty : s.quantity,
            price: s.tpPrice, reduce_only: true,
          });
          next[idx] = {
            ...s, status: "watching", orderId: undefined, seenOpen: false,
            tpOrderId: tpResult.order_id, tpSeenOpen: false,
            quantity: result.execQty > 0 ? result.execQty : s.quantity,
          };
          void logHistoryEvent({
            accountId, slotId: s.id, batchId, symbol: s.symbol, side: s.side,
            eventType: "entry_filled", limitPrice: s.limitPrice, tpPrice: s.tpPrice,
            quantity: result.execQty > 0 ? result.execQty : s.quantity, repunchCountAtEvent: s.repunchCount,
            orderId: tpResult.order_id, note: "filled during chase reset — protected with TP, reset aborted",
          });
        } catch (err) {
          console.error(`[repunch] chase reset: failed to protect unexpected fill for slot ${s.id}`, err);
        }
      }
      return true;
    }
    if (result.outcome === "unknown") anyUnclear = true;
  }
  if (anyUnclear) {
    console.warn(`[repunch] chase reset for batch ${batchId}: one or more cancels unconfirmed — retrying next tick`);
    return false;
  }

  for (const s of batchLegs) {
    void logHistoryEvent({
      accountId, slotId: s.id, batchId, symbol: s.symbol, side: s.side,
      eventType: "ladder_reset", limitPrice: s.limitPrice, tpPrice: s.tpPrice,
      quantity: s.quantity, repunchCountAtEvent: s.repunchCount,
      note: `chain reset — market ran to ${markPrice}, gap ${gap.toFixed(4)} exceeded threshold ${threshold.toFixed(4)}`,
    });
  }
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].batchId === batchId && !next[i].stopped) next.splice(i, 1);
  }

  const rebuilt = await placeRebuiltLadder(
    acc, accountId, next, batchId,
    { symbol: anchor.symbol, side: anchor.side, stepSize: ladderCfg.stepSize, stepSizeIncrement: ladderCfg.stepSizeIncrement, totalLegs, baseQty, doubleQtyEnabled, ladderResetEnabled: ladderCfg.ladderResetEnabled, tpOffset },
    markPrice,
    "chase reset",
  );
  next.push(...rebuilt);

  return true;
}

const DEDUP_WINDOW_MS = 10_000;

async function dedupeSimultaneousBatches(
  acc: any,
  accountId: number,
  next: WatchedSlot[],
): Promise<boolean> {
  let changed = false;

  const batchesBySymbolSide = new Map<string, { batchId: string; createdAt: number }[]>();
  for (const s of next) {
    if (!s.batchId || s.stopped) continue;
    const createdAt = Number(s.batchId.split("-").pop());
    if (!createdAt || isNaN(createdAt)) continue;
    const key = `${s.symbol}-${s.side}`;
    const arr = batchesBySymbolSide.get(key) ?? [];
    if (!arr.some((b) => b.batchId === s.batchId)) arr.push({ batchId: s.batchId, createdAt });
    batchesBySymbolSide.set(key, arr);
  }

  for (const [, batches] of batchesBySymbolSide) {
    if (batches.length < 2) continue;
    batches.sort((a, b) => a.createdAt - b.createdAt);

    for (let i = 1; i < batches.length; i++) {
      if (batches[i].createdAt - batches[i - 1].createdAt >= DEDUP_WINDOW_MS) continue;

      const dupBatchId = batches[i].batchId;
      for (const s of next) {
        if (s.batchId !== dupBatchId || s.stopped) continue;

        let dedupCancelOk = true;
        // Only cancel entry limits — never cancel reduce-only TP.
        if (s.orderId) {
          try { await cancelOrderForAccount(acc, s.orderId); }
          catch (err) { console.error(`[repunch] dedup: cancel entry failed for slot ${s.id}`, err); dedupCancelOk = false; }
        }
        // Do NOT cancel s.tpOrderId (reduce-only). Leave it; mark stopped so engine ignores further actions.
        if (!dedupCancelOk) continue;

        s.stopped = true;
        changed = true;

        void logHistoryEvent({
          accountId, slotId: s.id, batchId: s.batchId, symbol: s.symbol, side: s.side,
          eventType: "trimmed", limitPrice: s.limitPrice, tpPrice: s.tpPrice, quantity: s.quantity,
          repunchCountAtEvent: s.repunchCount, orderId: s.orderId ?? s.tpOrderId,
          note: `duplicate batch auto-stopped — created ${batches[i].createdAt - batches[i - 1].createdAt}ms after ${batches[i - 1].batchId}`,
        });
      }

      console.warn(`[repunch] dedup: stopped duplicate batch ${dupBatchId} (too close to ${batches[i - 1].batchId})`);
    }
  }

  return changed;
}

async function tickForAccount(row: SettingsRow) {
  const { settingsId, accountId } = row;
  const next = [...row.slots];
  let changed = false;

  const acc = await getAccount(accountId);
  if (!acc) return;

  // ── PHASE -1: duplicate-batch safety net ────────────────────────────────
  const dedupChanged = await dedupeSimultaneousBatches(acc, accountId, next);
  if (dedupChanged) changed = true;

  // ── PHASE 0: chase reset ────────────────────────────────────────────────
  const chaseBatchIds = new Set(
    next.filter((s) => !s.stopped && s.batchId).map((s) => s.batchId as string),
  );
  for (const batchId of chaseBatchIds) {
    const resetHappened = await resetChainIfNeeded(acc, accountId, next, batchId);
    if (resetHappened) changed = true;
  }

  const needsOrders = next.some((s) => s.status === "pending_fill" || s.status === "watching" || s.status === "tearing_down");
  const openIds = needsOrders ? await fetchOpenOrderIds(accountId) : null;

  const activatedThisTick = new Set<string>();
  const positionSizeCache = new Map<string, number | null>();
  const accountedQty = new Map<string, number>();
  const EPS = 1e-6;

  for (const s of next) {
    if (s.stopped) continue;
    if (s.status === "watching") {
      const key = `${s.symbol}-${s.side === "BUY" ? "LONG" : "SHORT"}`;
      accountedQty.set(key, (accountedQty.get(key) ?? 0) + s.quantity);
    }
  }

  // ── PHASE 1: entry limit filled → place TP ──────────────────────────────
  // Prefer getOrderStatus when the order left the open book (fast + accurate
  // for rapid markets). Fall back to position-size accounting if status API fails.
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

    // Order is off the book — confirm fill via status API first (handles fast markets).
    const { filled: statusFilled, execQty } = await checkAlreadyGoneOrder(acc, slot.orderId);

    let confirmedFill = statusFilled;
    let fillQty = execQty > 0 ? execQty : slot.quantity;

    if (!confirmedFill) {
      // Status said not filled (cancelled/rejected) or unavailable — double-check via position.
      const expectedSide = slot.side === "BUY" ? "LONG" : "SHORT";
      const key = `${slot.symbol}-${expectedSide}`;
      if (!positionSizeCache.has(key)) {
        positionSizeCache.set(key, await fetchPositionSize(accountId, slot.symbol, expectedSide));
      }
      const positionSize = positionSizeCache.get(key) ?? null;
      if (positionSize === null) continue;

      const already = accountedQty.get(key) ?? 0;
      const remaining = positionSize - already;
      if (remaining >= slot.quantity - EPS) {
        confirmedFill = true;
        fillQty = slot.quantity;
      } else {
        void logHistoryEvent({
          accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
          eventType: "trimmed", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice, quantity: slot.quantity,
          repunchCountAtEvent: slot.repunchCount, orderId: slot.orderId,
          note: `cancelled/rejected on exchange (order disappeared without a fill — live position ${positionSize}, already accounted ${already})`,
        });
        next.splice(i, 1); i--; changed = true;
        continue;
      }
    }

    const expectedSide = slot.side === "BUY" ? "LONG" : "SHORT";
    const key = `${slot.symbol}-${expectedSide}`;
    const already = accountedQty.get(key) ?? 0;
    accountedQty.set(key, already + fillQty);

    try {
      const result = await placeOrderForAccount(acc, {
        symbol: slot.symbol, side: slot.side === "BUY" ? "SELL" : "BUY", order_type: "LIMIT",
        quantity: fillQty, price: slot.tpPrice, reduce_only: true,
      });
      next[i] = {
        ...slot,
        status: "watching",
        tpOrderId: result.order_id,
        tpSeenOpen: false,
        orderId: undefined,
        seenOpen: false,
        quantity: fillQty,
      };
      changed = true;

      void logHistoryEvent({
        accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
        eventType: "entry_filled", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice, quantity: fillQty,
        repunchCountAtEvent: slot.repunchCount, orderId: result.order_id,
      });

      if (slot.batchId) {
        const activatedId = await activateNextQueued(acc, accountId, next, slot.batchId);
        if (activatedId) { changed = true; activatedThisTick.add(activatedId); }
      }
    } catch (err) {
      console.error(`[repunch] failed to place TP for slot ${slot.id} (account ${accountId})`, err);
      accountedQty.set(key, already);
    }
  }

  // ── PHASE 2: TP exit filled ─────────────────────────────────────────────
  // ONLY the first order (rank === 0) may trigger full batch teardown.
  // Non-first legs get an individual re-punch only.
  // Reduce-only TPs are never cancelled here — we only react when they leave the book.
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

    const { filled: reallyFilled, execQty } = await checkAlreadyGoneOrder(acc, slot.tpOrderId);

    if (!reallyFilled) {
      // Disappeared without fill — re-place TP to avoid naked position. Never leave unprotected.
      console.warn(`[repunch] TP for slot ${slot.id} disappeared without filling — re-placing`);
      try {
        const result = await placeOrderForAccount(acc, {
          symbol: slot.symbol, side: slot.side === "BUY" ? "SELL" : "BUY", order_type: "LIMIT",
          quantity: slot.quantity, price: slot.tpPrice, reduce_only: true,
        });
        next[i] = { ...slot, tpOrderId: result.order_id, tpSeenOpen: false };
        changed = true;
        void logHistoryEvent({
          accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
          eventType: "entry_filled", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice, quantity: slot.quantity,
          repunchCountAtEvent: slot.repunchCount, orderId: result.order_id,
          note: "TP re-placed after disappearing without a fill",
        });
      } catch (err) {
        console.error(`[repunch] failed to re-place TP for slot ${slot.id}`, err);
      }
      continue;
    }

    void logHistoryEvent({
      accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
      eventType: "tp_filled", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
      quantity: execQty > 0 ? execQty : slot.quantity, repunchCountAtEvent: slot.repunchCount, orderId: slot.tpOrderId,
    });

    // ── First order (rank 0) → full batch teardown at rebuild point ──────
    // Only when ladder reset is enabled for this batch; otherwise fall
    // through to the individual re-punch branch below like any other leg.
    if (isFirstOrder(slot) && slot.batchId && slot.ladderResetEnabled !== false) {
      const batchId = slot.batchId;
      const alreadyTearing = next.some((s) => s.batchId === batchId && s.status === "tearing_down");
      if (!alreadyTearing) {
        for (let j = 0; j < next.length; j++) {
          if (next[j].batchId === batchId && !next[j].stopped) {
            next[j] = { ...next[j], status: "tearing_down" };
          }
        }
        changed = true;
        await saveSlots(settingsId, next);
        void logHistoryEvent({
          accountId, slotId: slot.id, batchId, symbol: slot.symbol, side: slot.side,
          eventType: "ladder_reset", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
          quantity: slot.quantity, repunchCountAtEvent: slot.repunchCount,
          note: "FIRST-order TP filled — tearing down batch for rebuild at rebuild point (reduce-only TPs will NOT be cancelled)",
        });
      }
    } else {
      // ── Non-first leg → individual re-punch only (no batch cancel) ─────
      const did = await individualRepunch(acc, accountId, next, i);
      if (did) changed = true;
    }
  }

  // ── PHASE 3: progress any batch currently tearing down ──────────────────
  const tearingBatchIds = new Set(
    next.filter((s) => s.status === "tearing_down" && !s.stopped && s.batchId).map((s) => s.batchId as string),
  );
  for (const batchId of tearingBatchIds) {
    const progressed = await progressBatchTeardown(acc, accountId, next, batchId);
    if (progressed) changed = true;
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













// import { db, settingsTable, accountsTable } from "@workspace/db";
// import { eq } from "drizzle-orm";
// import {
//   callCoinswitch,
//   placeOrderForAccount,
//   cancelOrderForAccount,
//   getOrderStatusForAccount,
//   type OrderStatus,
// } from "../lib/coinswitchApi.js";
// import { decrypt } from "../lib/crypto.js";
// import { logHistoryEvent } from "../lib/history.js";

// export interface WatchedSlot {
//   id: string;
//   symbol: string;
//   side: "BUY" | "SELL";
//   limitPrice: number;
//   tpPrice: number;
//   quantity: number;
//   repunchCount: number;
//   // "tearing_down": batch is being cancelled + verified flat ahead of a full
//   // rebuild. Durable/persisted checkpoint state — see progressBatchTeardown.
//   status: "pending_fill" | "placing_tp" | "watching" | "repunching" | "tearing_down";
//   orderId?: string;
//   seenOpen?: boolean;
//   tpOrderId?: string;
//   tpSeenOpen?: boolean;
//   stopped?: boolean;
//   batchId?: string;
//   stepSize?: number;
//   doubleQtyEnabled?: boolean;
//   baseQty?: number;
//   totalLegs?: number;
//   // Multiplier (1–100) on stepSize — how far price is allowed to run away
//   // from the topmost tracked leg (chase case), or how far the rebuild
//   // anchor sits from mark price (TP-fill teardown case), before/when the
//   // ladder gets rebuilt.
//   stepSizeIncrement?: number;
//   // Rank 0 = entry / first order. Only rank-0 TP fill may trigger a full
//   // batch rebuild. Other ranks do an individual re-punch of that leg only.
//   rank?: number;
// }

// // Mirrors CONCURRENT_LIMIT in place-order.tsx — how many ladder legs stay
// // live/resting at once; the rest sit queued. Kept in sync manually since
// // the frontend and engine don't share a constants file.
// const CONCURRENT_LIMIT = 2;

// /**
//  * Every limit/TP price here is derived via float add/subtract (entry ±
//  * stepSize, limit ± tpOffset). With small step sizes (e.g. 0.01) that
//  * arithmetic routinely lands on 64.80999999999999 instead of 64.81, which
//  * then fails a strict `===` collision check against a sibling leg — and a
//  * duplicate leg gets created at what looks like the same price. Every
//  * computed price is rounded through this before being stored or compared.
//  */
// function roundPrice(value: number): number {
//   return Math.round(value * 1e8) / 1e8;
// }

// function computeQtyForRank(
//   next: WatchedSlot[],
//   batchId: string,
//   side: "BUY" | "SELL",
//   targetPrice: number,
//   doubleQtyEnabled: boolean | undefined,
//   baseQty: number,
//   totalLegs: number,
//   rankBoost = 0,
// ): number {
//   if (!doubleQtyEnabled) return baseQty;
//   if (!totalLegs || totalLegs <= 0) return baseQty;

//   const prices = next
//     .filter((s) => s.batchId === batchId && !s.stopped)
//     .map((s) => s.limitPrice);
//   if (!prices.includes(targetPrice)) prices.push(targetPrice);

//   const sorted = side === "BUY"
//     ? prices.sort((a, b) => b - a)
//     : prices.sort((a, b) => a - b);

//   const idx = sorted.indexOf(targetPrice) + rankBoost;
//   const baseCount = Math.ceil(totalLegs / 2);
//   return idx < baseCount ? baseQty : baseQty * 2;
// }

// function getBatchQtyConfig(
//   next: WatchedSlot[],
//   batchId: string,
// ): { doubleQtyEnabled: boolean; baseQty: number; totalLegs: number } | null {
//   for (const s of next) {
//     if (s.batchId === batchId && !s.stopped && s.totalLegs && s.baseQty != null) {
//       return { doubleQtyEnabled: !!s.doubleQtyEnabled, baseQty: s.baseQty, totalLegs: s.totalLegs };
//     }
//   }
//   return null;
// }

// /**
//  * Pulls stepSize/stepSizeIncrement from ANY sibling leg in the batch —
//  * a single leg losing its stamp shouldn't take down the whole batch's
//  * rebuild behavior.
//  */
// function getBatchLadderConfig(
//   next: WatchedSlot[],
//   batchId: string,
// ): { stepSize: number; stepSizeIncrement: number } | null {
//   for (const s of next) {
//     if (s.batchId === batchId && !s.stopped && s.stepSize) {
//       return { stepSize: s.stepSize, stepSizeIncrement: s.stepSizeIncrement && s.stepSizeIncrement > 0 ? s.stepSizeIncrement : 1 };
//     }
//   }
//   return null;
// }

// /** True only for the entry / first order (rank 0). Missing rank is treated as non-first. */
// function isFirstOrder(slot: WatchedSlot): boolean {
//   return slot.rank === 0;
// }

// // Faster polling so rapid fill → TP is caught before the UI sticks on "Trade".
// const POLL_INTERVAL_MS = 2_000;
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

// async function fetchPositionSize(accountId: number, symbol: string, expectedSide: "LONG" | "SHORT"): Promise<number | null> {
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
//     const pos = positions.find((p: any) => p.position_side === expectedSide);
//     if (!pos) return 0;
//     const size = parseFloat(String((pos as any).position_size ?? 0));
//     return isNaN(size) ? 0 : Math.abs(size);
//   } catch (err) {
//     console.error(`[repunch] fetchPositionSize failed for account ${accountId}`, err);
//     return null;
//   }
// }

// /**
//  * Live last-traded price for a symbol. Returns null on failure so callers
//  * skip the check for this tick rather than crash the whole tick.
//  */
// async function fetchMarkPrice(acc: any, symbol: string): Promise<number | null> {
//   try {
//     const apiKey = decrypt(acc.apiKey);
//     const secretKey = decrypt(acc.secretKey);
//     const data = (await callCoinswitch("GET", "/trade/api/v2/futures/ticker", apiKey, secretKey, {
//       exchange: "EXCHANGE_2",
//       symbol,
//     })) as { data: Record<string, Record<string, unknown>> };
//     const ticker = data?.data?.["EXCHANGE_2"];
//     const raw = ticker?.last_price ?? ticker?.mark_price;
//     const price = raw != null ? parseFloat(String(raw)) : NaN;
//     return isNaN(price) ? null : price;
//   } catch (err) {
//     console.error(`[repunch] fetchMarkPrice failed for ${symbol}`, err);
//     return null;
//   }
// }

// async function activateNextQueued(acc: any, accountId: number, next: WatchedSlot[], batchId: string): Promise<string | null> {
//   const idx = next.findIndex((s) => s.batchId === batchId && s.status === "pending_fill" && !s.orderId && !s.stopped);
//   if (idx === -1) return null;
//   const slot = next[idx];
//   const batchCfg = getBatchQtyConfig(next, batchId);
//   const qty = batchCfg
//     ? computeQtyForRank(next, batchId, slot.side, slot.limitPrice, batchCfg.doubleQtyEnabled, batchCfg.baseQty, batchCfg.totalLegs)
//     : slot.quantity;
//   try {
//     const result = await placeOrderForAccount(acc, {
//       symbol: slot.symbol,
//       side: slot.side,
//       order_type: "LIMIT",
//       quantity: qty,
//       price: slot.limitPrice,
//     });
//     next[idx] = { ...slot, status: "pending_fill", orderId: result.order_id, seenOpen: false, quantity: qty };

//     void logHistoryEvent({
//       accountId, slotId: slot.id, batchId, symbol: slot.symbol, side: slot.side,
//       eventType: "queued_activated", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
//       quantity: qty, repunchCountAtEvent: slot.repunchCount, orderId: result.order_id,
//     });

//     return slot.id;
//   } catch (err) {
//     console.error(`[repunch] failed to activate queued slot ${slot.id}`, err);
//     void logHistoryEvent({
//       accountId, slotId: slot.id, batchId, symbol: slot.symbol, side: slot.side,
//       eventType: "queued_activated", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
//       quantity: qty, repunchCountAtEvent: slot.repunchCount,
//       note: `FAILED: ${(err as Error)?.message ?? "unknown error"}`,
//     });
//     return null;
//   }
// }

// /* ════════════════════════════════════════════════════════════════════════
//  * Cancel + fill verification helpers.
//  * ════════════════════════════════════════════════════════════════════════ */

// interface CancelVerifyResult {
//   outcome: "clear" | "filled" | "unknown";
//   execQty: number;
//   status: OrderStatus | null;
// }

// /**
//  * Attempts to cancel `orderId`, then ALWAYS re-verifies via order status.
//  * Used only for non-reduce-only entry limits — never for TP (reduce-only).
//  */
// async function cancelAndVerify(acc: any, orderId: string): Promise<CancelVerifyResult> {
//   try {
//     await cancelOrderForAccount(acc, orderId);
//   } catch {
//     // Ignore — could be already gone. Verified below.
//   }
//   const status = await getOrderStatusForAccount(acc, orderId);
//   if (!status) return { outcome: "unknown", execQty: 0, status: null };

//   const execQty = parseFloat(status.exec_quantity || "0");
//   if (!isNaN(execQty) && execQty > 1e-9) {
//     return { outcome: "filled", execQty, status };
//   }
//   if (status.status === "OPEN" || status.status === "PARTIALLY_FILLED") {
//     return { outcome: "unknown", execQty: 0, status };
//   }
//   return { outcome: "clear", execQty: 0, status };
// }

// /**
//  * Ground-truth check for an order that already left the open-orders book.
//  * Distinguishes real fill vs cancelled/rejected with no fill.
//  */
// async function checkAlreadyGoneOrder(acc: any, orderId: string): Promise<{ filled: boolean; execQty: number; status: OrderStatus | null }> {
//   const status = await getOrderStatusForAccount(acc, orderId);
//   if (!status) return { filled: false, execQty: 0, status: null };
//   const execQty = parseFloat(status.exec_quantity || "0");
//   return { filled: !isNaN(execQty) && execQty > 1e-9, execQty: isNaN(execQty) ? 0 : execQty, status };
// }

// /* ════════════════════════════════════════════════════════════════════════
//  * Shared rebuild core
//  * ════════════════════════════════════════════════════════════════════════ */

// interface LadderAnchorConfig {
//   symbol: string;
//   side: "BUY" | "SELL";
//   stepSize: number;
//   stepSizeIncrement: number;
//   totalLegs: number;
//   baseQty: number;
//   doubleQtyEnabled: boolean;
//   tpOffset: number;
// }

// /**
//  * Places a fresh ladder of `cfg.totalLegs` legs anchored at
//  * (markPrice ∓ stepSize*stepSizeIncrement). Rank 0 is stamped as first order.
//  */
// async function placeRebuiltLadder(
//   acc: any,
//   accountId: number,
//   next: WatchedSlot[],
//   batchId: string,
//   cfg: LadderAnchorConfig,
//   markPrice: number,
//   eventNote: string,
// ): Promise<WatchedSlot[]> {
//   const dir = cfg.side === "BUY" ? 1 : -1;
//   const threshold = cfg.stepSize * cfg.stepSizeIncrement;
//   const newTop = roundPrice(markPrice - dir * threshold);

//   console.warn(
//     `[repunch] rebuilding batch ${batchId}: anchor ${newTop} (mark ${markPrice}, threshold ${threshold.toFixed(8)}) — ${eventNote}`,
//   );

//   const rebuilt: WatchedSlot[] = [];

//   for (let rank = 0; rank < cfg.totalLegs; rank++) {
//     const legPrice = roundPrice(newTop - dir * cfg.stepSize * rank);
//     const legTp = roundPrice(legPrice + dir * cfg.tpOffset);
//     const qty = computeQtyForRank(
//       [...next, ...rebuilt], batchId, cfg.side, legPrice, cfg.doubleQtyEnabled, cfg.baseQty, cfg.totalLegs,
//     );
//     const legId = `${cfg.symbol}-${cfg.side}-${legPrice}-${Date.now()}-rebuild${rank}`;

//     if (rank < CONCURRENT_LIMIT) {
//       try {
//         const result = await placeOrderForAccount(acc, {
//           symbol: cfg.symbol, side: cfg.side, order_type: "LIMIT", quantity: qty, price: legPrice,
//         });
//         rebuilt.push({
//           id: legId, symbol: cfg.symbol, side: cfg.side, limitPrice: legPrice, tpPrice: legTp,
//           quantity: qty, repunchCount: 0, status: "pending_fill", orderId: result.order_id, seenOpen: false,
//           batchId, stepSize: cfg.stepSize, stepSizeIncrement: cfg.stepSizeIncrement,
//           doubleQtyEnabled: cfg.doubleQtyEnabled, baseQty: cfg.baseQty, totalLegs: cfg.totalLegs,
//           rank,
//         });
//         void logHistoryEvent({
//           accountId, slotId: legId, batchId, symbol: cfg.symbol, side: cfg.side,
//           eventType: "entry_placed", limitPrice: legPrice, tpPrice: legTp, quantity: qty,
//           repunchCountAtEvent: 0, orderId: result.order_id, note: `placed by rebuild — ${eventNote}`,
//         });
//       } catch (err) {
//         console.error(`[repunch] rebuild: failed to place live leg at ${legPrice} (rank ${rank})`, err);
//         rebuilt.push({
//           id: legId, symbol: cfg.symbol, side: cfg.side, limitPrice: legPrice, tpPrice: legTp,
//           quantity: qty, repunchCount: 0, status: "pending_fill", batchId,
//           stepSize: cfg.stepSize, stepSizeIncrement: cfg.stepSizeIncrement,
//           doubleQtyEnabled: cfg.doubleQtyEnabled, baseQty: cfg.baseQty, totalLegs: cfg.totalLegs,
//           rank,
//         });
//         void logHistoryEvent({
//           accountId, slotId: legId, batchId, symbol: cfg.symbol, side: cfg.side,
//           eventType: "queued", limitPrice: legPrice, tpPrice: legTp, quantity: qty,
//           repunchCountAtEvent: 0, note: `rebuild: live placement FAILED, queued instead — ${(err as Error)?.message ?? "unknown error"}`,
//         });
//       }
//     } else {
//       rebuilt.push({
//         id: legId, symbol: cfg.symbol, side: cfg.side, limitPrice: legPrice, tpPrice: legTp,
//         quantity: qty, repunchCount: 0, status: "pending_fill", batchId,
//         stepSize: cfg.stepSize, stepSizeIncrement: cfg.stepSizeIncrement,
//         doubleQtyEnabled: cfg.doubleQtyEnabled, baseQty: cfg.baseQty, totalLegs: cfg.totalLegs,
//         rank,
//       });
//       void logHistoryEvent({
//         accountId, slotId: legId, batchId, symbol: cfg.symbol, side: cfg.side,
//         eventType: "queued", limitPrice: legPrice, tpPrice: legTp, quantity: qty,
//         repunchCountAtEvent: 0, note: `queued by rebuild — ${eventNote}`,
//       });
//     }
//   }

//   return rebuilt;
// }

// /**
//  * Individual re-punch for a non-first leg: TP filled → place the same limit
//  * again at the same price. Does NOT touch any sibling leg or reduce-only order.
//  */
// async function individualRepunch(
//   acc: any,
//   accountId: number,
//   next: WatchedSlot[],
//   idx: number,
// ): Promise<boolean> {
//   const slot = next[idx];
//   if (!slot || slot.stopped) return false;

//   const qty = slot.quantity;
//   try {
//     const result = await placeOrderForAccount(acc, {
//       symbol: slot.symbol,
//       side: slot.side,
//       order_type: "LIMIT",
//       quantity: qty,
//       price: slot.limitPrice,
//     });
//     next[idx] = {
//       ...slot,
//       status: "pending_fill",
//       orderId: result.order_id,
//       seenOpen: false,
//       tpOrderId: undefined,
//       tpSeenOpen: false,
//       repunchCount: (slot.repunchCount ?? 0) + 1,
//     };
//     void logHistoryEvent({
//       accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
//       eventType: "entry_placed", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
//       quantity: qty, repunchCountAtEvent: next[idx].repunchCount, orderId: result.order_id,
//       note: "individual re-punch after non-first TP fill",
//     });
//     return true;
//   } catch (err) {
//     console.error(`[repunch] individual re-punch failed for slot ${slot.id}`, err);
//     void logHistoryEvent({
//       accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
//       eventType: "entry_placed", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
//       quantity: qty, repunchCountAtEvent: slot.repunchCount,
//       note: `individual re-punch FAILED: ${(err as Error)?.message ?? "unknown error"}`,
//     });
//     return false;
//   }
// }

// /* ════════════════════════════════════════════════════════════════════════
//  * PHASE 3 — teardown → rebuild, ONLY after first-order (rank 0) TP fill.
//  *
//  * CRITICAL RULES:
//  * 1. We NEVER cancel reduce-only (TP) orders. We wait until they fill.
//  * 2. We only cancel non-reduce-only entry limits.
//  * 3. Rebuild runs only when every entry is clear AND every TP has filled
//  *    AND live position size for symbol+side is zero.
//  * ════════════════════════════════════════════════════════════════════════ */
// async function progressBatchTeardown(
//   acc: any,
//   accountId: number,
//   next: WatchedSlot[],
//   batchId: string,
// ): Promise<boolean> {
//   let changed = false;

//   const legIds = next
//     .filter((s) => s.batchId === batchId && s.status === "tearing_down" && !s.stopped)
//     .map((s) => s.id);
//   if (legIds.length === 0) return false;

//   let allClear = true;

//   for (const id of legIds) {
//     let idx = next.findIndex((s) => s.id === id);
//     if (idx === -1) continue;

//     // ── Entry limit (non-reduce-only): allowed to cancel + verify ────────
//     if (next[idx].orderId) {
//       const orderId = next[idx].orderId!;
//       const result = await cancelAndVerify(acc, orderId);
//       idx = next.findIndex((s) => s.id === id);

//       if (result.outcome === "filled") {
//         // Filled during teardown — place protective TP and leave watching;
//         // do NOT rebuild until that TP also fills and position is flat.
//         const slot = next[idx];
//         const filledQty = result.execQty > 0 ? result.execQty : slot.quantity;
//         try {
//           const tpResult = await placeOrderForAccount(acc, {
//             symbol: slot.symbol, side: slot.side === "BUY" ? "SELL" : "BUY",
//             order_type: "LIMIT", quantity: filledQty, price: slot.tpPrice, reduce_only: true,
//           });
//           next[idx] = {
//             ...slot, status: "watching", orderId: undefined, seenOpen: false,
//             tpOrderId: tpResult.order_id, tpSeenOpen: false, quantity: filledQty,
//           };
//           void logHistoryEvent({
//             accountId, slotId: slot.id, batchId, symbol: slot.symbol, side: slot.side,
//             eventType: "entry_filled", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
//             quantity: filledQty, repunchCountAtEvent: slot.repunchCount, orderId: tpResult.order_id,
//             note: "filled during teardown — protected with TP, rebuild deferred",
//           });
//         } catch (err) {
//           console.error(`[repunch] teardown: failed to protect unexpected fill for slot ${slot.id}`, err);
//           void logHistoryEvent({
//             accountId, slotId: slot.id, batchId, symbol: slot.symbol, side: slot.side,
//             eventType: "entry_filled", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
//             quantity: filledQty, repunchCountAtEvent: slot.repunchCount,
//             note: `FAILED to place protective TP after fill during teardown: ${(err as Error)?.message ?? "unknown error"} — retrying next tick`,
//           });
//         }
//         changed = true;
//         allClear = false;
//         continue;
//       }

//       if (result.outcome === "unknown") { allClear = false; continue; }

//       next[idx] = { ...next[idx], orderId: undefined };
//       changed = true;
//     }

//     idx = next.findIndex((s) => s.id === id);
//     if (idx === -1) continue;

//     // ── TP (reduce-only): NEVER cancel. Wait until it fills on its own. ──
//     if (next[idx].tpOrderId) {
//       const tpOrderId = next[idx].tpOrderId!;
//       // Only check status — do not call cancel.
//       const { filled, execQty, status } = await checkAlreadyGoneOrder(acc, tpOrderId);
//       idx = next.findIndex((s) => s.id === id);
//       const slot = next[idx];

//       if (filled) {
//         next[idx] = { ...slot, tpOrderId: undefined, tpSeenOpen: false };
//         changed = true;
//         void logHistoryEvent({
//           accountId, slotId: slot.id, batchId, symbol: slot.symbol, side: slot.side,
//           eventType: "tp_filled", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
//           quantity: execQty > 0 ? execQty : slot.quantity, repunchCountAtEvent: slot.repunchCount,
//           orderId: tpOrderId, note: "TP filled naturally during teardown (never cancelled)",
//         });
//       } else if (status && (status.status === "OPEN" || status.status === "PARTIALLY_FILLED")) {
//         // Still live on the book — we refuse to cancel; wait another tick.
//         allClear = false;
//       } else if (!status) {
//         // Could not verify this tick — wait.
//         allClear = false;
//       } else {
//         // CANCELLED / REJECTED with zero exec — treat as clear (rare if we never cancel).
//         next[idx] = { ...slot, tpOrderId: undefined, tpSeenOpen: false };
//         changed = true;
//       }
//     }
//   }

//   if (!allClear) return changed; // retry next tick — do not rebuild yet

//   const anchorLeg = next.find((s) => s.batchId === batchId && s.status === "tearing_down" && !s.stopped);
//   if (!anchorLeg) return changed;
//   const expectedSide = anchorLeg.side === "BUY" ? "LONG" : "SHORT";
//   const positionSize = await fetchPositionSize(accountId, anchorLeg.symbol, expectedSide);
//   if (positionSize === null) return changed;
//   if (positionSize > 1e-9) {
//     console.warn(`[repunch] teardown: batch ${batchId} still shows an open position (${positionSize}) — waiting (reduce-only must fill first)`);
//     return changed;
//   }

//   const markPrice = await fetchMarkPrice(acc, anchorLeg.symbol);
//   if (markPrice == null) {
//     console.warn(`[repunch] teardown: mark price unavailable for ${anchorLeg.symbol} — retrying rebuild next tick`);
//     return changed;
//   }

//   const stepSize = anchorLeg.stepSize;
//   if (!stepSize || stepSize <= 0) {
//     console.error(`[repunch] teardown: batch ${batchId} has no stepSize — cannot rebuild, leaving batch cleared`);
//     for (let i = next.length - 1; i >= 0; i--) {
//       if (next[i].batchId === batchId && next[i].status === "tearing_down") next.splice(i, 1);
//     }
//     return true;
//   }

//   const stepSizeIncrement = anchorLeg.stepSizeIncrement && anchorLeg.stepSizeIncrement > 0 ? anchorLeg.stepSizeIncrement : 1;
//   const totalLegs = anchorLeg.totalLegs ?? next.filter((s) => s.batchId === batchId && s.status === "tearing_down").length;
//   const baseQty = anchorLeg.baseQty ?? anchorLeg.quantity;
//   const doubleQtyEnabled = !!anchorLeg.doubleQtyEnabled;
//   const tpOffset = Math.abs(anchorLeg.tpPrice - anchorLeg.limitPrice);

//   const doomed = next.filter((s) => s.batchId === batchId && s.status === "tearing_down");
//   for (const s of doomed) {
//     void logHistoryEvent({
//       accountId, slotId: s.id, batchId, symbol: s.symbol, side: s.side,
//       eventType: "ladder_reset", limitPrice: s.limitPrice, tpPrice: s.tpPrice,
//       quantity: s.quantity, repunchCountAtEvent: s.repunchCount,
//       note: "batch confirmed flat — all reduce-only TPs filled; rebuilding after FIRST-order TP",
//     });
//   }
//   for (let i = next.length - 1; i >= 0; i--) {
//     if (next[i].batchId === batchId && next[i].status === "tearing_down") next.splice(i, 1);
//   }

//   const rebuilt = await placeRebuiltLadder(
//     acc, accountId, next, batchId,
//     { symbol: anchorLeg.symbol, side: anchorLeg.side, stepSize, stepSizeIncrement, totalLegs, baseQty, doubleQtyEnabled, tpOffset },
//     markPrice,
//     "first-order TP fill teardown",
//   );
//   next.push(...rebuilt);

//   return true;
// }

// /**
//  * PHASE 0 — chase reset: price runs away while NOTHING in the batch has
//  * filled yet. Never cancels reduce-only (there are none in this state).
//  */
// async function resetChainIfNeeded(
//   acc: any,
//   accountId: number,
//   next: WatchedSlot[],
//   batchId: string,
// ): Promise<boolean> {
//   const batchLegs = next.filter((s) => s.batchId === batchId && !s.stopped);
//   if (batchLegs.length === 0) return false;

//   if (batchLegs.some((s) => s.status === "watching" || s.status === "tearing_down")) return false;

//   const ladderCfg = getBatchLadderConfig(next, batchId);
//   if (!ladderCfg || ladderCfg.stepSizeIncrement <= 1) return false;

//   const anchor = batchLegs[0];
//   const threshold = ladderCfg.stepSize * ladderCfg.stepSizeIncrement;

//   const markPrice = await fetchMarkPrice(acc, anchor.symbol);
//   if (markPrice == null) return false;

//   const topmostLeg = batchLegs.reduce((top, s) =>
//     anchor.side === "BUY"
//       ? (s.limitPrice > top.limitPrice ? s : top)
//       : (s.limitPrice < top.limitPrice ? s : top),
//   );

//   const gap = anchor.side === "BUY"
//     ? markPrice - topmostLeg.limitPrice
//     : topmostLeg.limitPrice - markPrice;

//   if (gap <= threshold) return false;

//   const batchCfg = getBatchQtyConfig(next, batchId);
//   const totalLegs = batchCfg?.totalLegs ?? batchLegs.length;
//   const baseQty = batchCfg?.baseQty ?? topmostLeg.quantity;
//   const doubleQtyEnabled = batchCfg?.doubleQtyEnabled ?? false;
//   const tpOffset = Math.abs(anchor.tpPrice - anchor.limitPrice);

//   console.warn(
//     `[repunch] chase reset for batch ${batchId}: gap ${gap.toFixed(4)} > threshold ${threshold.toFixed(4)} (mark ${markPrice}, old top ${topmostLeg.limitPrice})`,
//   );

//   let anyUnclear = false;
//   for (const s of batchLegs) {
//     if (s.status !== "pending_fill" || !s.orderId) continue;
//     const result = await cancelAndVerify(acc, s.orderId);
//     if (result.outcome === "filled") {
//       const idx = next.findIndex((x) => x.id === s.id);
//       if (idx !== -1) {
//         try {
//           const tpResult = await placeOrderForAccount(acc, {
//             symbol: s.symbol, side: s.side === "BUY" ? "SELL" : "BUY",
//             order_type: "LIMIT", quantity: result.execQty > 0 ? result.execQty : s.quantity,
//             price: s.tpPrice, reduce_only: true,
//           });
//           next[idx] = {
//             ...s, status: "watching", orderId: undefined, seenOpen: false,
//             tpOrderId: tpResult.order_id, tpSeenOpen: false,
//             quantity: result.execQty > 0 ? result.execQty : s.quantity,
//           };
//           void logHistoryEvent({
//             accountId, slotId: s.id, batchId, symbol: s.symbol, side: s.side,
//             eventType: "entry_filled", limitPrice: s.limitPrice, tpPrice: s.tpPrice,
//             quantity: result.execQty > 0 ? result.execQty : s.quantity, repunchCountAtEvent: s.repunchCount,
//             orderId: tpResult.order_id, note: "filled during chase reset — protected with TP, reset aborted",
//           });
//         } catch (err) {
//           console.error(`[repunch] chase reset: failed to protect unexpected fill for slot ${s.id}`, err);
//         }
//       }
//       return true;
//     }
//     if (result.outcome === "unknown") anyUnclear = true;
//   }
//   if (anyUnclear) {
//     console.warn(`[repunch] chase reset for batch ${batchId}: one or more cancels unconfirmed — retrying next tick`);
//     return false;
//   }

//   for (const s of batchLegs) {
//     void logHistoryEvent({
//       accountId, slotId: s.id, batchId, symbol: s.symbol, side: s.side,
//       eventType: "ladder_reset", limitPrice: s.limitPrice, tpPrice: s.tpPrice,
//       quantity: s.quantity, repunchCountAtEvent: s.repunchCount,
//       note: `chain reset — market ran to ${markPrice}, gap ${gap.toFixed(4)} exceeded threshold ${threshold.toFixed(4)}`,
//     });
//   }
//   for (let i = next.length - 1; i >= 0; i--) {
//     if (next[i].batchId === batchId && !next[i].stopped) next.splice(i, 1);
//   }

//   const rebuilt = await placeRebuiltLadder(
//     acc, accountId, next, batchId,
//     { symbol: anchor.symbol, side: anchor.side, stepSize: ladderCfg.stepSize, stepSizeIncrement: ladderCfg.stepSizeIncrement, totalLegs, baseQty, doubleQtyEnabled, tpOffset },
//     markPrice,
//     "chase reset",
//   );
//   next.push(...rebuilt);

//   return true;
// }

// const DEDUP_WINDOW_MS = 10_000;

// async function dedupeSimultaneousBatches(
//   acc: any,
//   accountId: number,
//   next: WatchedSlot[],
// ): Promise<boolean> {
//   let changed = false;

//   const batchesBySymbolSide = new Map<string, { batchId: string; createdAt: number }[]>();
//   for (const s of next) {
//     if (!s.batchId || s.stopped) continue;
//     const createdAt = Number(s.batchId.split("-").pop());
//     if (!createdAt || isNaN(createdAt)) continue;
//     const key = `${s.symbol}-${s.side}`;
//     const arr = batchesBySymbolSide.get(key) ?? [];
//     if (!arr.some((b) => b.batchId === s.batchId)) arr.push({ batchId: s.batchId, createdAt });
//     batchesBySymbolSide.set(key, arr);
//   }

//   for (const [, batches] of batchesBySymbolSide) {
//     if (batches.length < 2) continue;
//     batches.sort((a, b) => a.createdAt - b.createdAt);

//     for (let i = 1; i < batches.length; i++) {
//       if (batches[i].createdAt - batches[i - 1].createdAt >= DEDUP_WINDOW_MS) continue;

//       const dupBatchId = batches[i].batchId;
//       for (const s of next) {
//         if (s.batchId !== dupBatchId || s.stopped) continue;

//         let dedupCancelOk = true;
//         // Only cancel entry limits — never cancel reduce-only TP.
//         if (s.orderId) {
//           try { await cancelOrderForAccount(acc, s.orderId); }
//           catch (err) { console.error(`[repunch] dedup: cancel entry failed for slot ${s.id}`, err); dedupCancelOk = false; }
//         }
//         // Do NOT cancel s.tpOrderId (reduce-only). Leave it; mark stopped so engine ignores further actions.
//         if (!dedupCancelOk) continue;

//         s.stopped = true;
//         changed = true;

//         void logHistoryEvent({
//           accountId, slotId: s.id, batchId: s.batchId, symbol: s.symbol, side: s.side,
//           eventType: "trimmed", limitPrice: s.limitPrice, tpPrice: s.tpPrice, quantity: s.quantity,
//           repunchCountAtEvent: s.repunchCount, orderId: s.orderId ?? s.tpOrderId,
//           note: `duplicate batch auto-stopped — created ${batches[i].createdAt - batches[i - 1].createdAt}ms after ${batches[i - 1].batchId}`,
//         });
//       }

//       console.warn(`[repunch] dedup: stopped duplicate batch ${dupBatchId} (too close to ${batches[i - 1].batchId})`);
//     }
//   }

//   return changed;
// }

// async function tickForAccount(row: SettingsRow) {
//   const { settingsId, accountId } = row;
//   const next = [...row.slots];
//   let changed = false;

//   const acc = await getAccount(accountId);
//   if (!acc) return;

//   // ── PHASE -1: duplicate-batch safety net ────────────────────────────────
//   const dedupChanged = await dedupeSimultaneousBatches(acc, accountId, next);
//   if (dedupChanged) changed = true;

//   // ── PHASE 0: chase reset ────────────────────────────────────────────────
//   const chaseBatchIds = new Set(
//     next.filter((s) => !s.stopped && s.batchId).map((s) => s.batchId as string),
//   );
//   for (const batchId of chaseBatchIds) {
//     const resetHappened = await resetChainIfNeeded(acc, accountId, next, batchId);
//     if (resetHappened) changed = true;
//   }

//   const needsOrders = next.some((s) => s.status === "pending_fill" || s.status === "watching" || s.status === "tearing_down");
//   const openIds = needsOrders ? await fetchOpenOrderIds(accountId) : null;

//   const activatedThisTick = new Set<string>();
//   const positionSizeCache = new Map<string, number | null>();
//   const accountedQty = new Map<string, number>();
//   const EPS = 1e-6;

//   for (const s of next) {
//     if (s.stopped) continue;
//     if (s.status === "watching") {
//       const key = `${s.symbol}-${s.side === "BUY" ? "LONG" : "SHORT"}`;
//       accountedQty.set(key, (accountedQty.get(key) ?? 0) + s.quantity);
//     }
//   }

//   // ── PHASE 1: entry limit filled → place TP ──────────────────────────────
//   // Prefer getOrderStatus when the order left the open book (fast + accurate
//   // for rapid markets). Fall back to position-size accounting if status API fails.
//   for (let i = 0; i < next.length; i++) {
//     const slot = next[i];
//     if (slot.stopped) continue;
//     if (activatedThisTick.has(slot.id)) continue;
//     if (slot.status !== "pending_fill" || !slot.orderId) continue;
//     if (!openIds) continue;

//     if (openIds.has(slot.orderId)) {
//       if (!slot.seenOpen) { next[i] = { ...slot, seenOpen: true }; changed = true; }
//       continue;
//     }

//     // Order is off the book — confirm fill via status API first (handles fast markets).
//     const { filled: statusFilled, execQty } = await checkAlreadyGoneOrder(acc, slot.orderId);

//     let confirmedFill = statusFilled;
//     let fillQty = execQty > 0 ? execQty : slot.quantity;

//     if (!confirmedFill) {
//       // Status said not filled (cancelled/rejected) or unavailable — double-check via position.
//       const expectedSide = slot.side === "BUY" ? "LONG" : "SHORT";
//       const key = `${slot.symbol}-${expectedSide}`;
//       if (!positionSizeCache.has(key)) {
//         positionSizeCache.set(key, await fetchPositionSize(accountId, slot.symbol, expectedSide));
//       }
//       const positionSize = positionSizeCache.get(key) ?? null;
//       if (positionSize === null) continue;

//       const already = accountedQty.get(key) ?? 0;
//       const remaining = positionSize - already;
//       if (remaining >= slot.quantity - EPS) {
//         confirmedFill = true;
//         fillQty = slot.quantity;
//       } else {
//         void logHistoryEvent({
//           accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
//           eventType: "trimmed", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice, quantity: slot.quantity,
//           repunchCountAtEvent: slot.repunchCount, orderId: slot.orderId,
//           note: `cancelled/rejected on exchange (order disappeared without a fill — live position ${positionSize}, already accounted ${already})`,
//         });
//         next.splice(i, 1); i--; changed = true;
//         continue;
//       }
//     }

//     const expectedSide = slot.side === "BUY" ? "LONG" : "SHORT";
//     const key = `${slot.symbol}-${expectedSide}`;
//     const already = accountedQty.get(key) ?? 0;
//     accountedQty.set(key, already + fillQty);

//     try {
//       const result = await placeOrderForAccount(acc, {
//         symbol: slot.symbol, side: slot.side === "BUY" ? "SELL" : "BUY", order_type: "LIMIT",
//         quantity: fillQty, price: slot.tpPrice, reduce_only: true,
//       });
//       next[i] = {
//         ...slot,
//         status: "watching",
//         tpOrderId: result.order_id,
//         tpSeenOpen: false,
//         orderId: undefined,
//         seenOpen: false,
//         quantity: fillQty,
//       };
//       changed = true;

//       void logHistoryEvent({
//         accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
//         eventType: "entry_filled", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice, quantity: fillQty,
//         repunchCountAtEvent: slot.repunchCount, orderId: result.order_id,
//       });

//       if (slot.batchId) {
//         const activatedId = await activateNextQueued(acc, accountId, next, slot.batchId);
//         if (activatedId) { changed = true; activatedThisTick.add(activatedId); }
//       }
//     } catch (err) {
//       console.error(`[repunch] failed to place TP for slot ${slot.id} (account ${accountId})`, err);
//       accountedQty.set(key, already);
//     }
//   }

//   // ── PHASE 2: TP exit filled ─────────────────────────────────────────────
//   // ONLY the first order (rank === 0) may trigger full batch teardown.
//   // Non-first legs get an individual re-punch only.
//   // Reduce-only TPs are never cancelled here — we only react when they leave the book.
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

//     const { filled: reallyFilled, execQty } = await checkAlreadyGoneOrder(acc, slot.tpOrderId);

//     if (!reallyFilled) {
//       // Disappeared without fill — re-place TP to avoid naked position. Never leave unprotected.
//       console.warn(`[repunch] TP for slot ${slot.id} disappeared without filling — re-placing`);
//       try {
//         const result = await placeOrderForAccount(acc, {
//           symbol: slot.symbol, side: slot.side === "BUY" ? "SELL" : "BUY", order_type: "LIMIT",
//           quantity: slot.quantity, price: slot.tpPrice, reduce_only: true,
//         });
//         next[i] = { ...slot, tpOrderId: result.order_id, tpSeenOpen: false };
//         changed = true;
//         void logHistoryEvent({
//           accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
//           eventType: "entry_filled", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice, quantity: slot.quantity,
//           repunchCountAtEvent: slot.repunchCount, orderId: result.order_id,
//           note: "TP re-placed after disappearing without a fill",
//         });
//       } catch (err) {
//         console.error(`[repunch] failed to re-place TP for slot ${slot.id}`, err);
//       }
//       continue;
//     }

//     void logHistoryEvent({
//       accountId, slotId: slot.id, batchId: slot.batchId, symbol: slot.symbol, side: slot.side,
//       eventType: "tp_filled", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
//       quantity: execQty > 0 ? execQty : slot.quantity, repunchCountAtEvent: slot.repunchCount, orderId: slot.tpOrderId,
//     });

//     // ── First order (rank 0) → full batch teardown at rebuild point ──────
//     if (isFirstOrder(slot) && slot.batchId) {
//       const batchId = slot.batchId;
//       const alreadyTearing = next.some((s) => s.batchId === batchId && s.status === "tearing_down");
//       if (!alreadyTearing) {
//         for (let j = 0; j < next.length; j++) {
//           if (next[j].batchId === batchId && !next[j].stopped) {
//             next[j] = { ...next[j], status: "tearing_down" };
//           }
//         }
//         changed = true;
//         await saveSlots(settingsId, next);
//         void logHistoryEvent({
//           accountId, slotId: slot.id, batchId, symbol: slot.symbol, side: slot.side,
//           eventType: "ladder_reset", limitPrice: slot.limitPrice, tpPrice: slot.tpPrice,
//           quantity: slot.quantity, repunchCountAtEvent: slot.repunchCount,
//           note: "FIRST-order TP filled — tearing down batch for rebuild at rebuild point (reduce-only TPs will NOT be cancelled)",
//         });
//       }
//     } else {
//       // ── Non-first leg → individual re-punch only (no batch cancel) ─────
//       const did = await individualRepunch(acc, accountId, next, i);
//       if (did) changed = true;
//     }
//   }

//   // ── PHASE 3: progress any batch currently tearing down ──────────────────
//   const tearingBatchIds = new Set(
//     next.filter((s) => s.status === "tearing_down" && !s.stopped && s.batchId).map((s) => s.batchId as string),
//   );
//   for (const batchId of tearingBatchIds) {
//     const progressed = await progressBatchTeardown(acc, accountId, next, batchId);
//     if (progressed) changed = true;
//   }

//   if (changed) await saveSlots(settingsId, next);
// }

// async function tick() {
//   if (running) return;
//   running = true;
//   try {
//     const rows = await loadAllSettingsRows();
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