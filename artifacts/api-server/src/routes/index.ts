import { Router, type IRouter } from "express";
import healthRouter from "./health";
import botRouter from "./bot";
import alertsRouter from "./alerts";

const router: IRouter = Router();

router.use(healthRouter);
router.use(botRouter);
router.use(alertsRouter);

export default router;
