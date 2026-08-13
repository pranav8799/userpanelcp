// src/pages/history.tsx
import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchHistory, fetchHistorySymbols, type HistoryQueryParams, type HistoryEventInput } from "@/lib/historyApi";
import { useAuth } from "@/contexts/auth-context";
import { RefreshCw, Search, X, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Filter } from "lucide-react";

const EVENT_TYPE_OPTIONS: { value: HistoryEventInput["eventType"] | "ALL"; label: string }[] = [
  { value: "ALL", label: "All Events" },
  { value: "entry_placed", label: "Entry Placed" },
  { value: "queued", label: "Queued" },
  { value: "queued_activated", label: "Queued Activated" },
  { value: "entry_filled", label: "Entry Filled" },
  { value: "tp_filled", label: "TP Filled" },
  { value: "repunched", label: "Re-punched" },
  { value: "shifted", label: "Shifted" },
  { value: "demoted", label: "Demoted" },
  { value: "trimmed", label: "Trimmed" },
  { value: "rebalanced", label: "Rebalanced" },
  { value: "stopped", label: "Stopped" },
  { value: "resumed", label: "Resumed" },
  { value: "removed_manual", label: "Removed (Manual)" },
  { value: "ladder_reset", label: "Ladder Reset" },
];

const EVENT_TYPE_COLORS: Record<string, string> = {
  entry_placed: "hsl(258 82% 64%)",
  queued: "hsl(220 9% 55%)",
  queued_activated: "hsl(258 82% 64%)",
  entry_filled: "hsl(162 88% 42%)",
  tp_filled: "hsl(162 88% 42%)",
  repunched: "hsl(38 92% 45%)",
  shifted: "hsl(258 82% 64%)",
  demoted: "hsl(38 92% 45%)",
  trimmed: "hsl(345 88% 58%)",
  rebalanced: "hsl(200 88% 55%)",
  stopped: "hsl(38 92% 45%)",
  resumed: "hsl(162 88% 42%)",
  removed_manual: "hsl(345 88% 58%)",
  ladder_reset: "hsl(280 82% 60%)",
};

const fmt = (v: string | number | null | undefined, decimals = 4) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (n === null || n === undefined || isNaN(n as number)) return "—";
  return (n as number).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

interface FilterChipProps { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; activeColor?: string; }
function FilterChip({ value, options, onChange, activeColor }: FilterChipProps) {
  const isActive = value !== options[0].value;
  return (
    <div className="relative">
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="appearance-none pl-2.5 pr-6 py-1 rounded-md text-[11px] font-semibold cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring transition-all"
        style={isActive ? { background: "hsl(258 82% 64% / 0.15)", color: activeColor ?? "hsl(var(--primary))", border: `1px solid ${activeColor ?? "hsl(258 82% 64% / 0.4)"}` } : { background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))", border: "1px solid hsl(var(--border))" }}>
        {options.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
      <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none" style={{ color: isActive ? (activeColor ?? "hsl(var(--primary))") : "hsl(var(--muted-foreground))" }} />
    </div>
  );
}

export default function History() {
  const { account } = useAuth();

  const [search, setSearch] = useState("");
  const [symbol, setSymbol] = useState("ALL");
  const [side, setSide] = useState<"ALL" | "BUY" | "SELL">("ALL");
  const [eventType, setEventType] = useState<string>("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [minQty, setMinQty] = useState("");
  const [maxQty, setMaxQty] = useState("");
  const [minRepunchCount, setMinRepunchCount] = useState("");
  const [maxRepunchCount, setMaxRepunchCount] = useState("");
  const [batchId, setBatchId] = useState("");
  const [sortBy, setSortBy] = useState<HistoryQueryParams["sortBy"]>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  useEffect(() => { setPage(1); }, [search, symbol, side, eventType, dateFrom, dateTo, minQty, maxQty, minRepunchCount, maxRepunchCount, batchId, pageSize]);

  const { data: symbols } = useQuery({
    queryKey: ["historySymbols", account?.id],
    queryFn: () => fetchHistorySymbols(account?.id),
    enabled: !!account?.id,
  });

  const queryParams: HistoryQueryParams = {
    accountId: account?.id,
    symbol: symbol !== "ALL" ? symbol : undefined,
    side: side !== "ALL" ? side : undefined,
    eventType: eventType !== "ALL" ? (eventType as HistoryEventInput["eventType"]) : undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    minQty: minQty ? Number(minQty) : undefined,
    maxQty: maxQty ? Number(maxQty) : undefined,
    minRepunchCount: minRepunchCount ? Number(minRepunchCount) : undefined,
    maxRepunchCount: maxRepunchCount ? Number(maxRepunchCount) : undefined,
    batchId: batchId || undefined,
    search: search || undefined,
    page,
    pageSize,
    sortBy,
    sortDir,
  };

  const { data, isFetching, refetch } = useQuery({
    queryKey: ["history", queryParams],
    queryFn: () => fetchHistory(queryParams),
    enabled: !!account?.id,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  const activeFilterCount =
    (symbol !== "ALL" ? 1 : 0) + (side !== "ALL" ? 1 : 0) + (eventType !== "ALL" ? 1 : 0) +
    (dateFrom ? 1 : 0) + (dateTo ? 1 : 0) + (minQty ? 1 : 0) + (maxQty ? 1 : 0) +
    (minRepunchCount ? 1 : 0) + (maxRepunchCount ? 1 : 0) + (batchId ? 1 : 0) + (search ? 1 : 0);

  const clearFilters = () => {
    setSearch(""); setSymbol("ALL"); setSide("ALL"); setEventType("ALL");
    setDateFrom(""); setDateTo(""); setMinQty(""); setMaxQty("");
    setMinRepunchCount(""); setMaxRepunchCount(""); setBatchId("");
  };

  const symbolOptions = useMemo(
    () => [{ value: "ALL", label: "All Symbols" }, ...(symbols ?? []).map((s) => ({ value: s, label: s }))],
    [symbols],
  );

  const toggleSort = (col: NonNullable<HistoryQueryParams["sortBy"]>) => {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(col); setSortDir("desc"); }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold">Trade History</h1>
          <p className="text-sm text-muted-foreground">Every auto-trade event — including legs later trimmed from the active ladder.</p>
        </div>
        <button onClick={() => refetch()} className="p-2 rounded-lg text-muted-foreground hover:text-foreground transition-colors" style={{ border: "1px solid hsl(var(--border))" }}>
          <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Filter bar */}
      <div className="rounded-xl p-3 mb-3 space-y-2.5" style={{ border: "1px solid hsl(var(--border))", background: "hsl(var(--card))" }}>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[180px] max-w-[280px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search symbol or note…"
              className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors" />
            {search && (<button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"><X className="w-3 h-3" /></button>)}
          </div>

          <FilterChip value={symbol} options={symbolOptions} onChange={setSymbol} />
          <FilterChip value={side} options={[{ value: "ALL", label: "All Sides" }, { value: "BUY", label: "▲ Buy" }, { value: "SELL", label: "▼ Sell" }]} onChange={(v) => setSide(v as any)} activeColor="hsl(258 82% 60%)" />
          <FilterChip value={eventType} options={EVENT_TYPE_OPTIONS} onChange={setEventType} activeColor="hsl(162 88% 42%)" />

          <input value={batchId} onChange={(e) => setBatchId(e.target.value)} placeholder="Batch ID…"
            className="w-32 px-2.5 py-1 rounded-md text-[11px] bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors" />

          {activeFilterCount > 0 && (
            <button onClick={clearFilters} className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-all"
              style={{ color: "hsl(345 88% 62%)", border: "1px solid hsl(345 88% 58% / 0.3)", background: "hsl(345 88% 58% / 0.07)" }}>
              <X className="w-3 h-3" /> Clear ({activeFilterCount})
            </button>
          )}

          <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
            <span className="font-semibold text-foreground">{total}</span> total events
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap pt-1" style={{ borderTop: "1px dashed hsl(var(--border))" }}>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Date range</span>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="px-2 py-1 rounded-md text-[11px] bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors" />
          <span className="text-[11px] text-muted-foreground">to</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="px-2 py-1 rounded-md text-[11px] bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors" />

          <span className="ml-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Qty</span>
          <input type="number" step="any" value={minQty} onChange={(e) => setMinQty(e.target.value)} placeholder="min"
            className="w-16 px-2 py-1 rounded-md text-[11px] bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors" />
          <span className="text-[11px] text-muted-foreground">–</span>
          <input type="number" step="any" value={maxQty} onChange={(e) => setMaxQty(e.target.value)} placeholder="max"
            className="w-16 px-2 py-1 rounded-md text-[11px] bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors" />

          <span className="ml-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Re-punches</span>
          <input type="number" value={minRepunchCount} onChange={(e) => setMinRepunchCount(e.target.value)} placeholder="min"
            className="w-14 px-2 py-1 rounded-md text-[11px] bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors" />
          <span className="text-[11px] text-muted-foreground">–</span>
          <input type="number" value={maxRepunchCount} onChange={(e) => setMaxRepunchCount(e.target.value)} placeholder="max"
            className="w-14 px-2 py-1 rounded-md text-[11px] bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors" />
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto rounded-xl" style={{ border: "1px solid hsl(var(--border))" }}>
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10">
            <tr style={{ background: "hsl(var(--muted))", borderBottom: "1px solid hsl(var(--border))" }}>
              {[
                { key: "createdAt" as const, label: "Time" },
                { key: null, label: "Symbol" },
                { key: null, label: "Side" },
                { key: null, label: "Event" },
                { key: "limitPrice" as const, label: "Limit Price" },
                { key: null, label: "TP Price" },
                { key: "quantity" as const, label: "Qty" },
                { key: "repunchCountAtEvent" as const, label: "Re-punches" },
                { key: null, label: "Batch" },
                { key: null, label: "Note" },
              ].map((col) => (
                <th key={col.label} className="px-3 py-2 text-left font-semibold uppercase tracking-wider text-muted-foreground select-none"
                  style={col.key ? { cursor: "pointer" } : undefined}
                  onClick={col.key ? () => toggleSort(col.key!) : undefined}>
                  <span className="flex items-center gap-1">
                    {col.label}
                    {col.key && sortBy === col.key && <span>{sortDir === "asc" ? "↑" : "↓"}</span>}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={10} className="text-center py-16 text-muted-foreground">
                {isFetching ? "Loading…" : (
                  <div className="flex flex-col items-center gap-2">
                    <Filter className="w-6 h-6 opacity-30" />
                    <span>No history events match your filters</span>
                    {activeFilterCount > 0 && (
                      <button onClick={clearFilters} className="text-xs font-semibold underline underline-offset-2" style={{ color: "hsl(var(--primary))" }}>Clear filters</button>
                    )}
                  </div>
                )}
              </td></tr>
            ) : rows.map((row, idx) => (
              <tr key={row.id} style={{ borderBottom: "1px solid hsl(var(--border))", background: idx % 2 === 0 ? "transparent" : "hsl(var(--muted) / 0.3)" }}>
                <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{new Date(row.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2 font-bold font-mono">{row.symbol}</td>
                <td className="px-3 py-2">
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={row.side === "BUY" ? { background: "hsl(162 88% 42% / 0.15)", color: "hsl(162 88% 46%)" } : { background: "hsl(345 88% 58% / 0.15)", color: "hsl(345 88% 62%)" }}>{row.side}</span>
                </td>
                <td className="px-3 py-2">
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={{ background: `${EVENT_TYPE_COLORS[row.eventType] ?? "hsl(var(--muted-foreground))"} / 0.15)`.replace(")", "").replace("hsl(", "hsl("), color: EVENT_TYPE_COLORS[row.eventType] ?? "hsl(var(--muted-foreground))" }}>
                    {row.eventType.replace(/_/g, " ")}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono">{fmt(row.limitPrice, 2)}</td>
                <td className="px-3 py-2 font-mono text-muted-foreground">{fmt(row.tpPrice, 2)}</td>
                <td className="px-3 py-2 font-mono">{fmt(row.quantity)}</td>
                <td className="px-3 py-2 font-mono text-center">{row.repunchCountAtEvent}</td>
                <td className="px-3 py-2 font-mono text-muted-foreground text-[10px]">{row.batchId ? row.batchId.slice(0, 18) + "…" : "—"}</td>
                <td className="px-3 py-2 text-muted-foreground max-w-[220px] truncate" title={row.note ?? undefined}>{row.note ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">Rows per page</span>
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}
              className="px-2 py-1 rounded-md text-[11px] font-semibold bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring">
              {[10, 25, 50, 100, 200].map((s) => (<option key={s} value={s}>{s}</option>))}
            </select>
          </div>
          <span className="text-[11px] text-muted-foreground">
            {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button disabled={page <= 1} onClick={() => setPage(1)} className="p-1 rounded disabled:opacity-30" style={{ border: "1px solid hsl(var(--border))" }}><ChevronsLeft className="w-3.5 h-3.5" /></button>
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="p-1 rounded disabled:opacity-30" style={{ border: "1px solid hsl(var(--border))" }}><ChevronLeft className="w-3.5 h-3.5" /></button>
            <span className="text-[11px] px-2">{page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="p-1 rounded disabled:opacity-30" style={{ border: "1px solid hsl(var(--border))" }}><ChevronRight className="w-3.5 h-3.5" /></button>
            <button disabled={page >= totalPages} onClick={() => setPage(totalPages)} className="p-1 rounded disabled:opacity-30" style={{ border: "1px solid hsl(var(--border))" }}><ChevronsRight className="w-3.5 h-3.5" /></button>
          </div>
        </div>
      )}
    </div>
  );
}