import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { botConfigTable, alertsTable } from "@workspace/db";
import { eq, count, desc, sum, max, gte, and } from "drizzle-orm";
import {
  ListBotsResponse,
  CreateBotBody,
  CreateBotResponse,
  GetBotResponse,
  UpdateBotBody,
  UpdateBotResponse,
  DeleteBotResponse,
  StartBotResponse,
  StopBotResponse,
  TestBotResponse,
  GetBotAlertsResponse,
  GetBotStatsResponse,
  GetTokenInfoQueryParams,
  GetTokenInfoResponse,
} from "@workspace/api-zod";
import { botRegistry, getDexScreenerData } from "../bot/botRegistry";
import type { BotConfig } from "@workspace/db";

const router: IRouter = Router();

function toBotDetail(config: BotConfig, running: boolean, lastCheckAt: Date | null, error: string | null) {
  return {
    id: config.id,
    name: config.name,
    isActive: config.isActive,
    hasTelegramToken: !!config.telegramToken,
    telegramTokenPreview: config.telegramToken
      ? `${config.telegramToken.slice(0, 10)}...${config.telegramToken.slice(-4)}`
      : null,
    chatId: config.chatId ?? null,
    tokenAddress: config.tokenAddress ?? null,
    tokenName: config.tokenName ?? null,
    tokenSymbol: config.tokenSymbol ?? null,
    chain: config.chain ?? null,
    minBuyUsd: config.minBuyUsd,
    alertImageUrl: config.alertImageUrl ?? null,
    dextUrl: config.dextUrl ?? null,
    screenerUrl: config.screenerUrl ?? null,
    buyUrl: config.buyUrl ?? null,
    trendingUrl: config.trendingUrl ?? null,
    alertEmoji: config.alertEmoji,
    alertStyle: config.alertStyle ?? "sosana",
    alertMediaType: config.alertMediaType ?? null,
    alertMediaFileId: config.alertMediaFileId ?? null,
    emojiPerTier: config.emojiPerTier,
    tier1Min: config.tier1Min,
    tier2Min: config.tier2Min,
    tier3Min: config.tier3Min,
    running,
    lastCheckAt: lastCheckAt?.toISOString() ?? null,
    error: error ?? null,
  };
}

function applyInput(body: ReturnType<typeof CreateBotBody.parse>): Partial<BotConfig> & { updatedAt: Date } {
  const updates: Partial<BotConfig> & { updatedAt: Date } = { updatedAt: new Date() };
  if (body.name !== undefined && body.name !== null) updates.name = body.name;
  if (body.telegramToken !== undefined) updates.telegramToken = body.telegramToken;
  if (body.chatId !== undefined) updates.chatId = body.chatId;
  if (body.tokenAddress !== undefined) updates.tokenAddress = body.tokenAddress;
  if (body.tokenName !== undefined) updates.tokenName = body.tokenName;
  if (body.tokenSymbol !== undefined) updates.tokenSymbol = body.tokenSymbol;
  if (body.chain !== undefined) updates.chain = body.chain;
  if (body.minBuyUsd !== undefined && body.minBuyUsd !== null) updates.minBuyUsd = body.minBuyUsd;
  if (body.alertImageUrl !== undefined) updates.alertImageUrl = body.alertImageUrl;
  if (body.dextUrl !== undefined) updates.dextUrl = body.dextUrl;
  if (body.screenerUrl !== undefined) updates.screenerUrl = body.screenerUrl;
  if (body.buyUrl !== undefined) updates.buyUrl = body.buyUrl;
  if (body.trendingUrl !== undefined) updates.trendingUrl = body.trendingUrl;
  if (body.emojiPerTier !== undefined && body.emojiPerTier !== null) updates.emojiPerTier = body.emojiPerTier;
  if (body.tier1Min !== undefined && body.tier1Min !== null) updates.tier1Min = body.tier1Min;
  if (body.tier2Min !== undefined && body.tier2Min !== null) updates.tier2Min = body.tier2Min;
  if (body.tier3Min !== undefined && body.tier3Min !== null) updates.tier3Min = body.tier3Min;
  if (body.alertEmoji !== undefined) updates.alertEmoji = body.alertEmoji;
  if (body.alertStyle !== undefined) updates.alertStyle = body.alertStyle;
  if (body.alertMediaType !== undefined) updates.alertMediaType = body.alertMediaType;
  if (body.alertMediaFileId !== undefined) updates.alertMediaFileId = body.alertMediaFileId;
  return updates;
}

router.get("/bots", async (_req, res) => {
  const configs = await db.select().from(botConfigTable).orderBy(desc(botConfigTable.id));

  const alertCounts = await db
    .select({ botConfigId: alertsTable.botConfigId, total: count() })
    .from(alertsTable)
    .groupBy(alertsTable.botConfigId);

  const countMap = new Map<number, number>();
  for (const row of alertCounts) {
    if (row.botConfigId != null) countMap.set(row.botConfigId, row.total);
  }

  const result = configs.map((c) => {
    const status = botRegistry.getStatus(c.id);
    return {
      id: c.id,
      name: c.name,
      isActive: c.isActive,
      tokenName: c.tokenName ?? null,
      tokenSymbol: c.tokenSymbol ?? null,
      tokenAddress: c.tokenAddress ?? null,
      chain: c.chain ?? null,
      running: status.running,
      lastCheckAt: status.lastCheckAt?.toISOString() ?? null,
      error: status.error ?? null,
      alertCount: countMap.get(c.id) ?? 0,
    };
  });

  res.json(ListBotsResponse.parse(result));
});

router.post("/bots", async (req, res) => {
  const body = CreateBotBody.parse(req.body);
  const updates = applyInput(body);
  const [config] = await db
    .insert(botConfigTable)
    .values({ name: body.name ?? "New Bot", ...updates })
    .returning();
  const status = botRegistry.getStatus(config!.id);
  res.json(CreateBotResponse.parse(toBotDetail(config!, status.running, status.lastCheckAt, status.error)));
});

router.get("/bots/:id", async (req, res) => {
  const id = parseInt(req.params.id!);
  const [config] = await db.select().from(botConfigTable).where(eq(botConfigTable.id, id)).limit(1);
  if (!config) { res.status(404).json({ error: "Not found" }); return; }
  const status = botRegistry.getStatus(id);
  res.json(GetBotResponse.parse(toBotDetail(config, status.running, status.lastCheckAt, status.error)));
});

router.put("/bots/:id", async (req, res) => {
  const id = parseInt(req.params.id!);
  const body = UpdateBotBody.parse(req.body);
  const updates = applyInput(body);
  const [config] = await db.update(botConfigTable).set(updates).where(eq(botConfigTable.id, id)).returning();
  if (!config) { res.status(404).json({ error: "Not found" }); return; }
  const status = botRegistry.getStatus(id);
  res.json(UpdateBotResponse.parse(toBotDetail(config, status.running, status.lastCheckAt, status.error)));
});

router.delete("/bots/:id", async (req, res) => {
  const id = parseInt(req.params.id!);
  await botRegistry.stop(id);
  await db.delete(botConfigTable).where(eq(botConfigTable.id, id));
  res.json(DeleteBotResponse.parse({ ok: true }));
});

router.post("/bots/:id/start", async (req, res) => {
  const id = parseInt(req.params.id!);
  const result = await botRegistry.start(id);
  const status = botRegistry.getStatus(id);
  res.json(StartBotResponse.parse({
    id,
    running: result.running,
    lastCheckAt: status.lastCheckAt?.toISOString() ?? null,
    error: result.error ?? status.error ?? null,
  }));
});

router.post("/bots/:id/stop", async (req, res) => {
  const id = parseInt(req.params.id!);
  await botRegistry.stop(id);
  res.json(StopBotResponse.parse({ id, running: false, lastCheckAt: null, error: null }));
});

router.post("/bots/:id/test", async (req, res) => {
  const id = parseInt(req.params.id!);
  const result = await botRegistry.sendTestAlert(id);
  res.json(TestBotResponse.parse(result));
});

router.get("/bots/:id/alerts", async (req, res) => {
  const id = parseInt(req.params.id!);
  const limit = parseInt(String(req.query.limit ?? "50")) || 50;
  const rows = await db
    .select()
    .from(alertsTable)
    .where(eq(alertsTable.botConfigId, id))
    .orderBy(desc(alertsTable.sentAt))
    .limit(limit);
  res.json(GetBotAlertsResponse.parse(rows));
});

router.get("/bots/:id/stats", async (req, res) => {
  const id = parseInt(req.params.id!);
  const [agg] = await db
    .select({
      total: count(),
      totalVolume: sum(alertsTable.amountUsd),
      biggestBuy: max(alertsTable.amountUsd),
    })
    .from(alertsTable)
    .where(eq(alertsTable.botConfigId, id));

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [todayAgg] = await db
    .select({ total: count() })
    .from(alertsTable)
    .where(and(eq(alertsTable.botConfigId, id), gte(alertsTable.sentAt, todayStart)));

  const total = agg?.total ?? 0;
  const totalVolumeUsd = parseFloat(String(agg?.totalVolume ?? "0")) || 0;
  const biggestBuyUsd = parseFloat(String(agg?.biggestBuy ?? "0")) || 0;
  const avgBuyUsd = total > 0 ? totalVolumeUsd / total : 0;

  res.json(GetBotStatsResponse.parse({
    totalAlerts: total,
    totalVolumeUsd: Math.round(totalVolumeUsd * 100) / 100,
    avgBuyUsd: Math.round(avgBuyUsd * 100) / 100,
    biggestBuyUsd: Math.round(biggestBuyUsd * 100) / 100,
    alertsToday: todayAgg?.total ?? 0,
  }));
});

// DexScreener chainId → DexTools chain slug (they differ for several chains)
const DEXTOOLS_CHAIN: Record<string, string> = {
  ethereum: "ether",
  bsc: "bnb",
  polygon: "polygon",
  arbitrum: "arbitrum",
  base: "base",
  avalanche: "avalanche",
  optimism: "optimism",
  solana: "solana",
};

router.get("/token-info", async (req, res) => {
  const query = GetTokenInfoQueryParams.parse(req.query);
  const address = query.address;
  const dexData = await getDexScreenerData(address);

  if (!dexData) {
    res.json(GetTokenInfoResponse.parse({ address, found: false }));
    return;
  }

  const chainId = dexData.chainId ?? "solana";
  const pairAddress = dexData.pairAddress;
  const isEvm = address.startsWith("0x");

  // DexScreener URL — uses chainId directly (e.g. /ethereum/, /bsc/, /solana/)
  const dexscreenerUrl = `https://dexscreener.com/${chainId}/${pairAddress}`;

  // DexTools URL — uses its own chain slug (ether, bnb, etc.)
  const dextoolsChain = DEXTOOLS_CHAIN[chainId] ?? chainId;
  const dextoolsUrl = `https://www.dextools.io/app/en/${dextoolsChain}/pair-explorer/${pairAddress}`;

  // raydiumUrl only for Solana — Buy URL is always user-custom, this is just metadata
  const raydiumUrl = isEvm ? null : `https://raydium.io/swap/?inputMint=sol&outputMint=${address}`;

  res.json(GetTokenInfoResponse.parse({
    address,
    name: dexData.baseToken.name || null,
    symbol: dexData.baseToken.symbol || null,
    priceUsd: dexData.priceUsd ? parseFloat(dexData.priceUsd) : null,
    marketCap: dexData.marketCap ?? dexData.fdv ?? null,
    priceChange24h: dexData.priceChange?.h24 ?? null,
    liquidity: dexData.liquidity?.usd ?? null,
    dexscreenerUrl,
    dextoolsUrl,
    raydiumUrl,
    pairAddress,
    chainId,
    found: true,
  }));
});

export default router;
