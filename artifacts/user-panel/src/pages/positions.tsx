import React from "react";
import { useGetPositions, getGetPositionsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatPnl, formatNumber } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { RefreshCw, LayoutTemplate } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

export default function Positions() {
  const queryClient = useQueryClient();
  const { data, isLoading, isRefetching } = useGetPositions();

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetPositionsQueryKey() });
  };

  const positions = data?.positions || [];

  return (
    <div className="space-y-6 h-full flex flex-col pb-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Open Positions</h1>
        <Button 
          variant="outline" 
          size="icon" 
          onClick={handleRefresh}
          className={isRefetching ? "animate-spin" : ""}
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
        </div>
      ) : positions.length === 0 ? (
        <Card className="bg-muted/30 border-dashed py-16 flex-1 flex items-center justify-center">
          <CardContent className="flex flex-col items-center text-center p-0">
            <LayoutTemplate className="w-12 h-12 text-muted-foreground mb-4 opacity-40" />
            <p className="text-lg font-medium">No open positions</p>
            <p className="text-sm text-muted-foreground mt-2 max-w-[250px]">
              When you open positions in the market, they will appear here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {positions.map((position) => {
            const isLong = position.positionSide === "LONG" || position.positionSide === "BOTH" && parseFloat(position.positionSize || "0") > 0;
            const size = Math.abs(parseFloat(position.positionSize || "0"));
            const pnlInfo = formatPnl(position.unrealisedPnl);
            
            return (
              <Card key={`${position.symbol}-${position.positionSide}`} className="overflow-hidden border-border/50 shadow-sm">
                <div className={`h-1 w-full ${isLong ? "bg-profit" : "bg-loss"}`} />
                <CardContent className="p-5">
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex items-center gap-3">
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
      )}
    </div>
  );
}
