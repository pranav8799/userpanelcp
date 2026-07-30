import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable, otpsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import http from "http";
import { generateToken } from "../lib/authMiddleware.js";
import type { Request, Response } from "express";

const router = Router();

// Rate limit: max 3 OTP sends per number per 10 minutes (keyed by IP)


// ── Helper: send SMS via powerstext.in ──────────────────────────────────────
async function sendSms(phone: string, message: string): Promise<void> {
  const authenticKey = process.env.SMS_AUTH_KEY ?? "";
  const senderid = "DSAENT";
  const templateid = "1607100000000367692";

  const params = new URLSearchParams({
    "authentic-key": authenticKey,
    senderid,
    route: "1",
    number: phone,
    message,
    templateid,
  });

  const url = `http://sms1.powerstext.in/http-tokenkeyapi.php?${params.toString()}`;

  await new Promise<void>((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`SMS API failed (${res.statusCode}): ${body}`));
        });
      })
      .on("error", reject);
  });
}

// POST /auth/send-otp
router.post("/send-otp", async (req: Request, res: Response): Promise<void> => {
  const phone = (req.body?.phone ?? "").toString().trim();

  if (!/^\d{10}$/.test(phone)) {
    res.status(400).json({ error: "Enter a valid 10-digit mobile number" });
    return;
  }

  let account: typeof accountsTable.$inferSelect | undefined;
  try {
    [account] = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.mobileNumber, phone));
  } catch (err) {
    req.log.error({ err }, "DB error looking up account");
    res.status(500).json({ error: "Database error. Please try again.", detail: (err as Error).message });
    return;
  }

  if (!account || !account.isActive) {
    res.status(404).json({ error: "No account found with this mobile number" });
    return;
  }

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  try {
    await db.delete(otpsTable).where(eq(otpsTable.phone, phone));
    await db.insert(otpsTable).values({ phone, otp, expiresAt });
  } catch (err) {
    req.log.error({ err }, "DB error saving OTP");
    res.status(500).json({ error: "Database error saving OTP. Please try again.", detail: (err as Error).message });
    return;
  }

  const message = `Use this verification code ${otp} to verify your mobile number on WealthFunds2x DE`;

  try {
    await sendSms(phone, message);
    res.json({ success: true, message: "OTP sent successfully" });
  } catch {
    req.log.error("SMS send failed");
    res.status(500).json({ error: "SMS service unavailable. Please try again." });
  }
});

// POST /auth/verify-otp
router.post("/verify-otp", async (req: Request, res: Response): Promise<void> => {
  const phone = (req.body?.phone ?? "").toString().trim();
  const otp = (req.body?.otp ?? "").toString().trim();

  if (!phone || !otp) {
    res.status(400).json({ error: "Phone and OTP are required" });
    return;
  }

  const [record] = await db.select().from(otpsTable).where(eq(otpsTable.phone, phone));

  if (!record) {
    res.status(401).json({ error: "No OTP found. Please request a new one." });
    return;
  }
  if (new Date() > record.expiresAt) {
    await db.delete(otpsTable).where(eq(otpsTable.phone, phone));
    res.status(401).json({ error: "OTP expired. Please request a new one." });
    return;
  }
  if (record.otp !== otp) {
    res.status(401).json({ error: "Invalid OTP. Please try again." });
    return;
  }

  await db.delete(otpsTable).where(eq(otpsTable.phone, phone));

  const [account] = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.mobileNumber, phone));

  if (!account) {
    res.status(404).json({ error: "Account not found." });
    return;
  }

  const token = generateToken(account.id);
  const masked = maskPhone(account.mobileNumber);

  // Set httpOnly cookie (30-day session)
  res.cookie("auth_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: "/",
  });

  res.json({
    token,
    account: {
      id: account.id,
      name: account.name,
      maskedMobileNumber: masked,
      isActive: account.isActive,
    },
  });
});

// POST /auth/logout
router.post("/logout", (_req: Request, res: Response): void => {
  res.clearCookie("auth_token", { path: "/" });
  res.json({ message: "Logged out successfully" });
});

function maskPhone(phone: string): string {
  if (phone.length < 4) return "••••";
  return phone.slice(0, 2) + "••••••" + phone.slice(-2);
}

export default router;
