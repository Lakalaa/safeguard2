import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { alertsTable } from "@workspace/db";
import { desc, count, sum, max, gte } from "drizzle-orm";
import { ListAlertsQueryParams, ListAlertsResponse, GetStatsResponse, GetTokenInfoQueryParams, GetTokenInfoResponse } from "@workspace/api-zod";
import { getDexScreenerData } from "../bot/buyAlertBot";

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

router.get("/token-info", async (req, res) => {
  const query = GetTokenInfoQueryParams.parse(req.query);
  const address = query.address;

  const dexData = await getDexScreenerData(address);

  if (!dexData) {
    const data = GetTokenInfoResponse.parse({ address, found: false });
    res.json(data);
    return;
  }

  const pairAddress = dexData.pairAddress;
  const name = dexData.baseToken.name || null;
  const symbol = dexData.baseToken.symbol || null;
  const priceUsd = dexData.priceUsd ? parseFloat(dexData.priceUsd) : null;
  const marketCap = dexData.marketCap ?? dexData.fdv ?? null;
  const priceChange24h = dexData.priceChange?.h24 ?? null;
  const liquidity = dexData.liquidity?.usd ?? null;

  const dexscreenerUrl = `https://dexscreener.com/solana/${pairAddress}`;
  const dextoolsUrl = `https://www.dextools.io/app/en/solana/pair-explorer/${pairAddress}`;
  const raydiumUrl = `https://raydium.io/swap/?inputMint=sol&outputMint=${address}`;

  const data = GetTokenInfoResponse.parse({
    address,
    name,
    symbol,
    priceUsd: priceUsd !== null && !isNaN(priceUsd) ? priceUsd : null,
    marketCap: marketCap !== null ? Math.round(marketCap) : null,
    priceChange24h: priceChange24h !== null ? Math.round(priceChange24h * 100) / 100 : null,
    liquidity: liquidity !== null ? Math.round(liquidity) : null,
    dexscreenerUrl,
    dextoolsUrl,
    raydiumUrl,
    pairAddress,
    found: true,
  });

  res.json(data);
});

export default router;
