import { Router } from "express";
import { db, accountsTable, otpsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import http from "http";
import { encrypt } from "../lib/crypto.js";
import { authMiddleware } from "../lib/authMiddleware.js";
import type { Request, Response } from "express";

const router = Router();

const otpRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  message: { error: "Too many OTP requests. Please wait 10 minutes before trying again." },
  standardHeaders: true,
  legacyHeaders: false,
});

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

function serialize(a: typeof accountsTable.$inferSelect) {
  return {
    id: a.id,
    name: a.name,
    mobileNumber: a.mobileNumber,
    maskedMobileNumber: a.mobileNumber.slice(0, 2) + "••••••" + a.mobileNumber.slice(-2),
    isActive: a.isActive,
    apiKeyMasked: "****" + a.apiKey.slice(-8),
  };
}

// PATCH /account — name / apiKey / secretKey only.
// Mobile number is intentionally NOT accepted here — see /mobile/send-otp below.
router.patch("/", authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.auth;
  const name = req.body?.name != null ? String(req.body.name).trim() : undefined;
  const apiKey = req.body?.apiKey != null ? String(req.body.apiKey).trim() : undefined;
  const secretKey = req.body?.secretKey != null ? String(req.body.secretKey).trim() : undefined;

  if (name === "") { res.status(400).json({ error: "Name cannot be empty" }); return; }
  if (apiKey === "" || secretKey === "") { res.status(400).json({ error: "API key / secret key cannot be empty" }); return; }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name;
  if (apiKey !== undefined) updates.apiKey = encrypt(apiKey);
  if (secretKey !== undefined) updates.secretKey = encrypt(secretKey);

  if (Object.keys(updates).length > 1) {
    await db.update(accountsTable).set(updates).where(eq(accountsTable.id, accountId));
  }

  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.id, accountId));
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }
  res.json(serialize(account));
});

// POST /account/mobile/send-otp — body: { newMobile }
router.post("/mobile/send-otp", authMiddleware, otpRateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.auth;
  const newMobile = (req.body?.newMobile ?? "").toString().trim();

  if (!/^\d{10}$/.test(newMobile)) {
    res.status(400).json({ error: "Enter a valid 10-digit mobile number" });
    return;
  }

  const [existing] = await db.select().from(accountsTable).where(eq(accountsTable.mobileNumber, newMobile));
  if (existing && existing.id !== accountId) {
    res.status(409).json({ error: "This mobile number is already in use by another account." });
    return;
  }

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await db.delete(otpsTable).where(eq(otpsTable.phone, newMobile));
  await db.insert(otpsTable).values({ phone: newMobile, otp, expiresAt });

  const message = `Use this verification code ${otp} to verify your new mobile number on WealthFunds2x DE`;
  try {
    await sendSms(newMobile, message);
    res.json({ success: true, message: "OTP sent successfully" });
  } catch {
    res.status(500).json({ error: "SMS service unavailable. Please try again." });
  }
});

// POST /account/mobile/verify-otp — body: { newMobile, otp }
router.post("/mobile/verify-otp", authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.auth;
  const newMobile = (req.body?.newMobile ?? "").toString().trim();
  const otp = (req.body?.otp ?? "").toString().trim();

  if (!newMobile || !otp) { res.status(400).json({ error: "Mobile number and OTP are required" }); return; }

  const [record] = await db.select().from(otpsTable).where(eq(otpsTable.phone, newMobile));
  if (!record) { res.status(401).json({ error: "No OTP found. Please request a new one." }); return; }
  if (new Date() > record.expiresAt) {
    await db.delete(otpsTable).where(eq(otpsTable.phone, newMobile));
    res.status(401).json({ error: "OTP expired. Please request a new one." });
    return;
  }
  if (record.otp !== otp) { res.status(401).json({ error: "Invalid OTP. Please try again." }); return; }

  const [existing] = await db.select().from(accountsTable).where(eq(accountsTable.mobileNumber, newMobile));
  if (existing && existing.id !== accountId) {
    await db.delete(otpsTable).where(eq(otpsTable.phone, newMobile));
    res.status(409).json({ error: "This mobile number is already in use by another account." });
    return;
  }

  await db.delete(otpsTable).where(eq(otpsTable.phone, newMobile));
  await db.update(accountsTable).set({ mobileNumber: newMobile, updatedAt: new Date() }).where(eq(accountsTable.id, accountId));

  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.id, accountId));
  res.json(serialize(account));
});

export default router;