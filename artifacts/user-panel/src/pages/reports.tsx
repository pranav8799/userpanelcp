import React, { useEffect, useMemo, useState } from "react";
import { useGetClosedOrders } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatPnl } from "@/lib/utils";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from "recharts";
import { format, subDays, isSameDay } from "date-fns";
import { useTheme } from "@/components/theme-provider";

export default function Reports() {
  const getClosedOrders = useGetClosedOrders();
  const { theme } = useTheme();
  const [days, setDays] = useState(30);

  useEffect(() => {
    // Fetch last 30 days of closed orders
    getClosedOrders.mutate({ data: { limit: 500 } });
  }, []);

  const orders = getClosedOrders.data?.orders || [];
  
  const chartData = useMemo(() => {
    if (!orders.length) return [];
    
    const data = [];
    const today = new Date();
    
    // Create an array of the last N days
    for (let i = days - 1; i >= 0; i--) {
      const date = subDays(today, i);
      let dayPnl = 0;
      
      // Sum up realised PNL for this day
      orders.forEach(order => {
        if (order.createdAt && order.realisedPnl) {
          const orderDate = new Date(parseInt(order.createdAt));
          if (isSameDay(date, orderDate)) {
            dayPnl += parseFloat(order.realisedPnl);
          }
        }
      });
      
      data.push({
        date: format(date, "MMM dd"),
        fullDate: date,
        pnl: dayPnl,
        isProfit: dayPnl >= 0
      });
    }
    return data;
  }, [orders, days]);

  const totalPeriodPnl = useMemo(() => chartData.reduce((acc, curr) => acc + curr.pnl, 0), [chartData]);
  const winDays = useMemo(() => chartData.filter(d => d.pnl > 0).length, [chartData]);
  const lossDays = useMemo(() => chartData.filter(d => d.pnl < 0).length, [chartData]);

  const profitColor = theme === 'dark' ? "hsl(142 70% 40%)" : "hsl(142 71% 45%)";
  const lossColor = theme === 'dark' ? "hsl(0 84% 60%)" : "hsl(0 84.2% 60.2%)";
  const gridColor = theme === 'dark' ? "hsl(240 3.7% 15.9%)" : "hsl(240 5.9% 90%)";

  return (
    <div className="space-y-6 h-full flex flex-col pb-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Performance</h1>
        <p className="text-muted-foreground text-sm">Realised P&L over the last {days} days</p>
      </div>

      {getClosedOrders.isPending ? (
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <Card>
            <CardContent className="p-5">
              <div className="text-sm font-medium text-muted-foreground mb-1">Period P&L</div>
              <div className={`text-2xl font-bold ${totalPeriodPnl > 0 ? "text-profit" : totalPeriodPnl < 0 ? "text-loss" : ""}`}>
                {formatPnl(totalPeriodPnl).formatted}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-5">
              <div className="text-sm font-medium text-muted-foreground mb-1">Win/Loss Days</div>
              <div className="text-2xl font-bold flex items-center gap-2">
                <span className="text-profit">{winDays}W</span>
                <span className="text-muted-foreground text-lg">/</span>
                <span className="text-loss">{lossDays}L</span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card className="flex-1 min-h-[400px] flex flex-col">
        <CardHeader>
          <CardTitle>Daily Realised P&L</CardTitle>
          <CardDescription>Daily profit and loss settlement</CardDescription>
        </CardHeader>
        <CardContent className="flex-1 p-0 pb-4">
          {getClosedOrders.isPending ? (
            <div className="p-6 h-full flex items-center justify-center">
              <Skeleton className="w-full h-full" />
            </div>
          ) : chartData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              No data available for this period
            </div>
          ) : (
            <div className="h-[350px] w-full px-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 20, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
                  <XAxis 
                    dataKey="date" 
                    axisLine={false} 
                    tickLine={false} 
                    tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} 
                    minTickGap={20}
                  />
                  <YAxis 
                    axisLine={false} 
                    tickLine={false} 
                    tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                    tickFormatter={(val) => `$${Math.abs(val)}`}
                  />
                  <Tooltip 
                    cursor={{ fill: theme === 'dark' ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)" }}
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload;
                        return (
                          <div className="bg-popover border border-border p-3 rounded-lg shadow-lg">
                            <div className="text-sm font-medium mb-1">{data.date}</div>
                            <div className={`font-bold ${data.isProfit ? "text-profit" : data.pnl < 0 ? "text-loss" : ""}`}>
                              {formatPnl(data.pnl).formatted}
                            </div>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <ReferenceLine y={0} stroke={gridColor} strokeWidth={2} />
                  <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.isProfit ? profitColor : lossColor} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
