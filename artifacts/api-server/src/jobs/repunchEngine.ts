import { db, settingsTable, accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { callCoinswitch, placeOrderForAccount, cancelOrderForAccount } from "../lib/coinswitchApi.js";
import { decrypt } from "../lib/crypto.js";

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
  // Ladder buy-diff in points, copied onto every slot (entry + ladder legs)
  // at creation time in place-order.tsx. Used by shiftDemoteTrim to know how
  // far past the triggering leg to place the new shifted leg.
  stepSize?: number;
  // Per-trade toggle: farther-half legs (by rank, see totalLegs) trade at
  // 2× baseQty instead of baseQty. Same value on every leg in a batch.
  doubleQtyEnabled?: boolean;
  // Unit qty entered on the ticket — constant across the whole batch.
  // `quantity` holds whatever was actually used at this leg's last live
  // placement; baseQty lets us recompute the doubled amount later.
  baseQty?: number;
  // Fixed leg count for this batch's whole lifetime (numberOfOrders + 1).
  // Drives the base/double split point; deliberately NOT derived from the
  // batch's current array length (which can drift temporarily — see the
  // trim-skipped-because-watching case in shiftDemoteTrim).
  totalLegs?: number;
}

/**
 * Determines the qty to use when a leg is about to be freshly placed
 * (initial creation, activation from queue, repunch, or shift).
 *
 * Rank is by price, counted from the leg closest to market outward: for BUY
 * the highest price is rank 0, for SELL the lowest price is rank 0. The
 * first `ceil(totalLegs / 2)` ranks trade at baseQty; the rest at
 * baseQty * 2. Watching legs are included when establishing rank (so every
 * other leg's split stays correct) even though they never get resized
 * themselves — the caller simply never invokes this for a watching leg.
 *
 * `rankBoost` accounts for a shift leg that will land at rank 0 in the same
 * event, before it's actually been pushed into `next` yet — see the Phase 2
 * repunch call site, which passes 1 when its own shift is about to succeed.
 */
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
  if (!totalLegs || totalLegs <= 0) return baseQty; // missing config — fail safe to base

  const prices = next
    .filter((s) => s.batchId === batchId && !s.stopped)
    .map((s) => s.limitPrice);
  if (!prices.includes(targetPrice)) prices.push(targetPrice);

  const sorted = side === "BUY"
    ? prices.sort((a, b) => b - a)  // BUY: highest price = rank 0 (closest to market)
    : prices.sort((a, b) => a - b); // SELL: lowest price = rank 0

  const idx = sorted.indexOf(targetPrice) + rankBoost;
  const baseCount = Math.ceil(totalLegs / 2);
  return idx < baseCount ? baseQty : baseQty * 2;
}

/**
 * doubleQtyEnabled / baseQty / totalLegs are supposed to be identical on
 * every leg in a batch — stamped once at trade creation and carried forward.
 * Rather than trusting only the one slot being acted on (which, if it lost
 * its own copy for any reason — legacy data, a partially-applied edit,
 * corruption — would silently fall back to base qty via computeQtyForRank's
 * fail-safe), look them up from ANY sibling leg in the same batch that
 * still has them. Returns null only if no leg in the whole batch has them
 * (e.g. the batch genuinely predates this feature), in which case callers
 * should leave qty untouched rather than guess.
 */
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
 * Activates the next queued ladder leg in the same batch (concurrency window).
 * Called right after an active leg's entry fills, so exactly N legs stay
 * resting on the book at a time (N = CONCURRENT_LIMIT set on the frontend).
 * Mutates `next` in place. Returns true if a slot was activated.
 */
async function activateNextQueued(acc: any, next: WatchedSlot[], batchId: string): Promise<string | null> {
  // A "queued" leg is a pending_fill slot with no orderId yet — this avoids
  // needing a status enum value the settings schema doesn't recognize.
  const idx = next.findIndex((s) => s.batchId === batchId && s.status === "pending_fill" && !s.orderId && !s.stopped);
  if (idx === -1) return null;
  const slot = next[idx];
  // This queued leg may have been sitting untouched through several shift
  // events since it was created or last demoted — its rank (and therefore
  // its base/double qty) can have changed since then. Recompute now, since
  // activation is a fresh-placement moment. Pull doubleQtyEnabled/baseQty/
  // totalLegs from any sibling in the batch, not just this slot's own copy
  // — if this specific slot lost its stamp for any reason, a sibling almost
  // always still has it.
  const batchCfg = getBatchQtyConfig(next, batchId);
  const qty = batchCfg
    ? computeQtyForRank(next, batchId, slot.side, slot.limitPrice, batchCfg.doubleQtyEnabled, batchCfg.baseQty, batchCfg.totalLegs)
    : slot.quantity; // no config found anywhere in the batch — leave qty as-is rather than guess
  try {
    const result = await placeOrderForAccount(acc, {
      symbol: slot.symbol,
      side: slot.side,
      order_type: "LIMIT",
      quantity: qty,
      price: slot.limitPrice,
    });
    next[idx] = { ...slot, status: "pending_fill", orderId: result.order_id, seenOpen: false, quantity: qty };
    return slot.id; // caller uses this to skip re-checking it in the same tick
  } catch (err) {
    console.error(`[repunch] failed to activate queued slot ${slot.id}`, err);
    return null;
  }
}

/**
 * Computes what the next shift leg's price/TP would be for a trigger slot,
 * and whether placing it would collide with a price some other tracked leg
 * in the same batch already occupies. Shared between the Phase 2 loop
 * (which needs to know ahead of time, to decide the repunch leg's own rank
 * boost) and shiftDemoteTrim (which does the actual placement).
 */
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

/**
 * Runs the "shift + demote + trim + rebalance" side effects that accompany
 * a repunch, per the sliding-window ladder strategy:
 *
 *  1. SHIFT      — place a brand-new leg one stepSize further from the
 *                  triggering leg's price (never queued — always placed
 *                  live).
 *  2. DEMOTE     — among this batch's currently-*live* resting legs
 *                  (excluding the just-placed shift leg), cancel the one
 *                  furthest from the shift direction (lowest price for BUY,
 *                  highest for SELL) and flip it back to queued (orderId
 *                  cleared, stays pending_fill).
 *  3. TRIM       — among ALL of this batch's tracked legs (any status),
 *                  find the overall bottom-most by price. If it is
 *                  pending_fill (live or queued), cancel any live order and
 *                  remove it entirely, so the total leg count stays
 *                  constant. If it is "watching" (an open position — can't
 *                  be cancelled), trimming is skipped for this cycle; the
 *                  chain temporarily grows by one leg until that watching
 *                  leg resolves on its own and something eligible reaches
 *                  the bottom.
 *  4. REBALANCE  — shift+trim change every remaining leg's *relative* rank
 *                  (rank is derived dynamically from sorted price position,
 *                  never stored). A live-resting leg whose rank crosses the
 *                  base/double boundary as a side effect of steps 1–3 keeps
 *                  whatever quantity it was last placed with, which is now
 *                  wrong for its new rank. Walk every live-resting leg in
 *                  the batch (other than the shift leg, which is already
 *                  correct) and cancel+re-place any whose current-rank qty
 *                  no longer matches what's resting on the exchange.
 *
 * Mutates `next` in place. Returns the array index that was removed by trim
 * (if any), so the caller can correct its own loop index.
 */
async function shiftDemoteTrim(
  acc: any,
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
    // Guard against placing a duplicate order on top of a leg that already
    // occupies this price (any status — live, queued, or watching). Easy to
    // hit with a small stepSize: consecutive repunch cycles can shift the
    // window onto a price another leg in the same batch already holds.
    console.warn(
      `[repunch] shift skipped for batch ${batchId}: price ${newPrice} already tracked (anchor ${triggerSlot.id})`,
    );
    // Skip demote/trim/rebalance too — no new leg was added, so ranks
    // haven't actually shifted. We'll try again next cycle once the window
    // has moved further.
    return { trimmedIndex: null };
  }

  // ── 1. SHIFT ──────────────────────────────────────────────────────────
  // The shift leg always lands at rank 0 (it's by definition the newest,
  // closest-to-market leg — nothing can be nearer at the moment it's
  // placed), so its qty is independent of whatever triggerSlot's own qty
  // happens to be right now. Pull config from any sibling in the batch,
  // not just triggerSlot, for the same resilience reason as activation.
  const batchCfg = getBatchQtyConfig(next, batchId);
  const shiftQty = batchCfg
    ? computeQtyForRank(next, batchId, triggerSlot.side, newPrice, batchCfg.doubleQtyEnabled, batchCfg.baseQty, batchCfg.totalLegs)
    : triggerSlot.quantity;
  let shiftLegId: string;
  try {
    const result = await placeOrderForAccount(acc, {
      symbol: triggerSlot.symbol,
      side: triggerSlot.side,
      order_type: "LIMIT",
      quantity: shiftQty,
      price: newPrice,
    });
    shiftLegId = `${triggerSlot.symbol}-${triggerSlot.side}-${newPrice}-${Date.now()}-shift`;
    next.push({
      id: shiftLegId,
      symbol: triggerSlot.symbol,
      side: triggerSlot.side,
      limitPrice: newPrice,
      tpPrice: newTp,
      quantity: shiftQty,
      repunchCount: 0,
      status: "pending_fill",
      orderId: result.order_id,
      seenOpen: false,
      batchId,
      stepSize: triggerSlot.stepSize,
      doubleQtyEnabled: batchCfg?.doubleQtyEnabled ?? triggerSlot.doubleQtyEnabled,
      baseQty: batchCfg?.baseQty ?? triggerSlot.baseQty ?? triggerSlot.quantity,
      totalLegs: batchCfg?.totalLegs ?? triggerSlot.totalLegs,
    });
  } catch (err) {
    console.error(`[repunch] shift failed for batch ${batchId} (anchor ${triggerSlot.id})`, err);
    return { trimmedIndex: null }; // nothing new was added — don't demote/trim/rebalance either
  }

  // ── 2. DEMOTE ─────────────────────────────────────────────────────────
  // Candidates: same batch, currently live-resting (pending_fill + orderId),
  // not stopped, excluding the shift leg we just placed (it can't be the
  // thing we immediately cancel). We do NOT need to special-case the
  // trigger slot by id: it was just repunched at its own original price,
  // which under normal upward (BUY) / downward (SELL) trending conditions
  // is never the "bottom" of the resting group. If your ladder can fire
  // out of price order, revisit this assumption.
  const isLiveResting = (s: WatchedSlot) =>
    s.batchId === batchId && s.status === "pending_fill" && !!s.orderId && !s.stopped && s.id !== shiftLegId;

  let demoteIdx = -1;
  for (let j = 0; j < next.length; j++) {
    if (!isLiveResting(next[j])) continue;
    if (demoteIdx === -1) { demoteIdx = j; continue; }
    const isFurther = dir === 1
      ? next[j].limitPrice < next[demoteIdx].limitPrice   // BUY: lowest price
      : next[j].limitPrice > next[demoteIdx].limitPrice;  // SELL: highest price
    if (isFurther) demoteIdx = j;
  }

  if (demoteIdx !== -1) {
    const demoteSlot = next[demoteIdx];
    try {
      await cancelOrderForAccount(acc, demoteSlot.orderId!);
      next[demoteIdx] = { ...demoteSlot, orderId: undefined, seenOpen: false };
    } catch (err) {
      // If the cancel call fails we don't know the true state of the order
      // on the exchange — leave it alone and retry demotion next tick
      // rather than risk a duplicate/mismatched local state.
      console.error(`[repunch] demote cancel failed for slot ${demoteSlot.id}`, err);
    }
  }

  // ── 3. TRIM ───────────────────────────────────────────────────────────
  // Bottom-most leg of the WHOLE batch (any status), by price.
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
          // Order state on the exchange is now uncertain for this slot —
          // still remove it locally rather than leaving a possibly-orphaned
          // live order untracked; cancel_all / manual cleanup is the backstop.
        }
      }
      next.splice(bottomIdx, 1);
      trimmedIndex = bottomIdx;
    }
    // If bottomSlot.status === "watching": can't cancel an open position —
    // trimming is skipped for this cycle (Option B). We still fall through
    // to rebalance below, since shift/demote already happened and ranks
    // already moved regardless of whether trim itself fired.
  }

  // ── 4. REBALANCE ─────────────────────────────────────────────────────
  // Shift+trim silently changed every other live-resting leg's rank (rank
  // is derived dynamically from sorted price position, never stored).
  // A leg whose rank crossed the base/double boundary as a side effect of
  // steps 1–3 keeps whatever quantity it was last placed with — which may
  // now be wrong. Walk every live-resting leg in the batch (other than the
  // shift leg, already correct) and cancel+re-place any whose recomputed
  // qty no longer matches what's resting on the exchange.
  if (batchCfg?.doubleQtyEnabled) {
    for (let j = 0; j < next.length; j++) {
      const s = next[j];
      if (s.batchId !== batchId || s.stopped) continue;
      if (s.status !== "pending_fill" || !s.orderId) continue;
      if (s.id === shiftLegId) continue; // just placed, already correct

      const correctQty = computeQtyForRank(
        next, batchId, s.side, s.limitPrice,
        batchCfg.doubleQtyEnabled, batchCfg.baseQty, batchCfg.totalLegs,
      );
      if (correctQty === s.quantity) continue; // rank didn't cross the boundary

      try {
        await cancelOrderForAccount(acc, s.orderId);
        const result = await placeOrderForAccount(acc, {
          symbol: s.symbol,
          side: s.side,
          order_type: "LIMIT",
          quantity: correctQty,
          price: s.limitPrice,
        });
        next[j] = { ...s, orderId: result.order_id, seenOpen: false, quantity: correctQty };
      } catch (err) {
        console.error(`[repunch] rebalance re-place failed for slot ${s.id}`, err);
        // Leave local state as-is; the next shift/demote/trim cycle for
        // this batch will attempt the same correction again.
      }
    }
  }

  return { trimmedIndex };
}

async function tickForAccount(row: SettingsRow) {
  const { settingsId, accountId } = row;
  const next = [...row.slots];
  let changed = false;

  const acc = await getAccount(accountId);
  if (!acc) return;

  const needsOrders = next.some((s) => s.status === "pending_fill" || s.status === "watching");
  const openIds = needsOrders ? await fetchOpenOrderIds(accountId) : null;

  // Slots activated by activateNextQueued during this tick — skip re-checking
  // them below, since a brand-new order can never legitimately be "filled"
  // in the same tick it was placed. Without this guard, a pre-existing open
  // position for the same symbol/side (e.g. from the entry leg already
  // having filled) gets misread as proof the new order filled instantly.
  const activatedThisTick = new Set<string>();

  // Phase 1: entry limit filled → place TP exit limit
  for (let i = 0; i < next.length; i++) {
    const slot = next[i];
    if (slot.stopped) continue;
    if (activatedThisTick.has(slot.id)) continue;
    if (slot.status !== "pending_fill" || !slot.orderId) continue;
    if (!openIds) continue; // fetch failed this tick, retry next tick

    if (openIds.has(slot.orderId)) {
      if (!slot.seenOpen) { next[i] = { ...slot, seenOpen: true }; changed = true; }
      continue;
    }

    // Order isn't resting on the book anymore. Check the position FIRST,
    // regardless of seenOpen — an order can fill instantly before we ever
    // get a chance to observe it resting open. Only fall back to seenOpen
    // to decide "cancelled" vs "still being placed", never to decide "filled".
    const expectedSide = slot.side === "BUY" ? "LONG" : "SHORT";
    const filled = await hasOpenPosition(accountId, slot.symbol, expectedSide);
    if (filled === null) continue; // fetch failed, retry next tick

    if (!filled) {
      if (!slot.seenOpen) continue; // never seen open + no position — might not be registered yet, wait
      next.splice(i, 1); i--; changed = true; // was open, now gone, no position — cancelled/rejected
      continue;
    }

    try {
      const result = await placeOrderForAccount(acc, {
        symbol: slot.symbol,
        side: slot.side === "BUY" ? "SELL" : "BUY",
        order_type: "LIMIT",
        quantity: slot.quantity,
        price: slot.tpPrice,
        reduce_only: true,
      });
      next[i] = { ...slot, status: "watching", tpOrderId: result.order_id, tpSeenOpen: false, orderId: undefined, seenOpen: false };
      changed = true;

      // This entry just filled — release the next queued ladder leg in the same batch, if any.
      if (slot.batchId) {
        const activatedId = await activateNextQueued(acc, next, slot.batchId);
        if (activatedId) { changed = true; activatedThisTick.add(activatedId); }
      }
    } catch (err) {
      console.error(`[repunch] failed to place TP for slot ${slot.id} (account ${accountId})`, err);
    }
  }

  // Phase 2: TP exit filled → repunch (self) + shift (new leg) + demote
  // (cancel current bottom-resting → queued) + trim (drop overall bottom leg
  // if it's cancellable, to keep total leg count constant) + rebalance
  // (re-place any live-resting leg whose rank crossed the base/double
  // boundary as a result of the shift/trim).
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
      // Repunch and shift are one event: if a shift leg is about to land
      // ahead of this one (same batch, no price collision), this leg's own
      // rank moves out by exactly one place. Its repunch qty needs to
      // reflect that final rank, not its pre-event one, else a leg sitting
      // right at the base/double boundary gets the wrong amount for the
      // entire time it's live. Config comes from any sibling in the batch,
      // not just this slot's own copy, for the same resilience reason as
      // activation and shift.
      const shiftTarget = slot.batchId ? computeShiftTarget(next, slot.batchId, slot) : null;
      const willShift = !!shiftTarget && !shiftTarget.willCollide;
      const batchCfg = slot.batchId ? getBatchQtyConfig(next, slot.batchId) : null;
      const repunchQty = batchCfg
        ? computeQtyForRank(next, slot.batchId ?? "", slot.side, slot.limitPrice, batchCfg.doubleQtyEnabled, batchCfg.baseQty, batchCfg.totalLegs, willShift ? 1 : 0)
        : slot.quantity;

      const result = await placeOrderForAccount(acc, {
        symbol: slot.symbol,
        side: slot.side,
        order_type: "LIMIT",
        quantity: repunchQty,
        price: slot.limitPrice,
      });
      const repunchedSlot: WatchedSlot = {
        ...slot,
        status: "pending_fill",
        orderId: result.order_id,
        seenOpen: false,
        tpOrderId: undefined,
        tpSeenOpen: false,
        repunchCount: slot.repunchCount + 1,
        quantity: repunchQty,
      };
      next[i] = repunchedSlot;
      changed = true;

      if (slot.batchId) {
        const { trimmedIndex } = await shiftDemoteTrim(acc, next, repunchedSlot, slot.batchId);
        changed = true;
        // trim can splice out an element anywhere in the array (not just at
        // i, unlike Phase 1's own-slot removal) — correct our loop index so
        // we don't skip whatever now sits at position i+1.
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
    // Run accounts sequentially to avoid hammering CoinSwitch with bursts
    // across many accounts at once; each account's own calls are already
    // sequential within tickForAccount.
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