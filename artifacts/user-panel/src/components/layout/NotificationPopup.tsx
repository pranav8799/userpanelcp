import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Bell, X } from "lucide-react";
import { useNotificationsUnread } from "@/hooks/use-notifications";
import { useAuth } from "@/contexts/auth-context";

export function NotificationPopup() {
  const { account } = useAuth();
  const [location, navigate] = useLocation();
  const { latest, latestNotificationAt, hasUnread, markSeen } = useNotificationsUnread(!!account);

  // Tracks a notification the user explicitly closed with the X — resets on
  // reload/new tab, and resets automatically once a *newer* notification
  // arrives (since dismissedAt won't match the new latestNotificationAt).
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);

  const shouldShow =
    !!account &&
    location !== "/notifications" &&
    hasUnread &&
    !!latest &&
    latestNotificationAt !== dismissedAt;

  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(shouldShow);
  }, [shouldShow]);

  if (!visible || !latest) return null;

  const handleClick = () => {
    if (latestNotificationAt) markSeen(latestNotificationAt);
    setVisible(false);
    navigate("/notifications");
  };

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (latestNotificationAt) setDismissedAt(latestNotificationAt);
    setVisible(false);
  };

  return (
    <div className="fixed z-[60] top-16 lg:top-6 left-1/2 -translate-x-1/2 lg:left-auto lg:right-6 lg:translate-x-0 w-[calc(100%-2rem)] max-w-sm animate-in slide-in-from-top-4 fade-in duration-300">
      <button
        onClick={handleClick}
        className="w-full text-left bg-card border border-border shadow-lg rounded-xl p-4 flex items-start gap-3 hover:bg-accent/50 transition-colors"
      >
        <span className="flex items-center justify-center w-9 h-9 rounded-full bg-primary/10 text-primary shrink-0">
          <Bell className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">{latest.title || "New notification"}</div>
          <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{latest.message}</div>
        </div>
        <span
          role="button"
          aria-label="Dismiss"
          onClick={handleDismiss}
          className="p-1 -mr-1 -mt-1 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground shrink-0"
        >
          <X className="w-4 h-4" />
        </span>
      </button>
    </div>
  );
}