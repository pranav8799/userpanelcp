import React, { useEffect } from "react";
import { useGetOpenOrders, useGetClosedOrders } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrency, formatPnl, formatNumber } from "@/lib/utils";
import { Link } from "wouter";
import { format } from "date-fns";
import { RefreshCw, InboxIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Orders() {
  const getOpenOrders = useGetOpenOrders();
  const getClosedOrders = useGetClosedOrders();

  const fetchOrders = () => {
    getOpenOrders.mutate({ data: {} });
    getClosedOrders.mutate({ data: {} });
  };

  useEffect(() => {
    fetchOrders();
  }, []);

  const openOrders = getOpenOrders.data?.orders || [];
  const closedOrders = getClosedOrders.data?.orders || [];
  const isLoading = getOpenOrders.isPending || getClosedOrders.isPending;

  return (
    <div className="space-y-6 h-full flex flex-col">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Orders</h1>
        <Button 
          variant="outline" 
          size="icon" 
          onClick={fetchOrders}
          className={isLoading ? "animate-spin" : ""}
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      <Tabs defaultValue="open" className="flex-1 flex flex-col">
        <TabsList className="w-full grid grid-cols-2">
          <TabsTrigger value="open">Open ({openOrders.length})</TabsTrigger>
          <TabsTrigger value="closed">Closed</TabsTrigger>
        </TabsList>
        
        <TabsContent value="open" className="flex-1 mt-4">
          <OrderList orders={openOrders} isLoading={getOpenOrders.isPending} emptyMessage="No open orders" />
        </TabsContent>
        
        <TabsContent value="closed" className="flex-1 mt-4">
          <OrderList orders={closedOrders} isLoading={getClosedOrders.isPending} emptyMessage="No closed orders" isClosed />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OrderList({ orders, isLoading, emptyMessage, isClosed = false }: { orders: any[], isLoading: boolean, emptyMessage: string, isClosed?: boolean }) {
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
        const pnlInfo = isClosed ? formatPnl(order.realisedPnl) : null;
        
        return (
          <Link key={order.orderId} href={`/orders/${order.orderId}`}>
            <Card className="hover:border-primary/50 transition-colors cursor-pointer active:scale-[0.99] duration-200">
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
                    
                    <div className="text-muted-foreground">Price</div>
                    <div className="font-medium">{formatCurrency(order.avgExecutionPrice || order.price)}</div>
                    
                    {order.triggerPrice && (
                      <>
                        <div className="text-muted-foreground">Trigger</div>
                        <div className="font-medium">{formatCurrency(order.triggerPrice)}</div>
                      </>
                    )}
                  </div>
                  
                  <div className="text-right flex flex-col items-end">
                    {isClosed && pnlInfo && pnlInfo.num !== 0 && (
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
