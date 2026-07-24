// pages/positions.tsx
import React, { useEffect, useMemo, useState } from "react";
import { useGetPositions, useGetClosedOrders, getGetPositionsQueryKey, placeOrder } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrency, formatPnl, formatNumber } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { RefreshCw, LayoutTemplate, InboxIcon, Search, X, SlidersHorizontal } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { format } from "date-fns";
import { DoubleConfirmDialog } from "@/components/double-confirm-dialog";

interface PositionFilters {
  search: string;
  side: "ALL" | "LONG" | "SHORT";
  pnl: "ALL" | "PROFIT" | "LOSS";
}

interface ClosedOrderFilters {
  search: string;
  side: "ALL" | "BUY" | "SELL";
  orderType: "ALL" | "MARKET" | "LIMIT";
}

const DEFAULT_FILTERS: PositionFilters = { search: "", side: "ALL", pnl: "ALL" };
const DEFAULT_CLOSED_FILTERS: ClosedOrderFilters = { search: "", side: "ALL", orderType: "ALL" };

export default function Positions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, isRefetching, refetch } = useGetPositions();
  const getClosedOrders = useGetClosedOrders();

  const [tab, setTab] = useState<"positions" | "closed">("positions");

  const [filters, setFilters] = useState<PositionFilters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmMode, setConfirmMode] = useState<null | "selected" | "all">(null);
  const [isBusy, setIsBusy] = useState(false);

  const [closedFilters, setClosedFilters] = useState<ClosedOrderFilters>(DEFAULT_CLOSED_FILTERS);

  const positions = data?.positions || [];
  const closedOrders = getClosedOrders.data?.orders || [];

  const posKey = (p: any) => `${p.symbol}-${p.positionSide}`;

  const filteredPositions = useMemo(() => {
    const q = filters.search.toLowerCase().trim();
    return positions.filter((p: any) => {
      if (q && !p.symbol?.toLowerCase().includes(q)) return false;
      if (filters.side !== "ALL" && p.positionSide !== filters.side) return false;
      if (filters.pnl !== "ALL") {
        const pnl = parseFloat(p.unrealisedPnl ?? "0");
        if (filters.pnl === "PROFIT" && pnl <= 0) return false;
        if (filters.pnl === "LOSS" && pnl >= 0) return false;
      }
      return true;
    });
  }, [positions, filters]);

  const filteredClosed = useMemo(() => {
    const q = closedFilters.search.toLowerCase().trim();
    return closedOrders.filter((o: any) => {
      if (q && !o.symbol?.toLowerCase().includes(q) && !o.orderId?.toLowerCase().includes(q)) return false;
      if (closedFilters.side !== "ALL" && o.side !== closedFilters.side) return false;
      if (closedFilters.orderType !== "ALL" && o.orderType !== closedFilters.orderType) return false;
      return true;
    });
  }, [closedOrders, closedFilters]);

  useEffect(() => {
    getClosedOrders.mutate({ data: {} });
  }, []);

  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const validKeys = new Set(positions.map(posKey));
      let changed = false;
      const next = new Set<string>();
      prev.forEach((k) => { if (validKeys.has(k)) next.add(k); else changed = true; });
      return changed ? next : prev;
    });
  }, [positions]);

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetPositionsQueryKey() });
    getClosedOrders.mutate({ data: {} });
  };

  const toggleOne = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === filteredPositions.length && filteredPositions.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredPositions.map(posKey)));
    }
  };

  const exitOne = (pos: any) => {
    const qty = Math.abs(parseFloat(pos.positionSize ?? "0"));
    return placeOrder({
      symbol: pos.symbol,
      side: pos.positionSide === "LONG" ? "SELL" : "BUY",
      order_type: "MARKET",
      quantity: qty,
      reduceOnly: true,
    });
  };

  const doExitSelected = async () => {
    const toExit = positions.filter((p: any) => selected.has(posKey(p)));
    if (!toExit.length) return;
    setIsBusy(true);
    const results = await Promise.allSettled(toExit.map(exitOne));
    setIsBusy(false);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    toast({
      title: ok === toExit.length ? `Exited ${ok} position${ok !== 1 ? "s" : ""} ✓` : `Exited ${ok}/${toExit.length}`,
      variant: ok === toExit.length ? "default" : "destructive",
    });
    setSelected(new Set());
    setConfirmMode(null);
    refetch();
  };

  const doExitAll = async () => {
    if (!positions.length) return;
    setIsBusy(true);
    const results = await Promise.allSettled(positions.map(exitOne));
    setIsBusy(false);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    toast({
      title: ok === positions.length ? `Exited all ${ok} position${ok !== 1 ? "s" : ""} ✓` : `Exited ${ok}/${positions.length}`,
      variant: ok === positions.length ? "default" : "destructive",
    });
    setConfirmMode(null);
    refetch();
  };

  const activeFilterCount = (filters.search ? 1 : 0) + (filters.side !== "ALL" ? 1 : 0) + (filters.pnl !== "ALL" ? 1 : 0);
  const closedActiveFilterCount = (closedFilters.search ? 1 : 0) + (closedFilters.side !== "ALL" ? 1 : 0) + (closedFilters.orderType !== "ALL" ? 1 : 0);

  return (
    <div className="space-y-6 h-full flex flex-col pb-28">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Positions</h1>
        <Button variant="outline" size="icon" onClick={handleRefresh} className={isRefetching ? "animate-spin" : ""}>
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "positions" | "closed")} className="flex-1 flex flex-col">
        <TabsList className="w-full grid grid-cols-2">
          <TabsTrigger value="positions">Positions ({positions.length})</TabsTrigger>
          <TabsTrigger value="closed">Closed Orders</TabsTrigger>
        </TabsList>

        <TabsContent value="positions" className="flex-1 mt-4 space-y-3">
          {/* Search + filters */}
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
                <button onClick={() => setFilters((f) => ({ ...f, search: "" }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <SlidersHorizontal className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <FilterSelect
                value={filters.side}
                onChange={(v) => setFilters((f) => ({ ...f, side: v as PositionFilters["side"] }))}
                options={[
                  { value: "ALL", label: "All Sides" },
                  { value: "LONG", label: "▲ Long" },
                  { value: "SHORT", label: "▼ Short" },
                ]}
              />
              <FilterSelect
                value={filters.pnl}
                onChange={(v) => setFilters((f) => ({ ...f, pnl: v as PositionFilters["pnl"] }))}
                options={[
                  { value: "ALL", label: "All PnL" },
                  { value: "PROFIT", label: "✓ Profit" },
                  { value: "LOSS", label: "✗ Loss" },
                ]}
              />
              {activeFilterCount > 0 && (
                <button
                  onClick={() => setFilters(DEFAULT_FILTERS)}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-destructive border border-destructive/30 bg-destructive/5"
                >
                  <X className="w-3 h-3" /> Clear ({activeFilterCount})
                </button>
              )}

              <div className="ml-auto flex items-center gap-2">
                {selected.size > 0 && (
                  <button
                    onClick={() => setConfirmMode("selected")}
                    className="px-2.5 py-1 rounded-md text-[11px] font-bold text-destructive-foreground bg-destructive"
                  >
                    Exit Selected ({selected.size})
                  </button>
                )}
                <button
                  onClick={() => setConfirmMode("all")}
                  disabled={positions.length === 0}
                  className="px-2.5 py-1 rounded-md text-[11px] font-bold text-destructive-foreground bg-destructive disabled:opacity-40"
                >
                  Exit All ({positions.length})
                </button>
              </div>
            </div>
          </div>

          {isLoading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
            </div>
          ) : filteredPositions.length === 0 ? (
            <Card className="bg-muted/30 border-dashed py-16 flex-1 flex items-center justify-center">
              <CardContent className="flex flex-col items-center text-center p-0">
                <LayoutTemplate className="w-12 h-12 text-muted-foreground mb-4 opacity-40" />
                <p className="text-lg font-medium">
                  {positions.length === 0 ? "No open positions" : "No positions match your filters"}
                </p>
                {positions.length === 0 && (
                  <p className="text-sm text-muted-foreground mt-2 max-w-[250px]">
                    When you open positions in the market, they will appear here.
                  </p>
                )}
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="flex items-center gap-2 px-1">
                <Checkbox
                  checked={selected.size === filteredPositions.length && filteredPositions.length > 0}
                  onCheckedChange={toggleAll}
                />
                <span className="text-xs text-muted-foreground">
                  {selected.size > 0 ? `${selected.size} selected` : "Select all"}
                </span>
              </div>

              <div className="space-y-4 pb-8">
                {filteredPositions.map((position: any) => {
                  const key = posKey(position);
                  const isSelected = selected.has(key);
                  const isLong = position.positionSide === "LONG" || (position.positionSide === "BOTH" && parseFloat(position.positionSize || "0") > 0);
                  const size = Math.abs(parseFloat(position.positionSize || "0"));
                  const pnlInfo = formatPnl(position.unrealisedPnl);

                  return (
                    <Card
                      key={key}
                      onClick={() => toggleOne(key)}
                      className={`overflow-hidden shadow-sm transition-colors cursor-pointer ${isSelected ? "border-primary/50 bg-primary/5" : "border-border/50"}`}
                    >
                      <div className={`h-1 w-full ${isLong ? "bg-profit" : "bg-loss"}`} />
                      <CardContent className="p-5">
                        <div className="flex justify-between items-start mb-4">
                          <div className="flex items-center gap-3">
                            <Checkbox checked={isSelected} onCheckedChange={() => toggleOne(key)} onClick={(e) => e.stopPropagation()} />
                            <Badge variant={isLong ? "profit" : "loss"} className="font-bold">
                              {isLong ? "LONG" : "SHORT"} {position.leverage}x
                            </Badge>
                            <span className="text-lg font-bold">{position.symbol}</span>
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-muted-foreground mb-1">Unrealized P&L</div>
                            <div className={`font-bold text-lg leading-none ${pnlInfo.num !== 0 ? (pnlInfo.isProfit ? "text-profit" : "text-loss") : ""}`}>
                              {pnlInfo.formatted}
                            </div>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-border/50">
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">Size</div>
                            <div className="font-medium">{formatNumber(size, 4)}</div>
                          </div>
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">Value</div>
                            <div className="font-medium">{formatCurrency(position.positionValue)}</div>
                          </div>
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">Entry Price</div>
                            <div className="font-medium">{formatCurrency(position.avgEntryPrice)}</div>
                          </div>
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">Mark Price</div>
                            <div className="font-medium">{formatCurrency(position.markPrice)}</div>
                          </div>
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">Liq. Price</div>
                            <div className="font-medium text-destructive">{formatCurrency(position.liquidationPrice)}</div>
                          </div>
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">Margin</div>
                            <div className="font-medium">{formatCurrency(position.positionMargin)}</div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="closed" className="flex-1 mt-4 space-y-3">
          <div className="space-y-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <input
                value={closedFilters.search}
                onChange={(e) => setClosedFilters((f) => ({ ...f, search: e.target.value }))}
                placeholder="Search symbol or order ID…"
                className="w-full pl-9 pr-8 py-2.5 rounded-lg text-sm bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {closedFilters.search && (
                <button onClick={() => setClosedFilters((f) => ({ ...f, search: "" }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <SlidersHorizontal className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <FilterSelect
                value={closedFilters.side}
                onChange={(v) => setClosedFilters((f) => ({ ...f, side: v as ClosedOrderFilters["side"] }))}
                options={[
                  { value: "ALL", label: "All Sides" },
                  { value: "BUY", label: "▲ Buy" },
                  { value: "SELL", label: "▼ Sell" },
                ]}
              />
              <FilterSelect
                value={closedFilters.orderType}
                onChange={(v) => setClosedFilters((f) => ({ ...f, orderType: v as ClosedOrderFilters["orderType"] }))}
                options={[
                  { value: "ALL", label: "All Types" },
                  { value: "MARKET", label: "Market" },
                  { value: "LIMIT", label: "Limit" },
                ]}
              />
              {closedActiveFilterCount > 0 && (
                <button
                  onClick={() => setClosedFilters(DEFAULT_CLOSED_FILTERS)}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-destructive border border-destructive/30 bg-destructive/5"
                >
                  <X className="w-3 h-3" /> Clear ({closedActiveFilterCount})
                </button>
              )}
              <span className="ml-auto text-[11px] text-muted-foreground">
                {filteredClosed.length === closedOrders.length ? `${closedOrders.length} total` : `${filteredClosed.length} of ${closedOrders.length}`}
              </span>
            </div>
          </div>

          <ClosedOrderList
            orders={filteredClosed}
            isLoading={getClosedOrders.isPending}
            emptyMessage={closedOrders.length === 0 ? "No closed orders" : "No orders match your filters"}
          />
        </TabsContent>
      </Tabs>

      <DoubleConfirmDialog
        open={confirmMode !== null}
        title={confirmMode === "all" ? "Exit All Positions" : "Exit Selected Positions"}
        description={
          confirmMode === "all"
            ? `This will close all ${positions.length} open position${positions.length !== 1 ? "s" : ""} at market price.`
            : `This will close ${selected.size} selected position${selected.size !== 1 ? "s" : ""} at market price.`
        }
        confirmWord="EXIT"
        actionLabel={confirmMode === "all" ? "Exit All" : "Exit Selected"}
        isLoading={isBusy}
        onCancel={() => setConfirmMode(null)}
        onConfirm={confirmMode === "all" ? doExitAll : doExitSelected}
      />
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

function ClosedOrderList({
  orders, isLoading, emptyMessage,
}: {
  orders: any[];
  isLoading: boolean;
  emptyMessage: string;
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
        const pnlInfo = formatPnl(order.realisedPnl);

        return (
          <Link key={order.orderId} href={`/orders/${order.orderId}`}>
            <Card className="transition-colors cursor-pointer active:scale-[0.99] duration-200 hover:border-primary/50">
              <CardContent className="p-4">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2">
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
                    {pnlInfo.num !== 0 && (
                      <div className={`font-bold mb-1 ${pnlInfo.isProfit ? "text-profit" : "text-loss"}`}>
                        {pnlInfo.formatted}
                      </div>
                    )}
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