// pages/orders.tsx
import React, { useEffect, useMemo, useState } from "react";
import { useGetOpenOrders, useCancelOrder, useCancelAllOrders } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { Link, useSearch } from "wouter";
import { format } from "date-fns";
import {
  RefreshCw, InboxIcon, Search, X, SlidersHorizontal, Trash2, Play, Pause, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { DoubleConfirmDialog } from "@/components/double-confirm-dialog";
import { repunchStore, useWatchedSlots, useSetWatchedSlots, type WatchedSlot } from "@/lib/repunchStore";

interface OrderFilters {
  search: string;
  side: "ALL" | "BUY" | "SELL";
  orderType: "ALL" | "MARKET" | "LIMIT";
}

interface RepunchFilters {
  search: string;
  side: "ALL" | "BUY" | "SELL";
  status: "ALL" | "pending_fill" | "placing_tp" | "watching" | "repunching" | "stopped";
}

const DEFAULT_FILTERS: OrderFilters = { search: "", side: "ALL", orderType: "ALL" };
const DEFAULT_REPUNCH_FILTERS: RepunchFilters = { search: "", side: "ALL", status: "ALL" };

type RepunchConfirm =
  | { type: "stop_one"; slotId: string; label: string }
  | { type: "stop_selected"; count: number }
  | { type: "remove_one"; slotId: string; label: string }
  | { type: "remove_selected"; count: number }
  | { type: "clear_all"; count: number }
  | null;

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

const slotStatusStyle = (slot: WatchedSlot): { bg: string; color: string } => {
  if (slot.stopped) return { bg: "hsl(38 92% 45% / 0.15)", color: "hsl(38 92% 45%)" };
  switch (slot.status) {
    case "repunching":
    case "placing_tp":
      return { bg: "hsl(258 82% 64% / 0.15)", color: "hsl(258 82% 64%)" };
    case "pending_fill":
      return { bg: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" };
    case "watching":
    default:
      return { bg: "hsl(162 88% 42% / 0.15)", color: "hsl(162 88% 42%)" };
  }
};

export default function Orders() {
  const { toast } = useToast();
  const search = useSearch();
  const getOpenOrders = useGetOpenOrders();
  const cancelOrderMut = useCancelOrder();
  const cancelAllMut = useCancelAllOrders();

  const initialTab = useMemo<"open" | "repunch">(() => {
    const params = new URLSearchParams(search);
    return params.get("tab") === "repunch" ? "repunch" : "open";
  }, [search]);

  const [tab, setTab] = useState<"open" | "repunch">(initialTab);
  useEffect(() => { setTab(initialTab); }, [initialTab]);

  const [openFilters, setOpenFilters] = useState<OrderFilters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmMode, setConfirmMode] = useState<null | "selected" | "all">(null);
  const [isBusy, setIsBusy] = useState(false);

  const watchedSlots = useWatchedSlots();
  const setWatchedSlots = useSetWatchedSlots();
  const [repunchFilters, setRepunchFilters] = useState<RepunchFilters>(DEFAULT_REPUNCH_FILTERS);
  const [selectedSlots, setSelectedSlots] = useState<Set<string>>(new Set());
  const [repunchConfirm, setRepunchConfirm] = useState<RepunchConfirm>(null);

  const fetchOrders = () => {
    getOpenOrders.mutate({ data: {} });
  };

  useEffect(() => {
    fetchOrders();
  }, []);

  const openOrders = getOpenOrders.data?.orders || [];
  const isLoading = getOpenOrders.isPending;

  const filteredOpen = useMemo(() => {
    const q = openFilters.search.toLowerCase().trim();
    return openOrders.filter((o: any) => {
      if (q && !o.symbol?.toLowerCase().includes(q) && !o.orderId?.toLowerCase().includes(q)) return false;
      if (openFilters.side !== "ALL" && o.side !== openFilters.side) return false;
      if (openFilters.orderType !== "ALL" && o.orderType !== openFilters.orderType) return false;
      return true;
    });
  }, [openOrders, openFilters]);

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

  // Clear stale selections when the open-order list changes underneath us
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(openOrders.map((o: any) => o.orderId));
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => { if (validIds.has(id)) next.add(id); else changed = true; });
      return changed ? next : prev;
    });
  }, [openOrders]);

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

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === filteredOpen.length && filteredOpen.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredOpen.map((o: any) => o.orderId)));
    }
  };

  const doCancelSelected = async () => {
    const toCancel = openOrders.filter((o: any) => selected.has(o.orderId));
    if (!toCancel.length) return;
    setIsBusy(true);
    const results = await Promise.allSettled(
      toCancel.map((o: any) => cancelOrderMut.mutateAsync({ orderId: o.orderId }))
    );
    setIsBusy(false);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    toast({
      title: ok === toCancel.length ? `Cancelled ${ok} order${ok !== 1 ? "s" : ""} ✓` : `Cancelled ${ok}/${toCancel.length}`,
      variant: ok === toCancel.length ? "default" : "destructive",
    });
    setSelected(new Set());
    setConfirmMode(null);
    fetchOrders();
  };

  const doCancelAll = () => {
    setIsBusy(true);
    cancelAllMut.mutate(
      { data: {} },
      {
        onSuccess: () => {
          toast({ title: "All orders cancelled ✓" });
          setIsBusy(false);
          setConfirmMode(null);
          setSelected(new Set());
          fetchOrders();
        },
        onError: (err: any) => {
          setIsBusy(false);
          toast({ title: "Cancel All Failed", description: err?.message, variant: "destructive" });
        },
      }
    );
  };

  /* ── repunch actions ── */
  const toggleOneSlot = (id: string) => {
    setSelectedSlots((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllSlots = () => {
    if (selectedSlots.size === filteredSlots.length && filteredSlots.length > 0) {
      setSelectedSlots(new Set());
    } else {
      setSelectedSlots(new Set(filteredSlots.map((s) => s.id)));
    }
  };

  const toggleStopped = (slotId: string) => {
    setWatchedSlots((prev) => prev.map((s) => (s.id === slotId ? { ...s, stopped: !s.stopped } : s)));
  };

  const setSlotsStopped = (slotIds: Set<string>, stopped: boolean) => {
    setWatchedSlots((prev) => prev.map((s) => (slotIds.has(s.id) ? { ...s, stopped } : s)));
  };

  const removeSlot = (slotId: string) => {
    setWatchedSlots((prev) => prev.filter((s) => s.id !== slotId));
    setSelectedSlots((prev) => { if (!prev.has(slotId)) return prev; const next = new Set(prev); next.delete(slotId); return next; });
  };

  const removeSlots = (slotIds: Set<string>) => {
    setWatchedSlots((prev) => prev.filter((s) => !slotIds.has(s.id)));
    setSelectedSlots(new Set());
  };

  const handleRepunchConfirm = () => {
    if (!repunchConfirm) return;
    if (repunchConfirm.type === "stop_one") setSlotsStopped(new Set([repunchConfirm.slotId]), true);
    else if (repunchConfirm.type === "stop_selected") setSlotsStopped(selectedSlots, true);
    else if (repunchConfirm.type === "remove_one") removeSlot(repunchConfirm.slotId);
    else if (repunchConfirm.type === "remove_selected") removeSlots(selectedSlots);
    else if (repunchConfirm.type === "clear_all") setWatchedSlots([]);
    setRepunchConfirm(null);
  };

  const repunchConfirmCfg = useMemo(() => {
    if (!repunchConfirm) return null;
    switch (repunchConfirm.type) {
      case "stop_one": return { title: "Stop Re-punching", description: `Stop auto re-punch for ${repunchConfirm.label}?`, confirmWord: "STOP", actionLabel: "Stop" };
      case "stop_selected": return { title: "Stop Selected", description: `Stop auto re-punch for ${repunchConfirm.count} selected slot${repunchConfirm.count !== 1 ? "s" : ""}?`, confirmWord: "STOP", actionLabel: "Stop Selected" };
      case "remove_one": return { title: "Remove From Monitor", description: `Remove ${repunchConfirm.label} from the re-punch monitor?`, confirmWord: "REMOVE", actionLabel: "Remove" };
      case "remove_selected": return { title: "Remove Selected", description: `Remove ${repunchConfirm.count} selected slot${repunchConfirm.count !== 1 ? "s" : ""}?`, confirmWord: "REMOVE", actionLabel: "Remove Selected" };
      case "clear_all": return { title: "Clear Re-punch Monitor", description: `Remove all ${repunchConfirm.count} slot${repunchConfirm.count !== 1 ? "s" : ""}?`, confirmWord: "CLEAR", actionLabel: "Clear All" };
    }
  }, [repunchConfirm]);

  const goToTab = (next: "open" | "repunch") => {
    setTab(next);
  };

  return (
    <div className="space-y-6 h-full flex flex-col pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Orders</h1>
        <Button variant="outline" size="icon" onClick={fetchOrders} className={isLoading ? "animate-spin" : ""}>
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      <Tabs value={tab} onValueChange={(v) => goToTab(v as "open" | "repunch")} className="flex-1 flex flex-col">
        <TabsList className="w-full grid grid-cols-2">
          <TabsTrigger value="open">Open Orders ({openOrders.length})</TabsTrigger>
          <TabsTrigger value="repunch">
            Repunch ({watchedSlots.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="open" className="flex-1 mt-4 space-y-3">
          <SearchFilterBar
            filters={openFilters}
            setFilters={setOpenFilters}
            resultCount={filteredOpen.length}
            totalCount={openOrders.length}
            showActions
            selectedCount={selected.size}
            totalOpenCount={openOrders.length}
            onCancelSelected={() => setConfirmMode("selected")}
            onCancelAll={() => setConfirmMode("all")}
          />

          {filteredOpen.length > 0 && (
            <div className="flex items-center gap-2 px-1">
              <Checkbox
                checked={selected.size === filteredOpen.length && filteredOpen.length > 0}
                onCheckedChange={toggleAll}
              />
              <span className="text-xs text-muted-foreground">
                {selected.size > 0 ? `${selected.size} selected` : "Select all"}
              </span>
            </div>
          )}

          <OrderList
            orders={filteredOpen}
            isLoading={getOpenOrders.isPending}
            emptyMessage={openOrders.length === 0 ? "No open orders" : "No orders match your filters"}
            selectable
            selected={selected}
            onToggle={toggleOne}
          />
        </TabsContent>

        <TabsContent value="repunch" className="flex-1 mt-4 space-y-3">
          <RepunchFilterBar
            filters={repunchFilters}
            setFilters={setRepunchFilters}
            resultCount={filteredSlots.length}
            totalCount={watchedSlots.length}
            selectedCount={selectedSlots.size}
            onStopSelected={() => setRepunchConfirm({ type: "stop_selected", count: selectedSlots.size })}
            onResumeSelected={() => setSlotsStopped(selectedSlots, false)}
            onRemoveSelected={() => setRepunchConfirm({ type: "remove_selected", count: selectedSlots.size })}
            onClearAll={() => setRepunchConfirm({ type: "clear_all", count: watchedSlots.length })}
          />

          {filteredSlots.length > 0 && (
            <div className="flex items-center gap-2 px-1">
              <Checkbox
                checked={selectedSlots.size === filteredSlots.length && filteredSlots.length > 0}
                onCheckedChange={toggleAllSlots}
              />
              <span className="text-xs text-muted-foreground">
                {selectedSlots.size > 0 ? `${selectedSlots.size} selected` : "Select all"}
              </span>
            </div>
          )}

          <RepunchList
            slots={filteredSlots}
            totalCount={watchedSlots.length}
            selected={selectedSlots}
            onToggle={toggleOneSlot}
            onToggleStopped={toggleStopped}
            onRequestStopOne={(slotId, label) => setRepunchConfirm({ type: "stop_one", slotId, label })}
            onRequestRemoveOne={(slotId, label) => setRepunchConfirm({ type: "remove_one", slotId, label })}
            onClearFilters={() => setRepunchFilters(DEFAULT_REPUNCH_FILTERS)}
          />
        </TabsContent>
      </Tabs>

      <DoubleConfirmDialog
        open={confirmMode !== null}
        title={confirmMode === "all" ? "Cancel All Orders" : "Cancel Selected Orders"}
        description={
          confirmMode === "all"
            ? `This will cancel all ${openOrders.length} open order${openOrders.length !== 1 ? "s" : ""}.`
            : `This will cancel ${selected.size} selected order${selected.size !== 1 ? "s" : ""}.`
        }
        confirmWord="CANCEL"
        actionLabel={confirmMode === "all" ? "Cancel All" : "Cancel Selected"}
        isLoading={isBusy}
        onCancel={() => setConfirmMode(null)}
        onConfirm={confirmMode === "all" ? doCancelAll : doCancelSelected}
      />

      <DoubleConfirmDialog
        open={repunchConfirm !== null}
        title={repunchConfirmCfg?.title ?? ""}
        description={repunchConfirmCfg?.description ?? ""}
        confirmWord={repunchConfirmCfg?.confirmWord ?? "CONFIRM"}
        actionLabel={repunchConfirmCfg?.actionLabel ?? "Confirm"}
        isLoading={false}
        onCancel={() => setRepunchConfirm(null)}
        onConfirm={handleRepunchConfirm}
      />
    </div>
  );
}

function SearchFilterBar({
  filters, setFilters, resultCount, totalCount,
  showActions, selectedCount, totalOpenCount, onCancelSelected, onCancelAll,
}: {
  filters: OrderFilters;
  setFilters: React.Dispatch<React.SetStateAction<OrderFilters>>;
  resultCount: number;
  totalCount: number;
  showActions?: boolean;
  selectedCount?: number;
  totalOpenCount?: number;
  onCancelSelected?: () => void;
  onCancelAll?: () => void;
}) {
  const activeCount = (filters.search ? 1 : 0) + (filters.side !== "ALL" ? 1 : 0) + (filters.orderType !== "ALL" ? 1 : 0);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          placeholder="Search symbol or order ID…"
          className="w-full pl-9 pr-8 py-2.5 rounded-lg text-sm bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {filters.search && (
          <button
            onClick={() => setFilters((f) => ({ ...f, search: "" }))}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <SlidersHorizontal className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <FilterSelect
          value={filters.side}
          onChange={(v) => setFilters((f) => ({ ...f, side: v as OrderFilters["side"] }))}
          options={[
            { value: "ALL", label: "All Sides" },
            { value: "BUY", label: "▲ Buy" },
            { value: "SELL", label: "▼ Sell" },
          ]}
        />
        <FilterSelect
          value={filters.orderType}
          onChange={(v) => setFilters((f) => ({ ...f, orderType: v as OrderFilters["orderType"] }))}
          options={[
            { value: "ALL", label: "All Types" },
            { value: "MARKET", label: "Market" },
            { value: "LIMIT", label: "Limit" },
          ]}
        />
        {activeCount > 0 && (
          <button
            onClick={() => setFilters(DEFAULT_FILTERS)}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-destructive border border-destructive/30 bg-destructive/5"
          >
            <X className="w-3 h-3" /> Clear ({activeCount})
          </button>
        )}

        {showActions && (
          <div className="ml-auto flex items-center gap-2">
            {(selectedCount ?? 0) > 0 && (
              <button
                onClick={onCancelSelected}
                className="px-2.5 py-1 rounded-md text-[11px] font-bold text-destructive-foreground bg-destructive"
              >
                Cancel Selected ({selectedCount})
              </button>
            )}
            <button
              onClick={onCancelAll}
              disabled={!totalOpenCount}
              className="px-2.5 py-1 rounded-md text-[11px] font-bold text-destructive-foreground bg-destructive disabled:opacity-40"
            >
              Cancel All ({totalOpenCount ?? 0})
            </button>
          </div>
        )}
      </div>

      {!showActions && (
        <span className="block text-[11px] text-muted-foreground text-right">
          {resultCount === totalCount ? `${totalCount} total` : `${resultCount} of ${totalCount}`}
        </span>
      )}
    </div>
  );
}

function RepunchFilterBar({
  filters, setFilters, resultCount, totalCount, selectedCount,
  onStopSelected, onResumeSelected, onRemoveSelected, onClearAll,
}: {
  filters: RepunchFilters;
  setFilters: React.Dispatch<React.SetStateAction<RepunchFilters>>;
  resultCount: number;
  totalCount: number;
  selectedCount: number;
  onStopSelected: () => void;
  onResumeSelected: () => void;
  onRemoveSelected: () => void;
  onClearAll: () => void;
}) {
  const activeCount = (filters.search ? 1 : 0) + (filters.side !== "ALL" ? 1 : 0) + (filters.status !== "ALL" ? 1 : 0);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          placeholder="Search symbol…"
          className="w-full pl-9 pr-8 py-2.5 rounded-lg text-sm bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {filters.search && (
          <button
            onClick={() => setFilters((f) => ({ ...f, search: "" }))}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <SlidersHorizontal className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <FilterSelect
          value={filters.side}
          onChange={(v) => setFilters((f) => ({ ...f, side: v as RepunchFilters["side"] }))}
          options={[
            { value: "ALL", label: "All Sides" },
            { value: "BUY", label: "▲ Buy" },
            { value: "SELL", label: "▼ Sell" },
          ]}
        />
        <FilterSelect
          value={filters.status}
          onChange={(v) => setFilters((f) => ({ ...f, status: v as RepunchFilters["status"] }))}
          options={[
            { value: "ALL", label: "All Statuses" },
            { value: "pending_fill", label: "Pending Fill" },
            { value: "placing_tp", label: "Placing TP" },
            { value: "watching", label: "Watching" },
            { value: "repunching", label: "Re-punching" },
            { value: "stopped", label: "Stopped" },
          ]}
        />
        {activeCount > 0 && (
          <button
            onClick={() => setFilters(DEFAULT_REPUNCH_FILTERS)}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-destructive border border-destructive/30 bg-destructive/5"
          >
            <X className="w-3 h-3" /> Clear ({activeCount})
          </button>
        )}
      </div>

      {selectedCount > 0 ? (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground">{selectedCount} selected</span>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <button onClick={onStopSelected} className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold" style={{ background: "hsl(38 92% 50% / 0.15)", color: "hsl(38 92% 38%)", border: "1px solid hsl(38 92% 50% / 0.3)" }}>
              <Pause className="w-3 h-3" /> Stop
            </button>
            <button onClick={onResumeSelected} className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold" style={{ background: "hsl(162 88% 42% / 0.12)", color: "hsl(162 88% 42%)", border: "1px solid hsl(162 88% 42% / 0.3)" }}>
              <Play className="w-3 h-3" /> Resume
            </button>
            <button onClick={onRemoveSelected} className="px-2.5 py-1 rounded-md text-[11px] font-bold text-destructive-foreground bg-destructive">
              Remove ({selectedCount})
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            {resultCount === totalCount ? `${totalCount} total` : `${resultCount} of ${totalCount}`}
          </span>
          <button
            onClick={onClearAll}
            disabled={totalCount === 0}
            className="px-2.5 py-1 rounded-md text-[11px] font-bold text-destructive-foreground bg-destructive disabled:opacity-40"
          >
            Clear All ({totalCount})
          </button>
        </div>
      )}
    </div>
  );
}

function FilterSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  const isActive = value !== options[0].value;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`appearance-none px-2.5 py-1 rounded-md text-[11px] font-semibold cursor-pointer border ${
        isActive ? "bg-primary/10 text-primary border-primary/30" : "bg-muted text-muted-foreground border-border"
      }`}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function OrderList({
  orders, isLoading, emptyMessage, selectable = false, selected, onToggle,
}: {
  orders: any[];
  isLoading: boolean;
  emptyMessage: string;
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
}) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <Card className="bg-muted/30 border-dashed py-12">
        <CardContent className="flex flex-col items-center justify-center text-center p-0">
          <InboxIcon className="w-10 h-10 text-muted-foreground mb-4 opacity-50" />
          <p className="text-sm font-medium">{emptyMessage}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3 pb-8">
      {orders.map((order) => {
        const isBuy = order.side === "BUY";
        const isSelected = selectable && selected?.has(order.orderId);

        return (
          <Link key={order.orderId} href={`/orders/${order.orderId}`}>
            <Card className={`transition-colors cursor-pointer active:scale-[0.99] duration-200 ${isSelected ? "border-primary/50 bg-primary/5" : "hover:border-primary/50"}`}>
              <CardContent className="p-4">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2">
                    {selectable && (
                      <Checkbox
                        checked={!!isSelected}
                        onCheckedChange={() => onToggle?.(order.orderId)}
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                      />
                    )}
                    <Badge variant={isBuy ? "profit" : "loss"}>{order.side}</Badge>
                    <span className="font-bold">{order.symbol}</span>
                  </div>
                  <Badge variant="outline" className="capitalize text-[10px]">
                    {order.status?.toLowerCase().replace("_", " ")}
                  </Badge>
                </div>

                <div className="flex justify-between items-end mt-3">
                  <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
                    <div className="text-muted-foreground">Type</div>
                    <div className="font-medium capitalize">{order.orderType?.toLowerCase().replace("_", " ")}</div>

                    <div className="text-muted-foreground">Amount</div>
                    <div className="font-medium">{formatNumber(order.quantity, 4)}</div>

                    {order.price && (
                      <>
                        <div className="text-muted-foreground">Price</div>
                        <div className="font-medium">{formatCurrency(order.price)}</div>
                      </>
                    )}

                    {order.triggerPrice && (
                      <>
                        <div className="text-muted-foreground">Trigger</div>
                        <div className="font-medium">{formatCurrency(order.triggerPrice)}</div>
                      </>
                    )}
                  </div>

                  <div className="text-right flex flex-col items-end">
                    {order.createdAt && (
                      <div className="text-[10px] text-muted-foreground mt-auto">
                        {format(new Date(parseInt(order.createdAt)), "MMM dd, HH:mm")}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}

function RepunchList({
  slots, totalCount, selected, onToggle, onToggleStopped, onRequestStopOne, onRequestRemoveOne, onClearFilters,
}: {
  slots: WatchedSlot[];
  totalCount: number;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleStopped: (id: string) => void;
  onRequestStopOne: (id: string, label: string) => void;
  onRequestRemoveOne: (id: string, label: string) => void;
  onClearFilters: () => void;
}) {
  if (slots.length === 0) {
    return (
      <Card className="bg-muted/30 border-dashed py-12">
        <CardContent className="flex flex-col items-center justify-center text-center p-0 gap-1">
          <RefreshCw className="w-10 h-10 text-muted-foreground mb-3 opacity-40" />
          {totalCount === 0 ? (
            <>
              <p className="text-sm font-medium">No orders are being watched for re-punch yet.</p>
              <p className="text-xs text-muted-foreground max-w-[260px]">Enable Auto-punch and take a trade to start monitoring.</p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">No slots match your filters</p>
              <button onClick={onClearFilters} className="text-xs font-semibold underline underline-offset-2 text-primary">Clear filters</button>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3 pb-8">
      {slots.map((slot) => {
        const isSelected = selected.has(slot.id);
        const statusStyle = slotStatusStyle(slot);
        return (
          <Card key={slot.id} className={`transition-colors ${isSelected ? "border-primary/50 bg-primary/5" : ""}`}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Checkbox checked={isSelected} onCheckedChange={() => onToggle(slot.id)} />
                  <span className="font-bold font-mono">{slot.symbol}</span>
                  <Badge variant={slot.side === "BUY" ? "profit" : "loss"}>{slot.side}</Badge>
                </div>
                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold" style={{ background: statusStyle.bg, color: statusStyle.color }}>
                  {slot.status === "repunching" && !slot.stopped && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                  {slotStatusLabel(slot)}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 text-sm mb-3">
                <div>
                  <div className="text-[11px] text-muted-foreground">Limit</div>
                  <div className="font-medium font-mono">{formatCurrency(slot.limitPrice)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">TP</div>
                  <div className="font-medium font-mono">{formatCurrency(slot.tpPrice)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Qty</div>
                  <div className="font-medium font-mono">{formatNumber(slot.quantity, 4)}</div>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={slot.repunchCount > 0 ? { background: "hsl(162 88% 42% / 0.15)", color: "hsl(162 88% 42%)" } : { background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}>
                  {slot.repunchCount === 0 ? "No re-punches yet" : `♻ ×${slot.repunchCount} re-punched`}
                </span>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => { if (slot.stopped) onToggleStopped(slot.id); else onRequestStopOne(slot.id, slot.symbol); }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold transition-all"
                    style={slot.stopped ? { background: "hsl(162 88% 42% / 0.12)", color: "hsl(162 88% 42%)", border: "1px solid hsl(162 88% 42% / 0.3)" } : { background: "hsl(38 92% 50% / 0.12)", color: "hsl(38 92% 38%)", border: "1px solid hsl(38 92% 50% / 0.3)" }}
                  >
                    {slot.stopped ? <><Play className="w-2.5 h-2.5" /> Resume</> : <><Pause className="w-2.5 h-2.5" /> Stop</>}
                  </button>
                  <button
                    onClick={() => onRequestRemoveOne(slot.id, slot.symbol)}
                    className="px-2 py-1 rounded-md text-[10px] font-bold"
                    style={{ border: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}