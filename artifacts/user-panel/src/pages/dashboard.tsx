import React from "react";
import { Link } from "wouter";
import { useAuth } from "@/contexts/auth-context";
import { useGetBalance, useGetPnlSummary, useGetClosedOrders, getGetBalanceQueryKey, getGetPnlSummaryQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatPnl } from "@/lib/utils";
import { ArrowRight, RefreshCw, PlusCircle, TrendingUp, TrendingDown, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export default function Dashboard() {
  const { account } = useAuth();
  const queryClient = useQueryClient();

  const { data: balance, isLoading: isBalanceLoading, isRefetching: isBalanceRefetching } = useGetBalance();
  const { data: pnl, isLoading: isPnlLoading, isRefetching: isPnlRefetching } = useGetPnlSummary();
  
  // Use a query hook for closed orders. Wait, the API has useGetClosedOrders as a mutation?
  // Let me check api.ts... Ah, useGetClosedOrders is a POST so it's generated as a mutation hook.
  // We need to use it in useEffect or wrap it in a useQuery if possible. 
  // Let's look at the generated API again.
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
  Hello, {account?.name?.split(" ")[0] ?? "there"}
</h1>
          <p className="text-muted-foreground">Here is your trading overview.</p>
        </div>
        <Button 
          variant="outline" 
          size="icon" 
          onClick={() => {
            queryClient.invalidateQueries({ queryKey: getGetBalanceQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetPnlSummaryQueryKey() });
            // For mutations we might have to manually refetch.
          }}
          className={(isBalanceRefetching || isPnlRefetching) ? "animate-spin" : ""}
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Balance</CardTitle>
          </CardHeader>
          <CardContent>
            {isBalanceLoading ? (
              <Skeleton className="h-10 w-32 mb-2" />
            ) : (
              <div className="text-4xl font-bold tracking-tight">{formatCurrency(balance?.totalBalance)}</div>
            )}
            <div className="flex items-center gap-2 mt-4 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Available:</span> 
              {isBalanceLoading ? <Skeleton className="h-4 w-16 inline-block" /> : formatCurrency(balance?.availableBalance)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Today's P&L</CardTitle>
          </CardHeader>
          <CardContent>
            {isPnlLoading ? (
              <Skeleton className="h-10 w-32 mb-2" />
            ) : (
              <div className={`text-4xl font-bold tracking-tight ${pnl && pnl.todayPnl > 0 ? "text-profit" : pnl && pnl.todayPnl < 0 ? "text-loss" : ""}`}>
                {formatPnl(pnl?.todayPnl).formatted}
              </div>
            )}
            <div className="grid grid-cols-3 gap-2 mt-4 text-xs">
              <div>
                <div className="text-muted-foreground mb-1">Week</div>
                <div className={pnl && pnl.weekPnl > 0 ? "text-profit" : pnl && pnl.weekPnl < 0 ? "text-loss" : ""}>
                  {formatPnl(pnl?.weekPnl).formatted}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground mb-1">Month</div>
                <div className={pnl && pnl.monthPnl > 0 ? "text-profit" : pnl && pnl.monthPnl < 0 ? "text-loss" : ""}>
                  {formatPnl(pnl?.monthPnl).formatted}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground mb-1">Total</div>
                <div className={pnl && pnl.totalPnl > 0 ? "text-profit" : pnl && pnl.totalPnl < 0 ? "text-loss" : ""}>
                  {formatPnl(pnl?.totalPnl).formatted}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex gap-4">
        <Button asChild className="flex-1" size="lg">
          <Link href="/place-order">
            <PlusCircle className="w-5 h-5 mr-2" />
            New Order
          </Link>
        </Button>
        <Button asChild variant="secondary" className="flex-1" size="lg">
          <Link href="/positions">
            <TrendingUp className="w-5 h-5 mr-2" />
            Positions
          </Link>
        </Button>
      </div>

      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Recent Activity</h2>
          <Button asChild variant="link" size="sm">
            <Link href="/orders">View All <ArrowRight className="w-4 h-4 ml-1" /></Link>
          </Button>
        </div>
        <RecentOrders />
      </div>
    </div>
  );
}

function RecentOrders() {
  const getClosedOrders = useGetClosedOrders();
  
  React.useEffect(() => {
    getClosedOrders.mutate({ data: { limit: 5 } });
  }, []);

  if (getClosedOrders.isPending) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
      </div>
    );
  }

  const orders = getClosedOrders.data?.orders || [];

  if (orders.length === 0) {
    return (
      <Card className="bg-muted/30 border-dashed">
        <CardContent className="flex flex-col items-center justify-center p-8 text-center">
          <Clock className="w-8 h-8 text-muted-foreground mb-3 opacity-50" />
          <p className="text-sm font-medium">No recent orders</p>
          <p className="text-xs text-muted-foreground mt-1">Your closed orders will appear here</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {orders.map((order) => {
        const pnlInfo = formatPnl(order.realisedPnl);
        const isBuy = order.side === "BUY";
        
        return (
          <Link key={order.orderId} href={`/orders/${order.orderId}`}>
            <Card className="hover:bg-accent/50 transition-colors cursor-pointer active:scale-[0.99] duration-200">
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <Badge variant={isBuy ? "profit" : "loss"} className="w-12 justify-center">
                    {order.side}
                  </Badge>
                  <div>
                    <div className="font-bold">{order.symbol}</div>
                    <div className="text-xs text-muted-foreground">
                      {order.quantity} @ {formatCurrency(order.avgExecutionPrice || order.price)}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className={`font-medium ${pnlInfo.num !== 0 ? (pnlInfo.isProfit ? "text-profit" : "text-loss") : ""}`}>
                    {pnlInfo.formatted}
                  </div>
                  <div className="text-xs text-muted-foreground capitalize">
                    {order.status?.toLowerCase().replace("_", " ")}
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
