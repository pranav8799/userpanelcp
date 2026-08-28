import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

const LAST_SEEN_KEY = "notifications:lastSeenAt";

export interface NotificationSummary {
  id: number;
  title: string;
  message: string;
  targetType: "ALL" | "ACCOUNT";
  createdAt: string;
}

async function fetchNotifications(): Promise<NotificationSummary[]> {
  const res = await fetch("/api/notifications", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load notifications");
  return res.json();
}

/**
 * Shared notifications-unread state. Both the sidebar/bottom-nav badge and
 * the popup read from the same react-query cache (same queryKey), so this
 * doesn't cause extra network requests when used in multiple components.
 */
export function useNotificationsUnread(enabled: boolean) {
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);

  useEffect(() => {
    setLastSeenAt(localStorage.getItem(LAST_SEEN_KEY));
  }, []);

  const query = useQuery({
    queryKey: ["notifications", "unread-check"],
    queryFn: fetchNotifications,
    enabled,
    refetchInterval: 60_000,
  });

  const latest = query.data?.[0] ?? null;
  const latestNotificationAt = latest?.createdAt ?? null;
  const hasUnread = !!latestNotificationAt && (!lastSeenAt || latestNotificationAt > lastSeenAt);

  const markSeen = (timestamp: string) => {
    localStorage.setItem(LAST_SEEN_KEY, timestamp);
    setLastSeenAt(timestamp);
  };

  return { latest, latestNotificationAt, hasUnread, lastSeenAt, markSeen };
}