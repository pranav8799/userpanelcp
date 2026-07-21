import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthPayload {
  accountId: number;
}

declare global {
  namespace Express {
    interface Request {
      auth: AuthPayload;
    }
  }
}

const JWT_SECRET = process.env.SESSION_SECRET || process.env.JWT_SECRET || "change-me";

export function generateToken(accountId: number): string {
  return jwt.sign({ accountId }, JWT_SECRET, { expiresIn: "30d" });
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Prefer httpOnly cookie, fall back to Authorization header
  const token =
    req.cookies?.auth_token ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : null);

  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
    req.auth = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session. Please log in again." });
  }
}
