import { Router } from "express";
import { db, accountsTable, otpsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import http from "http";
import rateLimit from "express-rate-limit";
import { encrypt } from "../lib/crypto.js";
import { generateToken } from "../lib/authMiddleware.js";
import type { Request, Response } from "express";

const router = Router();

const otpRateLimit = rateLimit({
  windowMs: 0 * 10  * 1000,
  max: 3,
  message: { error: "Too many OTP requests. Please wait 10 minutes before trying again." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Duplicated from auth.ts for now — consider moving to a shared lib/sms.ts
// and importing it in both places so the template/sender config lives in
// exactly one spot.
async function sendSms(phone: string, message: string): Promise<void> {
  const authenticKey = process.env.SMS_AUTH_KEY ?? "";
  const senderid = "DSAENT";
  const templateid = "1607100000000367692";
  const params = new URLSearchParams({ "authentic-key": authenticKey, senderid, route: "1", number: phone, message, templateid });
  const url = `http://sms1.powerstext.in/http-tokenkeyapi.php?${params.toString()}`;
  await new Promise<void>((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`SMS API failed (${res.statusCode}): ${body}`));
      });
    }).on("error", reject);
  });
}

function maskPhone(phone: string): string {
  if (phone.length < 4) return "••••";
  return phone.slice(0, 2) + "••••••" + phone.slice(-2);
}

// POST /signup/send-otp
router.post("/send-otp", otpRateLimit, async (req: Request, res: Response): Promise<void> => {
  const phone = (req.body?.phone ?? "").toString().trim();
  if (!/^\d{10}$/.test(phone)) {
    res.status(400).json({ error: "Enter a valid 10-digit mobile number" });
    return;
  }

  const [existing] = await db.select().from(accountsTable).where(eq(accountsTable.mobileNumber, phone));
  if (existing) {
    res.status(409).json({ error: "An account with this mobile number already exists. Please sign in instead." });
    return;
  }

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  try {
    await db.delete(otpsTable).where(eq(otpsTable.phone, phone));
    await db.insert(otpsTable).values({ phone, otp, expiresAt });
  } catch (err) {
    res.status(500).json({ error: "Database error saving OTP. Please try again.", detail: (err as Error).message });
    return;
  }

  const message = `Use this verification code ${otp} to verify your mobile number on WealthFunds2x DE`;
  try {
    await sendSms(phone, message);
    res.json({ success: true, message: "OTP sent successfully" });
  } catch {
    res.status(500).json({ error: "SMS service unavailable. Please try again." });
  }
});

// POST /signup/verify-otp
router.post("/verify-otp", async (req: Request, res: Response): Promise<void> => {
  const phone = (req.body?.phone ?? "").toString().trim();
  const otp = (req.body?.otp ?? "").toString().trim();
  const name = (req.body?.name ?? "").toString().trim();
  const apiKey = (req.body?.apiKey ?? "").toString().trim();
  const secretKey = (req.body?.secretKey ?? "").toString().trim();

  if (!phone || !otp || !name || !apiKey || !secretKey) {
    res.status(400).json({ error: "Name, phone, API key, secret key and OTP are all required." });
    return;
  }

  const [record] = await db.select().from(otpsTable).where(eq(otpsTable.phone, phone));
  if (!record) { res.status(401).json({ error: "No OTP found. Please request a new one." }); return; }
  if (new Date() > record.expiresAt) {
    await db.delete(otpsTable).where(eq(otpsTable.phone, phone));
    res.status(401).json({ error: "OTP expired. Please request a new one." });
    return;
  }
  if (record.otp !== otp) { res.status(401).json({ error: "Invalid OTP. Please try again." }); return; }

  // Re-check right before committing — guards the race window between
  // send-otp and verify-otp (e.g. two tabs signing up with the same number).
  const [existing] = await db.select().from(accountsTable).where(eq(accountsTable.mobileNumber, phone));
  if (existing) {
    await db.delete(otpsTable).where(eq(otpsTable.phone, phone));
    res.status(409).json({ error: "An account with this mobile number already exists. Please sign in instead." });
    return;
  }

  await db.delete(otpsTable).where(eq(otpsTable.phone, phone));

  const result = await db.insert(accountsTable).values({
    name,
    mobileNumber: phone,
    apiKey: encrypt(apiKey),
    secretKey: encrypt(secretKey),
  });

  const [account] = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.id, (result as any)[0].insertId));

  const token = generateToken(account.id);
  const masked = maskPhone(account.mobileNumber);

  res.cookie("auth_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/",
  });

  res.json({
    token,
    account: { id: account.id, name: account.name, maskedMobileNumber: masked, isActive: account.isActive },
  });
});

export default router;