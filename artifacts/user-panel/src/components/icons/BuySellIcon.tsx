import type { SVGProps } from "react";

/**
 * Split buy/sell icon — green half (buy, up arrow) / red half (sell, down arrow).
 * Colors match the up/down tick colors already used in PriceTicker for consistency.
 * Drop-in replacement for a lucide icon: accepts `className` the same way.
 */
export function BuySellIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* Buy half — left */}
      <path d="M12 1.5 A10.5 10.5 0 0 0 12 22.5 Z" fill="hsl(162 88% 42%)" />
      {/* Sell half — right */}
      <path d="M12 1.5 A10.5 10.5 0 0 1 12 22.5 Z" fill="hsl(345 88% 58%)" />
      {/* Thin ring so the icon reads cleanly against any background */}
      <circle cx="12" cy="12" r="10.5" fill="none" stroke="hsl(var(--background))" strokeWidth="1.2" />
      {/* Up arrow — buy side */}
      <path
        d="M7.2 14.4 L7.2 10.2 M5.3 12.1 L7.2 10.1 L9.1 12.1"
        stroke="white"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Down arrow — sell side */}
      <path
        d="M16.8 9.6 L16.8 13.8 M14.9 11.9 L16.8 13.9 L18.7 11.9"
        stroke="white"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}