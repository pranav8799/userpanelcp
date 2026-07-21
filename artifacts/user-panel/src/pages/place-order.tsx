import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { usePlaceOrder } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { Loader2, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { orderSchema } from "@/lib/validations";
import { formatCurrency, formatNumber } from "@/lib/utils";

import { Card, CardContent } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export default function PlaceOrder() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const placeOrder = usePlaceOrder();
  
  const [confirmData, setConfirmData] = useState<z.infer<typeof orderSchema> | null>(null);

  const form = useForm<z.infer<typeof orderSchema>>({
    resolver: zodResolver(orderSchema),
    defaultValues: {
      symbol: "BTCUSDT",
      side: "BUY",
      order_type: "MARKET",
      quantity: 0.001,
      reduceOnly: false,
    },
  });

  const orderType = form.watch("order_type");
  const side = form.watch("side");
  
  const requiresPrice = orderType === "LIMIT";
  const requiresTrigger = orderType === "STOP_MARKET" || orderType === "TAKE_PROFIT_MARKET";

  const onSubmit = (data: z.infer<typeof orderSchema>) => {
    setConfirmData(data);
  };

  const handleConfirm = () => {
    if (!confirmData) return;
    
    placeOrder.mutate({ data: confirmData as any }, {
      onSuccess: () => {
        toast({ title: "Order Placed Successfully", description: "Your order has been submitted to the market." });
        setConfirmData(null);
        setLocation("/orders");
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Order Failed", description: err.error || "An error occurred placing the order." });
        setConfirmData(null);
      }
    });
  };

  return (
    <div className="max-w-md mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Place Order</h1>
        <p className="text-muted-foreground text-sm">Execute trades on the market</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <FormField
            control={form.control}
            name="side"
            render={({ field }) => (
              <FormItem>
                <Tabs value={field.value} onValueChange={field.onChange} className="w-full">
                  <TabsList className="w-full h-14 p-1 bg-muted rounded-xl">
                    <TabsTrigger value="BUY" className="w-1/2 h-full rounded-lg font-bold text-base data-[state=active]:bg-profit data-[state=active]:text-profit-foreground transition-all">
                      BUY / LONG
                    </TabsTrigger>
                    <TabsTrigger value="SELL" className="w-1/2 h-full rounded-lg font-bold text-base data-[state=active]:bg-loss data-[state=active]:text-loss-foreground transition-all">
                      SELL / SHORT
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </FormItem>
            )}
          />

          <Card>
            <CardContent className="p-5 space-y-5">
              <FormField
                control={form.control}
                name="symbol"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Symbol</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. BTCUSDT" {...field} className="font-bold text-lg uppercase" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="order_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Order Type</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="MARKET">Market</SelectItem>
                          <SelectItem value="LIMIT">Limit</SelectItem>
                          <SelectItem value="STOP_MARKET">Stop Market</SelectItem>
                          <SelectItem value="TAKE_PROFIT_MARKET">Take Profit Market</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="quantity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Quantity</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.0001" placeholder="0.00" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {requiresPrice && (
                <FormField
                  control={form.control}
                  name="price"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Limit Price</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.01" placeholder="0.00" {...field} value={field.value || ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {requiresTrigger && (
                <FormField
                  control={form.control}
                  name="triggerPrice"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Trigger Price</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.01" placeholder="0.00" {...field} value={field.value || ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="reduceOnly"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 bg-muted/20">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">Reduce Only</FormLabel>
                      <p className="text-xs text-muted-foreground">Only reduces your position size</p>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <Button 
            type="submit" 
            size="xl" 
            className="w-full text-lg shadow-lg"
            variant={side === "BUY" ? "profit" : "loss"}
          >
            {side} {form.watch("symbol")}
          </Button>
        </form>
      </Form>

      {/* Confirmation Dialog */}
      <Dialog open={!!confirmData} onOpenChange={(open) => !open && setConfirmData(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-warning" />
              Confirm Order
            </DialogTitle>
            <DialogDescription>
              Please review your order details before submitting.
            </DialogDescription>
          </DialogHeader>
          
          {confirmData && (
            <div className="space-y-4 py-4">
              <div className={`p-4 rounded-lg flex items-center justify-between font-bold text-xl ${confirmData.side === "BUY" ? "bg-profit/10 text-profit" : "bg-loss/10 text-loss"}`}>
                <span>{confirmData.side}</span>
                <span>{confirmData.symbol}</span>
              </div>
              
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground block mb-1">Order Type</span>
                  <span className="font-medium">{confirmData.order_type.replace("_", " ")}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block mb-1">Quantity</span>
                  <span className="font-medium">{confirmData.quantity}</span>
                </div>
                
                {confirmData.price && (
                  <div>
                    <span className="text-muted-foreground block mb-1">Limit Price</span>
                    <span className="font-medium">{formatCurrency(confirmData.price)}</span>
                  </div>
                )}
                
                {confirmData.triggerPrice && (
                  <div>
                    <span className="text-muted-foreground block mb-1">Trigger Price</span>
                    <span className="font-medium">{formatCurrency(confirmData.triggerPrice)}</span>
                  </div>
                )}

                <div>
                  <span className="text-muted-foreground block mb-1">Options</span>
                  <span className="font-medium">{confirmData.reduceOnly ? "Reduce Only" : "None"}</span>
                </div>
              </div>
            </div>
          )}
          
          <DialogFooter className="flex-col sm:flex-col gap-2 pt-2">
            <Button 
              className="w-full" 
              size="lg"
              variant={confirmData?.side === "BUY" ? "profit" : "loss"}
              onClick={handleConfirm}
              disabled={placeOrder.isPending}
            >
              {placeOrder.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Confirm & Submit
            </Button>
            <Button variant="outline" className="w-full" size="lg" onClick={() => setConfirmData(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
