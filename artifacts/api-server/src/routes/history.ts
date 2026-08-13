// src/routes/history.ts
import { Router, type IRouter } from "express";
import { queryHistory, getHistorySymbols, logHistoryEvents, type HistoryEventInput } from "../lib/history.js";

const router: IRouter = Router();

/**
 * GET /api/history
 * Query params: accountId, symbol, side, eventType, batchId, slotId,
 * dateFrom, dateTo, minQty, maxQty, minRepunchCount, maxRepunchCount,
 * search, page, pageSize, sortBy, sortDir
 */
router.get("/", async (req, res) => {
  try {
    const q = req.query;
    const result = await queryHistory({
      accountId: q.accountId ? Number(q.accountId) : undefined,
      symbol: typeof q.symbol === "string" ? q.symbol : undefined,
      side: q.side === "BUY" || q.side === "SELL" ? q.side : undefined,
      eventType: typeof q.eventType === "string" ? (q.eventType as any) : undefined,
      batchId: typeof q.batchId === "string" ? q.batchId : undefined,
      slotId: typeof q.slotId === "string" ? q.slotId : undefined,
      dateFrom: typeof q.dateFrom === "string" ? q.dateFrom : undefined,
      dateTo: typeof q.dateTo === "string" ? q.dateTo : undefined,
      minQty: q.minQty ? Number(q.minQty) : undefined,
      maxQty: q.maxQty ? Number(q.maxQty) : undefined,
      minRepunchCount: q.minRepunchCount ? Number(q.minRepunchCount) : undefined,
      maxRepunchCount: q.maxRepunchCount ? Number(q.maxRepunchCount) : undefined,
      search: typeof q.search === "string" ? q.search : undefined,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
      sortBy: typeof q.sortBy === "string" ? (q.sortBy as any) : undefined,
      sortDir: q.sortDir === "asc" || q.sortDir === "desc" ? q.sortDir : undefined,
    });
    res.json(result);
  } catch (err: any) {
    console.error("[history] query failed", err);
    res.status(500).json({ message: "Failed to fetch history", error: err.message });
  }
});

/**
 * GET /api/history/symbols
 * Distinct symbols seen in history — used to populate the symbol filter.
 */
router.get("/symbols", async (req, res) => {
  try {
    const accountId = req.query.accountId ? Number(req.query.accountId) : undefined;
    const symbols = await getHistorySymbols(accountId);
    res.json({ symbols });
  } catch (err: any) {
    console.error("[history] symbols query failed", err);
    res.status(500).json({ message: "Failed to fetch symbols", error: err.message });
  }
});

/**
 * POST /api/history/log
 * Ingest endpoint for CLIENT-SIDE creation events — the initial ladder
 * placement (entry + ladder legs, live or queued) happens in place-order.tsx
 * via direct placeOrder() calls, not through the repunch engine, so there's
 * no other server-side hook that sees "a new batch was just created." The
 * frontend calls this right after a successful ladder placement.
 *
 * Everything that happens AFTER creation (fills, repunches, shifts, demotes,
 * trims, rebalances) is logged directly by repunchEngine.ts server-side —
 * this endpoint is only for the creation moment.
 */
router.post("/log", async (req, res) => {
  try {
    const events = req.body?.events as HistoryEventInput[] | undefined;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ message: "events[] required" });
    }
    await logHistoryEvents(events);
    return res.json({ ok: true, count: events.length });
  } catch (err: any) {
    console.error("[history] log ingest failed", err);
    return res.status(500).json({ message: "Failed to log events", error: err.message });
  }
});

export default router;