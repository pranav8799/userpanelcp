import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "$0.00";
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(num);
}

export function formatNumber(value: string | number | null | undefined, decimals = 4): string {
  if (value === null || value === undefined) return "0";
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return "0";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(num);
}

export function formatPnl(value: string | number | null | undefined): { formatted: string, isProfit: boolean, isLoss: boolean, num: number } {
  const num = typeof value === 'string' ? parseFloat(value) : (value || 0);
  const isProfit = num > 0;
  const isLoss = num < 0;
  const sign = isProfit ? "+" : "";
  return {
    formatted: `${sign}${formatCurrency(num)}`,
    isProfit,
    isLoss,
    num
  };
}

export function formatCompactNumber(number: number | string | null | undefined): string {
  if (!number) return "0";
  const num = typeof number === 'string' ? parseFloat(number) : number;
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(num);
}
