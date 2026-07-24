import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, TrendingDown } from "lucide-react";

const SYMBOLS = ["XAUUSDT", "XAGUSDT", "BTCUSDT", "ETHUSDT", "CLUSDT"] as const;

interface TickerData {
  symbol: string;
  lastPrice: string | number;
  markPrice?: string | number;
  indexPrice?: string | number;
  fundingRate?: string | number;
  bestBidPrice?: string | number;
  bestAskPrice?: string | number;
  high24h?: string | number;
  low24h?: string | number;
  priceChangePct24h?: string | number;
}

async function fetchTicker(symbol: string): Promise<TickerData> {
  const res = await fetch(`/api/market/ticker?symbol=${encodeURIComponent(symbol)}`, {
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw data;
  return data as TickerData;
}

function fmtPrice(v: string | number | undefined, decimals = 2) {
  if (v === undefined || v === null) return "—";
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function TickerItem({ symbol }: { symbol: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["market-ticker", symbol],
    queryFn: () => fetchTicker(symbol),
    refetchInterval: 4000,
    staleTime: 2000,
  });

  // Track previous price to color the price on tick direction (up/down flash)
  const prevRef = useRef<number | null>(null);
  const current = data?.lastPrice != null ? parseFloat(String(data.lastPrice)) : null;
  const prev = prevRef.current;
  const direction = current != null && prev != null ? (current > prev ? "up" : current < prev ? "down" : null) : null;
  if (current != null) prevRef.current = current;

  const pctRaw = data?.priceChangePct24h;
  const pct = pctRaw != null ? parseFloat(String(pctRaw)) : null;

  return (
    <div
      className="flex items-center gap-1.5 sm:gap-2.5 px-2.5 sm:px-4 shrink-0 snap-start"
      style={{ borderRight: "1px solid hsl(var(--border))" }}
    >
      <span className="text-[10px] sm:text-[12px] font-bold text-muted-foreground whitespace-nowrap">
        {symbol.replace("USDT", "")}
      </span>
      {isLoading && !data ? (
        <span className="text-xs text-muted-foreground">…</span>
      ) : (
        <>
          <span
            className="text-xs sm:text-sm font-mono font-bold transition-colors whitespace-nowrap"
            style={{
              color:
                direction === "up" ? "hsl(162 88% 42%)" :
                direction === "down" ? "hsl(345 88% 58%)" :
                "hsl(var(--foreground))",
            }}
          >
            {fmtPrice(data?.lastPrice)}
          </span>
          {pct != null && !isNaN(pct) && (
            <span
              className="flex items-center gap-0.5 text-[10px] sm:text-[11px] font-semibold whitespace-nowrap"
              style={{ color: pct >= 0 ? "hsl(162 88% 42%)" : "hsl(345 88% 58%)" }}
            >
              {pct >= 0 ? (
                <TrendingUp className="w-2.5 h-2.5 sm:w-3 sm:h-3 shrink-0" />
              ) : (
                <TrendingDown className="w-2.5 h-2.5 sm:w-3 sm:h-3 shrink-0" />
              )}
              {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
            </span>
          )}
        </>
      )}
    </div>
  );
}

export function PriceTicker() {
  return (
    <div
      className="ticker-scroll flex items-stretch shrink-0 overflow-x-auto snap-x snap-mandatory"
      style={{
        height: 40,
        background: "hsl(var(--card))",
        borderBottom: "1px solid hsl(var(--border))",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {/* Hide the scrollbar across browsers without needing a Tailwind plugin */}
      <style>{`
        .ticker-scroll::-webkit-scrollbar { display: none; }
        .ticker-scroll { scrollbar-width: none; -ms-overflow-style: none; }
        @media (min-width: 640px) {
          .ticker-scroll { height: 44px; }
        }
      `}</style>

      {/* <div
        className="flex items-center shrink-0 pl-3 pr-3 sm:pl-4 sm:pr-4 sticky left-0 z-10"
        style={{ borderRight: "1px solid hsl(var(--border))", background: "hsl(var(--card))" }}
      >
        <span
          className="font-bold text-xs sm:text-sm tracking-wide whitespace-nowrap"
          style={{ color: "hsl(38 92% 45%)", fontFamily: "'Space Grotesk', sans-serif" }}
        >
          <span className="sm:hidden">W2X</span>
          <span className="hidden sm:inline">WEALTHFUNDS2X</span>
        </span>
      </div> */}
      <div className="flex items-center justify-center sm:flex-1 min-w-max sm:min-w-0">
        {SYMBOLS.map((s) => (
          <TickerItem key={s} symbol={s} />
        ))}
      </div>
    </div>
  );
}