// src/pages/notifications.tsx
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bell, Megaphone, RefreshCw, Loader2, Inbox } from "lucide-react";

// ── helpers ────────────────────────────────────────────────────────────
function getErrorMessage(err: unknown, fallback: string): string {
  if (!err) return fallback;
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object") {
    const anyErr = err as Record<string, unknown>;
    if (typeof anyErr.error === "string") return anyErr.error;
    if (typeof anyErr.message === "string") return anyErr.message;
  }
  return fallback;
}

async function requestJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw data;
  return data as T;
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// ── types ──────────────────────────────────────────────────────────────
interface NotificationItem {
  id: number;
  title: string;
  message: string;
  targetType: "ALL" | "ACCOUNT";
  createdAt: string;
}

export default function Notifications() {
  const {
    data: notifications,
    isLoading,
    isError,
    error,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => requestJson<NotificationItem[]>("/api/notifications", "GET"),
  });

  return (
    <div className="max-w-xl mx-auto space-y-4 pb-12 px-3 sm:px-0">
      <div className="flex items-center justify-between pt-2">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2">
            <Bell className="w-5 h-5 sm:w-6 sm:h-6" />
            Notifications
          </h1>
          <p className="text-muted-foreground text-sm">Updates and announcements</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* ── Loading ──────────────────────────────────────────────────── */}
      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Card key={i}>
              <CardContent className="p-4 space-y-2">
                <div className="h-4 w-2/3 rounded bg-muted animate-pulse" />
                <div className="h-3 w-full rounded bg-muted animate-pulse" />
                <div className="h-3 w-1/3 rounded bg-muted animate-pulse" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── Error ────────────────────────────────────────────────────── */}
      {isError && !isLoading && (
        <Card>
          <CardContent className="p-6 text-center space-y-3">
            <p className="text-sm text-muted-foreground">
              {getErrorMessage(error, "Could not load notifications")}
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              {isFetching ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Empty ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && notifications && notifications.length === 0 && (
        <Card>
          <CardContent className="p-8 flex flex-col items-center text-center gap-2">
            <Inbox className="w-8 h-8 text-muted-foreground" />
            <p className="font-medium">No notifications yet</p>
            <p className="text-sm text-muted-foreground">You're all caught up.</p>
          </CardContent>
        </Card>
      )}

      {/* ── List ─────────────────────────────────────────────────────── */}
      {!isLoading && !isError && notifications && notifications.length > 0 && (
        <div className="space-y-3">
          {notifications.map((n) => (
            <Card key={n.id}>
              <CardContent className="p-4 space-y-1.5">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-semibold text-sm sm:text-base leading-snug break-words">
                    {n.title}
                  </h3>
                  {n.targetType === "ALL" && (
                    <Badge variant="secondary" className="flex items-center gap-1 shrink-0 text-[10px] sm:text-xs">
                      <Megaphone className="w-3 h-3" />
                      Broadcast
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
                  {n.message}
                </p>
                <p className="text-xs text-muted-foreground pt-1">
                  {formatRelativeTime(n.createdAt)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
