import React from "react";
import { Link, useLocation } from "wouter";
import { ListOrdered, Briefcase, BarChart3, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/auth-context";
import { PriceTicker } from "@/components/layout/PriceTicker";
import buySellIconImg from "@/assets/buy-sell-icon.png";

// Desktop sidebar nav (unchanged set, minus Dashboard)
const NAV_ITEMS = [
  { href: "/orders", label: "Orders", icon: ListOrdered },
  { href: "/positions", label: "Positions", icon: Briefcase },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/profile", label: "Profile", icon: User },
];

// Mobile bottom nav: Place Order sits in the middle, elevated
const MOBILE_NAV_ITEMS = [
  { href: "/orders", label: "Orders", icon: ListOrdered },
  { href: "/positions", label: "Positions", icon: Briefcase },
  { href: "/place-order", label: "BUY / SELL", icon: BarChart3, isAction: true },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/profile", label: "Profile", icon: User },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const { account, isLoading } = useAuth();
  const [location] = useLocation();

  if (isLoading) {
    return <div className="min-h-screen bg-background flex items-center justify-center">Loading...</div>;
  }

  // Allow login without shell layout
  if (!account && (location === '/login' || location === '/signup')) {
    return <>{children}</>;
  }

  return (
    <div className="flex flex-col h-[100dvh] w-full bg-background overflow-hidden text-foreground">
      {/* Price ticker strip — full width, above sidebar + content */}
      <PriceTicker />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Desktop Sidebar */}
        <aside className="hidden lg:flex w-64 flex-col border-r bg-card/50">
          <div className="p-6">
            <h1 className="text-xl font-bold tracking-tight text-primary flex items-center gap-2">
              <div className="w-6 h-6 rounded bg-primary flex items-center justify-center">
                <span className="text-primary-foreground text-xs font-bold">W</span>
              </div>
              WealthFunds<span className="text-muted-foreground">2x</span>
            </h1>
          </div>

          <nav className="flex-1 px-4 space-y-1">
            {NAV_ITEMS.map((item) => {
              const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <item.icon className="w-5 h-5" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="p-4">
            <Link
              href="/place-order"
              className="flex items-center justify-center gap-2 w-full py-3 px-4 bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg text-sm font-medium transition-colors"
            >
              <img src={buySellIconImg} alt="" className="w-4 h-4 rounded-sm object-cover" />
              BUY / SELL
            </Link>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 flex flex-col min-w-0 overflow-y-auto pb-16 lg:pb-0 relative">
          <div className="flex-1 container max-w-5xl mx-auto p-4 lg:p-8">
            {children}
          </div>
        </main>
      </div>

      {/* Mobile Bottom Nav */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 h-16 bg-card border-t flex items-center justify-around px-2 z-50 safe-area-bottom">
        {MOBILE_NAV_ITEMS.map((item) => {
          const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));

          // Elevated center "Place Order" action button
          if (item.isAction) {
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-col items-center justify-center -mt-8"
              >
                <div
                  className={cn(
                    "flex items-center justify-center w-14 h-14 rounded-full shadow-lg transition-transform active:scale-95 border-4 border-background overflow-hidden",
                    isActive && "ring-2 ring-primary"
                  )}
                >
                  <img src={buySellIconImg} alt="Buy / Sell" className="w-full h-full object-cover" />
                </div>
                <span className="text-[10px] font-medium text-muted-foreground mt-1 scale-90">
                  {item.label}
                </span>
              </Link>
            );
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center justify-center w-full h-full space-y-1 text-xs font-medium transition-colors",
                isActive ? "text-primary" : "text-muted-foreground"
              )}
            >
              <item.icon className={cn("w-5 h-5", isActive && "fill-primary/20")} strokeWidth={isActive ? 2.5 : 2} />
              <span className="scale-90">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}