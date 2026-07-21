import { z } from "zod";

export const loginSchema = z.object({
  phone: z.string().regex(/^\d{10}$/, "Mobile number must be 10 digits"),
});

export const otpSchema = z.object({
  phone: z.string().regex(/^\d{10}$/, "Mobile number must be 10 digits"),
  otp: z.string().regex(/^\d{4}$/, "OTP must be 4 digits"),
});

export const orderSchema = z.object({
  symbol: z.string().min(1, "Symbol is required").toUpperCase(),
  side: z.enum(["BUY", "SELL"]),
  order_type: z.enum(["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"]),
  quantity: z.coerce.number().positive("Quantity must be greater than 0"),
  price: z.coerce.number().positive("Price must be greater than 0").optional(),
  triggerPrice: z.coerce.number().positive("Trigger price must be greater than 0").optional(),
  reduceOnly: z.boolean().optional(),
}).refine((data) => {
  if (data.order_type === "LIMIT" && !data.price) return false;
  return true;
}, {
  message: "Price is required for LIMIT orders",
  path: ["price"]
}).refine((data) => {
  if ((data.order_type === "STOP_MARKET" || data.order_type === "TAKE_PROFIT_MARKET") && !data.triggerPrice) return false;
  return true;
}, {
  message: "Trigger price is required for STOP/TAKE_PROFIT orders",
  path: ["triggerPrice"]
});
