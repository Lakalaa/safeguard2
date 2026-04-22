import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { botConfigTable, alertsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getChainConfig, detectChainFromAddress } from "./chains/chainConfig";
import { SolanaMonitor, type BuyEvent } from "./chains/solanaMonitor";
import { EvmMonitor } from "./chains/evmMonitor";
import type { BotConfig } from "@workspace/db";

export interface DexScreenerPair {
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  priceChange: { h24?: number };
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  chainId?: string;
  url?: string;
}

export async function getDexScreenerData(tokenAddress: string): Promise<DexScreenerPair | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { pairs?: DexScreenerPair[] };
    if (!data.pairs || data.pairs.length === 0) return null;
    const matching = data.pairs.filter(
      (p) => p.baseToken.address.toLowerCase() === tokenAddress.toLowerCase(),
    );
    const list = matching.length > 0 ? matching : data.pairs;
    list.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    return list[0] ?? null;
  } catch {
    return null;
  }
}

function getTier(amountUsd: number, tier1: number, tier2: number, tier3: number): number {
  if (amountUsd >= tier3) return 3;
  if (amountUsd >= tier2) return 2;
  return 1;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

interface AlertParams {
  tokenName: string;
  tokenSymbol: string;
  chainName: string;
  tier: number;
  emojiPerTier: number;
  alertEmoji: string;
  amountUsd: number;
  amountNative: number;
  nativeCurrency: string;
  tokensReceived: number;
  buyerAddress: string;
  txSignature: string;
  explorerTx: string;
  explorerAddress: string;
  marketCap: number | null;
  priceChangePct: number | null;
  dextUrl?: string | null;
  screenerUrl?: string | null;
  buyUrl?: string | null;
  trendingUrl?: string | null;
}

function buildAlertMessage(params: AlertParams): string {
  const emoji = params.alertEmoji || "🟢";
  const circles = emoji.repeat(params.tier * params.emojiPerTier);
  const buyerUrl = params.explorerAddress.replace("{address}", params.buyerAddress);
  const txUrl = params.explorerTx.replace("{tx}", params.txSignature);

  const positionLine =
    params.priceChangePct !== null
      ? `\n🪙 Position ${params.priceChangePct >= 0 ? "+" : ""}${params.priceChangePct.toFixed(0)}%`
      : "";
  const mcapLine =
    params.marketCap !== null
      ? `\n💰 Market Cap ${formatNumber(params.marketCap)}`
      : "";

  return (
    `<b>${params.tokenName} Buy!</b> <i>${params.chainName}</i>\n` +
    `${circles}\n\n` +
    `🔀 Spent <b>${formatNumber(params.amountUsd)}</b> (<b>${params.amountNative.toFixed(4)} ${params.nativeCurrency}</b>)\n` +
    `🔀 Got <b>${params.tokensReceived.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${params.tokenSymbol}</b>\n` +
    `👤 <a href="${buyerUrl}">Buyer</a> · <a href="${txUrl}">TX</a>${positionLine}${mcapLine}`
  );
}

function buildAlertKeyboard(params: AlertParams): TelegramBot.InlineKeyboardMarkup {
  const buyerUrl = params.explorerAddress.replace("{address}", params.buyerAddress);
  const txUrl = params.explorerTx.replace("{tx}", params.txSignature);

  const actionRow: TelegramBot.InlineKeyboardButton[] = [];
  if (params.buyUrl) actionRow.push({ text: "🛒 Buy", url: params.buyUrl });
  if (params.dextUrl) actionRow.push({ text: "📊 DexTools", url: params.dextUrl });
  if (params.screenerUrl) actionRow.push({ text: "📈 Screener", url: params.screenerUrl });
  if (params.trendingUrl) actionRow.push({ text: "🔥 Trending", url: params.trendingUrl });

  const explorerRow: TelegramBot.InlineKeyboardButton[] = [
    { text: "👤 Buyer", url: buyerUrl },
    { text: "🔗 TX", url: txUrl },
  ];

  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  if (actionRow.length > 0) rows.push(actionRow);
  rows.push(explorerRow);

  return { inline_keyboard: rows };
}

interface BotInstance {
  configId: number;
  chainId: string;
  running: boolean;
  lastCheckAt: Date | null;
  error: string | null;
  monitor: SolanaMonitor | EvmMonitor | null;
  dexCache: { data: DexScreenerPair | null; fetchedAt: number };
}

/** Returns the bot token to use: stored in DB first, then TELEGRAM_BOT_TOKEN env var fallback */
function resolveToken(config: BotConfig | undefined): string | null {
  return config?.telegramToken || process.env["TELEGRAM_BOT_TOKEN"] || null;
}

class BotRegistry {
  private instances = new Map<number, BotInstance>();

  getStatus(configId: number): { running: boolean; lastCheckAt: Date | null; error: string | null } {
    const inst = this.instances.get(configId);
    if (!inst) return { running: false, lastCheckAt: null, error: null };
    return { running: inst.running, lastCheckAt: inst.lastCheckAt, error: inst.error };
  }

  isRunning(configId: number): boolean {
    return this.instances.get(configId)?.running ?? false;
  }

  async start(configId: number): Promise<{ running: boolean; error?: string }> {
    const existing = this.instances.get(configId);
    if (existing?.running) return { running: true };

    const [config] = await db
      .select()
      .from(botConfigTable)
      .where(eq(botConfigTable.id, configId))
      .limit(1);

    if (!config) return { running: false, error: "Bot config not found." };
    if (!resolveToken(config)) return { running: false, error: "Telegram bot token not set." };
    if (!config.tokenAddress) return { running: false, error: "Token address not set." };
    if (!config.chatId) return { running: false, error: "Telegram chat ID not set." };

    const inst: BotInstance = {
      configId,
      chainId: config.chain ?? "solana",
      running: false,
      lastCheckAt: null,
      error: null,
      monitor: null,
      dexCache: { data: null, fetchedAt: 0 },
    };

    try {
      let chainId = config.chain ?? detectChainFromAddress(config.tokenAddress);

      const dexData = await getDexScreenerData(config.tokenAddress);
      if (dexData?.chainId) chainId = dexData.chainId;

      const chainConfig = getChainConfig(chainId);
      if (!chainConfig) {
        inst.error = `Unsupported chain: ${chainId}`;
        this.instances.set(configId, inst);
        return { running: false, error: inst.error };
      }

      await db
        .update(botConfigTable)
        .set({ chain: chainId, isActive: true })
        .where(eq(botConfigTable.id, configId));

      inst.chainId = chainId;
      inst.running = true;
      inst.dexCache = { data: dexData, fetchedAt: Date.now() };

      const handleBuy = (event: BuyEvent) => {
        inst.lastCheckAt = new Date();
        this.onBuyEvent(event, configId, chainId, inst).catch((err) => {
          logger.error({ err, configId }, "Error handling buy event");
        });
      };

      if (chainConfig.type === "solana") {
        inst.monitor = new SolanaMonitor(config.tokenAddress, handleBuy);
      } else {
        inst.monitor = new EvmMonitor(config.tokenAddress, dexData?.pairAddress ?? null, chainConfig, handleBuy);
      }

      await inst.monitor.start();
      this.instances.set(configId, inst);
      logger.info({ configId, token: config.tokenAddress, chain: chainId }, "Bot started");
      return { running: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      inst.error = msg;
      inst.running = false;
      this.instances.set(configId, inst);
      return { running: false, error: msg };
    }
  }

  async stop(configId: number): Promise<void> {
    const inst = this.instances.get(configId);
    if (!inst) return;
    if (inst.monitor) {
      await inst.monitor.stop();
      inst.monitor = null;
    }
    inst.running = false;
    await db
      .update(botConfigTable)
      .set({ isActive: false })
      .where(eq(botConfigTable.id, configId));
    this.instances.set(configId, inst);
    logger.info({ configId }, "Bot stopped");
  }

  async autoStartAll(): Promise<void> {
    const configs = await db
      .select()
      .from(botConfigTable)
      .where(and(eq(botConfigTable.isActive, true)));
    for (const config of configs) {
      logger.info({ configId: config.id, name: config.name }, "Auto-starting bot");
      await this.start(config.id);
    }
  }

  private async onBuyEvent(
    event: BuyEvent,
    configId: number,
    chainId: string,
    inst: BotInstance,
  ): Promise<void> {
    const [config] = await db
      .select()
      .from(botConfigTable)
      .where(eq(botConfigTable.id, configId))
      .limit(1);
    const token = resolveToken(config);
    if (!token || !config?.chatId) return;

    const chainConfig = getChainConfig(chainId);
    if (!chainConfig) return;

    const dexData = await this.getCachedDexData(config.tokenAddress!, inst);
    const marketCap = dexData?.marketCap ?? dexData?.fdv ?? null;
    const priceChangePct = dexData?.priceChange?.h24 ?? null;
    const tokenPriceUsd = dexData?.priceUsd ? parseFloat(dexData.priceUsd) : 0;
    const amountUsd =
      event.amountUsd > 0.001
        ? event.amountUsd
        : tokenPriceUsd > 0
          ? event.tokensReceived * tokenPriceUsd
          : 0;

    if (amountUsd < (config.minBuyUsd ?? 1)) return;

    const tier = getTier(amountUsd, config.tier1Min, config.tier2Min, config.tier3Min);

    await db.insert(alertsTable).values({
      botConfigId: configId,
      txSignature: event.signature,
      chain: chainId,
      buyerAddress: event.buyerAddress,
      amountUsd,
      amountNative: event.amountNative,
      nativeCurrency: chainConfig.nativeCurrency,
      tokensReceived: event.tokensReceived,
      marketCap: marketCap ?? null,
      priceChangePct: priceChangePct ?? null,
      tier,
    });

    const tgBot = new TelegramBot(token, { polling: false });
    const alertParams: AlertParams = {
      tokenName: config.tokenName ?? dexData?.baseToken.name ?? "Token",
      tokenSymbol: config.tokenSymbol ?? dexData?.baseToken.symbol ?? "TKN",
      chainName: chainConfig.name,
      tier,
      emojiPerTier: config.emojiPerTier,
      alertEmoji: config.alertEmoji || "🟢",
      amountUsd,
      amountNative: event.amountNative,
      nativeCurrency: chainConfig.nativeCurrency,
      tokensReceived: event.tokensReceived,
      buyerAddress: event.buyerAddress,
      txSignature: event.signature,
      explorerTx: chainConfig.explorerTx,
      explorerAddress: chainConfig.explorerAddress,
      marketCap: marketCap ?? null,
      priceChangePct: priceChangePct ?? null,
      dextUrl: config.dextUrl,
      screenerUrl: config.screenerUrl,
      buyUrl: config.buyUrl,
      trendingUrl: config.trendingUrl,
    };
    const message = buildAlertMessage(alertParams);
    const keyboard = buildAlertKeyboard(alertParams);

    const mediaFileId = config.alertMediaFileId;
    const mediaType = config.alertMediaType ?? "photo";
    const mediaUrl = config.alertImageUrl;

    if (mediaFileId || mediaUrl) {
      const mediaSrc = (mediaFileId ?? mediaUrl) as string;
      const mediaOpts = { caption: message, parse_mode: "HTML" as const, reply_markup: keyboard };
      if (mediaType === "video") {
        await tgBot.sendVideo(config.chatId, mediaSrc, mediaOpts);
      } else if (mediaType === "animation") {
        await tgBot.sendAnimation(config.chatId, mediaSrc, mediaOpts);
      } else {
        await tgBot.sendPhoto(config.chatId, mediaSrc, mediaOpts);
      }
    } else {
      await tgBot.sendMessage(config.chatId, message, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
    }

    logger.info({ configId, buyer: event.buyerAddress, amountUsd, chain: chainId, tier }, "Buy alert sent");
  }

  private async getCachedDexData(tokenAddress: string, inst: BotInstance): Promise<DexScreenerPair | null> {
    const now = Date.now();
    if (now - inst.dexCache.fetchedAt < 30_000) return inst.dexCache.data;
    const data = await getDexScreenerData(tokenAddress);
    inst.dexCache = { data, fetchedAt: now };
    return data;
  }

  async sendTestAlert(configId: number): Promise<{ success: boolean; message: string }> {
    const [config] = await db
      .select()
      .from(botConfigTable)
      .where(eq(botConfigTable.id, configId))
      .limit(1);

    const token = resolveToken(config);
    if (!token || !config?.chatId) {
      return { success: false, message: "Bot token or chat ID not configured." };
    }

    try {
      const tgBot = new TelegramBot(token, { polling: false });
      const tokenName = config.tokenName ?? "your token";
      const chainId = config.chain ?? "solana";
      const chainConfig = getChainConfig(chainId);
      const chainName = chainConfig?.name ?? chainId;

      const msg =
        `✅ <b>Bot connected successfully!</b>\n\n` +
        `Monitoring: <b>${tokenName}</b> on <b>${chainName}</b>\n` +
        `Min buy: <b>$${config.minBuyUsd ?? 1}</b>\n\n` +
        `Real buy alerts will appear here as they happen on-chain.`;

      await tgBot.sendMessage(config.chatId, msg, { parse_mode: "HTML" });
      return { success: true, message: "Connection verified! Bot is ready." };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: msg };
    }
  }
}

export const botRegistry = new BotRegistry();
