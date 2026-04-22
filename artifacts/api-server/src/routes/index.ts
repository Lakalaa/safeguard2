import { Router, type IRouter } from "express";
import healthRouter from "./health";
import botsRouter from "./bots";

const router: IRouter = Router();

router.use(healthRouter);
router.use(botsRouter);

export default router;
