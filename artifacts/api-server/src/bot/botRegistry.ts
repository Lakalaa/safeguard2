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
 * Tier based on fixed USD thresholds configured per-bot.
 * Tier 1 (small):  below tier2Min
 * Tier 2 (medium): tier2Min – tier3Min-1
 * Tier 3 (whale):  tier3Min+
 */
function getTier(amountUsd: number, tier2Min: number, tier3Min: number): number {
  if (amountUsd >= tier3Min) return 3; // whale
  if (amountUsd >= tier2Min) return 2; // medium
  return 1;                             // small
}

// Parse buyUrl which may be JSON {"text":"...","url":"..."} or a plain URL string
function parseBuyLink(raw: string | null | undefined): { text: string; url: string } | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { text?: string; url?: string };
    if (p.url?.startsWith("http")) return { text: p.text || "🛒 Buy", url: p.url };
  } catch { /* not JSON */ }
  if (raw.startsWith("http")) return { text: "🛒 Buy", url: raw };
  return null;
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
  buyButtons?: string | null;      // JSON: [{text,url}] extra inline buttons on buy alert
  telegramUrl?: string | null;
  twitterUrl?: string | null;
  websiteUrl?: string | null;
  emojiPerTier: number;            // how many emojis per tier level (1×, 2×, 3×)
  trendingRank: number | null;     // position in DexScreener boosts leaderboard, null if not trending
  dexPaidScore: number | null;     // total boost amount ("Dex Paid" score), null if 0
}

// ── Shared helpers ─────────────────────────────────────────────────────────────
function emojiBar(params: AlertParams): string {
  const emoji = params.alertEmoji || "🟢";
  const perTier = Math.max(1, params.emojiPerTier ?? 5);
  // tier 1 = 1×, tier 2 = 2×, tier 3 = 3×
  const count = perTier * params.tier;
  return emoji.repeat(count);
}

// Wave animation frames: sweeps ⚡ left→center→right then back to static
function waveEmojiFrames(emoji: string, count: number): string[] {
  const full = emoji.repeat(count);
  if (count <= 2) return [full, full, full, full, full];
  function frame(litStart: number, litLen: number): string {
    const arr = Array(count).fill(emoji);
    for (let i = litStart; i < Math.min(litStart + litLen, count); i++) arr[i] = "⚡";
    return arr.join("");
  }
  const third = Math.max(1, Math.ceil(count / 3));
  return [
    full,                              // Frame 1 – initial send
    frame(0, third),                   // Frame 2 – left lights up
    frame(third, third),               // Frame 3 – middle
    frame(count - third, third),       // Frame 4 – right
    full,                              // Frame 5 – settle back
  ];
}

// Chain-specific emoji for EVM style
function chainEmoji(chainName: string): string {
  const n = (chainName || "").toLowerCase();
  if (n.includes("ethereum") || n === "eth") return "⟠";
  if (n.includes("bsc") || n.includes("binance")) return "🔶";
  if (n.includes("arbitrum")) return "🔷";
  if (n.includes("polygon") || n.includes("matic")) return "🟣";
  if (n.includes("optimism")) return "🔴";
  if (n.includes("base")) return "🔵";
  if (n.includes("solana") || n === "sol") return "◎";
  if (n.includes("avalanche") || n.includes("avax")) return "🔺";
  if (n.includes("fantom") || n === "ftm") return "👻";
  if (n.includes("tron") || n === "trx") return "♦️";
  if (n.includes("cronos") || n === "cro") return "🔵";
  if (n.includes("sui")) return "💧";
  if (n.includes("ton")) return "💎";
  if (n.includes("near")) return "🌙";
  return "🔗";
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
  if (params.dextUrl) linkParts.push(`<a href="${params.dextUrl}">DexTools</a>`);
  if (params.screenerUrl) linkParts.push(`<a href="${params.screenerUrl}">Screener</a>`);
  const _buyLink = parseBuyLink(params.buyUrl);
  if (_buyLink) linkParts.push(`<a href="${_buyLink.url}">${_buyLink.text}</a>`);
  if (params.trendingUrl && params.trendingRank !== null) linkParts.push(`<a href="${params.trendingUrl}">🔥 Trending #${params.trendingRank}</a>`);
  const linksFooter = linkParts.length > 0 ? `\n\n${linkParts.join(" | ")}` : "";

  return (
    `<b>${params.tokenName} ${buyLabel}</b>` +
    trendingLine + `\n` +
    `${emojiBar(params)}\n\n` +
    `🔀 Spent <b>${formatNumber(params.amountUsd)}</b>${nativeStr}\n` +
    `🔀 Got <b>${params.tokensReceived.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${params.tokenSymbol}</b>\n` +
    `👤 <a href="${buyerUrl}">Buyer</a> / <a href="${txUrl}">TX</a>` +
    positionLine +
    mcapLine +
    linksFooter
  );
}

function buildSosanaKeyboard(params: AlertParams): TelegramBot.InlineKeyboardMarkup {
  const trendingHref = params.trendingRank !== null ? (params.trendingUrl ?? params.screenerUrl ?? null) : null;
  const extraRows = buildCustomButtonRows(params).inline_keyboard;
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  if (trendingHref) rows.push([{ text: "🔥 Trending", url: trendingHref }]);
  rows.push(...extraRows);
  return { inline_keyboard: rows };
}

// ── Style 3: Wave (animated) ────────────────────────────────────────────────────
// Same layout as SOSANA but emoji bar animates after sending.
// buildWaveMessage accepts an optional emojiBarStr to override for animation frames.
function buildWaveMessage(params: AlertParams, emojiBarStr?: string): string {
  const buyLabel = params.tier === 3 ? "🐋 Whale Buy!" : "Buy!";
  const buyerUrl = params.explorerAddress.replace("{address}", params.buyerAddress);
  const txUrl = params.explorerTx.replace("{tx}", params.txSignature);
  const bar = emojiBarStr ?? emojiBar(params);

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
    ? `\n💰 Market Cap <b>${Math.round(params.marketCap).toLocaleString("en-US")}</b>`
    : "";
  const linkParts: string[] = [];
  if (params.dextUrl) linkParts.push(`<a href="${params.dextUrl}">DexTools</a>`);
  if (params.screenerUrl) linkParts.push(`<a href="${params.screenerUrl}">Screener</a>`);
  const _wBuyLink = parseBuyLink(params.buyUrl);
  if (_wBuyLink) linkParts.push(`<a href="${_wBuyLink.url}">${_wBuyLink.text}</a>`);
  if (params.trendingUrl && params.trendingRank !== null) linkParts.push(`<a href="${params.trendingUrl}">🔥 Trending #${params.trendingRank}</a>`);
  const linksFooter = linkParts.length > 0 ? `\n\n${linkParts.join(" | ")}` : "";

  return (
    `<b>${params.tokenName} ${buyLabel}</b>` +
    trendingLine + `\n` +
    `${bar}\n\n` +
    `🔀 Spent <b>${formatNumber(params.amountUsd)}</b>${nativeStr}\n` +
    `🔀 Got <b>${params.tokensReceived.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${params.tokenSymbol}</b>\n` +
    `👤 <a href="${buyerUrl}">Buyer</a> / <a href="${txUrl}">TX</a>` +
    positionLine + mcapLine + linksFooter
  );
}

function buildWaveKeyboard(params: AlertParams): TelegramBot.InlineKeyboardMarkup {
  return buildSosanaKeyboard(params);
}

// ── Style 4: EVM ────────────────────────────────────────────────────────────────
// Chain-aware format: shows chain emoji, hex address, EVM styling.
function buildEvmMessage(params: AlertParams): string {
  const cEmoji = chainEmoji(params.chainName);
  const buyerUrl = params.explorerAddress.replace("{address}", params.buyerAddress);
  const txUrl    = params.explorerTx.replace("{tx}", params.txSignature);
  const shortAddr = params.buyerAddress.length > 10
    ? `${params.buyerAddress.slice(0, 6)}…${params.buyerAddress.slice(-4)}`
    : params.buyerAddress;
  const buyLabel = params.tier === 3 ? "🐋 Whale Buy!" : "Buy!";

  const trendingLine = params.trendingRank !== null ? `\n📡 Trending #${params.trendingRank}` : "";
  const nativeStr = params.amountNative > 0
    ? `${params.amountNative.toFixed(4)} ${params.nativeCurrency} (${formatNumber(params.amountUsd)})`
    : formatNumber(params.amountUsd);
  const positionLine = params.priceChangePct !== null
    ? `\n📈 Position: <b>${params.priceChangePct >= 0 ? "+" : ""}${params.priceChangePct.toFixed(1)}%</b>`
    : "";
  const mcapLine = params.marketCap !== null
    ? `\n💎 MCap: <b>${Math.round(params.marketCap).toLocaleString("en-US")}</b>`
    : "";

  const socialParts: string[] = [];
  if (params.telegramUrl) socialParts.push(`<a href="${params.telegramUrl}">Telegram</a>`);
  if (params.twitterUrl)  socialParts.push(`<a href="${params.twitterUrl}">X</a>`);
  if (params.websiteUrl)  socialParts.push(`<a href="${params.websiteUrl}">Website</a>`);
  const socialLine = socialParts.length > 0 ? `\n🌐 ${socialParts.join(" | ")}` : "";

  const linkParts: string[] = [];
  if (params.dextUrl) linkParts.push(`<a href="${params.dextUrl}">DexTools</a>`);
  if (params.screenerUrl) linkParts.push(`<a href="${params.screenerUrl}">Screener</a>`);
  const _eBuyLink = parseBuyLink(params.buyUrl);
  if (_eBuyLink) linkParts.push(`<a href="${_eBuyLink.url}">${_eBuyLink.text}</a>`);
  if (params.trendingUrl && params.trendingRank !== null) linkParts.push(`<a href="${params.trendingUrl}">🔥 Trending #${params.trendingRank}</a>`);
  const linksFooter = linkParts.length > 0 ? `\n\n${linkParts.join(" | ")}` : "";

  return (
    `${cEmoji} <b>${params.tokenName} [${params.tokenSymbol}]</b> — ${params.chainName} ${buyLabel}` +
    trendingLine + `\n` +
    `${emojiBar(params)}\n\n` +
    `💰 <b>${nativeStr}</b>\n` +
    `🛍 Got: <b>${params.tokensReceived.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${params.tokenSymbol}</b>\n` +
    `📍 <a href="${buyerUrl}">${shortAddr}</a> | <a href="${txUrl}">Txn</a>` +
    positionLine + mcapLine + socialLine + linksFooter
  );
}

function buildEvmKeyboard(params: AlertParams): TelegramBot.InlineKeyboardMarkup {
  return buildSosanaKeyboard(params);
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

  const trendLinkParts: string[] = [];
  if (params.dextUrl) trendLinkParts.push(`<a href="${params.dextUrl}">DexTools</a>`);
  if (params.screenerUrl) trendLinkParts.push(`<a href="${params.screenerUrl}">Screener</a>`);
  const _buyLinkMsg = parseBuyLink(params.buyUrl);
  if (_buyLinkMsg) trendLinkParts.push(`<a href="${_buyLinkMsg.url}">${_buyLinkMsg.text}</a>`);
  if (params.trendingUrl && params.trendingRank !== null) trendLinkParts.push(`<a href="${params.trendingUrl}">🔥 Trending #${params.trendingRank}</a>`);
  const trendLinksFooter = trendLinkParts.length > 0 ? `\n\n${trendLinkParts.join(" | ")}` : "";

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
    trendingFooterLine +
    trendLinksFooter
  );
}

function buildCustomButtonRows(params: AlertParams): TelegramBot.InlineKeyboardMarkup {
  if (!params.buyButtons) return { inline_keyboard: [] };
  try {
    const parsed = JSON.parse(params.buyButtons) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return { inline_keyboard: [] };
    // New format: [[{text,url},...], ...] — 2D array where each inner array is one row
    if (Array.isArray(parsed[0])) {
      const rows = (parsed as { text: string; url: string }[][]).map(row =>
        row.map(b => ({ text: b.text, url: b.url }))
      );
      return { inline_keyboard: rows };
    }
    // Legacy format: [{text,url},...] — flat array, 2 per row
    const flat = parsed as { text: string; url: string }[];
    const rows: TelegramBot.InlineKeyboardButton[][] = [];
    for (let i = 0; i < flat.length; i += 2) {
      rows.push(flat.slice(i, i + 2).map(b => ({ text: b.text, url: b.url })));
    }
    return { inline_keyboard: rows };
  } catch { return { inline_keyboard: [] }; }
}

function buildTrendingKeyboard(params: AlertParams): TelegramBot.InlineKeyboardMarkup {
  const trendingHref = params.trendingRank !== null ? (params.trendingUrl ?? params.screenerUrl ?? null) : null;
  const extraRows = buildCustomButtonRows(params).inline_keyboard;
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  if (trendingHref) rows.push([{ text: "🔥 Trending", url: trendingHref }]);
  rows.push(...extraRows);
  return { inline_keyboard: rows };
}

// ── Dispatcher ─────────────────────────────────────────────────────────────────
function buildAlertMessage(params: AlertParams, emojiBarStr?: string): string {
  if (params.alertStyle === "trending") return buildTrendingMessage(params);
  if (params.alertStyle === "wave")     return buildWaveMessage(params, emojiBarStr);
  if (params.alertStyle === "evm")      return buildEvmMessage(params);
  return buildSosanaMessage(params);
}

function buildAlertKeyboard(params: AlertParams): TelegramBot.InlineKeyboardMarkup {
  if (params.alertStyle === "trending") return buildTrendingKeyboard(params);
  if (params.alertStyle === "wave")     return buildWaveKeyboard(params);
  if (params.alertStyle === "evm")      return buildEvmKeyboard(params);
  return buildSosanaKeyboard(params);
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
  voteTimer: ReturnType<typeof setInterval> | null;
  broadcastTimer: ReturnType<typeof setInterval> | null;
  coBotInstance: TelegramBot | null;
}

// ── Twitter raid tracker ────────────────────────────────────────────────────────
async function getTweetMetrics(tweetId: string): Promise<{ likes: number; retweets: number; replies: number } | null> {
  const token = process.env["TWITTER_BEARER_TOKEN"];
  if (!token) {
    logger.warn("[Raid] TWITTER_BEARER_TOKEN not set — skipping raid alert");
    return null;
  }
  try {
    const res = await fetch(
      `https://api.twitter.com/2/tweets/${tweetId}?tweet.fields=public_metrics`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25_000) },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ tweetId, status: res.status, body }, "[Raid] Twitter API error");
      return null;
    }
    const data = await res.json() as {
      data?: { public_metrics?: { like_count: number; retweet_count: number; reply_count: number } };
    };
    const m = data.data?.public_metrics;
    if (!m) {
      logger.warn({ tweetId, data }, "[Raid] No public_metrics in Twitter response");
      return null;
    }
    return { likes: m.like_count, retweets: m.retweet_count, replies: m.reply_count };
  } catch (err) {
    logger.warn({ tweetId, err: String(err) }, "[Raid] getTweetMetrics exception");
    return null;
  }
}

// ── Shared progress bar ────────────────────────────────────────────────────────
function progressBar(current: number, target: number, width = 12): string {
  if (target <= 0) return "░".repeat(width);
  const filled = Math.min(width, Math.round((current / target) * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function buildRaidMessage(
  metrics: { likes: number; retweets: number; replies: number },
  targets: { likes: number; retweets: number; replies: number },
  tweetUrl: string,
  config: BotConfig,
): { text: string; keyboard: TelegramBot.InlineKeyboardMarkup } {
  function statLine(label: string, current: number, target: number): string {
    if (target <= 0) return "";
    const pct = Math.min(100, Math.round((current / target) * 100));
    const reached = current >= target;
    const square = reached ? "🟩" : "🟥";
    const badge = reached ? "💯%" : `${pct}%`;
    return `${square} ${label} ${current} | ${target} [${badge}]`;
  }

  const allDone =
    metrics.likes >= targets.likes &&
    metrics.retweets >= targets.retweets &&
    metrics.replies >= targets.replies;

  const lines: string[] = [
    `⚡ <b>Raid Tweet</b>`,
    ``,
  ];

  const l = statLine("Likes", metrics.likes, targets.likes);
  const r = statLine("Retweets", metrics.retweets, targets.retweets);
  const rep = statLine("Replies", metrics.replies, targets.replies);
  if (l) lines.push(l);
  if (r) lines.push(r);
  if (rep) lines.push(rep);

  lines.push(``);
  if (allDone) {
    lines.push(`🔥 <b>ALL TARGETS CRUSHED — LFG! 🚀</b>`);
    lines.push(``);
  }

  lines.push(tweetUrl);
  lines.push(``);
  lines.push(`🔥 <b>Trending</b>`);

  const keyboard: TelegramBot.InlineKeyboardMarkup = {
    inline_keyboard: [[{ text: "🐦 RAID THE TWEET →", url: tweetUrl }]],
  };

  return { text: lines.join("\n"), keyboard };
}

// ── Simulated vote alert ────────────────────────────────────────────────────────
function buildVoteMessage(config: BotConfig, currentCount: number): string {
  const name = config.tokenName ?? config.tokenSymbol ?? "Token";
  const pos = config.votePosition ?? 1;
  const needed = config.voteNeeded ?? 50;
  const target = currentCount + needed;
  const bar = progressBar(currentCount, target);
  const pct = Math.min(100, Math.round((currentCount / target) * 100));

  return [
    `🗳 <b>VOTE ALERT</b> 🗳`,
    ``,
    `🔥 <b>${name}</b> just received a new vote!`,
    ``,
    `📊 Total Votes:  <b>${currentCount.toLocaleString()}</b>`,
    `🏆 Position:     <b>#${pos}</b>`,
    `🎯 <b>${needed}</b> more votes needed to top the leaderboard!`,
    ``,
    `<code>${bar}</code>  [${pct}%]`,
    ``,
    `⬆️ <b>Every vote counts — go vote NOW!</b>`,
  ].join("\n");
}

function buildVoteKeyboard(config: BotConfig): TelegramBot.InlineKeyboardMarkup | undefined {
  const raw = config.voteButtons;
  if (!raw) return undefined;
  try {
    const buttons = JSON.parse(raw) as { text: string; url: string }[];
    if (!buttons.length) return undefined;
    const rows: TelegramBot.InlineKeyboardButton[][] = [];
    for (let i = 0; i < buttons.length; i += 2) {
      rows.push(
        buttons.slice(i, i + 2).map((b) => ({ text: b.text, url: b.url })),
      );
    }
    return { inline_keyboard: rows };
  } catch { return undefined; }
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
  if (config.dextUrl) linkParts.push(`<a href="${config.dextUrl}">DexTools</a>`);
  if (config.screenerUrl) linkParts.push(`<a href="${config.screenerUrl}">Screener</a>`);
  const _buyLinkRepeat = parseBuyLink(config.buyUrl);
  if (_buyLinkRepeat) linkParts.push(`<a href="${_buyLinkRepeat.url}">${_buyLinkRepeat.text}</a>`);
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

/** For raid + vote: use the dedicated utility bot if set, otherwise fall back to main token */
function resolveUtilityToken(config: BotConfig | undefined): string | null {
  return config?.utilityBotToken || resolveToken(config);
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

    // Clear any orphaned timers from a previous inactive-timer run before creating fresh instance
    if (existing) {
      if (existing.repeatTimer) { clearInterval(existing.repeatTimer); existing.repeatTimer = null; }
      if (existing.raidTimer) { clearInterval(existing.raidTimer); existing.raidTimer = null; }
      if (existing.voteTimer) { clearInterval(existing.voteTimer); existing.voteTimer = null; }
      if (existing.broadcastTimer) { clearInterval(existing.broadcastTimer); existing.broadcastTimer = null; }
    }

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
      voteTimer: null,
      broadcastTimer: null,
      coBotInstance: null,
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

      // Start vote timer if configured
      if (config.voteInterval && config.voteInterval > 0) {
        inst.voteTimer = setInterval(() => {
          this.sendVoteAlert(configId).catch((err) =>
            logger.error({ err, configId }, "Vote alert error"),
          );
        }, config.voteInterval * 1000);
        logger.info({ configId, intervalSecs: config.voteInterval }, "Vote timer started");
      }

      // Start broadcast timer if configured
      if (config.broadcastText && config.broadcastInterval && config.broadcastInterval > 0) {
        inst.broadcastTimer = setInterval(() => {
          this.sendBroadcast(configId).catch((err) =>
            logger.error({ err, configId }, "Broadcast error"),
          );
        }, config.broadcastInterval * 1000);
        logger.info({ configId, intervalSecs: config.broadcastInterval }, "Broadcast timer started");
      }

      // Start co-bot (command sharing) if configured
      if (config.coBotToken) {
        try {
          const { createCommandBot } = await import("./commandBot");
          inst.coBotInstance = createCommandBot(config.coBotToken);
          logger.info({ configId }, "Co-bot started");
        } catch (err) {
          logger.warn({ err: String(err), configId }, "Co-bot failed to start — continuing without it");
        }
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
    if (inst.voteTimer) { clearInterval(inst.voteTimer); inst.voteTimer = null; }
    if (inst.broadcastTimer) { clearInterval(inst.broadcastTimer); inst.broadcastTimer = null; }
    if (inst.coBotInstance) {
      inst.coBotInstance.stopPolling().catch(() => null);
      inst.coBotInstance = null;
    }
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

  /** Swap the repeat timer live — works even when monitoring is off */
  restartRepeatTimer(configId: number, intervalSecs: number | null): void {
    let inst = this.instances.get(configId);
    if (!inst) {
      inst = { configId, chainId: "solana", running: false, lastCheckAt: null, error: null, monitor: null, dexCache: { data: null, fetchedAt: 0 }, repeatTimer: null, raidTimer: null, voteTimer: null, broadcastTimer: null, coBotInstance: null };
      this.instances.set(configId, inst);
    }

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

  /** Update raid timer live — works even when monitoring is off */
  restartRaidTimer(configId: number, intervalSecs: number | null): void {
    let inst = this.instances.get(configId);
    if (!inst) {
      inst = { configId, chainId: "solana", running: false, lastCheckAt: null, error: null, monitor: null, dexCache: { data: null, fetchedAt: 0 }, repeatTimer: null, raidTimer: null, voteTimer: null, broadcastTimer: null, coBotInstance: null };
      this.instances.set(configId, inst);
    }
    if (inst.raidTimer) { clearInterval(inst.raidTimer); inst.raidTimer = null; }
    const secs = intervalSecs ?? 0;
    if (secs > 0) {
      inst.raidTimer = setInterval(() => {
        this.sendRaidAlert(configId).catch((err) =>
          logger.error({ err, configId }, "Raid alert error"),
        );
      }, secs * 1000);
      logger.info({ configId, intervalSecs: secs }, "Raid timer updated");
    }
    this.instances.set(configId, inst);
  }

  /** Update vote timer live — works even when monitoring is off */
  restartVoteTimer(configId: number, intervalSecs: number | null): void {
    let inst = this.instances.get(configId);
    if (!inst) {
      inst = { configId, chainId: "solana", running: false, lastCheckAt: null, error: null, monitor: null, dexCache: { data: null, fetchedAt: 0 }, repeatTimer: null, raidTimer: null, voteTimer: null, broadcastTimer: null, coBotInstance: null };
      this.instances.set(configId, inst);
    }
    if (inst.voteTimer) { clearInterval(inst.voteTimer); inst.voteTimer = null; }
    const secs = intervalSecs ?? 0;
    if (secs > 0) {
      inst.voteTimer = setInterval(() => {
        this.sendVoteAlert(configId).catch((err) =>
          logger.error({ err, configId }, "Vote alert error"),
        );
      }, secs * 1000);
      logger.info({ configId, intervalSecs: secs }, "Vote timer updated");
    }
    this.instances.set(configId, inst);
  }

  /** Update broadcast timer live */
  restartBroadcastTimer(configId: number, intervalSecs: number | null): void {
    let inst = this.instances.get(configId);
    if (!inst) {
      inst = { configId, chainId: "solana", running: false, lastCheckAt: null, error: null, monitor: null, dexCache: { data: null, fetchedAt: 0 }, repeatTimer: null, raidTimer: null, voteTimer: null, broadcastTimer: null, coBotInstance: null };
      this.instances.set(configId, inst);
    }
    if (inst.broadcastTimer) { clearInterval(inst.broadcastTimer); inst.broadcastTimer = null; }
    const secs = intervalSecs ?? 0;
    if (secs > 0) {
      inst.broadcastTimer = setInterval(() => {
        this.sendBroadcast(configId).catch((err) =>
          logger.error({ err, configId }, "Broadcast error"),
        );
      }, secs * 1000);
      logger.info({ configId, intervalSecs: secs }, "Broadcast timer updated");
    }
    this.instances.set(configId, inst);
  }

  /** Start or stop the co-bot for command sharing — takes effect immediately */
  restartCoBot(configId: number, token: string | null): void {
    let inst = this.instances.get(configId);
    if (!inst) {
      inst = { configId, chainId: "solana", running: false, lastCheckAt: null, error: null, monitor: null, dexCache: { data: null, fetchedAt: 0 }, repeatTimer: null, raidTimer: null, voteTimer: null, broadcastTimer: null, coBotInstance: null };
      this.instances.set(configId, inst);
    }

    // Stop existing co-bot if running
    if (inst.coBotInstance) {
      inst.coBotInstance.stopPolling().catch(() => null);
      inst.coBotInstance = null;
    }

    // Start new co-bot if token provided
    if (token) {
      import("./commandBot").then(({ createCommandBot }) => {
        try {
          inst!.coBotInstance = createCommandBot(token);
          logger.info({ configId }, "Co-bot (re)started");
        } catch (err) {
          logger.warn({ err: String(err), configId }, "Co-bot failed to start");
        }
        this.instances.set(configId, inst!);
      }).catch(() => null);
      return; // return early; instances.set happens inside the promise
    }
    this.instances.set(configId, inst);
  }

  private async sendBroadcast(configId: number): Promise<void> {
    const [config] = await db
      .select().from(botConfigTable).where(eq(botConfigTable.id, configId)).limit(1);
    const token = resolveToken(config);
    if (!token || !config?.chatId || !config.broadcastText) return;

    let keyboard: TelegramBot.InlineKeyboardMarkup | undefined;
    if (config.broadcastButtons) {
      try {
        const btns = JSON.parse(config.broadcastButtons) as { text: string; url: string }[];
        if (btns.length) {
          const rows: TelegramBot.InlineKeyboardButton[][] = [];
          for (let i = 0; i < btns.length; i += 2) {
            rows.push(btns.slice(i, i + 2).map(b => ({ text: b.text, url: b.url })));
          }
          keyboard = { inline_keyboard: rows };
        }
      } catch { /* ignore bad JSON */ }
    }

    const broadcastTokens = [token, ...(config.coBotToken ? [config.coBotToken] : [])];
    for (const tk of broadcastTokens) {
      const tgBot = new TelegramBot(tk, { polling: false });
      if (config.broadcastImageFileId) {
        await tgBot.sendPhoto(config.chatId, config.broadcastImageFileId, {
          caption: config.broadcastText,
          parse_mode: "HTML",
          ...(keyboard ? { reply_markup: keyboard } : {}),
        }).catch((e) => logger.warn({ err: String(e), configId, tk: tk.slice(0, 10) }, "Co-bot broadcast photo failed"));
      } else {
        await tgBot.sendMessage(config.chatId, config.broadcastText, {
          parse_mode: "HTML",
          disable_web_page_preview: false,
          ...(keyboard ? { reply_markup: keyboard } : {}),
        }).catch((e) => logger.warn({ err: String(e), configId, tk: tk.slice(0, 10) }, "Co-bot broadcast message failed"));
      }
    }
    logger.info({ configId, bots: broadcastTokens.length }, "Broadcast sent");
  }

  private async sendVoteAlert(configId: number): Promise<void> {
    const [config] = await db
      .select().from(botConfigTable).where(eq(botConfigTable.id, configId)).limit(1);
    const token = resolveUtilityToken(config);
    if (!token || !config?.chatId) return;

    // Increment vote count with slight randomness to look natural
    const base = config.voteIncrement ?? 10;
    const jitter = Math.floor(Math.random() * 5) - 2;
    const newCount = (config.voteCount ?? 1000) + Math.max(1, base + jitter);
    await db.update(botConfigTable)
      .set({ voteCount: newCount, updatedAt: new Date() })
      .where(eq(botConfigTable.id, configId));

    const message = buildVoteMessage({ ...config, voteCount: newCount }, newCount);
    const keyboard = buildVoteKeyboard(config);
    const voteTokens = [token, ...(config.coBotToken ? [config.coBotToken] : [])];
    for (const tk of voteTokens) {
      const tgBot = new TelegramBot(tk, { polling: false });
      if (config.voteImageFileId) {
        await tgBot.sendPhoto(config.chatId, config.voteImageFileId, {
          caption: message,
          parse_mode: "HTML",
          ...(keyboard ? { reply_markup: keyboard } : {}),
        }).catch((e) => logger.warn({ err: String(e), configId, tk: tk.slice(0, 10) }, "Co-bot vote photo failed"));
      } else {
        await tgBot.sendMessage(config.chatId, message, {
          parse_mode: "HTML",
          ...(keyboard ? { reply_markup: keyboard } : {}),
        }).catch((e) => logger.warn({ err: String(e), configId, tk: tk.slice(0, 10) }, "Co-bot vote message failed"));
      }
    }
    logger.info({ configId, newCount, bots: voteTokens.length }, "Vote alert sent");
  }

  private async sendRaidAlert(configId: number): Promise<void> {
    const [config] = await db
      .select().from(botConfigTable).where(eq(botConfigTable.id, configId)).limit(1);
    const token = resolveUtilityToken(config);
    if (!token || !config?.chatId || !config.raidTweetUrl) return;

    const tweetId = config.raidTweetUrl.match(/\/status\/(\d+)/)?.[1];
    if (!tweetId) return;

    const targets = {
      likes: config.raidTargetLikes ?? 10,
      retweets: config.raidTargetRetweets ?? 5,
      replies: config.raidTargetReplies ?? 5,
    };

    // Try to get live metrics — post regardless of whether it succeeds
    const metrics = await getTweetMetrics(tweetId);

    const name = config.tokenName ?? config.tokenSymbol ?? "Token";
    const keyboard: TelegramBot.InlineKeyboardMarkup = {
      inline_keyboard: [[{ text: "🐦 RAID THE TWEET →", url: config.raidTweetUrl }]],
    };

    let text: string;
    if (metrics) {
      const { text: built } = buildRaidMessage(metrics, targets, config.raidTweetUrl, config);
      text = built;
    } else {
      // Twitter API unavailable — post a static call-to-action with URL for preview
      text = [
        `⚡ <b>Raid Tweet</b>`,
        ``,
        `❤️ Like  •  🔁 Retweet  •  💬 Reply`,
        ``,
        config.raidTweetUrl,
        ``,
        `🔥 <b>Trending</b>`,
      ].join("\n");
    }

    const raidTokens = [token, ...(config.coBotToken ? [config.coBotToken] : [])];
    for (const tk of raidTokens) {
      const tgBot = new TelegramBot(tk, { polling: false });
      await tgBot.sendMessage(config.chatId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      }).catch((e) => logger.warn({ err: String(e), configId, tk: tk.slice(0, 10) }, "Co-bot raid message failed"));
    }
    logger.info({ configId, tweetId, hasMetrics: !!metrics, bots: raidTokens.length }, "Raid alert sent");
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
    const repeatTokens = [token, ...(config.coBotToken ? [config.coBotToken] : [])];
    for (const tk of repeatTokens) {
      const tgBot = new TelegramBot(tk, { polling: false });
      await tgBot.sendMessage(config.chatId, message, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }).catch((e) => logger.warn({ err: String(e), configId, tk: tk.slice(0, 10) }, "Co-bot repeat message failed"));
    }
    logger.info({ configId, bots: repeatTokens.length }, "Repeat alert sent");
  }

  async autoStartAll(): Promise<void> {
    const configs = await db.select().from(botConfigTable);
    for (const config of configs) {
      // Start full monitoring for active bots
      if (config.isActive) {
        logger.info({ configId: config.id, name: config.name }, "Auto-starting bot");
        await this.start(config.id);
      } else {
        // Even inactive bots: start any configured timers independently
        const hasTimer = (config.voteInterval && config.voteInterval > 0)
          || (config.raidInterval && config.raidInterval > 0)
          || (config.repeatInterval && config.repeatInterval > 0)
          || (config.broadcastInterval && config.broadcastInterval > 0 && !!config.broadcastText);
        if (hasTimer) {
          logger.info({ configId: config.id }, "Starting timers for inactive bot");
          if (config.voteInterval && config.voteInterval > 0) this.restartVoteTimer(config.id, config.voteInterval);
          if (config.raidInterval && config.raidInterval > 0) this.restartRaidTimer(config.id, config.raidInterval);
          if (config.repeatInterval && config.repeatInterval > 0) this.restartRepeatTimer(config.id, config.repeatInterval);
          if (config.broadcastInterval && config.broadcastInterval > 0 && config.broadcastText) this.restartBroadcastTimer(config.id, config.broadcastInterval);
        }
      }
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

    const tier = getTier(amountUsd, config.tier2Min ?? 500, config.tier3Min ?? 1000);

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

    const alertParams: AlertParams = {
      tokenName: config.tokenName ?? dexData?.baseToken.name ?? "Token",
      tokenSymbol: config.tokenSymbol ?? dexData?.baseToken.symbol ?? "TKN",
      chainName: chainConfig.name,
      tier,
      minBuyUsd: config.minBuyUsd ?? 1,
      alertEmoji: config.alertEmoji || "🟢",
      emojiPerTier: config.emojiPerTier ?? 5,
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
      buyButtons: config.buyButtons,
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

    const isWaveStyle = alertParams.alertStyle === "wave";
    const waveFrames = isWaveStyle
      ? waveEmojiFrames(alertParams.alertEmoji || "🟢", (alertParams.emojiPerTier ?? 5) * alertParams.tier)
      : [];

    const alertTokens = [token, ...(config.coBotToken ? [config.coBotToken] : [])];
    for (const tk of alertTokens) {
      const tgBot = new TelegramBot(tk, { polling: false });
      if (mediaFileId || mediaUrl) {
        const mediaSrc = (mediaFileId ?? mediaUrl) as string;
        const mediaOpts = { caption: message, parse_mode: "HTML" as const, reply_markup: keyboard };
        if (mediaType === "video") {
          await tgBot.sendVideo(config.chatId, mediaSrc, mediaOpts).catch((e) => logger.warn({ err: String(e), configId, tk: tk.slice(0, 10) }, "Co-bot buy video failed"));
        } else if (mediaType === "animation") {
          await tgBot.sendAnimation(config.chatId, mediaSrc, mediaOpts).catch((e) => logger.warn({ err: String(e), configId, tk: tk.slice(0, 10) }, "Co-bot buy animation failed"));
        } else {
          await tgBot.sendPhoto(config.chatId, mediaSrc, mediaOpts).catch((e) => logger.warn({ err: String(e), configId, tk: tk.slice(0, 10) }, "Co-bot buy photo failed"));
        }
      } else {
        const sent = await tgBot.sendMessage(config.chatId, message, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: keyboard,
        }).catch((e) => { logger.warn({ err: String(e), configId, tk: tk.slice(0, 10) }, "Co-bot buy message failed"); return null; });

        // Fire wave animation in background (non-blocking)
        if (isWaveStyle && sent?.message_id && waveFrames.length > 1) {
          void (async () => {
            const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
            for (let i = 1; i < waveFrames.length; i++) {
              await delay(400);
              const frameMsg = buildAlertMessage(alertParams, waveFrames[i]);
              await tgBot.editMessageText(frameMsg, {
                chat_id: config.chatId,
                message_id: sent.message_id,
                parse_mode: "HTML",
                disable_web_page_preview: true,
                reply_markup: keyboard,
              }).catch(() => {});
            }
          })();
        }
      }
    }

    logger.info({ configId, buyer: event.buyerAddress, amountUsd, chain: chainId, tier, bots: alertTokens.length }, "Buy alert sent");
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
