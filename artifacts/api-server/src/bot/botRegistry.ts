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

/**
 * Auto-tier based on multiples of the configured min buy.
 * Tier 1 (small):  1× – 9× minBuy
 * Tier 2 (medium): 10× – 49× minBuy
 * Tier 3 (whale):  50×+ minBuy
 */
function getTier(amountUsd: number, minBuyUsd: number): number {
  const min = minBuyUsd > 0 ? minBuyUsd : 1;
  if (amountUsd >= min * 50) return 3; // whale
  if (amountUsd >= min * 10) return 2; // medium
  return 1;                             // small
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
  const max = Math.max(1, params.emojiPerTier);

  // Emoji count scales by tier:
  //   Tier 1 (small) → 1 emoji always (no matter what emojiPerTier is)
  //   Tier 2 (medium) → half of max, minimum 2
  //   Tier 3 (whale) → full emojiPerTier
  const emojiCount =
    params.tier === 3 ? max :
    params.tier === 2 ? Math.max(2, Math.round(max / 2)) :
    1;
  const emojiBar = emoji.repeat(emojiCount);

  // Whale label for tier 3
  const buyLabel = params.tier === 3 ? "🐋 Whale Buy!" : "New Buy!";

  const buyerUrl = params.explorerAddress.replace("{address}", params.buyerAddress);
  const txUrl = params.explorerTx.replace("{tx}", params.txSignature);
  const shortBuyer = `${params.buyerAddress.slice(0, 6)}…${params.buyerAddress.slice(-4)}`;

  const nativeStr = params.amountNative > 0
    ? ` (${params.amountNative.toFixed(4)} ${params.nativeCurrency})`
    : "";

  const mcapLine = params.marketCap !== null
    ? `\n💎 Market Cap: <b>${formatNumber(params.marketCap)}</b>`
    : "";

  const priceChangeLine = params.priceChangePct !== null
    ? `\n📊 24h: <b>${params.priceChangePct >= 0 ? "+" : ""}${params.priceChangePct.toFixed(1)}%</b>`
    : "";

  // Action links embedded in text (NOT inline buttons)
  const linkParts: string[] = [];
  if (params.buyUrl) linkParts.push(`<a href="${params.buyUrl}">🛒 Buy</a>`);
  if (params.dextUrl) linkParts.push(`<a href="${params.dextUrl}">📊 DexTools</a>`);
  if (params.screenerUrl) linkParts.push(`<a href="${params.screenerUrl}">📈 DexScreener</a>`);
  if (params.trendingUrl) linkParts.push(`<a href="${params.trendingUrl}">🔥 Trending</a>`);
  const linksLine = linkParts.length > 0 ? `\n\n${linkParts.join("  |  ")}` : "";

  return (
    `${emojiBar}\n` +
    `<b>${params.tokenName} — ${buyLabel}</b>\n` +
    `${emojiBar}\n\n` +
    `💰 Spent: <b>${formatNumber(params.amountUsd)}</b>${nativeStr}\n` +
    `🪙 Got: <b>${params.tokensReceived.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${params.tokenSymbol}</b>\n` +
    `👤 Buyer: <a href="${buyerUrl}">${shortBuyer}</a>` +
    mcapLine +
    priceChangeLine +
    linksLine
  );
}

function buildAlertKeyboard(params: AlertParams): TelegramBot.InlineKeyboardMarkup | undefined {
  // Action links (Buy, DexTools, Screener, Trending) are embedded as hyperlinks
  // in the message text. The keyboard only shows explorer buttons.
  const buyerUrl = params.explorerAddress.replace("{address}", params.buyerAddress);
  const txUrl = params.explorerTx.replace("{tx}", params.txSignature);

  return {
    inline_keyboard: [[
      { text: "👤 Buyer Wallet", url: buyerUrl },
      { text: "🔗 View TX", url: txUrl },
    ]],
  };
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

    const minBuy = config.minBuyUsd ?? 1;
    if (amountUsd < minBuy) return;

    const tier = getTier(amountUsd, minBuy);

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
