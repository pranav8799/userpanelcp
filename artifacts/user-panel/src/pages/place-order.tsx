import { useState, useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { repunchStore, useWatchedSlots, useSetWatchedSlots, type WatchedSlot } from "@/lib/repunchStore";
import {
  useGetBalance,
  useGetPositions,
  usePlaceOrder,
  useCancelOrder,
  useCancelAllOrders,
  useGetLeverage,
  useSetLeverage,
  useAddMargin,
  useGetSettings,
  useUpdateSettings,
  getOpenOrders,
  placeOrder,
  OrderInputSide,
  OrderInputOrderType,
  type Position,
  type Order,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  RefreshCw, Plus, Trash2, X, ChevronDown, ChevronLeft, ChevronRight,
  ChevronsLeft, ChevronsRight, AlertTriangle, Loader2,
  Save, Search, Filter, SlidersHorizontal, Pause, Play,
} from "lucide-react";

/* ── types ─────────────────────────────────────────────────── */
interface OpenOrder extends Order {}

interface MultiOrderRow {
  id: number;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  quantity: string;
  price: string;
}

interface AutoPunchConfig {
  orderCount: number;
  stepSize: number;
  tpPoints: number;
}

type ConfirmState =
  | { type: "exit_one"; pos: Position }
  | { type: "exit_selected"; count: number }
  | { type: "exit_all"; count: number }
  | { type: "cancel_all"; count: number }
  | { type: "cancel_selected"; count: number }
  | { type: "cancel_order"; order: OpenOrder }
  | { type: "repunch_stop_one"; slotId: string; label: string }
  | { type: "repunch_stop_selected"; count: number }
  | { type: "repunch_remove_one"; slotId: string; label: string }
  | { type: "repunch_remove_selected"; count: number }
  | { type: "repunch_clear_all"; count: number }
  | { type: "save_and_place" }
  | null;

interface PositionFilters { search: string; side: "ALL" | "LONG" | "SHORT"; pnl: "ALL" | "PROFIT" | "LOSS"; }
interface OrderFilters { search: string; side: "ALL" | "BUY" | "SELL"; orderType: "ALL" | "MARKET" | "LIMIT"; reduceOnly: "ALL" | "YES" | "NO"; }
interface RepunchFilters { search: string; side: "ALL" | "BUY" | "SELL"; status: "ALL" | "pending_fill" | "placing_tp" | "watching" | "repunching" | "stopped"; }

/* ── helpers ── */
const fmt = (v: string | number | null | undefined, decimals = 2) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (n === null || n === undefined || isNaN(n as number)) return "—";
  return (n as number).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};
const fmtINR = (v: number | null | undefined) => {
  if (v == null || isNaN(v)) return "—";
  return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

const pnlColor = (v: string | number | null | undefined) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (n == null || isNaN(n) || n === 0) return "text-muted-foreground";
  return n > 0 ? "text-[hsl(162_88%_42%)]" : "text-[hsl(345_88%_58%)]";
};
const pnlSign = (v: string | number | null | undefined) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (n == null || isNaN(n) || n === 0) return "";
  return n > 0 ? "+" : "";
};
const calcMargin = (quantity: string | number | null | undefined, price: string | number | null | undefined, lev: number): number | null => {
  const q = typeof quantity === "string" ? parseFloat(quantity) : quantity;
  const p = typeof price === "string" ? parseFloat(price) : price;
  if (q == null || isNaN(q) || p == null || isNaN(p) || !p || !lev) return null;
  return (q * p) / lev;
};
const slotStatusLabel = (slot: WatchedSlot): string => {
  if (slot.stopped) return "Stopped";
  switch (slot.status) {
    case "pending_fill": return "Pending Fill";
    case "placing_tp": return "Placing TP";
    case "watching": return "Watching";
    case "repunching": return "Re-punching…";
    default: return slot.status;
  }
};
const slotStatusColor = (slot: WatchedSlot): string => {
  if (slot.stopped) return "hsl(38 92% 45%)";
  switch (slot.status) {
    case "repunching": case "placing_tp": return "hsl(258 82% 64%)";
    case "pending_fill": return "hsl(var(--muted-foreground))";
    case "watching": default: return "hsl(162 88% 42%)";
  }
};

const LEVERAGE_PRESETS = [10, 15, 20, 25, 30];
const SYMBOL_OPTIONS = ["XAUUSDT", "XAGUSDT", "BTCUSDT", "ETHUSDT", "CLUSDT"] as const;
// const ORDER_TYPES: { value: OrderInputOrderType; label: string }[] = [
//   { value: "MARKET", label: "Market" },
//   { value: "LIMIT", label: "Limit" },
// ];
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

/* ══════════════ Pagination ══════════════ */
function usePagination<T>(items: T[], defaultPageSize = 25) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  useEffect(() => { setPage(1); }, [items.length, pageSize]);
  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = pageSize === 0 ? items : items.slice((safePage - 1) * pageSize, safePage * pageSize);
  return { paged, page: safePage, pageSize, totalPages, totalItems: items.length, setPage, setPageSize, hasPrev: safePage > 1, hasNext: safePage < totalPages };
}

interface PaginationBarProps {
  page: number; pageSize: number; totalPages: number; totalItems: number;
  hasPrev: boolean; hasNext: boolean; onPage: (p: number) => void; onPageSize: (s: number) => void;
}
function PaginationBar({ page, pageSize, totalPages, totalItems, hasPrev, hasNext, onPage, onPageSize }: PaginationBarProps) {
  const start = pageSize === 0 ? 1 : (page - 1) * pageSize + 1;
  const end = pageSize === 0 ? totalItems : Math.min(page * pageSize, totalItems);
  const pageNumbers: (number | "…")[] = [];
  if (totalPages <= 7) { for (let i = 1; i <= totalPages; i++) pageNumbers.push(i); }
  else {
    pageNumbers.push(1);
    if (page > 3) pageNumbers.push("…");
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pageNumbers.push(i);
    if (page < totalPages - 2) pageNumbers.push("…");
    pageNumbers.push(totalPages);
  }
  const btnBase: React.CSSProperties = { minWidth: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", transition: "all 0.15s", border: "1px solid hsl(var(--border))", background: "transparent", color: "hsl(var(--muted-foreground))" };
  const btnActive: React.CSSProperties = { ...btnBase, background: "hsl(258 82% 64% / 0.18)", color: "hsl(var(--primary))", border: "1px solid hsl(258 82% 64% / 0.4)" };
  const btnDisabled: React.CSSProperties = { ...btnBase, opacity: 0.35, cursor: "not-allowed" };
  if (totalItems === 0) return null;
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2 shrink-0 flex-wrap" style={{ borderTop: "1px solid hsl(var(--border))", background: "hsl(var(--card))" }}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground shrink-0">Rows per page</span>
        <div className="relative">
          <select value={pageSize === 0 ? "all" : pageSize} onChange={(e) => onPageSize(e.target.value === "all" ? 0 : Number(e.target.value))}
            className="appearance-none pl-2.5 pr-6 py-1 rounded-md text-[11px] font-semibold cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring transition-all"
            style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))", border: "1px solid hsl(var(--border))" }}>
            {PAGE_SIZE_OPTIONS.map((s) => (<option key={s} value={s}>{s}</option>))}
            <option value="all">All</option>
          </select>
          <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none text-muted-foreground" />
        </div>
      </div>
      <span className="text-[11px] text-muted-foreground">
        {totalItems === 0 ? "0 rows" : pageSize === 0 ? `All ${totalItems}` : `${start}–${end} of ${totalItems}`}
      </span>
      {pageSize !== 0 && totalPages > 1 && (
        <div className="flex items-center gap-1">
          <button style={hasPrev ? btnBase : btnDisabled} disabled={!hasPrev} onClick={() => onPage(1)}><ChevronsLeft className="w-3.5 h-3.5" /></button>
          <button style={hasPrev ? btnBase : btnDisabled} disabled={!hasPrev} onClick={() => onPage(page - 1)}><ChevronLeft className="w-3.5 h-3.5" /></button>
          {pageNumbers.map((n, i) => n === "…" ? (<span key={`e-${i}`} className="px-1 text-[11px] text-muted-foreground select-none">…</span>) : (
            <button key={n} style={n === page ? btnActive : btnBase} onClick={() => onPage(n as number)}>{n}</button>
          ))}
          <button style={hasNext ? btnBase : btnDisabled} disabled={!hasNext} onClick={() => onPage(page + 1)}><ChevronRight className="w-3.5 h-3.5" /></button>
          <button style={hasNext ? btnBase : btnDisabled} disabled={!hasNext} onClick={() => onPage(totalPages)}><ChevronsRight className="w-3.5 h-3.5" /></button>
        </div>
      )}
    </div>
  );
}

interface FilterChipProps { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; activeColor?: string; }
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

interface TableToolbarProps {
  searchValue: string; onSearchChange: (v: string) => void; searchPlaceholder: string;
  filterSlot?: React.ReactNode; activeFilterCount: number; onClearFilters: () => void;
  resultCount: number; totalCount: number;
}
function TableToolbar({ searchValue, onSearchChange, searchPlaceholder, filterSlot, activeFilterCount, onClearFilters, resultCount, totalCount }: TableToolbarProps) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 shrink-0 flex-wrap" style={{ borderBottom: "1px solid hsl(var(--border))", background: "hsl(var(--card))" }}>
      <div className="relative flex-1 min-w-[160px] max-w-[280px]">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
        <input value={searchValue} onChange={(e) => onSearchChange(e.target.value)} placeholder={searchPlaceholder}
          className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors" />
        {searchValue && (<button onClick={() => onSearchChange("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"><X className="w-3 h-3" /></button>)}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <SlidersHorizontal className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        {filterSlot}
      </div>
      {activeFilterCount > 0 && (
        <button onClick={onClearFilters} className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-all"
          style={{ color: "hsl(345 88% 62%)", border: "1px solid hsl(345 88% 58% / 0.3)", background: "hsl(345 88% 58% / 0.07)" }}>
          <X className="w-3 h-3" /> Clear ({activeFilterCount})
        </button>
      )}
      <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
        {resultCount === totalCount ? (<span>{totalCount} total</span>) : (<span><span className="font-semibold text-foreground">{resultCount}</span> of {totalCount}</span>)}
      </span>
    </div>
  );
}

/* ══════════════ Confirm Dialog ══════════════ */
function ConfirmDialog({ state, onConfirm, onCancel }: { state: ConfirmState; onConfirm: () => void; onCancel: () => void }) {
  if (!state) return null;
  const cfg = {
    exit_one: { title: "Exit Position", desc: state.type === "exit_one" ? `Close ${state.pos.positionSide} on ${state.pos.symbol}?` : "", label: "Exit Position" },
    exit_selected: { title: "Exit Selected", desc: state.type === "exit_selected" ? `Close ${state.count} position${state.count !== 1 ? "s" : ""}?` : "", label: `Exit Selected` },
    exit_all: { title: "Exit All", desc: state.type === "exit_all" ? `Close all ${state.count} position${state.count !== 1 ? "s" : ""}?` : "", label: `Exit All` },
    cancel_all: { title: "Cancel All Orders", desc: state.type === "cancel_all" ? `Cancel ${state.count} open order${state.count !== 1 ? "s" : ""}?` : "", label: `Cancel All` },
    cancel_selected: { title: "Cancel Selected Orders", desc: state.type === "cancel_selected" ? `Cancel ${state.count} selected order${state.count !== 1 ? "s" : ""}?` : "", label: `Cancel Selected` },
    cancel_order: { title: "Cancel Order", desc: state.type === "cancel_order" ? `Cancel ${state.order.side} ${state.order.orderType} order on ${state.order.symbol}?` : "", label: "Cancel Order" },
    repunch_stop_one: { title: "Stop Re-punching", desc: state.type === "repunch_stop_one" ? `Stop auto re-punch for ${state.label}?` : "", label: "Stop" },
    repunch_stop_selected: { title: "Stop Selected", desc: state.type === "repunch_stop_selected" ? `Stop auto re-punch for ${state.count} selected slot${state.count !== 1 ? "s" : ""}?` : "", label: "Stop Selected" },
    repunch_remove_one: { title: "Remove From Monitor", desc: state.type === "repunch_remove_one" ? `Remove ${state.label} from the re-punch monitor?` : "", label: "Remove" },
    repunch_remove_selected: { title: "Remove Selected", desc: state.type === "repunch_remove_selected" ? `Remove ${state.count} selected slot${state.count !== 1 ? "s" : ""}?` : "", label: "Remove Selected" },
    repunch_clear_all: { title: "Clear Re-punch Monitor", desc: state.type === "repunch_clear_all" ? `Remove all ${state.count} slot${state.count !== 1 ? "s" : ""}?` : "", label: "Clear All" },
    save_and_place: { title: "Place Order", desc: "Save this as your default configuration and place the order now?", label: "Yes, Place Order" },
  }[state.type] as { title: string; desc: string; label: string };

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><AlertTriangle className="w-4 h-4" style={{ color: "hsl(345 88% 58%)" }} />{cfg.title}</DialogTitle>
          <DialogDescription>{cfg.desc}</DialogDescription>
        </DialogHeader>
        <p className="text-xs px-3 py-2 rounded-lg" style={{ background: "hsl(345 88% 58% / 0.08)", border: "1px solid hsl(345 88% 58% / 0.2)", color: "hsl(345 88% 52%)" }}>This action is irreversible.</p>
        <DialogFooter className="gap-2">
          <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ border: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}>Cancel</button>
          <button onClick={onConfirm} className="px-4 py-2 rounded-lg text-sm font-bold" style={{ background: "hsl(345 88% 58%)", color: "#fff" }}>{cfg.label}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ══════════════ Mobile Re-punch Monitor Modal ══════════════ */
interface MobileRepunchModalProps {
  open: boolean;
  onClose: () => void;
  slots: WatchedSlot[];
  filters: RepunchFilters;
  setFilters: (updater: (f: RepunchFilters) => RepunchFilters) => void;
  activeFilterCount: number;
  onClearFilters: () => void;
  totalCount: number;
  selectedSlots: Set<string>;
  setSelectedSlots: React.Dispatch<React.SetStateAction<Set<string>>>;
  onToggleStopped: (slotId: string) => void;
  onRequestStopOne: (slotId: string, label: string) => void;
  onRequestRemoveOne: (slotId: string, label: string) => void;
  onRequestClearAll: () => void;
  onRefresh?: () => void;
}
function MobileRepunchModal({
  open, onClose, slots, filters, setFilters, activeFilterCount, onClearFilters, totalCount,
  selectedSlots, setSelectedSlots, onToggleStopped, onRequestStopOne, onRequestRemoveOne, onRequestClearAll, onRefresh,
}: MobileRepunchModalProps) {
  if (!open) return null;
  return (
    <div className="md:hidden fixed inset-0 z-[60] flex flex-col" style={{ background: "hsl(var(--background))" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: "1px solid hsl(var(--border))" }}>
        <div className="flex items-center gap-2">
          <RefreshCw className="w-4 h-4" style={{ color: "hsl(162 88% 42%)" }} />
          <span className="font-bold text-sm">Re-punch Monitor</span>
          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold" style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}>{totalCount}</span>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors" style={{ border: "1px solid hsl(var(--border))" }}><X className="w-4 h-4" /></button>
      </div>

      {/* Search + filters */}
      <div className="px-4 py-2.5 space-y-2 shrink-0" style={{ borderBottom: "1px solid hsl(var(--border))" }}>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} placeholder="Search symbol…"
            className="w-full pl-8 pr-3 py-2 rounded-lg text-xs bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors" />
          {filters.search && (<button onClick={() => setFilters((f) => ({ ...f, search: "" }))} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"><X className="w-3 h-3" /></button>)}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <FilterChip label="Side" value={filters.side} options={[{ value: "ALL", label: "All Sides" }, { value: "BUY", label: "▲ Buy" }, { value: "SELL", label: "▼ Sell" }]} onChange={(v) => setFilters((f) => ({ ...f, side: v as RepunchFilters["side"] }))} activeColor="hsl(258 82% 60%)" />
          <FilterChip label="Status" value={filters.status} options={[{ value: "ALL", label: "All Statuses" }, { value: "pending_fill", label: "Pending Fill" }, { value: "placing_tp", label: "Placing TP" }, { value: "watching", label: "Watching" }, { value: "repunching", label: "Re-punching" }, { value: "stopped", label: "Stopped" }]} onChange={(v) => setFilters((f) => ({ ...f, status: v as RepunchFilters["status"] }))} activeColor="hsl(162 88% 42%)" />
          {activeFilterCount > 0 && (
            <button onClick={onClearFilters} className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-all"
              style={{ color: "hsl(345 88% 62%)", border: "1px solid hsl(345 88% 58% / 0.3)", background: "hsl(345 88% 58% / 0.07)" }}>
              <X className="w-3 h-3" /> Clear
            </button>
          )}
          {onRefresh && (
            <button onClick={onRefresh} className="ml-auto p-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors" style={{ border: "1px solid hsl(var(--border))" }}>
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {selectedSlots.size > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] text-muted-foreground">{selectedSlots.size} selected</span>
            <button onClick={onRequestClearAll} disabled={totalCount === 0} className="ml-auto px-2.5 py-1 rounded-md text-[10px] font-bold disabled:opacity-40" style={{ background: "hsl(345 88% 58%)", color: "#fff" }}>Clear All ({totalCount})</button>
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {slots.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground px-6 text-center">
            <RefreshCw className="w-6 h-6 opacity-30" />
            {totalCount === 0 ? (
              <>
                <span className="text-sm font-medium">No orders are being watched for re-punch yet.</span>
                <span className="text-[11px] opacity-70">Place a trade with orders configured to start monitoring.</span>
              </>
            ) : (
              <>
                <span className="text-sm font-medium">No slots match your filters</span>
                <button onClick={onClearFilters} className="text-xs font-semibold underline underline-offset-2" style={{ color: "hsl(var(--primary))" }}>Clear filters</button>
              </>
            )}
          </div>
        ) : (
          <div className="p-3 space-y-2">
            {slots.map((slot) => {
              const isSelected = selectedSlots.has(slot.id);
              return (
                <div key={slot.id} className="rounded-xl p-3" style={{ border: `1px solid ${isSelected ? "hsl(258 82% 64% / 0.5)" : "hsl(var(--border))"}`, background: isSelected ? "hsl(258 82% 64% / 0.06)" : "hsl(var(--card))" }}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Checkbox checked={isSelected} onCheckedChange={(v) => { setSelectedSlots((prev) => { const next = new Set(prev); if (v) next.add(slot.id); else next.delete(slot.id); return next; }); }} />
                      <span className="font-bold font-mono text-sm">{slot.symbol}</span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={slot.side === "BUY" ? { background: "hsl(162 88% 42% / 0.15)", color: "hsl(162 88% 46%)" } : { background: "hsl(345 88% 58% / 0.15)", color: "hsl(345 88% 62%)" }}>{slot.side}</span>
                    </div>
                    <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold" style={{ background: `${slotStatusColor(slot)} / 0.15)`.replace(")", "").replace("hsl(", "hsl("), color: slotStatusColor(slot) }}>
                      {slot.status === "repunching" && !slot.stopped && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                      {slotStatusLabel(slot)}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[11px] mb-2.5">
                    <div><p className="text-muted-foreground">Limit</p><p className="font-mono font-semibold">{fmt(slot.limitPrice)}</p></div>
                    <div><p className="text-muted-foreground">TP</p><p className="font-mono font-semibold">{fmt(slot.tpPrice)}</p></div>
                    <div><p className="text-muted-foreground">Qty</p><p className="font-mono font-semibold">{fmt(slot.quantity, 4)}</p></div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={slot.repunchCount > 0 ? { background: "hsl(162 88% 42% / 0.15)", color: "hsl(162 88% 42%)" } : { background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}>{slot.repunchCount === 0 ? "No re-punches yet" : `♻ ×${slot.repunchCount} re-punched`}</span>
                    <div className="flex gap-1.5">
                      <button onClick={() => { if (slot.stopped) onToggleStopped(slot.id); else onRequestStopOne(slot.id, slot.symbol); }}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold transition-all"
                        style={slot.stopped ? { background: "hsl(162 88% 42% / 0.12)", color: "hsl(162 88% 42%)", border: "1px solid hsl(162 88% 42% / 0.3)" } : { background: "hsl(38 92% 50% / 0.12)", color: "hsl(38 92% 38%)", border: "1px solid hsl(38 92% 50% / 0.3)" }}>
                        {slot.stopped ? <><Play className="w-2.5 h-2.5" /> Resume</> : <><Pause className="w-2.5 h-2.5" /> Stop</>}
                      </button>
                      <button onClick={() => onRequestRemoveOne(slot.id, slot.symbol)} className="px-2 py-1 rounded-md text-[10px] font-bold" style={{ border: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}><Trash2 className="w-3 h-3" /></button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════ Main ═══════════════════════════════════ */
export default function PlaceOrder() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  /* ── trade terminal fields (in the order they appear) ── */
  const [symbol, setSymbol] = useState("XAUUSDT");                 // 1. symbol
  const [side, setSide] = useState<OrderInputSide>("BUY");         // 2. buy / sell
  const orderType: OrderInputOrderType = "LIMIT"; // orders are always LIMIT now
  const [price, setPrice] = useState("");                          // 3. price
  const [quantity, setQuantity] = useState("");                    // 4. quantity
  const [leverage, setLeverage] = useState(10);                    // 5. leverage
  const [numberOfOrders, setNumberOfOrders] = useState("");         // 6. number of orders
  const [stepSize, setStepSize] = useState("");                    // 7. buy diff (step size)
  const [takeProfit, setTakeProfit] = useState("");                // 8. take profit (points)
  // 9. available balance — rendered from useGetBalance()
  const [usdInrRate, setUsdInrRate] = useState<number>(87.5); // fallback until live rate loads

  const [isSavingDefaults, setIsSavingDefaults] = useState(false);
  const [defaultsSaved, setDefaultsSaved] = useState(false);
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);
  const [isPunching, setIsPunching] = useState(false);

  const watchedSlots = useWatchedSlots();
  const setWatchedSlots = useSetWatchedSlots();

  const [rightTab, setRightTab] = useState<"positions" | "orders" | "repunch">("positions");
  const [expandedTpsl, setExpandedTpsl] = useState<string | null>(null);
  const [posTpValues, setPosTpValues] = useState<Record<string, { tp: string; sl: string }>>({});
  const [addingMarginKey, setAddingMarginKey] = useState<string | null>(null);
  const [marginAmounts, setMarginAmounts] = useState<Record<string, string>>({});
  const [selectedPositions, setSelectedPositions] = useState<Set<string>>(new Set());
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [selectedSlots, setSelectedSlots] = useState<Set<string>>(new Set());
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);

  const [posFilters, setPosFilters] = useState<PositionFilters>({ search: "", side: "ALL", pnl: "ALL" });
  const [ordFilters, setOrdFilters] = useState<OrderFilters>({ search: "", side: "ALL", orderType: "ALL", reduceOnly: "ALL" });
  const [repunchFilters, setRepunchFilters] = useState<RepunchFilters>({ search: "", side: "ALL", status: "ALL" });

  const [showMulti, setShowMulti] = useState(false);
  const [multiOrders, setMultiOrders] = useState<MultiOrderRow[]>([]);
  const [multiCounter, setMultiCounter] = useState(0);

  const [isExecuting, setIsExecuting] = useState(false);
  const [isExecutingMulti, setIsExecutingMulti] = useState(false);

  /* ── queries ── */
  const { data: balance } = useGetBalance();
  const { data: positionsData, refetch: refetchPositions, isFetching: posLoading } = useGetPositions();
  const positionsArr = positionsData?.positions ?? [];

  const { data: openOrdersData, refetch: refetchOrders, isFetching: ordLoading } = useQuery({
    queryKey: ["openOrders"],
    queryFn: () => getOpenOrders({}),
    refetchInterval: 15_000,
    retry: false,
  });
  const ordersArr = (openOrdersData?.orders ?? []) as OpenOrder[];

  const { data: settings } = useGetSettings();
  const placeOrderMut = usePlaceOrder();
  const cancelOrderMut = useCancelOrder();
  const cancelAllMut = useCancelAllOrders();
  const setLeverageMut = useSetLeverage();
  const addMarginMut = useAddMargin();
  const updateSettingsMut = useUpdateSettings();

  // Load saved defaults (once) into the terminal fields
  const serverConfig = settings?.autoPunchConfig as AutoPunchConfig | undefined;
  useEffect(() => {
    if (serverConfig && !defaultsLoaded) {
      setNumberOfOrders(String(serverConfig.orderCount));
      setStepSize(String(serverConfig.stepSize));
      setTakeProfit(String(serverConfig.tpPoints));
      setDefaultsLoaded(true);
    }
  }, [serverConfig, defaultsLoaded]);
  useEffect(() => { setDefaultsSaved(false); }, [numberOfOrders, stepSize, takeProfit]);

  const getRawBalance = (): number | null => {
    const n = balance?.availableBalance != null ? parseFloat(balance.availableBalance) : null;
    return n != null && !isNaN(n) ? n : null;
  };

  useEffect(() => {
  let cancelled = false;
  fetch("https://api.exchangerate-api.com/v4/latest/USD")
    .then((r) => r.json())
    .then((data) => { if (!cancelled && data?.rates?.INR) setUsdInrRate(data.rates.INR); })
    .catch(() => {}); // keep fallback rate on failure
  return () => { cancelled = true; };
}, []);

  // const handleSaveDefaults = useCallback(() => {
  //   const cfg: AutoPunchConfig = { orderCount: numberOfOrders, stepSize: parseFloat(stepSize) || 0, tpPoints: parseFloat(takeProfit) || 0 };
  //   setIsSavingDefaults(true);
  //   updateSettingsMut.mutate({ data: { autoPunchConfig: cfg } }, {
  //     onSuccess: () => { setIsSavingDefaults(false); setDefaultsSaved(true); toast({ title: "Defaults saved ✓" }); },
  //     onError: (err: any) => { setIsSavingDefaults(false); toast({ title: "Failed to save defaults", description: err.message, variant: "destructive" }); },
  //   });
  // }, [numberOfOrders, stepSize, takeProfit, updateSettingsMut, toast]);

  /* ── multi-order limit ladder, placed after the entry order fills ── */
  const runAutoPunch = useCallback(async (
    tradeSymbol: string,
    tradeSide: OrderInputSide,
    tradeEntryPrice: number,
    baseQty: number,
    cfg: AutoPunchConfig,
    entryLeg?: { orderId?: string }
  ) => {
    setIsPunching(true);

    let totalOk = 0, totalFailed = 0;
    const newSlots: WatchedSlot[] = [];

    // Entry leg
    if (entryLeg) {
      const tp0 = tradeSide === "BUY" ? tradeEntryPrice + cfg.tpPoints : tradeEntryPrice - cfg.tpPoints;
      newSlots.push({
        id: `${tradeSymbol}-${tradeSide}-${tradeEntryPrice}-entry-${Date.now()}`,
        symbol: tradeSymbol,
        side: tradeSide,
        limitPrice: tradeEntryPrice,
        tpPrice: tp0,
        quantity: baseQty,
        repunchCount: 0,
        status: "pending_fill",
        orderId: entryLeg.orderId,
        seenOpen: false,
      });
    }

    // Limit orders
    for (let n = 1; n <= cfg.orderCount; n++) {
      const limitPrice = tradeSide === "BUY"
        ? tradeEntryPrice - cfg.stepSize * n
        : tradeEntryPrice + cfg.stepSize * n;
      const tp = tradeSide === "BUY"
        ? limitPrice + cfg.tpPoints
        : limitPrice - cfg.tpPoints;

      try {
        const result = await placeOrder({
          symbol: tradeSymbol,
          side: tradeSide,
          order_type: "LIMIT",
          quantity: baseQty,
          price: limitPrice,
        });

        newSlots.push({
          id: `${tradeSymbol}-${tradeSide}-${limitPrice}-${Date.now()}-${n}`,
          symbol: tradeSymbol,
          side: tradeSide,
          limitPrice,
          tpPrice: tp,
          quantity: baseQty,
          repunchCount: 0,
          status: "pending_fill",
          orderId: result.orderId,
          seenOpen: false,
        });
        totalOk++;
      } catch (err) {
        totalFailed++;
        console.error("Failed to place limit order", err);
      }
    }

    if (newSlots.length > 0) {
      setWatchedSlots((prev) => [...prev, ...newSlots]);
      setRightTab("repunch");
    }

    setIsPunching(false);

    toast({
      title: totalFailed === 0
        ? `⚡ ${totalOk} order${totalOk !== 1 ? "s" : ""} placed`
        : `⚡ Done — ${totalOk} ok, ${totalFailed} failed`,
      variant: totalFailed > 0 ? "destructive" : "default",
    });

    void refetchOrders();
  }, [toast, setWatchedSlots, refetchOrders]);

  /* ── execute main order ── */
  const handleExecute = useCallback(async () => {
    if (!symbol.trim() || !quantity) { toast({ title: "Symbol and quantity required", variant: "destructive" }); return; }
    if (!price) { toast({ title: "Price is required", variant: "destructive" }); return; }

    const baseQty = parseFloat(quantity);
    setIsExecuting(true);
    let result: { orderId: string; status: string } | null = null;
    try {
      result = await placeOrder({
        symbol: symbol.toUpperCase(), side, order_type: orderType, quantity: baseQty,
        price: parseFloat(price),
      });
      toast({ title: "Order Executed ✓" });
    } catch (err: any) {
      toast({ title: "Order Failed", description: err?.message, variant: "destructive" });
    }
    setIsExecuting(false);

    const orderCount = parseInt(numberOfOrders) || 0;
    const stepSizeNum = parseFloat(stepSize) || 0;
    const tpPointsNum = parseFloat(takeProfit) || 0;

    if (result && orderCount >= 1 && stepSizeNum > 0) {
      const ep = price ? parseFloat(price) : null;
      if (!ep || isNaN(ep)) {
        toast({ title: "Ladder skipped", description: "Enter a price so the ladder knows where to place limit orders.", variant: "destructive" });
      } else {
        void runAutoPunch(symbol.toUpperCase(), side, ep, baseQty, { orderCount, stepSize: stepSizeNum, tpPoints: tpPointsNum }, { orderId: result.orderId });
      }
    }
    void refetchOrders();
    void refetchPositions();
  }, [symbol, quantity, price, side, orderType, numberOfOrders, stepSize, takeProfit, runAutoPunch, toast, refetchOrders, refetchPositions]);

  const handleSaveDefaults = useCallback(() => {
  const cfg: AutoPunchConfig = { orderCount: parseInt(numberOfOrders) || 0, stepSize: parseFloat(stepSize) || 0, tpPoints: parseFloat(takeProfit) || 0 };
  setIsSavingDefaults(true);
  updateSettingsMut.mutate({ data: { autoPunchConfig: cfg } }, {
    onSuccess: () => {
      setIsSavingDefaults(false);
      setDefaultsSaved(true);
      toast({ title: "Defaults saved ✓" });
      void handleExecute();
    },
    onError: (err: any) => {
      setIsSavingDefaults(false);
      toast({ title: "Failed to save defaults", description: err.message, variant: "destructive" });
    },
  });
}, [numberOfOrders, stepSize, takeProfit, updateSettingsMut, toast, handleExecute]);



  /* ── leverage ── */
  const handleSetLeverage = useCallback(() => {
    if (!symbol.trim()) { toast({ title: "Enter a symbol", variant: "destructive" }); return; }
    setLeverageMut.mutate({ data: { symbol: symbol.toUpperCase(), leverage } }, {
      onSuccess: () => toast({ title: `Leverage set to ${leverage}×` }),
      onError: (err: any) => toast({ title: "Leverage Failed", description: err.message, variant: "destructive" }),
    });
  }, [symbol, leverage, setLeverageMut, toast]);

  /* ── Re-punch Monitor stop/resume/remove ── */
  const toggleSlotStopped = useCallback((slotId: string) => {
    setWatchedSlots((prev) => prev.map((s) => (s.id === slotId ? { ...s, stopped: !s.stopped } : s)));
  }, [setWatchedSlots]);
  const setSlotsStopped = useCallback((slotIds: Set<string>, stopped: boolean) => {
    setWatchedSlots((prev) => prev.map((s) => (slotIds.has(s.id) ? { ...s, stopped } : s)));
  }, [setWatchedSlots]);
  const removeSlot = useCallback((slotId: string) => {
    setWatchedSlots((prev) => prev.filter((s) => s.id !== slotId));
    setSelectedSlots((prev) => { if (!prev.has(slotId)) return prev; const next = new Set(prev); next.delete(slotId); return next; });
  }, [setWatchedSlots]);
  const removeSlots = useCallback((slotIds: Set<string>) => {
    setWatchedSlots((prev) => prev.filter((s) => !slotIds.has(s.id)));
    setSelectedSlots(new Set());
  }, [setWatchedSlots]);

  /* ── exit/cancel ── */
  const doExitPosition = useCallback((pos: Position) => {
    const qty = Math.abs(parseFloat(pos.positionSize ?? "0"));
    placeOrder({ symbol: pos.symbol, side: pos.positionSide === "LONG" ? "SELL" : "BUY", order_type: "MARKET", quantity: qty, reduceOnly: true })
      .then(() => { toast({ title: `Exited ${pos.symbol}` }); void refetchPositions(); })
      .catch((err: any) => toast({ title: "Exit Failed", description: err.message, variant: "destructive" }));
  }, [refetchPositions, toast]);

  const doExitSelected = useCallback(async () => {
    const toExit = positionsArr.filter((p) => selectedPositions.has(`${p.symbol}-${p.positionSide}`));
    if (!toExit.length) return;
    await Promise.allSettled(toExit.map((pos) => {
      const qty = Math.abs(parseFloat(pos.positionSize ?? "0"));
      return placeOrder({ symbol: pos.symbol, side: pos.positionSide === "LONG" ? "SELL" : "BUY", order_type: "MARKET", quantity: qty, reduceOnly: true });
    }));
    toast({ title: `Exit orders sent for ${toExit.length} position(s)` });
    setSelectedPositions(new Set());
    void refetchPositions();
  }, [positionsArr, selectedPositions, refetchPositions, toast]);

  const doExitAll = useCallback(async () => {
    if (!positionsArr.length) return;
    await Promise.allSettled(positionsArr.map((pos) => {
      const qty = Math.abs(parseFloat(pos.positionSize ?? "0"));
      return placeOrder({ symbol: pos.symbol, side: pos.positionSide === "LONG" ? "SELL" : "BUY", order_type: "MARKET", quantity: qty, reduceOnly: true });
    }));
    toast({ title: `Exit orders sent for all ${positionsArr.length}` });
    void refetchPositions();
  }, [positionsArr, refetchPositions, toast]);

  const doCancelAll = useCallback(() => {
    cancelAllMut.mutate({ data: { symbol: symbol.trim() ? symbol.toUpperCase() : undefined } }, {
      onSuccess: () => { toast({ title: "All orders cancelled" }); void refetchOrders(); },
      onError: (err: any) => toast({ title: "Cancel All Failed", description: err.message, variant: "destructive" }),
    });
  }, [cancelAllMut, symbol, refetchOrders, toast]);

  const doCancelSelected = useCallback(async () => {
    const toCancel = ordersArr.filter((o) => o.orderId && selectedOrders.has(o.orderId));
    if (!toCancel.length) return;
    const results = await Promise.allSettled(toCancel.map((o) => cancelOrderMut.mutateAsync({ orderId: o.orderId! })));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    toast({ title: ok === toCancel.length ? `Cancelled ${ok} order${ok !== 1 ? "s" : ""} ✓` : `Cancelled ${ok}/${toCancel.length}`, variant: ok === toCancel.length ? "default" : "destructive" });
    setSelectedOrders(new Set());
    void refetchOrders();
  }, [ordersArr, selectedOrders, cancelOrderMut, refetchOrders, toast]);

  const handleCancelOrder = useCallback((order: OpenOrder) => {
    if (!order.orderId) return;
    cancelOrderMut.mutate({ orderId: order.orderId }, {
      onSuccess: () => { toast({ title: "Order cancelled" }); void refetchOrders(); },
      onError: (err: any) => toast({ title: "Cancel Failed", description: err.message, variant: "destructive" }),
    });
  }, [cancelOrderMut, refetchOrders, toast]);

  const handleApplyTpsl = useCallback(async (pos: Position) => {
    const key = `${pos.symbol}-${pos.positionSide}`;
    const vals = posTpValues[key] ?? { tp: "", sl: "" };
    const exitSide = pos.positionSide === "LONG" ? "SELL" : "BUY";
    try {
      if (vals.tp) await placeOrder({ symbol: pos.symbol, side: exitSide, order_type: "TAKE_PROFIT_MARKET", quantity: 0, triggerPrice: parseFloat(vals.tp), reduceOnly: true });
      if (vals.sl) await placeOrder({ symbol: pos.symbol, side: exitSide, order_type: "STOP_MARKET", quantity: 0, triggerPrice: parseFloat(vals.sl), reduceOnly: true });
      toast({ title: `TP/SL set on ${pos.symbol}` });
      setExpandedTpsl(null);
      void refetchOrders();
    } catch (err: any) {
      toast({ title: "TP/SL Failed", description: err.message, variant: "destructive" });
    }
  }, [posTpValues, toast, refetchOrders]);

  const handleAddMargin = useCallback((pos: Position) => {
    const posKey = `${pos.symbol}-${pos.positionSide}`;
    const raw = marginAmounts[posKey];
    const amount = parseFloat(raw ?? "");
    if (!raw || isNaN(amount) || amount <= 0) { toast({ title: "Enter a valid margin amount", variant: "destructive" }); return; }
    addMarginMut.mutate({ data: { symbol: pos.symbol, margin: amount } }, {
      onSuccess: () => {
        toast({ title: `+${amount} USDT margin added ✓` });
        setAddingMarginKey(null);
        setMarginAmounts((prev) => { const next = { ...prev }; delete next[posKey]; return next; });
        void refetchPositions();
      },
      onError: (err: any) => toast({ title: "Add Margin Failed", description: err.message, variant: "destructive" }),
    });
  }, [marginAmounts, addMarginMut, refetchPositions, toast]);

  const handleConfirm = useCallback(() => {
    if (!confirmState) return;
    setConfirmState(null);
    if (confirmState.type === "exit_one") doExitPosition(confirmState.pos);
    else if (confirmState.type === "exit_selected") doExitSelected();
    else if (confirmState.type === "exit_all") doExitAll();
    else if (confirmState.type === "cancel_all") doCancelAll();
    else if (confirmState.type === "cancel_selected") doCancelSelected();
    else if (confirmState.type === "cancel_order") handleCancelOrder(confirmState.order);
    else if (confirmState.type === "repunch_stop_one") setSlotsStopped(new Set([confirmState.slotId]), true);
    else if (confirmState.type === "repunch_stop_selected") setSlotsStopped(selectedSlots, true);
    else if (confirmState.type === "repunch_remove_one") removeSlot(confirmState.slotId);
    else if (confirmState.type === "repunch_remove_selected") removeSlots(selectedSlots);
    else if (confirmState.type === "repunch_clear_all") setWatchedSlots([]);
    else if (confirmState.type === "save_and_place") handleSaveDefaults();
  }, [confirmState, doExitPosition, doExitSelected, doExitAll, doCancelAll, doCancelSelected, handleCancelOrder, setSlotsStopped, removeSlot, removeSlots, selectedSlots, setWatchedSlots]);

  /* ── multi-order ── */
  const addMultiRow = () => { setMultiOrders((prev) => [...prev, { id: multiCounter, symbol: "XAUUSDT", side: "BUY", orderType: "MARKET", quantity: "", price: "" }]); setMultiCounter((c) => c + 1); };
  const removeMultiRow = (id: number) => setMultiOrders((prev) => prev.filter((r) => r.id !== id));
  const updateMultiRow = (id: number, patch: Partial<MultiOrderRow>) => setMultiOrders((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const handleExecuteMulti = async () => {
    const valid = multiOrders.filter((o) => o.symbol.trim() && o.quantity);
    if (!valid.length) return;
    setIsExecutingMulti(true);
    const results = await Promise.allSettled(valid.map((o) =>
      placeOrder({ symbol: o.symbol.toUpperCase(), side: o.side, order_type: o.orderType, quantity: parseFloat(o.quantity), price: o.orderType !== "MARKET" && o.price ? parseFloat(o.price) : undefined })
    ));
    setIsExecutingMulti(false);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    toast({ title: `Multi-order: ${ok}/${valid.length} sent` });
    void refetchOrders();
  };

  /* ── filters ── */
  const filteredPositions = useMemo(() => {
    const q = posFilters.search.toLowerCase().trim();
    return positionsArr.filter((pos) => {
      if (q && !pos.symbol.toLowerCase().includes(q)) return false;
      if (posFilters.side !== "ALL" && pos.positionSide !== posFilters.side) return false;
      if (posFilters.pnl !== "ALL") {
        const pnl = parseFloat(pos.unrealisedPnl ?? "0");
        if (posFilters.pnl === "PROFIT" && pnl <= 0) return false;
        if (posFilters.pnl === "LOSS" && pnl >= 0) return false;
      }
      return true;
    });
  }, [positionsArr, posFilters]);

  const filteredOrders = useMemo(() => {
    const q = ordFilters.search.toLowerCase().trim();
    return ordersArr.filter((order) => {
      if (q && !order.symbol.toLowerCase().includes(q) && !(order.orderId ?? "").toLowerCase().includes(q)) return false;
      if (ordFilters.side !== "ALL" && order.side !== ordFilters.side) return false;
      if (ordFilters.orderType !== "ALL" && order.orderType !== ordFilters.orderType) return false;
      if (ordFilters.reduceOnly !== "ALL") {
        if (ordFilters.reduceOnly === "YES" && !order.reduceOnly) return false;
        if (ordFilters.reduceOnly === "NO" && order.reduceOnly) return false;
      }
      return true;
    });
  }, [ordersArr, ordFilters]);

  const filteredSlots = useMemo(() => {
    const q = repunchFilters.search.toLowerCase().trim();
    return watchedSlots.filter((slot) => {
      if (q && !slot.symbol.toLowerCase().includes(q)) return false;
      if (repunchFilters.side !== "ALL" && slot.side !== repunchFilters.side) return false;
      if (repunchFilters.status !== "ALL") {
        if (repunchFilters.status === "stopped") { if (!slot.stopped) return false; }
        else { if (slot.stopped || slot.status !== repunchFilters.status) return false; }
      }
      return true;
    });
  }, [watchedSlots, repunchFilters]);

  const posActiveFilters = (posFilters.search ? 1 : 0) + (posFilters.side !== "ALL" ? 1 : 0) + (posFilters.pnl !== "ALL" ? 1 : 0);
  const ordActiveFilters = (ordFilters.search ? 1 : 0) + (ordFilters.side !== "ALL" ? 1 : 0) + (ordFilters.orderType !== "ALL" ? 1 : 0) + (ordFilters.reduceOnly !== "ALL" ? 1 : 0);
  const repunchActiveFilters = (repunchFilters.search ? 1 : 0) + (repunchFilters.side !== "ALL" ? 1 : 0) + (repunchFilters.status !== "ALL" ? 1 : 0);
  const clearPosFilters = () => setPosFilters({ search: "", side: "ALL", pnl: "ALL" });
  const clearOrdFilters = () => setOrdFilters({ search: "", side: "ALL", orderType: "ALL", reduceOnly: "ALL" });
  const clearRepunchFilters = () => setRepunchFilters({ search: "", side: "ALL", status: "ALL" });

  const posPagination = usePagination(filteredPositions, 25);
  const ordPagination = usePagination(filteredOrders, 25);
  const repunchPagination = usePagination(filteredSlots, 25);

  useEffect(() => {
    setSelectedOrders((prev) => {
      if (prev.size === 0) return prev;
      const validKeys = new Set(ordersArr.map((o) => o.orderId).filter(Boolean) as string[]);
      let changed = false;
      const next = new Set<string>();
      prev.forEach((k) => { if (validKeys.has(k)) next.add(k); else changed = true; });
      return changed ? next : prev;
    });
  }, [ordersArr]);

  useEffect(() => {
    setSelectedSlots((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(watchedSlots.map((s) => s.id));
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => { if (validIds.has(id)) next.add(id); else changed = true; });
      return changed ? next : prev;
    });
  }, [watchedSlots]);

  const slotsWatching = watchedSlots.filter((s) => !s.stopped && s.status === "watching").length;
  const slotsRepunched = watchedSlots.filter((s) => s.repunchCount > 0).length;
  const slotsStoppedCount = watchedSlots.filter((s) => s.stopped).length;
  const slotsActive = watchedSlots.some((s) => s.status === "repunching");

  const tabs: Array<{ key: "positions" | "orders" | "repunch"; label: string; count: number; filtered: number }> = [
    { key: "positions", label: "Positions", count: positionsArr.length, filtered: filteredPositions.length },
    { key: "orders", label: "Open Orders", count: ordersArr.length, filtered: filteredOrders.length },
    { key: "repunch", label: "Re-punch Monitor", count: watchedSlots.length, filtered: filteredSlots.length },
  ];

  const stepSizeNum = parseFloat(stepSize) || 0;
const tpPointsNum = parseFloat(takeProfit) || 0;
const numberOfOrdersNum = parseInt(numberOfOrders) || 0;
const willLadder = stepSizeNum > 0 && numberOfOrdersNum >= 1;
const totalLegs = willLadder ? 1 + numberOfOrdersNum : 1;
const marginPerOrder = calcMargin(quantity, price, leverage);
const requiredMargin = marginPerOrder != null ? marginPerOrder * totalLegs : null;
const rawBalance = getRawBalance();
const insufficientMargin = requiredMargin != null && rawBalance != null && requiredMargin > rawBalance;
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex flex-1 min-h-0 flex-col md:flex-row overflow-y-auto md:overflow-hidden">
        {/* LEFT PANEL — Trade Terminal */}
        <div className="w-full md:w-80 md:shrink-0 flex flex-col overflow-y-auto" style={{ borderRight: "1px solid hsl(var(--border))" }}>
          <div className="p-4 pb-8 flex flex-col gap-3">

            {/* 1. Symbol */}
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1 block">Symbol</label>
              <div className="relative">
                <select value={symbol} onChange={(e) => setSymbol(e.target.value)}
                  className="w-full appearance-none rounded-lg px-3 py-2.5 pr-9 text-sm font-bold uppercase tracking-wider bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors cursor-pointer">
                  {SYMBOL_OPTIONS.map((s) => (<option key={s} value={s}>{s}</option>))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none text-muted-foreground" />
              </div>
            </div>

            {/* 2. Buy / Sell */}
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setSide("BUY")} className="py-3 rounded-xl font-bold text-sm tracking-wide transition-all"
                style={side === "BUY" ? { background: "hsl(162 88% 42%)", color: "#fff", boxShadow: "0 0 20px hsl(162 88% 42% / 0.35)" } : { border: "1px solid hsl(162 88% 42% / 0.35)", color: "hsl(162 88% 48%)", background: "hsl(162 88% 42% / 0.06)" }}>▲ BUY / LONG</button>
              <button onClick={() => setSide("SELL")} className="py-3 rounded-xl font-bold text-sm tracking-wide transition-all"
                style={side === "SELL" ? { background: "hsl(345 88% 58%)", color: "#fff", boxShadow: "0 0 20px hsl(345 88% 58% / 0.35)" } : { border: "1px solid hsl(345 88% 58% / 0.35)", color: "hsl(345 88% 64%)", background: "hsl(345 88% 58% / 0.06)" }}>▼ SELL / SHORT</button>
            </div>

            {/* <div className="flex gap-1 p-1 rounded-lg" style={{ background: "hsl(var(--muted))" }}>
              {ORDER_TYPES.map((ot) => (
                <button key={ot.value} onClick={() => setOrderType(ot.value)} className="flex-1 py-1.5 text-xs font-semibold rounded-md transition-all"
                  style={orderType === ot.value ? { background: "hsl(var(--card))", color: "hsl(var(--foreground))" } : { color: "hsl(var(--muted-foreground))" }}>{ot.label}</button>
              ))}
            </div> */}

            {/* 3. Price */}
            {/* 3 & 4. Price + Quantity */}
<div className="grid grid-cols-2 gap-2">
  <div>
    <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1 block">Price (USDT)</label>
    <input className="w-full rounded-lg px-3 py-2.5 text-sm font-mono bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors" type="number" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
  </div>
  <div>
    <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1 block">Quantity</label>
    <input className="w-full rounded-lg px-3 py-2.5 text-sm font-mono bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors" type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0.00" />
  </div>
</div>
{stepSizeNum > 0 && numberOfOrdersNum > 0 && (<p className="text-[10px] -mt-2" style={{ color: "hsl(258 82% 60%)" }}>⚡ Will ladder {numberOfOrdersNum} limit{numberOfOrdersNum !== 1 ? "s" : ""} from this price after entry.</p>)}

            {/* 5. Leverage */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Leverage</label>
                <span className="text-xs font-bold" style={{ color: "hsl(var(--primary))" }}>{leverage}×</span>
              </div>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex gap-1 flex-wrap">
                  {LEVERAGE_PRESETS.map((lv) => (
                    <button key={lv} onClick={() => setLeverage(lv)} className="px-1.5 py-0.5 rounded text-[11px] font-semibold transition-all"
                      style={leverage === lv ? { background: "hsl(258 82% 64% / 0.2)", color: "hsl(var(--primary))", border: "1px solid hsl(258 82% 64% / 0.4)" } : { background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))", border: "1px solid transparent" }}>{lv}×</button>
                  ))}
                </div>
                <button onClick={handleSetLeverage} disabled={setLeverageMut.isPending} className="px-4 py-1.5 rounded-xl font-semibold text-xs whitespace-nowrap transition-all disabled:opacity-50"
                  style={{ border: "1px solid hsl(258 82% 64% / 0.35)", color: "hsl(var(--primary))", background: "hsl(258 82% 64% / 0.06)" }}>{setLeverageMut.isPending ? "Setting…" : `Set ${leverage}×`}</button>
              </div>
            </div>

            <div className="border-t border-border" />

            {/* 6. Number of Orders */}
            <div>
  <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1 block">Number of Orders</label>
  <input
    className="w-full rounded-lg px-3 py-2 text-sm font-mono bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors"
    type="number" min="0" step="1" inputMode="numeric" value={numberOfOrders}
    onChange={(e) => setNumberOfOrders(e.target.value)} placeholder="e.g. 6" />
</div>

            {/* 7. Buy Diff (step size) */}
            {/* 7 & 8. Buy Diff + Take Profit */}
<div className="grid grid-cols-2 gap-2">
  <div>
    <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1 block">Buy Diff (pts)</label>
    <input
      className="w-full rounded-lg px-3 py-2 text-sm font-mono bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors"
      type="number" min="0" step="1" inputMode="decimal" value={stepSize}
      onChange={(e) => setStepSize(e.target.value)} placeholder="e.g. 50" />
  </div>
  <div>
    <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1 block">Take Profit (pts)</label>
    <input
      className="w-full rounded-lg px-3 py-2 text-sm font-mono bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors"
      type="number" min="0" step="1" inputMode="decimal" value={takeProfit}
      onChange={(e) => setTakeProfit(e.target.value)} placeholder="e.g. 100" />
  </div>
</div>
<p className="text-[10px] text-muted-foreground -mt-2">
  Limits every {stepSizeNum || "…"} pts {side === "BUY" ? "below" : "above"} entry · TP = limit {side === "BUY" ? "+" : "−"} {tpPointsNum || "…"} pts.
</p>

            {/* <button onClick={() => setConfirmState({ type: "save_and_place" })} disabled={isSavingDefaults} className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold transition-all disabled:opacity-50"
              style={defaultsSaved ? { background: "hsl(162 88% 42% / 0.12)", color: "hsl(162 88% 42%)", border: "1px solid hsl(162 88% 42% / 0.3)" } : { background: "hsl(258 82% 64% / 0.1)", color: "hsl(var(--primary))", border: "1px solid hsl(258 82% 64% / 0.3)" }}>
              {isSavingDefaults ? <><Loader2 className="w-3 h-3 animate-spin" /> Saving…</> : defaultsSaved ? <><Save className="w-3 h-3" /> Saved ✓</> : <><Save className="w-3 h-3" /> Save as Default</>}
            </button> */}

            {watchedSlots.length > 0 && (
              <button
                onClick={() => {
                  setRightTab("repunch");
                  setLocation("/orders?tab=repunch");
                }}
                className="w-full text-left rounded-xl overflow-hidden transition-colors" style={{ border: "1px solid hsl(162 88% 42% / 0.3)", background: "hsl(162 88% 42% / 0.04)" }}>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="flex items-center gap-1.5 text-[10px] font-semibold" style={{ color: "hsl(162 88% 42%)" }}>
                    <RefreshCw className="w-3 h-3" />Re-punch Monitor
                    {slotsActive && (<span className="w-2 h-2 rounded-full animate-pulse" style={{ background: "hsl(258 82% 64%)" }} />)}
                  </span>
                  <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold" style={{ background: "hsl(162 88% 42% / 0.15)", color: "hsl(162 88% 42%)" }}>{watchedSlots.length} slots</span>
                </div>
                <div className="flex items-center justify-between px-3 pb-2.5 gap-2" style={{ borderTop: "1px solid hsl(162 88% 42% / 0.15)" }}>
                  <span className="text-[9px] text-muted-foreground pt-1.5">{slotsWatching} watching · {slotsRepunched} re-punched{slotsStoppedCount > 0 && ` · ${slotsStoppedCount} stopped`}</span>
                  <span className="shrink-0 text-[10px] font-bold mt-1.5" style={{ color: "hsl(162 88% 42%)" }}>View all →</span>
                </div>
              </button>
            )}

            <div className="border-t border-border" />

            {/* 9. Available Balance */}
            {/* Margin Required + Available Balance */}
<div className="rounded-xl p-3 text-xs space-y-2" style={{ border: `1px solid ${insufficientMargin ? "hsl(345 88% 58% / 0.4)" : "hsl(var(--border))"}` }}>
  <div>
    <div className="flex justify-between items-baseline">
      <span className="text-muted-foreground">Margin Required{willLadder ? ` (${totalLegs} orders)` : ""}</span>
      <span className="font-mono font-semibold" style={insufficientMargin ? { color: "hsl(345 88% 58%)" } : undefined}>
        {requiredMargin != null ? `${fmt(requiredMargin)} USDT` : "—"}
      </span>
    </div>
    <div className="flex justify-end">
      <span className="font-mono text-[10px] text-muted-foreground">
        {requiredMargin != null ? fmtINR(requiredMargin * usdInrRate) : ""}
      </span>
    </div>
  </div>
  <div className="border-t border-border" />
  <div>
    <div className="flex justify-between items-baseline">
      <span className="text-muted-foreground">Available Balance</span>
      <span className="font-mono font-semibold">{rawBalance != null ? `${fmt(rawBalance)} USDT` : "—"}</span>
    </div>
    <div className="flex justify-end">
      <span className="font-mono text-[10px] text-muted-foreground">
        {rawBalance != null ? fmtINR(rawBalance * usdInrRate) : ""}
      </span>
    </div>
  </div>
  {insufficientMargin && (
    <p className="text-[10px]" style={{ color: "hsl(345 88% 58%)" }}>⚠ Required margin exceeds available balance.</p>
  )}
</div>  

            <div className="space-y-2 pt-1">
              <button onClick={handleExecute} disabled={isExecuting} className="w-full py-3 rounded-xl font-bold text-sm tracking-wide transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                style={side === "BUY" ? { background: "hsl(162 88% 42%)", color: "#fff", boxShadow: "0 0 16px hsl(162 88% 42% / 0.3)" } : { background: "hsl(345 88% 58%)", color: "#fff", boxShadow: "0 0 16px hsl(345 88% 58% / 0.3)" }}>
                {isExecuting ? "Executing…" : isPunching ? "Laddering…" : `${side} ${symbol}`}
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div className="hidden md:flex flex-1 flex-col min-w-0 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 shrink-0 flex-wrap gap-2" style={{ borderBottom: "1px solid hsl(var(--border))" }}>
            <div className="flex gap-1 flex-wrap">
              {tabs.map(({ key, label, count, filtered }) => {
                const isActive = rightTab === key;
                const hasFilter = key === "positions" ? posActiveFilters > 0 : key === "orders" ? ordActiveFilters > 0 : repunchActiveFilters > 0;
                return (
                  <button key={key} onClick={() => setRightTab(key)} className="px-4 py-1.5 rounded-lg text-sm font-semibold transition-all flex items-center gap-1.5"
                    style={isActive ? { background: "hsl(258 82% 64% / 0.15)", color: "hsl(var(--primary))" } : { color: "hsl(var(--muted-foreground))" }}>
                    {key === "repunch" && <RefreshCw className="w-3.5 h-3.5" />}{label}
                    <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: isActive ? "hsl(258 82% 64% / 0.2)" : "hsl(var(--muted))", color: isActive ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))" }}>{hasFilter ? `${filtered}/${count}` : count}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              {rightTab === "positions" && (
                <>
                  {selectedPositions.size > 0 && (<button onClick={() => setConfirmState({ type: "exit_selected", count: selectedPositions.size })} className="px-3 py-1.5 rounded-lg text-xs font-bold" style={{ background: "hsl(345 88% 58% / 0.15)", color: "hsl(345 88% 62%)", border: "1px solid hsl(345 88% 58% / 0.3)" }}>Exit Selected ({selectedPositions.size})</button>)}
                  <button onClick={() => setConfirmState({ type: "exit_all", count: positionsArr.length })} disabled={positionsArr.length === 0} className="px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-40" style={{ background: "hsl(345 88% 58%)", color: "#fff" }}>Exit All ({positionsArr.length})</button>
                </>
              )}
              {rightTab === "orders" && (
                <>
                  {selectedOrders.size > 0 && (<button onClick={() => setConfirmState({ type: "cancel_selected", count: selectedOrders.size })} className="px-3 py-1.5 rounded-lg text-xs font-bold" style={{ background: "hsl(345 88% 58% / 0.15)", color: "hsl(345 88% 62%)", border: "1px solid hsl(345 88% 58% / 0.3)" }}>Cancel Selected ({selectedOrders.size})</button>)}
                  <button onClick={() => setConfirmState({ type: "cancel_all", count: ordersArr.length })} disabled={ordersArr.length === 0} className="px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-40" style={{ background: "hsl(345 88% 58%)", color: "#fff" }}>Cancel All ({ordersArr.length})</button>
                </>
              )}
              {rightTab === "repunch" && (
                <>
                  {selectedSlots.size > 0 && (
                    <>
                      <button onClick={() => setConfirmState({ type: "repunch_stop_selected", count: selectedSlots.size })} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold" style={{ background: "hsl(38 92% 50% / 0.15)", color: "hsl(38 92% 38%)", border: "1px solid hsl(38 92% 50% / 0.3)" }}><Pause className="w-3 h-3" /> Stop Selected ({selectedSlots.size})</button>
                      <button onClick={() => setSlotsStopped(selectedSlots, false)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold" style={{ background: "hsl(162 88% 42% / 0.12)", color: "hsl(162 88% 42%)", border: "1px solid hsl(162 88% 42% / 0.3)" }}><Play className="w-3 h-3" /> Resume Selected</button>
                      <button onClick={() => setConfirmState({ type: "repunch_remove_selected", count: selectedSlots.size })} className="px-3 py-1.5 rounded-lg text-xs font-bold" style={{ background: "hsl(345 88% 58% / 0.15)", color: "hsl(345 88% 62%)", border: "1px solid hsl(345 88% 58% / 0.3)" }}>Remove ({selectedSlots.size})</button>
                    </>
                  )}
                  <button onClick={() => setConfirmState({ type: "repunch_clear_all", count: watchedSlots.length })} disabled={watchedSlots.length === 0} className="px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-40" style={{ background: "hsl(345 88% 58%)", color: "#fff" }}>Clear All ({watchedSlots.length})</button>
                </>
              )}
              <button onClick={() => rightTab === "positions" ? void refetchPositions() : void refetchOrders()} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors" style={{ border: "1px solid hsl(var(--border))" }}><RefreshCw className={`w-3.5 h-3.5 ${posLoading || ordLoading ? "animate-spin" : ""}`} /></button>
            </div>
          </div>

          {rightTab === "positions" && (
            <TableToolbar searchValue={posFilters.search} onSearchChange={(v) => setPosFilters((f) => ({ ...f, search: v }))} searchPlaceholder="Search symbol…" activeFilterCount={posActiveFilters} onClearFilters={clearPosFilters} resultCount={filteredPositions.length} totalCount={positionsArr.length}
              filterSlot={<>
                <FilterChip label="Side" value={posFilters.side} options={[{ value: "ALL", label: "All Sides" }, { value: "LONG", label: "▲ Long" }, { value: "SHORT", label: "▼ Short" }]} onChange={(v) => setPosFilters((f) => ({ ...f, side: v as PositionFilters["side"] }))} activeColor="hsl(258 82% 60%)" />
                <FilterChip label="PnL" value={posFilters.pnl} options={[{ value: "ALL", label: "All PnL" }, { value: "PROFIT", label: "✓ Profit" }, { value: "LOSS", label: "✗ Loss" }]} onChange={(v) => setPosFilters((f) => ({ ...f, pnl: v as PositionFilters["pnl"] }))} activeColor="hsl(162 88% 42%)" />
              </>} />
          )}
          {rightTab === "orders" && (
            <TableToolbar searchValue={ordFilters.search} onSearchChange={(v) => setOrdFilters((f) => ({ ...f, search: v }))} searchPlaceholder="Search symbol or order ID…" activeFilterCount={ordActiveFilters} onClearFilters={clearOrdFilters} resultCount={filteredOrders.length} totalCount={ordersArr.length}
              filterSlot={<>
                <FilterChip label="Side" value={ordFilters.side} options={[{ value: "ALL", label: "All Sides" }, { value: "BUY", label: "▲ Buy" }, { value: "SELL", label: "▼ Sell" }]} onChange={(v) => setOrdFilters((f) => ({ ...f, side: v as OrderFilters["side"] }))} activeColor="hsl(258 82% 60%)" />
                <FilterChip label="Type" value={ordFilters.orderType} options={[{ value: "ALL", label: "All Types" }, { value: "MARKET", label: "Market" }, { value: "LIMIT", label: "Limit" }]} onChange={(v) => setOrdFilters((f) => ({ ...f, orderType: v as OrderFilters["orderType"] }))} activeColor="hsl(258 82% 60%)" />
                <FilterChip label="Reduce Only" value={ordFilters.reduceOnly} options={[{ value: "ALL", label: "All Orders" }, { value: "YES", label: "Reduce Only" }, { value: "NO", label: "Non-Reduce" }]} onChange={(v) => setOrdFilters((f) => ({ ...f, reduceOnly: v as OrderFilters["reduceOnly"] }))} activeColor="hsl(38 92% 40%)" />
              </>} />
          )}
          {rightTab === "repunch" && (
            <TableToolbar searchValue={repunchFilters.search} onSearchChange={(v) => setRepunchFilters((f) => ({ ...f, search: v }))} searchPlaceholder="Search symbol…" activeFilterCount={repunchActiveFilters} onClearFilters={clearRepunchFilters} resultCount={filteredSlots.length} totalCount={watchedSlots.length}
              filterSlot={<>
                <FilterChip label="Side" value={repunchFilters.side} options={[{ value: "ALL", label: "All Sides" }, { value: "BUY", label: "▲ Buy" }, { value: "SELL", label: "▼ Sell" }]} onChange={(v) => setRepunchFilters((f) => ({ ...f, side: v as RepunchFilters["side"] }))} activeColor="hsl(258 82% 60%)" />
                <FilterChip label="Status" value={repunchFilters.status} options={[{ value: "ALL", label: "All Statuses" }, { value: "pending_fill", label: "Pending Fill" }, { value: "placing_tp", label: "Placing TP" }, { value: "watching", label: "Watching" }, { value: "repunching", label: "Re-punching" }, { value: "stopped", label: "Stopped" }]} onChange={(v) => setRepunchFilters((f) => ({ ...f, status: v as RepunchFilters["status"] }))} activeColor="hsl(162 88% 42%)" />
              </>} />
          )}

          <div className="flex-1 overflow-auto">
            {rightTab === "positions" && (
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr style={{ background: "hsl(var(--muted))", borderBottom: "1px solid hsl(var(--border))" }}>
                    <th className="px-3 py-2 text-left w-6"><Checkbox checked={selectedPositions.size === positionsArr.length && positionsArr.length > 0} onCheckedChange={(v) => { if (v) setSelectedPositions(new Set(positionsArr.map((p) => `${p.symbol}-${p.positionSide}`))); else setSelectedPositions(new Set()); }} /></th>
                    {["Sym", "Side", "Size", "Entry", "PnL", "Liq.", "Actions"].map((h) => (<th key={h} className="px-3 py-2 text-left font-semibold uppercase tracking-wider text-muted-foreground">{h}</th>))}
                  </tr>
                </thead>
                <tbody>
                  {filteredPositions.length === 0 ? (
                    <tr><td colSpan={8} className="text-center py-16 text-muted-foreground">
                      {positionsArr.length === 0 ? "No open positions" : (<div className="flex flex-col items-center gap-2"><Filter className="w-6 h-6 opacity-30" /><span>No positions match your filters</span><button onClick={clearPosFilters} className="text-xs font-semibold underline underline-offset-2" style={{ color: "hsl(var(--primary))" }}>Clear filters</button></div>)}
                    </td></tr>
                  ) : posPagination.paged.map((pos, idx) => {
                    const posKey = `${pos.symbol}-${pos.positionSide}`;
                    const isSelected = selectedPositions.has(posKey);
                    const isTpslOpen = expandedTpsl === posKey;
                    const tpVals = posTpValues[posKey] ?? { tp: "", sl: "" };
                    return (
                      <>
                        <tr key={posKey} style={{ borderBottom: isTpslOpen ? "none" : "1px solid hsl(var(--border))", background: isSelected ? "hsl(258 82% 64% / 0.06)" : idx % 2 === 0 ? "transparent" : "hsl(var(--muted) / 0.3)" }}>
                          <td className="px-3 py-2.5"><Checkbox checked={isSelected} onCheckedChange={(v) => { setSelectedPositions((prev) => { const next = new Set(prev); if (v) next.add(posKey); else next.delete(posKey); return next; }); }} /></td>
                          <td className="px-3 py-2.5 font-bold font-mono">{pos.symbol}</td>
                          <td className="px-3 py-2.5"><span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={pos.positionSide === "LONG" ? { background: "hsl(162 88% 42% / 0.15)", color: "hsl(162 88% 46%)" } : { background: "hsl(345 88% 58% / 0.15)", color: "hsl(345 88% 62%)" }}>{pos.positionSide === "LONG" ? "▲" : "▼"}</span></td>
                          <td className="px-3 py-2.5 font-mono">{fmt(pos.positionSize, 4)}</td>
                          <td className="px-3 py-2.5 font-mono">{fmt(pos.avgEntryPrice)}</td>
                          <td className={`px-3 py-2.5 font-mono font-semibold ${pnlColor(pos.unrealisedPnl)}`}>{pnlSign(pos.unrealisedPnl)}{fmt(pos.unrealisedPnl)} USDT</td>
                          <td className="px-3 py-2.5 font-mono text-muted-foreground">
                            {addingMarginKey === posKey ? (
                              <div className="flex items-center gap-1">
                                <input autoFocus type="number" min="0" step="any" value={marginAmounts[posKey] ?? ""} onChange={(e) => setMarginAmounts((prev) => ({ ...prev, [posKey]: e.target.value }))}
                                  onKeyDown={(e) => { if (e.key === "Enter") handleAddMargin(pos); if (e.key === "Escape") setAddingMarginKey(null); }} placeholder="+USDT"
                                  className="w-16 rounded px-1.5 py-0.5 text-xs font-mono bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring" />
                                <button onClick={() => handleAddMargin(pos)} disabled={addMarginMut.isPending} className="px-1.5 py-0.5 rounded text-[10px] font-bold disabled:opacity-50" style={{ background: "hsl(162 88% 42%)", color: "#fff" }}>{addMarginMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Add"}</button>
                                <button onClick={() => setAddingMarginKey(null)} className="p-0.5 text-muted-foreground hover:text-foreground"><X className="w-3 h-3" /></button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1 group cursor-pointer" onClick={() => setAddingMarginKey(posKey)} title="Add margin to move liquidation price">
                                <span>{fmt(pos.liquidationPrice)}</span><Plus className="w-2.5 h-2.5 opacity-0 group-hover:opacity-60 transition-opacity" style={{ color: "hsl(162 88% 42%)" }} />
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex gap-1.5">
                              <button onClick={() => setConfirmState({ type: "exit_one", pos })} className="px-2.5 py-1 rounded-md text-[10px] font-bold" style={{ background: "hsl(345 88% 58%)", color: "#fff" }}>Exit</button>
                              <button onClick={() => setExpandedTpsl(isTpslOpen ? null : posKey)} className="px-2.5 py-1 rounded-md text-[10px] font-bold transition-all" style={isTpslOpen ? { background: "hsl(258 82% 64% / 0.2)", color: "hsl(var(--primary))" } : { border: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}>TP/SL</button>
                            </div>
                          </td>
                        </tr>
                        {isTpslOpen && (
                          <tr key={`${posKey}-tpsl`}><td colSpan={8} style={{ borderBottom: "1px solid hsl(var(--border))", padding: 0 }}>
                            <div className="flex items-center gap-3 px-6 py-3" style={{ background: "hsl(258 82% 64% / 0.05)", borderTop: "1px dashed hsl(var(--border))" }}>
                              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground w-24">{pos.symbol} TP/SL</span>
                              <div className="flex items-center gap-1.5"><span className="text-[10px] text-muted-foreground">Take Profit</span><input className="w-28 rounded px-2 py-1.5 text-xs font-mono bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring" type="number" step="any" value={tpVals.tp} onChange={(e) => setPosTpValues((prev) => ({ ...prev, [posKey]: { ...tpVals, tp: e.target.value } }))} placeholder="TP price" /></div>
                              <div className="flex items-center gap-1.5"><span className="text-[10px] text-muted-foreground">Stop Loss</span><input className="w-28 rounded px-2 py-1.5 text-xs font-mono bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring" type="number" step="any" value={tpVals.sl} onChange={(e) => setPosTpValues((prev) => ({ ...prev, [posKey]: { ...tpVals, sl: e.target.value } }))} placeholder="SL price" /></div>
                              <button onClick={() => handleApplyTpsl(pos)} className="px-3 py-1.5 rounded-md text-xs font-bold" style={{ background: "hsl(var(--primary))", color: "#fff" }}>Apply</button>
                              <button onClick={() => setExpandedTpsl(null)} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
                            </div>
                          </td></tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            )}

            {rightTab === "orders" && (
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr style={{ background: "hsl(var(--muted))", borderBottom: "1px solid hsl(var(--border))" }}>
                    <th className="px-3 py-2 text-left w-6"><Checkbox checked={selectedOrders.size === filteredOrders.length && filteredOrders.length > 0} onCheckedChange={(v) => { if (v) setSelectedOrders(new Set(filteredOrders.map((o) => o.orderId).filter(Boolean) as string[])); else setSelectedOrders(new Set()); }} /></th>
                    {["Symbol", "Side", "Type", "Qty", "Price", "Margin Req.", "Status", "Reduce Only", "Created", "Actions"].map((h) => (<th key={h} className="px-3 py-2 text-left font-semibold uppercase tracking-wider text-muted-foreground">{h}</th>))}
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.length === 0 ? (
                    <tr><td colSpan={11} className="text-center py-16 text-muted-foreground">
                      {ordersArr.length === 0 ? "No open orders" : (<div className="flex flex-col items-center gap-2"><Filter className="w-6 h-6 opacity-30" /><span>No orders match your filters</span><button onClick={clearOrdFilters} className="text-xs font-semibold underline underline-offset-2" style={{ color: "hsl(var(--primary))" }}>Clear filters</button></div>)}
                    </td></tr>
                  ) : ordPagination.paged.map((order, idx) => {
                    const rowKey = order.orderId ?? `row-${idx}`;
                    const isOrderSelected = order.orderId ? selectedOrders.has(order.orderId) : false;
                    const margin = calcMargin(order.quantity, order.price, leverage);
                    return (
                      <tr key={rowKey} style={{ borderBottom: "1px solid hsl(var(--border))", background: isOrderSelected ? "hsl(258 82% 64% / 0.06)" : idx % 2 === 0 ? "transparent" : "hsl(var(--muted) / 0.3)" }}>
                        <td className="px-3 py-2.5"><Checkbox checked={isOrderSelected} disabled={!order.orderId} onCheckedChange={(v) => { if (!order.orderId) return; setSelectedOrders((prev) => { const next = new Set(prev); if (v) next.add(order.orderId!); else next.delete(order.orderId!); return next; }); }} /></td>
                        <td className="px-3 py-2.5 font-bold font-mono">{order.symbol}</td>
                        <td className="px-3 py-2.5"><span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={order.side === "BUY" ? { background: "hsl(162 88% 42% / 0.15)", color: "hsl(162 88% 46%)" } : { background: "hsl(345 88% 58% / 0.15)", color: "hsl(345 88% 62%)" }}>{order.side}</span></td>
                        <td className="px-3 py-2.5 text-muted-foreground">{order.orderType}</td>
                        <td className="px-3 py-2.5 font-mono">{fmt(order.quantity, 4)}</td>
                        <td className="px-3 py-2.5 font-mono">{order.orderType === "TAKE_PROFIT_MARKET" || order.orderType === "STOP_MARKET" ? (order.triggerPrice ? fmt(order.triggerPrice) : "—") : (order.price && order.price !== "0" ? fmt(order.price) : "—")}</td>
                        <td className="px-3 py-2.5 font-mono text-muted-foreground">{margin != null ? `${fmt(margin)} USDT` : "—"}</td>
                        <td className="px-3 py-2.5"><span className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: "hsl(258 82% 64% / 0.12)", color: "hsl(var(--primary))" }}>{order.status}</span></td>
                        <td className="px-3 py-2.5 text-muted-foreground">{order.reduceOnly ? "Yes" : "—"}</td>
                        <td className="px-3 py-2.5 text-muted-foreground">{order.createdAt ? new Date(order.createdAt).toLocaleTimeString() : "—"}</td>
                        <td className="px-3 py-2.5"><button onClick={() => setConfirmState({ type: "cancel_order", order })} disabled={!order.orderId || cancelOrderMut.isPending} className="px-2.5 py-1 rounded-md text-[10px] font-bold disabled:opacity-50" style={{ border: "1px solid hsl(345 88% 58% / 0.4)", color: "hsl(345 88% 62%)" }}>Cancel</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {rightTab === "repunch" && (
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr style={{ background: "hsl(var(--muted))", borderBottom: "1px solid hsl(var(--border))" }}>
                    <th className="px-3 py-2 text-left w-6"><Checkbox checked={selectedSlots.size === filteredSlots.length && filteredSlots.length > 0} onCheckedChange={(v) => { if (v) setSelectedSlots(new Set(filteredSlots.map((s) => s.id))); else setSelectedSlots(new Set()); }} /></th>
                    {["Symbol", "Side", "Limit Price", "TP Price", "Qty", "Status", "Re-punches", "Actions"].map((h) => (<th key={h} className="px-3 py-2 text-left font-semibold uppercase tracking-wider text-muted-foreground">{h}</th>))}
                  </tr>
                </thead>
                <tbody>
                  {filteredSlots.length === 0 ? (
                    <tr><td colSpan={8} className="text-center py-16 text-muted-foreground">
                      {watchedSlots.length === 0 ? (<div className="flex flex-col items-center gap-2"><RefreshCw className="w-6 h-6 opacity-30" /><span>No orders are being watched for re-punch yet.</span><span className="text-[11px] opacity-70">Place a trade with orders configured to start monitoring.</span></div>) : (<div className="flex flex-col items-center gap-2"><Filter className="w-6 h-6 opacity-30" /><span>No slots match your filters</span><button onClick={clearRepunchFilters} className="text-xs font-semibold underline underline-offset-2" style={{ color: "hsl(var(--primary))" }}>Clear filters</button></div>)}
                    </td></tr>
                  ) : repunchPagination.paged.map((slot, idx) => {
                    const isSlotSelected = selectedSlots.has(slot.id);
                    return (
                      <tr key={slot.id} style={{ borderBottom: "1px solid hsl(var(--border))", background: isSlotSelected ? "hsl(258 82% 64% / 0.06)" : idx % 2 === 0 ? "transparent" : "hsl(var(--muted) / 0.3)" }}>
                        <td className="px-3 py-2.5"><Checkbox checked={isSlotSelected} onCheckedChange={(v) => { setSelectedSlots((prev) => { const next = new Set(prev); if (v) next.add(slot.id); else next.delete(slot.id); return next; }); }} /></td>
                        <td className="px-3 py-2.5 font-bold font-mono">{slot.symbol}</td>
                        <td className="px-3 py-2.5"><span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={slot.side === "BUY" ? { background: "hsl(162 88% 42% / 0.15)", color: "hsl(162 88% 46%)" } : { background: "hsl(345 88% 58% / 0.15)", color: "hsl(345 88% 62%)" }}>{slot.side}</span></td>
                        <td className="px-3 py-2.5 font-mono">{fmt(slot.limitPrice)}</td>
                        <td className="px-3 py-2.5 font-mono text-muted-foreground">{fmt(slot.tpPrice)}</td>
                        <td className="px-3 py-2.5 font-mono">{fmt(slot.quantity, 4)}</td>
                        <td className="px-3 py-2.5"><span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold w-fit" style={{ background: `${slotStatusColor(slot)} / 0.15)`.replace(")", "").replace("hsl(", "hsl("), color: slotStatusColor(slot) }}>{slot.status === "repunching" && !slot.stopped && <Loader2 className="w-2.5 h-2.5 animate-spin" />}{slotStatusLabel(slot)}</span></td>
                        <td className="px-3 py-2.5"><span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={slot.repunchCount > 0 ? { background: "hsl(162 88% 42% / 0.15)", color: "hsl(162 88% 42%)" } : { background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}>{slot.repunchCount === 0 ? "—" : `♻ ×${slot.repunchCount}`}</span></td>
                        <td className="px-3 py-2.5">
                          <div className="flex gap-1.5">
                            <button onClick={() => { if (slot.stopped) toggleSlotStopped(slot.id); else setConfirmState({ type: "repunch_stop_one", slotId: slot.id, label: slot.symbol }); }}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold transition-all"
                              style={slot.stopped ? { background: "hsl(162 88% 42% / 0.12)", color: "hsl(162 88% 42%)", border: "1px solid hsl(162 88% 42% / 0.3)" } : { background: "hsl(38 92% 50% / 0.12)", color: "hsl(38 92% 38%)", border: "1px solid hsl(38 92% 50% / 0.3)" }}>
                              {slot.stopped ? <><Play className="w-2.5 h-2.5" /> Resume</> : <><Pause className="w-2.5 h-2.5" /> Stop</>}
                            </button>
                            <button onClick={() => setConfirmState({ type: "repunch_remove_one", slotId: slot.id, label: slot.symbol })} className="px-2 py-1 rounded-md text-[10px] font-bold" style={{ border: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}><Trash2 className="w-3 h-3" /></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {rightTab === "positions" && filteredPositions.length > 0 && (<PaginationBar page={posPagination.page} pageSize={posPagination.pageSize} totalPages={posPagination.totalPages} totalItems={posPagination.totalItems} hasPrev={posPagination.hasPrev} hasNext={posPagination.hasNext} onPage={posPagination.setPage} onPageSize={posPagination.setPageSize} />)}
          {rightTab === "orders" && filteredOrders.length > 0 && (<PaginationBar page={ordPagination.page} pageSize={ordPagination.pageSize} totalPages={ordPagination.totalPages} totalItems={ordPagination.totalItems} hasPrev={ordPagination.hasPrev} hasNext={ordPagination.hasNext} onPage={ordPagination.setPage} onPageSize={ordPagination.setPageSize} />)}
          {rightTab === "repunch" && filteredSlots.length > 0 && (<PaginationBar page={repunchPagination.page} pageSize={repunchPagination.pageSize} totalPages={repunchPagination.totalPages} totalItems={repunchPagination.totalItems} hasPrev={repunchPagination.hasPrev} hasNext={repunchPagination.hasNext} onPage={repunchPagination.setPage} onPageSize={repunchPagination.setPageSize} />)}
        </div>
      </div>

      <ConfirmDialog state={confirmState} onConfirm={handleConfirm} onCancel={() => setConfirmState(null)} />
    </div>
  );
}