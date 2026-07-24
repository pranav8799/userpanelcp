import { db, settingsTable, accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { callCoinswitch, placeOrderForAccount } from "../lib/coinswitchApi.js";
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

async function tickForAccount(row: SettingsRow) {
  const { settingsId, accountId } = row;
  const next = [...row.slots];
  let changed = false;

  const acc = await getAccount(accountId);
  if (!acc) return;

  const needsOrders = next.some((s) => s.status === "pending_fill" || s.status === "watching");
  const openIds = needsOrders ? await fetchOpenOrderIds(accountId) : null;

  // Phase 1: entry limit filled → place TP exit limit
  for (let i = 0; i < next.length; i++) {
    const slot = next[i];
    if (slot.stopped) continue;
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
    } catch (err) {
      console.error(`[repunch] failed to place TP for slot ${slot.id} (account ${accountId})`, err);
    }
  }

  // Phase 2: TP exit filled → repunch a fresh entry limit
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
      const result = await placeOrderForAccount(acc, {
        symbol: slot.symbol,
        side: slot.side,
        order_type: "LIMIT",
        quantity: slot.quantity,
        price: slot.limitPrice,
      });
      next[i] = {
        ...slot,
        status: "pending_fill",
        orderId: result.order_id,
        seenOpen: false,
        tpOrderId: undefined,
        tpSeenOpen: false,
        repunchCount: slot.repunchCount + 1,
      };
      changed = true;
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