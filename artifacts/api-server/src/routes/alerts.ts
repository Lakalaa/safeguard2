import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { alertsTable } from "@workspace/db";
import { eq, desc, count, sum, max, gte } from "drizzle-orm";
import { ListAlertsQueryParams, ListAlertsResponse, GetStatsResponse } from "@workspace/api-zod";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/alerts", async (req, res) => {
  const query = ListAlertsQueryParams.parse(req.query);

  const rows = await db
    .select()
    .from(alertsTable)
    .orderBy(desc(alertsTable.sentAt))
    .limit(query.limit);

  const data = ListAlertsResponse.parse(rows);
  res.json(data);
});

router.get("/stats", async (_req, res) => {
  const [agg] = await db
    .select({
      total: count(),
      totalVolume: sum(alertsTable.amountUsd),
      biggestBuy: max(alertsTable.amountUsd),
    })
    .from(alertsTable);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [todayAgg] = await db
    .select({ count: count() })
    .from(alertsTable)
    .where(gte(alertsTable.sentAt, todayStart));

  const total = agg?.total ?? 0;
  const totalVolumeUsd = parseFloat(String(agg?.totalVolume ?? "0")) || 0;
  const biggestBuyUsd = parseFloat(String(agg?.biggestBuy ?? "0")) || 0;
  const avgBuyUsd = total > 0 ? totalVolumeUsd / total : 0;
  const alertsToday = todayAgg?.count ?? 0;

  const data = GetStatsResponse.parse({
    totalAlerts: total,
    totalVolumeUsd: Math.round(totalVolumeUsd * 100) / 100,
    avgBuyUsd: Math.round(avgBuyUsd * 100) / 100,
    biggestBuyUsd: Math.round(biggestBuyUsd * 100) / 100,
    alertsToday,
  });

  res.json(data);
});

export default router;
