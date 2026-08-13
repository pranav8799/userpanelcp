// src/lib/historyApi.ts
//
// Hand-written (not orval-generated) since /api/history isn't in the
// OpenAPI spec that api.ts is generated from. Mirrors the same customFetch
// conventions used elsewhere — adjust BASE/credentials if your app's
// customFetch does something different (e.g. auth header injection).

export interface HistoryEventInput {
  accountId: number;
  slotId: string;
  batchId?: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  eventType:
    | "entry_placed"
    | "queued"
    | "queued_activated"
    | "entry_filled"
    | "tp_placed"
    | "tp_filled"
    | "repunched"
    | "shifted"
    | "demoted"
    | "trimmed"
    | "rebalanced"
    | "stopped"
    | "resumed"
    | "removed_manual"
    | "ladder_reset";
  limitPrice?: number | null;
  tpPrice?: number | null;
  quantity?: number | null;
  repunchCountAtEvent: number;
  orderId?: string | null;
  note?: string | null;
}

export interface HistoryRow extends HistoryEventInput {
  id: number;
  createdAt: string;
}

export interface HistoryQueryParams {
  accountId?: number;
  symbol?: string;
  side?: "BUY" | "SELL";
  eventType?: HistoryEventInput["eventType"];
  batchId?: string;
  slotId?: string;
  dateFrom?: string;
  dateTo?: string;
  minQty?: number;
  maxQty?: number;
  minRepunchCount?: number;
  maxRepunchCount?: number;
  search?: string;
  page?: number;
  pageSize?: number;
  sortBy?: "createdAt" | "quantity" | "repunchCountAtEvent" | "limitPrice";
  sortDir?: "asc" | "desc";
}

export interface HistoryResponse {
  rows: HistoryRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function buildQuery(params: HistoryQueryParams): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      search.append(key, String(value));
    }
  });
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

export async function fetchHistory(params: HistoryQueryParams): Promise<HistoryResponse> {
  const res = await fetch(`/api/history${buildQuery(params)}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch history (${res.status})`);
  return res.json();
}

export async function fetchHistorySymbols(accountId?: number): Promise<string[]> {
  const qs = accountId != null ? `?accountId=${accountId}` : "";
  const res = await fetch(`/api/history/symbols${qs}`, { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to fetch history symbols (${res.status})`);
  const data = await res.json();
  return data.symbols ?? [];
}

export async function logHistoryEvents(events: HistoryEventInput[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await fetch("/api/history/log", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });
  } catch (err) {
    console.error("Failed to log creation history", err);
    // Non-fatal — never block the actual trade flow on a logging failure.
  }
}