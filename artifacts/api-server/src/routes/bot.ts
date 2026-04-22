import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { botConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetBotConfigResponse,
  UpdateBotConfigBody,
  GetBotStatusResponse,
  StartBotResponse,
  StopBotResponse,
  TestAlertResponse,
} from "@workspace/api-zod";
import { buyAlertBot } from "../bot/buyAlertBot";
import type { BotConfig } from "@workspace/db";

const router: IRouter = Router();

type ConfigUpdate = Partial<Omit<BotConfig, "id" | "updatedAt">> & { updatedAt: Date };

function buildUpdate(body: ReturnType<typeof UpdateBotConfigBody.parse>): ConfigUpdate {
  const updates: ConfigUpdate = { updatedAt: new Date() };
  if (body.telegramToken !== undefined) updates.telegramToken = body.telegramToken;
  if (body.chatId !== undefined) updates.chatId = body.chatId;
  if (body.tokenAddress !== undefined) updates.tokenAddress = body.tokenAddress;
  if (body.tokenName !== undefined) updates.tokenName = body.tokenName;
  if (body.tokenSymbol !== undefined) updates.tokenSymbol = body.tokenSymbol;
  if (body.chain !== undefined) updates.chain = body.chain;
  if (body.minBuyUsd !== undefined) updates.minBuyUsd = body.minBuyUsd;
  if (body.alertImageUrl !== undefined) updates.alertImageUrl = body.alertImageUrl;
  if (body.dextUrl !== undefined) updates.dextUrl = body.dextUrl;
  if (body.screenerUrl !== undefined) updates.screenerUrl = body.screenerUrl;
  if (body.buyUrl !== undefined) updates.buyUrl = body.buyUrl;
  if (body.trendingUrl !== undefined) updates.trendingUrl = body.trendingUrl;
  if (body.emojiPerTier !== undefined) updates.emojiPerTier = body.emojiPerTier;
  if (body.tier1Min !== undefined) updates.tier1Min = body.tier1Min;
  if (body.tier2Min !== undefined) updates.tier2Min = body.tier2Min;
  if (body.tier3Min !== undefined) updates.tier3Min = body.tier3Min;
  return updates;
}

function toConfigResponse(config: BotConfig) {
  return GetBotConfigResponse.parse({
    hasTelegramToken: !!config.telegramToken,
    telegramTokenPreview: config.telegramToken
      ? `${config.telegramToken.slice(0, 10)}...${config.telegramToken.slice(-4)}`
      : null,
    chatId: config.chatId,
    tokenAddress: config.tokenAddress,
    tokenName: config.tokenName,
    tokenSymbol: config.tokenSymbol,
    chain: config.chain ?? "solana",
    minBuyUsd: config.minBuyUsd,
    alertImageUrl: config.alertImageUrl,
    dextUrl: config.dextUrl,
    screenerUrl: config.screenerUrl,
    buyUrl: config.buyUrl,
    trendingUrl: config.trendingUrl,
    emojiPerTier: config.emojiPerTier,
    tier1Min: config.tier1Min,
    tier2Min: config.tier2Min,
    tier3Min: config.tier3Min,
  });
}

router.get("/bot/config", async (_req, res) => {
  let [config] = await db.select().from(botConfigTable).limit(1);

  if (!config) {
    const [newConfig] = await db.insert(botConfigTable).values({}).returning();
    config = newConfig!;
  }

  res.json(toConfigResponse(config));
});

router.put("/bot/config", async (req, res) => {
  const body = UpdateBotConfigBody.parse(req.body);
  const updates = buildUpdate(body);

  const [existing] = await db.select().from(botConfigTable).limit(1);
  let config: BotConfig;
  if (existing) {
    const [updated] = await db
      .update(botConfigTable)
      .set(updates)
      .where(eq(botConfigTable.id, existing.id))
      .returning();
    config = updated!;
  } else {
    const [created] = await db.insert(botConfigTable).values(updates).returning();
    config = created!;
  }

  res.json(toConfigResponse(config));
});

router.get("/bot/status", (_req, res) => {
  const data = GetBotStatusResponse.parse(buyAlertBot.getStatus());
  res.json(data);
});

router.post("/bot/start", async (_req, res) => {
  const result = await buyAlertBot.start();
  const status = buyAlertBot.getStatus();
  const data = StartBotResponse.parse({
    running: result.running,
    monitoringToken: status.monitoringToken ?? null,
    lastCheckAt: status.lastCheckAt ?? null,
    error: result.error ?? null,
  });
  res.json(data);
});

router.post("/bot/stop", async (_req, res) => {
  await buyAlertBot.stop();
  const data = StopBotResponse.parse({ running: false, monitoringToken: null, lastCheckAt: null, error: null });
  res.json(data);
});

router.post("/bot/test", async (_req, res) => {
  const result = await buyAlertBot.sendTestAlert();
  const data = TestAlertResponse.parse(result);
  res.json(data);
});

export default router;
