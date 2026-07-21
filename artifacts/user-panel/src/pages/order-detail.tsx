import React, { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { useGetOpenOrders, useGetClosedOrders } from "@workspace/api-client-react";
import type { Order } from "@workspace/api-client-react/src/generated/api.schemas";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatPnl, formatNumber } from "@/lib/utils";
import { format } from "date-fns";

export default function OrderDetail() {
  const params = useParams();
  const orderId = params.id;
  
  const [order, setOrder] = useState<Order | null>(null);
  
  const getOpenOrders = useGetOpenOrders();
  const getClosedOrders = useGetClosedOrders();

  useEffect(() => {
    const fetchOrder = async () => {
      if (!orderId) return;
      
      try {
        const [openRes, closedRes] = await Promise.all([
          getOpenOrders.mutateAsync({ data: {} }),
          getClosedOrders.mutateAsync({ data: {} })
        ]);
        
        const found = [...(openRes.orders || []), ...(closedRes.orders || [])].find(
          (o) => o.orderId === orderId
        );
        
        if (found) {
          setOrder(found);
        }
      } catch (e) {
        console.error("Failed to fetch order", e);
      }
    };
    
    fetchOrder();
  }, [orderId]);

  if (!order) {
    return (
      <div className="h-[60vh] flex flex-col items-center justify-center space-y-4">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-muted-foreground">Loading order details...</p>
      </div>
    );
  }

  const isBuy = order.side === "BUY";
  const pnlInfo = formatPnl(order.realisedPnl);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 mb-2">
        <Button variant="ghost" size="icon" asChild className="-ml-2">
          <Link href="/orders">
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </Button>
        <h1 className="text-xl font-bold tracking-tight">Order Details</h1>
      </div>

      <Card className="overflow-hidden">
        <div className={`h-2 w-full ${isBuy ? "bg-profit" : "bg-loss"}`} />
        <CardContent className="p-6 space-y-8">
          <div className="flex justify-between items-start">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Badge variant={isBuy ? "profit" : "loss"} className="text-sm px-3 py-1">
                  {order.side}
                </Badge>
                <h2 className="text-2xl font-bold">{order.symbol}</h2>
              </div>
              <p className="text-sm text-muted-foreground">ID: {order.orderId}</p>
            </div>
            <Badge variant="outline" className="capitalize text-sm px-3 py-1">
              {order.status?.toLowerCase().replace("_", " ")}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-y-6">
            <DetailItem label="Order Type" value={order.orderType?.replace("_", " ")} capitalize />
            <DetailItem label="Date" value={order.createdAt ? format(new Date(parseInt(order.createdAt)), "MMM dd, yyyy HH:mm:ss") : "--"} />
            
            <DetailItem label="Quantity" value={formatNumber(order.quantity)} />
            <DetailItem label="Executed Qty" value={formatNumber(order.execQuantity)} />
            
            <DetailItem label="Order Price" value={order.price ? formatCurrency(order.price) : "Market"} />
            <DetailItem label="Avg Exec Price" value={order.avgExecutionPrice ? formatCurrency(order.avgExecutionPrice) : "--"} />
            
            {order.triggerPrice && (
              <DetailItem label="Trigger Price" value={formatCurrency(order.triggerPrice)} />
            )}
            
            <DetailItem label="Fee" value={order.executionFee ? formatCurrency(order.executionFee) : "$0.00"} />
          </div>

          <div className="pt-6 border-t border-border mt-4">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground font-medium">Realised P&L</span>
              <span className={`text-xl font-bold ${pnlInfo.num !== 0 ? (pnlInfo.isProfit ? "text-profit" : "text-loss") : ""}`}>
                {pnlInfo.formatted}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
      
      {order.status === "NEW" && (
        <div className="flex gap-4">
          <Button variant="destructive" className="w-full">
            Cancel Order
          </Button>
        </div>
      )}
    </div>
  );
}

function DetailItem({ label, value, capitalize = false }: { label: string, value: string | undefined | null, capitalize?: boolean }) {
  return (
    <div>
      <p className="text-sm text-muted-foreground mb-1">{label}</p>
      <p className={`font-medium ${capitalize ? "capitalize" : ""}`}>{value || "--"}</p>
    </div>
  );
}
