import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import meRouter from "./me.js";
import balanceRouter from "./balance.js";
import ordersRouter from "./orders.js";
import positionsRouter from "./positions.js";
import summaryRouter from "./summary.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/me", meRouter);
router.use("/balance", balanceRouter);
router.use("/orders", ordersRouter);
router.use("/positions", positionsRouter);
router.use("/summary", summaryRouter);

export default router;
