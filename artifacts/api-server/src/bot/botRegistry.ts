import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { botConfigTable, alertsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getChainConfig, detectChainFromAddress } from "./chains/chainConfig";
import { SolanaMonitor, type BuyEvent } from "./chains/solanaMonitor";
import { EvmMonitor } from "./chains/evmMonitor";
import { getNativePrice, getTrendingInfo } from "./chains/priceService";
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
  minBuyUsd: number;
  alertEmoji: string;
  alertStyle: string; // "sosana" | "trending"
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
  telegramUrl?: string | null;
  twitterUrl?: string | null;
  websiteUrl?: string | null;
  trendingRank: number | null;     // position in DexScreener boosts leaderboard, null if not trending
  dexPaidScore: number | null;     // total boost amount ("Dex Paid" score), null if 0
}

// ── Shared helpers ─────────────────────────────────────────────────────────────
function emojiBar(params: AlertParams): string {
  const emoji = params.alertEmoji || "🟢";
  const minBuy = params.minBuyUsd > 0 ? params.minBuyUsd : 1;
  const rawCount = Math.floor(params.amountUsd / minBuy);
  return emoji.repeat(Math.max(1, Math.min(rawCount, 200)));
}

// ── Style 1: SOSANA (default) ──────────────────────────────────────────────────
// Clean, text-link format matching the SOSANA/BOBO reference look.
function buildSosanaMessage(params: AlertParams): string {
  const buyLabel = params.tier === 3 ? "🐋 Whale Buy!" : "Buy!";
  const buyerUrl = params.explorerAddress.replace("{address}", params.buyerAddress);
  const txUrl = params.explorerTx.replace("{tx}", params.txSignature);

  const trendingLine = params.trendingRank !== null
    ? `\n📡 Trending #${params.trendingRank}`
    : "";

  const nativeStr = params.amountNative > 0
    ? ` (${params.amountNative.toFixed(3)} ${params.nativeCurrency})`
    : "";

  const positionLine = params.priceChangePct !== null
    ? `\n🪙 Position <b>${params.priceChangePct >= 0 ? "+" : ""}${params.priceChangePct.toFixed(0)}%</b>`
    : "";

  const mcapLine = params.marketCap !== null
    ? `\n💰 Market Cap <b>$${Math.round(params.marketCap).toLocaleString("en-US")}</b>`
    : "";

  const linkParts: string[] = [];
  if (params.dextUrl) linkParts.push(`<a href="${params.dextUrl}">DexT</a>`);
  if (params.screenerUrl) linkParts.push(`<a href="${params.screenerUrl}">Screener</a>`);
  if (params.buyUrl) linkParts.push(`<a href="${params.buyUrl}">Buy</a>`);
  if (params.trendingUrl) linkParts.push(`<a href="${params.trendingUrl}">Trending</a>`);
  const linksLine = linkParts.length > 0 ? `\n\n${linkParts.join(" | ")}` : "";

  return (
    `<b>${params.tokenName} ${buyLabel}</b>` +
    trendingLine + `\n` +
    `${emojiBar(params)}\n\n` +
    `🔀 Spent <b>${formatNumber(params.amountUsd)}</b>${nativeStr}\n` +
    `🔀 Got <b>${params.tokensReceived.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${params.tokenSymbol}</b>\n` +
    `👤 <a href="${buyerUrl}">Buyer</a> / <a href="${txUrl}">TX</a>` +
    positionLine +
    mcapLine +
    linksLine
  );
}

function buildSosanaKeyboard(_params: AlertParams): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [] };
}

// ── Style 2: Trending ──────────────────────────────────────────────────────────
// Richer format with real trending rank, social links and inline buy/dex buttons.
function buildTrendingMessage(params: AlertParams): string {
  const buyerUrl = params.explorerAddress.replace("{address}", params.buyerAddress);
  const txUrl = params.explorerTx.replace("{tx}", params.txSignature);
  const shortBuyer = `${params.buyerAddress.slice(0, 6)}…${params.buyerAddress.slice(-4)}`;

  // Trending rank line shown immediately after the title (matching reference image)
  const trendingHeaderLine = params.trendingRank !== null
    ? `\n📡 Trending #${params.trendingRank}`
    : "";

  const nativeStr = params.amountNative > 0
    ? `${params.amountNative.toFixed(3)} ${params.nativeCurrency} (${formatNumber(params.amountUsd)})`
    : formatNumber(params.amountUsd);

  const positionLine = params.priceChangePct !== null
    ? `\n🆕| Position: <b>${params.priceChangePct >= 0 ? "+" : ""}${params.priceChangePct.toFixed(1)}%</b>`
    : "";

  const mcapLine = params.marketCap !== null
    ? `\n📷| Market Cap: <b>$${Math.round(params.marketCap).toLocaleString("en-US")}</b>`
    : "";

  const socialParts: string[] = [];
  if (params.telegramUrl) socialParts.push(`<a href="${params.telegramUrl}">Telegram</a>`);
  if (params.twitterUrl) socialParts.push(`<a href="${params.twitterUrl}">X</a>`);
  if (params.websiteUrl) socialParts.push(`<a href="${params.websiteUrl}">Website</a>`);
  const socialLine = socialParts.length > 0 ? `\n👥| ${socialParts.join(" | ")}` : "";

  // Dex Paid score + repeat trending rank footer (matching reference image 1)
  const dexPaidLine = params.dexPaidScore !== null && params.dexPaidScore > 0
    ? `\n🐺 Dex Paid ⚡ ${Math.round(params.dexPaidScore).toLocaleString("en-US")}`
    : "";
  const trendingFooterLine = params.trendingRank !== null
    ? `\n🔴 Dex trending #${params.trendingRank}`
    : "";

  return (
    `<b>${params.tokenName} [${params.tokenSymbol}] Buy!</b>` +
    trendingHeaderLine + `\n` +
    `${emojiBar(params)}\n\n` +
    `💲| <b>${nativeStr}</b>\n` +
    `💼| Got: <b>${params.tokensReceived.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${params.tokenSymbol}</b>\n` +
    `👤| <a href="${buyerUrl}">${shortBuyer}</a> | <a href="${txUrl}">Txn</a>` +
    positionLine +
    mcapLine +
    socialLine +
    dexPaidLine +
    trendingFooterLine
  );
}

function buildTrendingKeyboard(params: AlertParams): TelegramBot.InlineKeyboardMarkup {
  const buttons: TelegramBot.InlineKeyboardButton[] = [];
  if (params.buyUrl) buttons.push({ text: "🛒 Buy", url: params.buyUrl });
  if (params.dextUrl) buttons.push({ text: "📊 DexTools", url: params.dextUrl });
  if (params.screenerUrl) buttons.push({ text: "📈 Screener", url: params.screenerUrl });
  if (params.trendingUrl) buttons.push({ text: "🔥 Trending", url: params.trendingUrl });
  return buttons.length > 0 ? { inline_keyboard: [buttons] } : { inline_keyboard: [] };
}

// ── Dispatcher ─────────────────────────────────────────────────────────────────
function buildAlertMessage(params: AlertParams): string {
  return params.alertStyle === "trending"
    ? buildTrendingMessage(params)
    : buildSosanaMessage(params);
}

function buildAlertKeyboard(params: AlertParams): TelegramBot.InlineKeyboardMarkup {
  return params.alertStyle === "trending"
    ? buildTrendingKeyboard(params)
    : buildSosanaKeyboard(params);
}

interface BotInstance {
  configId: number;
  chainId: string;
  running: boolean;
  lastCheckAt: Date | null;
  error: string | null;
  monitor: SolanaMonitor | EvmMonitor | null;
  dexCache: { data: DexScreenerPair | null; fetchedAt: number };
  repeatTimer: ReturnType<typeof setInterval> | null;
  raidTimer: ReturnType<typeof setInterval> | null;
}

// ── Twitter raid tracker ────────────────────────────────────────────────────────
async function getTweetMetrics(tweetId: string): Promise<{ likes: number; retweets: number; replies: number } | null> {
  const token = process.env["TWITTER_BEARER_TOKEN"];
  if (!token) return null;
  try {
    const res = await fetch(
      `https://api.twitter.com/2/tweets/${tweetId}?tweet.fields=public_metrics`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const data = await res.json() as {
      data?: { public_metrics?: { like_count: number; retweet_count: number; reply_count: number } };
    };
    const m = data.data?.public_metrics;
    if (!m) return null;
    return { likes: m.like_count, retweets: m.retweet_count, replies: m.reply_count };
  } catch { return null; }
}

function buildRaidMessage(
  metrics: { likes: number; retweets: number; replies: number },
  targets: { likes: number; retweets: number; replies: number },
  tweetUrl: string,
): string {
  function statLine(label: string, current: number, target: number): string {
    if (target <= 0) return "";
    const pct = Math.min(100, Math.round((current / target) * 100));
    const reached = current >= target;
    const sq = reached ? "🟩" : "🟥";
    const pctStr = pct >= 100 ? "💯%" : `${pct}%`;
    return `${sq} ${label} <b>${current}</b> | ${target} [${pctStr}]`;
  }
  const lines: string[] = [`⚡ <b>Raid Tweet</b>\n`];
  const l = statLine("Likes", metrics.likes, targets.likes);
  const r = statLine("Retweets", metrics.retweets, targets.retweets);
  const rep = statLine("Replies", metrics.replies, targets.replies);
  if (l) lines.push(l);
  if (r) lines.push(r);
  if (rep) lines.push(rep);
  lines.push(`\n${tweetUrl}`);
  return lines.join("\n");
}

// ── Periodic repeat post (real live data, not a fake buy) ──────────────────────
function buildRepeatMessage(config: BotConfig, dexData: DexScreenerPair | null, chainName: string): string {
  const name = config.tokenName ?? dexData?.baseToken.name ?? "Token";
  const symbol = config.tokenSymbol ?? dexData?.baseToken.symbol ?? "TKN";

  const price = dexData?.priceUsd ? parseFloat(dexData.priceUsd) : null;
  const priceStr = price === null ? "—"
    : price < 0.000001 ? `$${price.toFixed(10)}`
    : price < 0.001 ? `$${price.toFixed(8)}`
    : price < 1 ? `$${price.toFixed(6)}`
    : `$${price.toFixed(4)}`;

  const change24h = dexData?.priceChange?.h24 ?? null;
  const changeStr = change24h === null ? "—"
    : `${change24h >= 0 ? "+" : ""}${change24h.toFixed(1)}%`;

  const mcap = dexData?.marketCap ?? dexData?.fdv ?? null;
  const mcapStr = mcap === null ? "—" : `$${Math.round(mcap).toLocaleString("en-US")}`;

  const liq = dexData?.liquidity?.usd ?? null;
  const liqStr = liq === null ? "—"
    : liq >= 1_000_000 ? `$${(liq / 1_000_000).toFixed(2)}M`
    : liq >= 1_000 ? `$${(liq / 1_000).toFixed(1)}K`
    : `$${Math.round(liq)}`;

  const linkParts: string[] = [];
  if (config.dextUrl) linkParts.push(`<a href="${config.dextUrl}">DexT</a>`);
  if (config.screenerUrl) linkParts.push(`<a href="${config.screenerUrl}">Screener</a>`);
  if (config.buyUrl) linkParts.push(`<a href="${config.buyUrl}">Buy</a>`);
  const linksLine = linkParts.length > 0 ? `\n\n${linkParts.join(" | ")}` : "";

  return (
    `📊 <b>${name} [${symbol}]</b> — ${chainName}\n\n` +
    `💲 Price: <b>${priceStr}</b>\n` +
    `📈 24h: <b>${changeStr}</b>\n` +
    `💰 Market Cap: <b>${mcapStr}</b>\n` +
    `💧 Liquidity: <b>${liqStr}</b>` +
    linksLine
  );
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
      repeatTimer: null,
      raidTimer: null,
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

      // Start repeat timer if configured
      if (config.repeatInterval && config.repeatInterval > 0) {
        inst.repeatTimer = setInterval(() => {
          this.sendRepeatAlert(configId).catch((err) =>
            logger.error({ err, configId }, "Repeat alert error"),
          );
        }, config.repeatInterval * 1000);
        logger.info({ configId, intervalSecs: config.repeatInterval }, "Repeat timer started");
      }

      // Start raid timer if configured
      if (config.raidTweetUrl && config.raidInterval && config.raidInterval > 0) {
        inst.raidTimer = setInterval(() => {
          this.sendRaidAlert(configId).catch((err) =>
            logger.error({ err, configId }, "Raid alert error"),
          );
        }, config.raidInterval * 1000);
        logger.info({ configId, intervalSecs: config.raidInterval }, "Raid timer started");
      }

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
    if (inst.repeatTimer) { clearInterval(inst.repeatTimer); inst.repeatTimer = null; }
    if (inst.raidTimer) { clearInterval(inst.raidTimer); inst.raidTimer = null; }
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

  /** Swap the repeat timer live — called when admin changes the interval via /setup */
  restartRepeatTimer(configId: number, intervalSecs: number | null): void {
    const inst = this.instances.get(configId);
    if (!inst || !inst.running) return;

    if (inst.repeatTimer) {
      clearInterval(inst.repeatTimer);
      inst.repeatTimer = null;
    }

    const secs = intervalSecs ?? 0;
    if (secs > 0) {
      inst.repeatTimer = setInterval(() => {
        this.sendRepeatAlert(configId).catch((err) =>
          logger.error({ err, configId }, "Repeat alert error"),
        );
      }, secs * 1000);
      logger.info({ configId, intervalSecs: secs }, "Repeat timer updated");
    }
    this.instances.set(configId, inst);
  }

  /** Update raid timer live — called when admin changes url/interval */
  restartRaidTimer(configId: number, intervalSecs: number | null): void {
    const inst = this.instances.get(configId);
    if (!inst) return;
    if (inst.raidTimer) { clearInterval(inst.raidTimer); inst.raidTimer = null; }
    const secs = intervalSecs ?? 0;
    if (secs > 0 && inst.running) {
      inst.raidTimer = setInterval(() => {
        this.sendRaidAlert(configId).catch((err) =>
          logger.error({ err, configId }, "Raid alert error"),
        );
      }, secs * 1000);
      logger.info({ configId, intervalSecs: secs }, "Raid timer updated");
    }
    this.instances.set(configId, inst);
  }

  private async sendRaidAlert(configId: number): Promise<void> {
    const [config] = await db
      .select().from(botConfigTable).where(eq(botConfigTable.id, configId)).limit(1);
    const token = resolveToken(config);
    if (!token || !config?.chatId || !config.raidTweetUrl) return;

    const tweetId = config.raidTweetUrl.match(/\/status\/(\d+)/)?.[1];
    if (!tweetId) return;

    const metrics = await getTweetMetrics(tweetId);
    if (!metrics) return;

    const targets = {
      likes: config.raidTargetLikes ?? 10,
      retweets: config.raidTargetRetweets ?? 5,
      replies: config.raidTargetReplies ?? 5,
    };
    const message = buildRaidMessage(metrics, targets, config.raidTweetUrl);
    const tgBot = new TelegramBot(token, { polling: false });
    // disable_web_page_preview=false lets Telegram embed the tweet preview card
    await tgBot.sendMessage(config.chatId, message, { parse_mode: "HTML" });
    logger.info({ configId, tweetId, metrics }, "Raid alert sent");
  }

  private async sendRepeatAlert(configId: number): Promise<void> {
    const [config] = await db
      .select().from(botConfigTable).where(eq(botConfigTable.id, configId)).limit(1);
    const token = resolveToken(config);
    if (!token || !config?.chatId || !config.tokenAddress) return;

    const inst = this.instances.get(configId);
    if (!inst) return;

    const dexData = await this.getCachedDexData(config.tokenAddress, inst);
    const chainConfig = getChainConfig(inst.chainId);
    const chainName = chainConfig?.name ?? inst.chainId;

    const message = buildRepeatMessage(config, dexData, chainName);
    const tgBot = new TelegramBot(token, { polling: false });
    await tgBot.sendMessage(config.chatId, message, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    logger.info({ configId }, "Repeat alert sent");
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

    // Fetch live trending rank from DexScreener boosts leaderboard (cached 5 min)
    let trendingRank: number | null = null;
    let dexPaidScore: number | null = null;
    try {
      const trendInfo = await getTrendingInfo(config.tokenAddress!, chainId);
      trendingRank = trendInfo.rank;
      dexPaidScore = trendInfo.dexPaidScore;
    } catch { /* non-critical, skip */ }
    const amountUsd =
      event.amountUsd > 0.001
        ? event.amountUsd
        : tokenPriceUsd > 0
          ? event.tokensReceived * tokenPriceUsd
          : 0;

    // If the monitor couldn't determine how much native token was spent
    // (e.g. WETH/ERC-20 swap on EVM, or USDC swap on Solana), back-calculate
    // from amountUsd so the alert always shows "X.XX ETH" / "X.XX SOL".
    let amountNative = event.amountNative;
    if (amountNative <= 0 && amountUsd > 0) {
      try {
        const nativePrice = await getNativePrice(chainConfig.nativeCoinGeckoId);
        if (nativePrice > 0) amountNative = amountUsd / nativePrice;
      } catch { /* keep 0 */ }
    }

    const minBuy = config.minBuyUsd ?? 1;
    if (amountUsd < minBuy) return;

    const tier = getTier(amountUsd, minBuy);

    await db.insert(alertsTable).values({
      botConfigId: configId,
      txSignature: event.signature,
      chain: chainId,
      buyerAddress: event.buyerAddress,
      amountUsd,
      amountNative,
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
      minBuyUsd: config.minBuyUsd ?? 1,
      alertEmoji: config.alertEmoji || "🟢",
      alertStyle: config.alertStyle ?? "sosana",
      amountUsd,
      amountNative,
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
      telegramUrl: config.telegramUrl,
      twitterUrl: config.twitterUrl,
      websiteUrl: config.websiteUrl,
      trendingRank,
      dexPaidScore,
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
