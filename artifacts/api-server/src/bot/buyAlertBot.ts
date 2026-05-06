import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { botConfigTable, alertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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
    // Prefer pairs where the configured address is the base token, then sort by liquidity
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

function buildButtonRows(
  buttons: { text: string; url: string }[],
): TelegramBot.InlineKeyboardButton[][] {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2).map((b) => ({ text: b.text, url: b.url })));
  }
  return rows;
}

function buildAlertMessage(params: {
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
  priceUsd: number | null;
  liquidity: number | null;
  buyUrl: string | null;
}): string {
  const emoji = params.alertEmoji || "🟢";
  const circles = emoji.repeat(params.tier * params.emojiPerTier);
  const buyerUrl = params.explorerAddress.replace("{address}", params.buyerAddress);
  const txUrl = params.explorerTx.replace("{tx}", params.txSignature);

  const pctLine =
    params.priceChangePct !== null
      ? `\n📈 ${params.priceChangePct >= 0 ? "+" : ""}${params.priceChangePct.toFixed(1)}% (24h)`
      : "";

  const mcapLine =
    params.marketCap !== null
      ? `\n💰 Mkt Cap: ${formatNumber(params.marketCap)}`
      : "";

  const priceUsdLine =
    params.priceUsd !== null && params.priceUsd > 0
      ? `\n💵 Price: $${params.priceUsd < 0.001 ? params.priceUsd.toExponential(3) : params.priceUsd < 0.01 ? params.priceUsd.toFixed(6) : params.priceUsd.toFixed(4)}`
      : "";

  const liquidityLine =
    params.liquidity !== null && params.liquidity > 0
      ? `\n💧 Liq: ${formatNumber(params.liquidity)}`
      : "";

  return (
    `<b>${params.tokenName} Buy!</b> <i>${params.chainName}</i>\n` +
    `${circles}\n\n` +
    `🔀 Spent <b>${formatNumber(params.amountUsd)}</b> (<b>${params.amountNative.toFixed(4)} ${params.nativeCurrency}</b>)\n` +
    `🔀 Got <b>${params.tokensReceived.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${params.tokenSymbol}</b>\n` +
    `👤 <a href="${buyerUrl}">Buyer</a> | <a href="${txUrl}">TX</a>` +
    pctLine + mcapLine + priceUsdLine + liquidityLine
  );
}

class BuyAlertBot {
  private bot: TelegramBot | null = null;
  private running = false;
  private monitoringToken: string | null = null;
  private lastCheckAt: Date | null = null;
  private lastError: string | null = null;
  private monitor: SolanaMonitor | EvmMonitor | null = null;
  private dexCache: { data: DexScreenerPair | null; fetchedAt: number } = { data: null, fetchedAt: 0 };

  getStatus() {
    return {
      running: this.running,
      monitoringToken: this.monitoringToken,
      lastCheckAt: this.lastCheckAt,
      error: this.lastError,
    };
  }

  async start(): Promise<{ running: boolean; error?: string }> {
    if (this.running) return { running: true };

    const [config] = await db.select().from(botConfigTable).limit(1);

    if (!config?.telegramToken) {
      this.lastError = "Telegram bot token not set. Configure in Settings.";
      return { running: false, error: this.lastError };
    }
    if (!config.tokenAddress) {
      this.lastError = "Token address not set. Configure in Settings.";
      return { running: false, error: this.lastError };
    }
    if (!config.chatId) {
      this.lastError = "Telegram chat ID not set. Configure in Settings.";
      return { running: false, error: this.lastError };
    }

    try {
      this.bot = new TelegramBot(config.telegramToken, { polling: false });

      // Detect chain — prefer config.chain, otherwise detect from address or DexScreener
      let chainId = config.chain ?? detectChainFromAddress(config.tokenAddress);

      // If DexScreener knows this token, use its chain
      const dexData = await getDexScreenerData(config.tokenAddress);
      if (dexData?.chainId) chainId = dexData.chainId;

      const chainConfig = getChainConfig(chainId);
      if (!chainConfig) {
        this.lastError = `Unsupported chain: ${chainId}`;
        return { running: false, error: this.lastError };
      }

      // Save detected chain back to DB
      await db.update(botConfigTable).set({ chain: chainId }).where(eq(botConfigTable.id, config.id));

      this.monitoringToken = config.tokenAddress;
      this.running = true;
      this.lastError = null;
      this.dexCache = { data: dexData, fetchedAt: Date.now() };

      const handleBuy = (event: BuyEvent) => {
        this.lastCheckAt = new Date();
        this.onBuyEvent(event, chainId).catch((err) => {
          logger.error({ err }, "Error handling buy event");
        });
      };

      if (chainConfig.type === "solana") {
        this.monitor = new SolanaMonitor(config.tokenAddress, handleBuy);
      } else {
        const pairAddress = dexData?.pairAddress ?? null;
        this.monitor = new EvmMonitor(config.tokenAddress, pairAddress, chainConfig, handleBuy);
      }

      await this.monitor.start();

      logger.info(
        { token: config.tokenAddress, chain: chainId },
        `Buy alert bot started (${chainConfig.name})`,
      );
      return { running: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.running = false;
      return { running: false, error: msg };
    }
  }

  async stop(): Promise<void> {
    if (this.monitor) {
      await this.monitor.stop();
      this.monitor = null;
    }
    this.bot = null;
    this.running = false;
    this.monitoringToken = null;
    this.dexCache = { data: null, fetchedAt: 0 };
    logger.info("Buy alert bot stopped");
  }

  private async onBuyEvent(event: BuyEvent, chainId: string): Promise<void> {
    const [config] = await db.select().from(botConfigTable).limit(1);
    if (!config || !this.bot || !config.chatId) return;

    const chainConfig = getChainConfig(chainId);
    if (!chainConfig) return;

    const dexData = await this.getCachedDexData(config.tokenAddress!);
    const marketCap = dexData?.marketCap ?? dexData?.fdv ?? null;
    const priceChangePct = dexData?.priceChange?.h24 ?? null;
    const priceUsd = dexData?.priceUsd ? parseFloat(dexData.priceUsd) : null;
    const liquidity = dexData?.liquidity?.usd ?? null;

    // Reliable USD amount: prefer what the monitor computed, but fall back to
    // tokensReceived × current price from DexScreener.
    const tokenPriceUsd = priceUsd ?? 0;
    const amountUsd =
      event.amountUsd > 0.001
        ? event.amountUsd
        : tokenPriceUsd > 0
          ? event.tokensReceived * tokenPriceUsd
          : 0;

    if (amountUsd < (config.minBuyUsd ?? 1)) return;

    const tier = getTier(amountUsd, config.tier1Min, config.tier2Min, config.tier3Min);

    const [savedAlert] = await db
      .insert(alertsTable)
      .values({
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
      })
      .returning();

    if (!savedAlert) return;

    const message = buildAlertMessage({
      tokenName: config.tokenName ?? dexData?.baseToken.name ?? "Token",
      tokenSymbol: config.tokenSymbol ?? dexData?.baseToken.symbol ?? "TKN",
      chainName: chainConfig.name,
      tier,
      emojiPerTier: config.emojiPerTier,
      alertEmoji: config.alertEmoji ?? "🟢",
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
      priceUsd: priceUsd ?? null,
      liquidity: liquidity ?? null,
      buyUrl: (() => {
        if (!config.buyUrl) return null;
        try { const p = JSON.parse(config.buyUrl) as { url?: string }; return p.url ?? config.buyUrl; } catch { return config.buyUrl; }
      })(),
    });

    // ── Build inline keyboard buttons ─────────────────────────────────────
    // Standard action buttons (from config)
    // Row 1: DexTools | Chart | Buy (buy is 3rd if set)
    // Row 2: Trending alone
    // Row 3+: extra custom buttons 2 per row
    const mainRow: TelegramBot.InlineKeyboardButton[] = [];
    if (config.dextUrl) mainRow.push({ text: "📊 DexTools", url: config.dextUrl });
    if (config.screenerUrl) mainRow.push({ text: "📈 Chart", url: config.screenerUrl });
    if (config.buyUrl) {
      const buyHref = (() => { try { const p = JSON.parse(config.buyUrl) as { url?: string }; return p.url ?? config.buyUrl; } catch { return config.buyUrl; } })();
      const buyLabel = (() => { try { const p = JSON.parse(config.buyUrl) as { text?: string }; return p.text ?? "🛒 Buy"; } catch { return "🛒 Buy"; } })();
      mainRow.push({ text: buyLabel, url: buyHref });
    }

    const trendingHref = config.trendingUrl ?? config.screenerUrl ?? null;

    const extraButtons: { text: string; url: string }[] = [];
    if (config.buyButtons) {
      try {
        const extra = JSON.parse(config.buyButtons) as { text: string; url: string }[];
        if (Array.isArray(extra)) extraButtons.push(...extra);
      } catch { /* ignore malformed JSON */ }
    }

    const keyboardRows: TelegramBot.InlineKeyboardButton[][] = [];
    if (mainRow.length > 0) keyboardRows.push(mainRow);
    if (trendingHref) keyboardRows.push([{ text: "🔥 Trending", url: trendingHref }]);
    for (let i = 0; i < extraButtons.length; i += 2) {
      keyboardRows.push(extraButtons.slice(i, i + 2).map((b) => ({ text: b.text, url: b.url })));
    }
    const keyboard: TelegramBot.InlineKeyboardMarkup | undefined =
      keyboardRows.length > 0 ? { inline_keyboard: keyboardRows } : undefined;

    // ── Send alert (photo / video / animation / text) ─────────────────────
    const baseOpts = {
      parse_mode: "HTML" as const,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    };

    if (config.alertMediaFileId && config.alertMediaType) {
      if (config.alertMediaType === "video") {
        await this.bot.sendVideo(config.chatId, config.alertMediaFileId, {
          caption: message, ...baseOpts,
        });
      } else if (config.alertMediaType === "animation") {
        await this.bot.sendAnimation(config.chatId, config.alertMediaFileId, {
          caption: message, ...baseOpts,
        });
      } else {
        await this.bot.sendPhoto(config.chatId, config.alertMediaFileId, {
          caption: message, ...baseOpts,
        });
      }
    } else if (config.alertImageUrl) {
      await this.bot.sendPhoto(config.chatId, config.alertImageUrl, {
        caption: message, ...baseOpts,
      });
    } else {
      await this.bot.sendMessage(config.chatId, message, {
        ...baseOpts,
        disable_web_page_preview: true,
      });
    }

    logger.info(
      { buyer: event.buyerAddress, amountUsd, chain: chainId, tier },
      "Buy alert sent",
    );
  }

  private async getCachedDexData(tokenAddress: string): Promise<DexScreenerPair | null> {
    const now = Date.now();
    if (now - this.dexCache.fetchedAt < 30_000) return this.dexCache.data;
    const data = await getDexScreenerData(tokenAddress);
    this.dexCache = { data, fetchedAt: now };
    return data;
  }

  async sendTestAlert(): Promise<{ success: boolean; message: string }> {
    const [config] = await db.select().from(botConfigTable).limit(1);

    if (!config?.telegramToken || !config?.chatId) {
      return { success: false, message: "Bot token or chat ID not configured." };
    }

    try {
      const testBot = new TelegramBot(config.telegramToken, { polling: false });
      const tokenName = config.tokenName ?? "your token";
      const chainId = config.chain ?? "solana";
      const chainConfig = getChainConfig(chainId);
      const chainName = chainConfig?.name ?? chainId;

      const msg =
        `✅ <b>Bot connected successfully!</b>\n\n` +
        `Monitoring: <b>${tokenName}</b> on <b>${chainName}</b>\n` +
        `Min buy: <b>$${config.minBuyUsd ?? 1}</b>\n\n` +
        `Real buy alerts will appear here as they happen on-chain.`;

      await testBot.sendMessage(config.chatId, msg, { parse_mode: "HTML" });
      return { success: true, message: "Connection verified! Bot is ready." };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: msg };
    }
  }
}

export const buyAlertBot = new BuyAlertBot();
