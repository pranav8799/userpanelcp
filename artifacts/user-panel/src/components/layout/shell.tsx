import React from "react";
import { Link, useLocation } from "wouter";
import { ListOrdered, Briefcase, BarChart3, User, HistoryIcon, Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/auth-context";
import { PriceTicker } from "@/components/layout/PriceTicker";
import { NotificationPopup } from "@/components/layout/NotificationPopup";
import { useNotificationsUnread } from "@/hooks/use-notifications";
import buySellIconImg from "@/assets/buy-sell-icon.png";

// Desktop sidebar nav — BUY / SELL first, then the rest
const NAV_ITEMS = [
  { href: "/place-order", label: "BUY / SELL", isBuySell: true as const },
  { href: "/orders", label: "Orders", icon: ListOrdered },
  { href: "/positions", label: "Positions", icon: Briefcase },
  { href: "/history", label: "History", icon: HistoryIcon }, // ← new
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/notifications", label: "Notifications", icon: Bell }, // ← new
  { href: "/profile", label: "Profile", icon: User },
];

// Mobile bottom nav: Place Order sits in the middle, elevated (unchanged)
const MOBILE_NAV_ITEMS = [
  { href: "/orders", label: "Orders", icon: ListOrdered },
  { href: "/positions", label: "Positions", icon: Briefcase },
  { href: "/place-order", label: "BUY / SELL", icon: BarChart3, isAction: true },
  // { href: "/history", label: "BUY / SELL", icon: BarChart3, isAction: true },

  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/profile", label: "Profile", icon: User },
];

// Small helper so "BUY" renders green and "SELL" renders red everywhere the label appears
function BuySellLabel({ className }: { className?: string }) {
  return (
    <span className={className}>
      <span className="text-profit font-bold">BUY</span>
      <span className="text-muted-foreground"> / </span>
      <span className="text-loss font-bold">SELL</span>
    </span>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { account, isLoading } = useAuth();
  const [location] = useLocation();

  const { latestNotificationAt, hasUnread, markSeen } = useNotificationsUnread(!!account);

  // Visiting the notifications page marks everything seen so far as read
  React.useEffect(() => {
    if (location === "/notifications" && latestNotificationAt) {
      markSeen(latestNotificationAt);
    }
  }, [location, latestNotificationAt]);

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

      {/* Mobile top bar with notification bell */}
      <div className="lg:hidden flex items-center justify-between px-4 h-14 border-b bg-card/50 shrink-0">
        <h1 className="text-base font-bold tracking-tight text-primary flex items-center gap-2">
          <img src={buySellIconImg} alt="My Trade Study" className="w-7 h-7 rounded-md object-cover" />
          My Trade Study
        </h1>
        <Link
          href="/notifications"
          aria-label="Notifications"
          className="relative p-2 -mr-2 rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <Bell className="w-6 h-6" />
          {hasUnread && (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-destructive" />
          )}
        </Link>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Desktop Sidebar */}
        <aside className="hidden lg:flex w-64 flex-col border-r bg-card/50">
          <div className="p-6">
            <h1 className="text-xl font-bold tracking-tight text-primary flex items-center gap-2">
              <img src={buySellIconImg} alt="My Trade Study" className="w-8 h-8 rounded-md object-cover" />
              My Trade Study
            </h1>
          </div>

          <nav className="flex-1 px-4 space-y-1">
            {NAV_ITEMS.map((item) => {
              const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));

              // Special rendering for BUY / SELL at the top
              if ("isBuySell" in item && item.isBuySell) {
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
                    <img src={buySellIconImg} alt="" className="w-5 h-5 rounded-sm object-cover" />
                    <BuySellLabel />
                  </Link>
                );
              }

              // Regular nav items (Orders, Positions, Reports, Notifications, Profile)
              const Icon = item.icon;
              const showDot = item.href === "/notifications" && hasUnread;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 relative",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <span className="relative">
                    <Icon className="w-5 h-5" />
                    {showDot && (
                      <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-destructive" />
                    )}
                  </span>
                  {item.label}
                </Link>
              );
            })}
          </nav>
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
                <BuySellLabel className="text-[10px] mt-1 scale-90" />
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

      {/* Popup for new notifications — renders on every page except login/signup */}
      <NotificationPopup />
    </div>
  );
}