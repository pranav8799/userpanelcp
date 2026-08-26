import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import meRouter from "./me.js";
import balanceRouter from "./balance.js";
import ordersRouter from "./orders.js";
import positionsRouter from "./positions.js";
import summaryRouter from "./summary.js";
import leverageRouter from "./leverage.js";
import marginRouter from "./margin.js";
import settingsRouter from "./settings.js";
import marketRouter from "./market.js"; // ← new
import signupRouter from "./signup.js";     // ← new
import accountRouter from "./account.js";   // ← new
import historyRouter from "./history.js";   // ← new
import notificationsRouter from "./notifications.js"; // ← new
const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/auth/signup", signupRouter);   // ← mounts as /api/auth/signup/send-otp, /api/auth/signup/verify-otp
router.use("/me", meRouter);
router.use("/account", accountRouter);      // ← mounts as /api/account/me, /api/account (PATCH), /api/account/mobile/send-otp, /api/account/mobile/verify-otp
router.use("/balance", balanceRouter);
router.use("/orders", ordersRouter);
router.use("/positions", positionsRouter);
router.use("/summary", summaryRouter);
router.use("/leverage", leverageRouter);
router.use("/margin", marginRouter);
router.use("/market", marketRouter); // ← mounts as /api/market/price-ticker, /api/market/symbols
router.use("/settings", settingsRouter);
router.use("/history", historyRouter); // ← mounts as /api/history, /api/history/symbols, /api/history/log
router.use("/notifications", notificationsRouter); // ← mounts as /api/notifications

export default router;