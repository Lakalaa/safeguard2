import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { botConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { botRegistry, getDexScreenerData } from "./botRegistry";
import { logger } from "../lib/logger";
import type { BotConfig } from "@workspace/db";

// ── DEXTOOLS chain slug map ────────────────────────────────────────────────────
const DEXTOOLS_CHAIN: Record<string, string> = {
  ethereum: "ether", bsc: "bnb", polygon: "polygon",
  arbitrum: "arbitrum", base: "base", avalanche: "avalanche",
  optimism: "optimism", solana: "solana",
};

// ── Chain display names ────────────────────────────────────────────────────────
const CHAIN_LABELS: Record<string, string> = {
  ethereum: "Ethereum", solana: "Solana", bsc: "Binance",
  base: "Base", arbitrum: "Arbitrum", avalanche: "Avalanche",
  polygon: "Polygon", optimism: "Optimism",
};

// ── In-memory pending state per chat ─────────────────────────────────────────
type PendingState =
  | { step: "await_token_address"; chain: string }
  | { step: "await_emoji" }
  | { step: "await_emoji_count"; emoji: string }
  | { step: "await_media" }
  | { step: "await_buy_link" }
  | { step: "await_social_telegram" }
  | { step: "await_social_twitter"; telegramUrl: string | null }
  | { step: "await_social_website"; telegramUrl: string | null; twitterUrl: string | null }
  | { step: "await_raid_url" }
  | { step: "await_raid_targets"; tweetUrl: string }
  | { step: "await_tier_thresholds" }
  | { step: "await_vote_count" }
  | { step: "await_vote_position" }
  | { step: "await_vote_image" }
  | { step: "await_vote_buttons" };

const pendingState = new Map<string, PendingState>();

// ── Admin guard ────────────────────────────────────────────────────────────────
async function isAdmin(bot: TelegramBot, chatId: string | number, userId: number): Promise<boolean> {
  try {
    const member = await bot.getChatMember(String(chatId), userId);
    return member.status === "creator" || member.status === "administrator";
  } catch {
    return false;
  }
}

// ── Get or create bot config row for a chat ───────────────────────────────────
async function getOrCreate(chatId: string, chatTitle?: string): Promise<BotConfig> {
  const [existing] = await db
    .select().from(botConfigTable).where(eq(botConfigTable.chatId, chatId)).limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(botConfigTable).values({ name: chatTitle ?? `Group ${chatId}`, chatId }).returning();
  return created!;
}

// ── Keyboard builders ─────────────────────────────────────────────────────────
function chainKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "Ethereum", callback_data: "chain:ethereum" }],
      [{ text: "Solana", callback_data: "chain:solana" }],
      [
        { text: "TON", callback_data: "chain:ton" },
        { text: "Binance", callback_data: "chain:bsc" },
        { text: "Base", callback_data: "chain:base" },
      ],
      [
        { text: "Arbitrum", callback_data: "chain:arbitrum" },
        { text: "Avalanche", callback_data: "chain:avalanche" },
        { text: "Polygon", callback_data: "chain:polygon" },
      ],
    ],
  };
}

function settingsKeyboard(config: BotConfig, running: boolean): TelegramBot.InlineKeyboardMarkup {
  const emoji = config.alertEmoji ?? "🟢";
  const count = config.emojiPerTier ?? 5;
  const hasMedia = !!(config.alertMediaFileId || config.alertImageUrl);
  const min = config.minBuyUsd ?? 1;
  const style = config.alertStyle ?? "sosana";
  const styleLabel = style === "trending" ? "📊 Style: Trending ✅" : "🔄 Style: SOSANA ✅";
  const hasSocial = !!(config.telegramUrl || config.twitterUrl || config.websiteUrl);
  return {
    inline_keyboard: [
      [
        { text: `${emoji} Emoji ×${count}`, callback_data: "cfg:emoji" },
        { text: hasMedia ? "📸 Media ✅" : "📸 Add Media", callback_data: "cfg:media" },
      ],
      [
        { text: config.buyUrl ? "🛒 Buy Link ✅" : "🛒 Set Buy Link", callback_data: "cfg:buy" },
        { text: `💵 Min: $${min}`, callback_data: "cfg:min" },
      ],
      [
        { text: styleLabel, callback_data: "cfg:style" },
        { text: hasSocial ? "👥 Social ✅" : "👥 Social Links", callback_data: "cfg:social" },
      ],
      [
        { text: `⏰ Repeat: ${formatInterval(config.repeatInterval)}`, callback_data: "cfg:repeat" },
        { text: config.raidTweetUrl ? "🎯 Raid ✅" : "🎯 Raid Setup", callback_data: "cfg:raid" },
      ],
      [
        { text: config.voteInterval ? "🗳 Vote Alert ✅" : "🗳 Vote Alert", callback_data: "cfg:vote" },
      ],
      [
        {
          text: running ? "⏹ Stop" : "▶️ Start Monitoring",
          callback_data: running ? "action:stop" : "action:start",
        },
        { text: "🔄 Refresh", callback_data: "action:status" },
      ],
    ],
  };
}

function formatInterval(secs: number | null | undefined): string {
  if (!secs) return "Off";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${secs / 60}min`;
  return `${secs / 3600}hr`;
}

function repeatKeyboard(current: number | null | undefined): TelegramBot.InlineKeyboardMarkup {
  const presets = [
    { label: "Off", secs: 0 },
    { label: "30s", secs: 30 },
    { label: "1min", secs: 60 },
    { label: "5min", secs: 300 },
    { label: "15min", secs: 900 },
    { label: "30min", secs: 1800 },
    { label: "1hr", secs: 3600 },
    { label: "6hr", secs: 21600 },
    { label: "12hr", secs: 43200 },
    { label: "24hr", secs: 86400 },
  ];
  const cur = current ?? 0;
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < presets.length; i += 5) {
    rows.push(
      presets.slice(i, i + 5).map((p) => ({
        text: p.secs === cur ? `✅ ${p.label}` : p.label,
        callback_data: `set:repeat:${p.secs}`,
      })),
    );
  }
  rows.push([{ text: "⬅️ Back", callback_data: "action:settings" }]);
  return { inline_keyboard: rows };
}

function raidIntervalKeyboard(tweetUrl: string, current: number | null | undefined): TelegramBot.InlineKeyboardMarkup {
  const presets = [
    { label: "Off", secs: 0 },
    { label: "30s", secs: 30 },
    { label: "1min", secs: 60 },
    { label: "5min", secs: 300 },
    { label: "10min", secs: 600 },
    { label: "30min", secs: 1800 },
    { label: "1hr", secs: 3600 },
  ];
  const cur = current ?? 0;
  const row = presets.map((p) => ({
    text: p.secs === cur ? `✅ ${p.label}` : p.label,
    callback_data: `set:raid:interval:${p.secs}`,
  }));
  return {
    inline_keyboard: [
      row.slice(0, 4),
      row.slice(4),
      [
        { text: "🔗 Change Tweet", callback_data: "cfg:raid:url" },
        { text: "🎯 Set Targets", callback_data: "cfg:raid:targets" },
      ],
      [{ text: "🗑 Clear Raid", callback_data: "cfg:raid:clear" }],
      [{ text: "⬅️ Back", callback_data: "action:settings" }],
    ],
  };
}

function voteMenuKeyboard(config: BotConfig): TelegramBot.InlineKeyboardMarkup {
  const presets = [
    { label: "Off", secs: 0 },
    { label: "30s", secs: 30 },
    { label: "1min", secs: 60 },
    { label: "5min", secs: 300 },
    { label: "10min", secs: 600 },
    { label: "30min", secs: 1800 },
    { label: "1hr", secs: 3600 },
  ];
  const cur = config.voteInterval ?? 0;
  const row = presets.map((p) => ({
    text: p.secs === cur ? `✅ ${p.label}` : p.label,
    callback_data: `set:vote:interval:${p.secs}`,
  }));
  return {
    inline_keyboard: [
      row.slice(0, 4),
      row.slice(4),
      [
        { text: "🔢 Votes & Increment", callback_data: "cfg:vote:count" },
        { text: "📊 Leaderboard", callback_data: "cfg:vote:position" },
      ],
      [
        { text: "🖼 Banner Image", callback_data: "cfg:vote:image" },
        { text: "🔗 Buttons", callback_data: "cfg:vote:buttons" },
      ],
      [
        { text: config.voteImageFileId ? "🗑 Clear Image" : "── No Image ──", callback_data: "cfg:vote:clearimage" },
        { text: "🗑 Reset Votes to 0", callback_data: "cfg:vote:reset" },
      ],
      [{ text: "⬅️ Back", callback_data: "action:settings" }],
    ],
  };
}

function styleKeyboard(current: string): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: current === "sosana" ? "✅ SOSANA (current)" : "🔄 SOSANA",
          callback_data: "set:style:sosana",
        },
        {
          text: current === "trending" ? "✅ Trending (current)" : "📊 Trending",
          callback_data: "set:style:trending",
        },
      ],
      [{ text: "⬅️ Back", callback_data: "action:settings" }],
    ],
  };
}

function filterKeyboard(config: BotConfig): TelegramBot.InlineKeyboardMarkup {
  const min = config.minBuyUsd ?? 1;
  const t1 = config.tier1Min ?? 100;
  const t2 = config.tier2Min ?? 500;
  const t3 = config.tier3Min ?? 1000;
  return {
    inline_keyboard: [
      [{ text: `💵 Min Buy: $${min}`, callback_data: "cfg:min" }],
      [{ text: `🏷 Set Tiers ($${t1} / $${t2} / $${t3})`, callback_data: "cfg:tiers" }],
      [{ text: "⬅️ Back to Settings", callback_data: "action:settings" }],
    ],
  };
}

function filterText(config: BotConfig): string {
  const min = config.minBuyUsd ?? 1;
  const emoji = config.alertEmoji ?? "🟢";
  const count = config.emojiPerTier ?? 4;
  const t1 = config.tier1Min ?? 100;
  const t2 = config.tier2Min ?? 500;
  const t3 = config.tier3Min ?? 1000;
  return [
    `🔍 <b>Buy Alert Filters</b>`,
    ``,
    `Only buys of <b>$${min}+</b> will trigger an alert.`,
    ``,
    `<b>Tier Thresholds</b> (controls emoji count per buy size):`,
    `${emoji.repeat(count)} Small — $${min} – $${t1}`,
    `${emoji.repeat(count * 2)} Medium — $${t1} – $${t2}`,
    `${emoji.repeat(count * 3)} 🐋 Whale — $${t2}+`,
    ``,
    `<i>Tap below to update:</i>`,
  ].join("\n");
}

function minBuyKeyboard(): TelegramBot.InlineKeyboardMarkup {
  const amounts = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < amounts.length; i += 4)
    rows.push(amounts.slice(i, i + 4).map((n) => ({ text: `$${n}`, callback_data: `set:min:${n}` })));
  rows.push([{ text: "⬅️ Back to Filters", callback_data: "cfg:filter" }]);
  return { inline_keyboard: rows };
}

// ── Status text ───────────────────────────────────────────────────────────────
function statusText(config: BotConfig, running: boolean): string {
  const emoji = config.alertEmoji ?? "🟢";
  const count = config.emojiPerTier ?? 5;
  const min = config.minBuyUsd ?? 1;
  const lines: string[] = [
    `<b>🛡 Buy Alert Bot — Settings</b>`,
    `Status: ${running ? "🟢 Running" : "⚫ Stopped"}`,
  ];
  if (config.tokenName) lines.push(`\n<b>Token:</b> ${config.tokenName} (${config.tokenSymbol ?? "?"})`);
  if (config.chain) lines.push(`<b>Chain:</b> ${CHAIN_LABELS[config.chain] ?? config.chain}`);
  if (config.tokenAddress) lines.push(`<b>Address:</b> <code>${config.tokenAddress}</code>`);
  lines.push(`\n<b>Min Buy:</b> $${min}`);
  lines.push(
    `<b>Alert emoji:</b> ${emoji.repeat(count)} small  |  ${emoji.repeat(count * 2)} medium  |  ${emoji.repeat(count * 3)} 🐋 whale`,
  );
  if (config.alertMediaFileId || config.alertImageUrl) lines.push(`<b>Alert media:</b> ✅`);
  if (config.buyUrl) lines.push(`<b>Buy link:</b> ✅`);
  if (config.dextUrl || config.screenerUrl) lines.push(`<b>DexTools / Screener:</b> ✅ auto-filled`);
  return lines.join("\n");
}

async function sendSettings(
  bot: TelegramBot,
  chatId: string,
  config: BotConfig,
  running: boolean,
  editMsgId?: number,
): Promise<void> {
  const text = statusText(config, running);
  const markup = settingsKeyboard(config, running);
  if (editMsgId) {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: editMsgId,
      parse_mode: "HTML", reply_markup: markup,
    }).catch(() => null);
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: markup });
  }
}

// ── Main bot startup ──────────────────────────────────────────────────────────
export function startCommandBot(): void {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — command bot disabled");
    return;
  }

  // Init without polling first so we can clear any stale webhook
  const bot = new TelegramBot(token, { polling: false });

  // Clear any stale webhook via direct Telegram API call, then start polling
  fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`)
    .then((r) => r.json())
    .then((body) => {
      logger.info({ body }, "Webhook cleared — starting long-poll");
      bot.startPolling({ restart: false }).catch((err) => {
        logger.error({ err: String(err) }, "startPolling error");
      });
    })
    .catch((err) => {
      logger.warn({ err: String(err) }, "deleteWebhook request failed — starting poll anyway");
      bot.startPolling({ restart: false }).catch(() => null);
    });

  // Register commands so they appear in "/" menu
  bot.setMyCommands([
    { command: "add", description: "Add / change monitored token" },
    { command: "token", description: "Set token address directly" },
    { command: "setup", description: "Open settings panel" },
    { command: "start", description: "Start buy alert monitoring" },
    { command: "stop", description: "Stop monitoring" },
    { command: "status", description: "Check current status" },
    { command: "ca", description: "Look up any token — /ca <address>" },
    { command: "filter", description: "Set buy alert filters (min buy, tiers)" },
  ]).catch(() => null);

  bot.on("polling_error", (err) => {
    logger.error({ msg: String(err) }, "Telegram polling error");
  });

  // ── /ca — public contract address lookup (any user, any chain) ───────────
  bot.onText(/^\/ca(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const address = match?.[1]?.trim();
    if (!address) {
      await bot.sendMessage(chatId,
        `🔍 <b>Token Lookup</b>\n\nUsage: <code>/ca TOKEN_ADDRESS</code>\n\nWorks on all chains — Solana, Ethereum, BSC, Base, Polygon, Arbitrum, Avalanche, Optimism.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const lookupMsg = await bot.sendMessage(chatId, `🔍 Looking up <code>${address.slice(0, 10)}…</code> on DexScreener…`, { parse_mode: "HTML" });
    try {
      const dexData = await getDexScreenerData(address);
      if (!dexData) {
        await bot.editMessageText(
          `❌ Token not found. Make sure the address is correct and the token has a trading pair.`,
          { chat_id: chatId, message_id: lookupMsg.message_id },
        ).catch(() => null);
        return;
      }

      const name = dexData.baseToken.name;
      const symbol = dexData.baseToken.symbol;
      const chain = dexData.chainId ?? "?";
      const chainLabel = CHAIN_LABELS[chain] ?? chain;
      const screenerUrl = dexData.url ?? `https://dexscreener.com/${chain}/${address}`;

      const price = dexData.priceUsd ? parseFloat(dexData.priceUsd) : null;
      const priceStr = price === null ? "—"
        : price < 0.000001 ? `$${price.toFixed(10)}`
        : price < 0.001 ? `$${price.toFixed(8)}`
        : price < 1 ? `$${price.toFixed(6)}`
        : `$${price.toFixed(4)}`;

      const change24h = dexData.priceChange?.h24 ?? null;
      const changeEmoji = change24h === null ? "" : change24h >= 0 ? "📈 " : "📉 ";
      const changeStr = change24h !== null ? `${changeEmoji}<b>${change24h >= 0 ? "+" : ""}${change24h.toFixed(1)}%</b>` : "—";

      const mcap = dexData.marketCap ?? dexData.fdv ?? null;
      const mcapStr = mcap !== null ? `$${Math.round(mcap).toLocaleString("en-US")}` : "—";

      const liq = dexData.liquidity?.usd ?? null;
      const liqStr = liq === null ? "—"
        : liq >= 1_000_000 ? `$${(liq / 1_000_000).toFixed(2)}M`
        : liq >= 1_000 ? `$${(liq / 1_000).toFixed(1)}K`
        : `$${Math.round(liq)}`;

      const text =
        `🔍 <b>${name} [${symbol}]</b>\n` +
        `⛓ ${chainLabel}\n\n` +
        `💲 Price: <b>${priceStr}</b>\n` +
        `24h: ${changeStr}\n` +
        `💰 Market Cap: <b>${mcapStr}</b>\n` +
        `💧 Liquidity: <b>${liqStr}</b>\n\n` +
        `📋 Contract:\n<code>${address}</code>\n\n` +
        `<a href="${screenerUrl}">📈 View on DexScreener</a>`;

      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: lookupMsg.message_id,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }).catch(() => null);
    } catch {
      await bot.editMessageText(`❌ Error looking up token. Please try again.`, {
        chat_id: chatId,
        message_id: lookupMsg.message_id,
      }).catch(() => null);
    }
  });

  // ── Shared: process a token address lookup + save ─────────────────────────
  async function processTokenAddress(
    chatId: string,
    address: string,
    chain: string,
    config: BotConfig,
  ): Promise<void> {
    await bot.sendMessage(chatId, `🔍 Looking up token on DexScreener…`);
    try {
      const dexData = await getDexScreenerData(address);
      const chainId = dexData?.chainId ?? chain;
      const pairAddress = dexData?.pairAddress ?? null;
      const dextoolsChain = DEXTOOLS_CHAIN[chainId] ?? chainId;
      const screenerUrl = pairAddress
        ? `https://dexscreener.com/${chainId}/${pairAddress}` : null;
      const dextUrl = pairAddress
        ? `https://www.dextools.io/app/en/${dextoolsChain}/pair-explorer/${pairAddress}` : null;

      await db.update(botConfigTable).set({
        tokenAddress: address,
        tokenName: dexData?.baseToken.name ?? null,
        tokenSymbol: dexData?.baseToken.symbol ?? null,
        chain: chainId,
        screenerUrl,
        dextUrl,
        updatedAt: new Date(),
      }).where(eq(botConfigTable.id, config.id));

      const name = dexData?.baseToken.name ?? `${address.slice(0, 8)}…`;
      const sym = dexData?.baseToken.symbol ?? "?";
      const priceUsd = dexData?.priceUsd ? parseFloat(dexData.priceUsd) : null;
      const mcap = dexData?.marketCap ?? dexData?.fdv ?? null;

      let reply = dexData
        ? `✅ <b>${name} (${sym})</b> found on <b>${CHAIN_LABELS[chainId] ?? chainId}</b>\n`
        : `✅ Token saved on <b>${CHAIN_LABELS[chain] ?? chain}</b>\n`;
      if (priceUsd) reply += `💵 Price: $${priceUsd.toFixed(8)}\n`;
      if (mcap) {
        const mcapStr = mcap >= 1_000_000
          ? `$${(mcap / 1_000_000).toFixed(2)}M` : `$${(mcap / 1_000).toFixed(0)}K`;
        reply += `📊 Market Cap: ${mcapStr}\n`;
      }
      if (screenerUrl) reply += `\n✅ DexTools &amp; DexScreener links auto-filled`;

      await bot.sendMessage(chatId, reply, { parse_mode: "HTML" });

      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running);
    } catch (err) {
      logger.error({ err }, "Token lookup error");
      await bot.sendMessage(chatId, "❌ Could not look up that token. Please check the address and try again.");
    }
  }

  // ── Bot added to group ────────────────────────────────────────────────────
  bot.on("new_chat_members", async (msg) => {
    try {
      const me = await bot.getMe();
      if (!(msg.new_chat_members ?? []).some((m) => m.id === me.id)) return;
      const chatId = String(msg.chat.id);
      await getOrCreate(chatId, msg.chat.title);
      await bot.sendMessage(chatId,
        `🛠 <b>Click button below to add your token for buy bot</b>`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "➡️ Add Token", callback_data: "action:add_token" }]] },
        },
      );
    } catch (err) { logger.error({ err }, "new_chat_members error"); }
  });

  // ── /add ──────────────────────────────────────────────────────────────────
  bot.onText(/^\/add(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) {
      await bot.sendMessage(chatId, "⛔ Only group admins can use this command.").catch(() => null);
      return;
    }
    await getOrCreate(chatId, msg.chat.title);
    await bot.sendMessage(chatId,
      `🛠 <b>Click button below to add your token for buy bot</b>`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "➡️ Add Token", callback_data: "action:add_token" }]] },
      },
    );
  });

  // ── /token <address> ──────────────────────────────────────────────────────
  // This is the privacy-mode-safe way to submit an address (works in all groups)
  bot.onText(/^\/token(@\S+)?(\s+(.+))?$/, async (msg, match) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) {
      await bot.sendMessage(chatId, "⛔ Only group admins can set the token.").catch(() => null);
      return;
    }
    const address = match?.[3]?.trim();
    if (!address) {
      await bot.sendMessage(chatId,
        `⚙️ Usage: <code>/token 0xYourContractAddress</code>\n\nFirst use /add to select the chain, then send the address with this command.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    const state = pendingState.get(chatId);
    const chain = state?.step === "await_token_address" ? state.chain : "ethereum";
    pendingState.delete(chatId);
    const config = await getOrCreate(chatId, msg.chat.title);
    await processTokenAddress(chatId, address, chain, config);
  });

  // ── /filter — admin filter settings (min buy, tiers) ─────────────────────
  bot.onText(/^\/filter(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) return;
    const config = await getOrCreate(chatId, msg.chat.title);
    await bot.sendMessage(chatId, filterText(config), {
      parse_mode: "HTML",
      reply_markup: filterKeyboard(config),
    });
  });

  // ── /setup ────────────────────────────────────────────────────────────────
  bot.onText(/^\/setup(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) return;
    const config = await getOrCreate(chatId, msg.chat.title);
    const { running } = botRegistry.getStatus(config.id);
    await sendSettings(bot, chatId, config, running);
  });

  // ── /start ────────────────────────────────────────────────────────────────
  bot.onText(/^\/start(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) return;
    const config = await getOrCreate(chatId, msg.chat.title);
    if (!config.tokenAddress) {
      await bot.sendMessage(chatId, "⚠️ No token configured yet. Use /add first.");
      return;
    }
    await bot.sendMessage(chatId, "⏳ Starting…");
    const result = await botRegistry.start(config.id);
    if (result.running) {
      await bot.sendMessage(chatId,
        `✅ <b>Started!</b> Now monitoring <b>${config.tokenName ?? config.tokenAddress}</b> on <b>${CHAIN_LABELS[config.chain ?? ""] ?? config.chain}</b>.\n\nBuy alerts will appear here 🔔`,
        { parse_mode: "HTML" });
    } else {
      await bot.sendMessage(chatId, `❌ ${result.error ?? "Failed to start"}`);
    }
  });

  // ── /stop ─────────────────────────────────────────────────────────────────
  bot.onText(/^\/stop(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) return;
    const config = await getOrCreate(chatId, msg.chat.title);
    await botRegistry.stop(config.id);
    await bot.sendMessage(chatId, "⏹ Monitoring stopped.");
  });

  // ── /status ───────────────────────────────────────────────────────────────
  bot.onText(/^\/status(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) return;
    const config = await getOrCreate(chatId, msg.chat.title);
    const { running } = botRegistry.getStatus(config.id);
    await sendSettings(bot, chatId, config, running);
  });

  // ── Callback query handler ────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    if (!query.message || !query.from) return;
    const chatId = String(query.message.chat.id);
    const msgId = query.message.message_id;
    const data = query.data ?? "";

    if (!(await isAdmin(bot, chatId, query.from.id))) {
      await bot.answerCallbackQuery(query.id, { text: "⛔ Only group admins.", show_alert: true });
      return;
    }
    await bot.answerCallbackQuery(query.id);

    const config = await getOrCreate(chatId, query.message.chat.title);

    // Add Token → chain picker
    if (data === "action:add_token") {
      await bot.editMessageText(
        `🔧 <b>Buy Bot Setup</b>\n\nPlease select the chain of your token below`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: chainKeyboard() },
      ).catch(() => null);
      return;
    }

    // Chain selected → ask for address
    if (data.startsWith("chain:")) {
      const chain = data.replace("chain:", "");
      pendingState.set(chatId, { step: "await_token_address", chain });
      const chainLabel = CHAIN_LABELS[chain] ?? chain;
      await bot.editMessageText(
        `⚙️ <b>Send the token address to track</b> [${chainLabel}]`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML" },
      ).catch(() => null);
      await bot.sendMessage(chatId,
        `📋 Paste the <b>${chainLabel}</b> token contract address below.\n\n<i>Tip: If the bot doesn't see your message, use this command instead:\n<code>/token 0xYourAddress</code></i>`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } },
      );
      return;
    }

    // Settings / status refresh
    if (data === "action:settings" || data === "action:status") {
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running, msgId);
      return;
    }

    // Start
    if (data === "action:start") {
      const updated = await getOrCreate(chatId);
      if (!updated.tokenAddress) {
        await bot.sendMessage(chatId, "⚠️ Set a token first with /add");
        return;
      }
      await bot.sendMessage(chatId, "⏳ Starting…");
      const result = await botRegistry.start(updated.id);
      const fresh = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(fresh.id);
      await sendSettings(bot, chatId, fresh, running, msgId);
      if (!result.running)
        await bot.sendMessage(chatId, `❌ ${result.error ?? "Failed to start"}`);
      return;
    }

    // Stop
    if (data === "action:stop") {
      await botRegistry.stop(config.id);
      const updated = await getOrCreate(chatId);
      await sendSettings(bot, chatId, updated, false, msgId);
      return;
    }

    // Filter menu
    if (data === "cfg:filter") {
      await bot.editMessageText(filterText(config), {
        chat_id: chatId, message_id: msgId, parse_mode: "HTML",
        reply_markup: filterKeyboard(config),
      }).catch(() => null);
      return;
    }

    // Tier thresholds
    if (data === "cfg:tiers") {
      pendingState.set(chatId, { step: "await_tier_thresholds" });
      const t1 = config.tier1Min ?? 100;
      const t2 = config.tier2Min ?? 500;
      const t3 = config.tier3Min ?? 1000;
      await bot.sendMessage(chatId,
        `🏷 <b>Tier Thresholds</b>\n\nSend three numbers: <b>Tier1 Tier2 Tier3</b> (in USD)\n\n` +
        `• Tier 1 = upper limit of Small buys\n• Tier 2 = upper limit of Medium buys\n• Tier 3 = Whale minimum\n\n` +
        `Example: <code>500 1000 5000</code>\n\nCurrent: <b>$${t1} / $${t2} / $${t3}</b>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // Min buy picker
    if (data === "cfg:min") {
      await bot.editMessageText(
        `<b>💵 Minimum Buy Amount</b>\n\nOnly buys at or above this amount will post an alert. Choose:`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: minBuyKeyboard() },
      ).catch(() => null);
      return;
    }
    if (data.startsWith("set:min:")) {
      const n = parseFloat(data.split(":")[2] ?? "1");
      await db.update(botConfigTable).set({ minBuyUsd: n, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      await bot.editMessageText(filterText(updated), {
        chat_id: chatId, message_id: msgId, parse_mode: "HTML",
        reply_markup: filterKeyboard(updated),
      }).catch(() => null);
      await bot.answerCallbackQuery(query.id, { text: `✅ Min buy set to $${n}` });
      return;
    }

    // Emoji prompt
    if (data === "cfg:emoji") {
      pendingState.set(chatId, { step: "await_emoji" });
      const e = config.alertEmoji ?? "🟢";
      const c = config.emojiPerTier ?? 5;
      await bot.sendMessage(chatId,
        `🎨 <b>Set Alert Emoji</b>\n\nReply with the emoji to use on buy alerts.\n\nExamples: 🔥 💎 🚀 ⚡ 🐋 🟢 💰\n\nCurrent preview with <b>${e} ×${c}</b>:\n• Small buy: ${e.repeat(c)}\n• Medium buy: ${e.repeat(c * 2)}\n• 🐋 Whale: ${e.repeat(c * 3)}`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } },
      );
      return;
    }

    // Media prompt
    if (data === "cfg:media") {
      pendingState.set(chatId, { step: "await_media" });
      await bot.sendMessage(chatId,
        `📸 <b>Set Alert Media</b>\n\nReply with:\n• An <b>image</b> (photo)\n• A <b>video</b> or <b>GIF</b>\n• A direct URL (http://…)\n• <code>remove</code> to clear\n\nThis appears with every buy alert.`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } },
      );
      return;
    }

    // Buy link prompt
    if (data === "cfg:buy") {
      pendingState.set(chatId, { step: "await_buy_link" });
      await bot.sendMessage(chatId,
        `🛒 <b>Set Buy Link</b>\n\nReply with your token's buy URL:\n\nExamples:\n• <code>https://raydium.io/swap/?outputMint=…</code>\n• <code>https://app.uniswap.org/swap?outputCurrency=…</code>\n• <code>https://jup.ag/swap/SOL-…</code>`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } },
      );
      return;
    }

    // Alert style picker
    if (data === "cfg:style") {
      const current = config.alertStyle ?? "sosana";
      await bot.editMessageText(
        `🎨 <b>Alert Style</b>\n\n` +
        `<b>SOSANA</b> — Clean format with text links at the bottom. Simple and fast.\n\n` +
        `<b>Trending</b> — Richer format with native-first amounts, social links (Telegram / X / Website) and inline Buy / DexTools / Screener buttons.`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: styleKeyboard(current) },
      ).catch(() => null);
      return;
    }

    if (data === "set:style:sosana" || data === "set:style:trending") {
      const newStyle = data === "set:style:trending" ? "trending" : "sosana";
      await db.update(botConfigTable).set({ alertStyle: newStyle, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running, msgId);
      await bot.answerCallbackQuery(query.id, { text: `✅ Style set to ${newStyle === "trending" ? "Trending" : "SOSANA"}` });
      return;
    }

    // Repeat timer picker
    if (data === "cfg:repeat") {
      await bot.editMessageText(
        `⏰ <b>Repeat Post Interval</b>\n\n` +
        `The bot will post a live token stats update (price, market cap, liquidity) at the selected interval.\n\n` +
        `This is <b>real DexScreener data</b> — not a fake buy. Set <b>Off</b> to disable.`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: repeatKeyboard(config.repeatInterval) },
      ).catch(() => null);
      return;
    }

    if (data.startsWith("set:repeat:")) {
      const secs = parseInt(data.split(":")[2] ?? "0");
      const interval = secs > 0 ? secs : null;
      await db.update(botConfigTable).set({ repeatInterval: interval, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      botRegistry.restartRepeatTimer(config.id, interval);
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running, msgId);
      const label = secs === 0 ? "disabled" : formatInterval(secs);
      await bot.answerCallbackQuery(query.id, { text: `⏰ Repeat: ${label}` });
      return;
    }

    // ── Raid tracker ─────────────────────────────────────────────────────────────
    if (data === "cfg:raid" || data === "cfg:raid:url" || data === "cfg:raid:targets" || data === "cfg:raid:clear" || data.startsWith("set:raid:interval:")) {
      const hasBearerToken = !!process.env["TWITTER_BEARER_TOKEN"];
      if (!hasBearerToken) {
        await bot.answerCallbackQuery(query.id, {
          text: "⚠️ TWITTER_BEARER_TOKEN not set. Contact admin.",
          show_alert: true,
        });
        return;
      }
    }

    if (data === "cfg:raid") {
      if (!config.raidTweetUrl) {
        await bot.editMessageText(
          `🎯 <b>Raid Tracker</b>\n\nTrack live Twitter engagement and post progress updates to your group.\n\n` +
          `No tweet configured yet. Tap <b>Set Tweet URL</b> to begin.`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: raidIntervalKeyboard("", config.raidInterval) },
        ).catch(() => null);
      } else {
        const tweetShort = config.raidTweetUrl.length > 50 ? config.raidTweetUrl.slice(0, 47) + "…" : config.raidTweetUrl;
        await bot.editMessageText(
          `🎯 <b>Raid Tracker</b>\n\n` +
          `Tweet: <a href="${config.raidTweetUrl}">${tweetShort}</a>\n` +
          `Targets: ❤️ ${config.raidTargetLikes ?? 10} | 🔁 ${config.raidTargetRetweets ?? 5} | 💬 ${config.raidTargetReplies ?? 5}\n` +
          `Interval: ${formatInterval(config.raidInterval)}\n\n` +
          `Pick an update interval below (or Off to pause):`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: raidIntervalKeyboard(config.raidTweetUrl, config.raidInterval) },
        ).catch(() => null);
      }
      return;
    }

    if (data === "cfg:raid:url") {
      pendingState.set(chatId, { step: "await_raid_url" });
      await bot.sendMessage(chatId,
        `🔗 <b>Set Tweet URL</b>\n\nSend the full URL of the tweet you want to raid.\nExample: <code>https://x.com/user/status/1234567890</code>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (data === "cfg:raid:targets") {
      if (!config.raidTweetUrl) {
        await bot.answerCallbackQuery(query.id, { text: "Set a tweet URL first.", show_alert: true });
        return;
      }
      pendingState.set(chatId, { step: "await_raid_targets", tweetUrl: config.raidTweetUrl });
      await bot.sendMessage(chatId,
        `🎯 <b>Set Targets</b>\n\nSend three numbers: <b>Likes Retweets Replies</b>\nExample: <code>50 20 10</code>\n\nCurrent: ❤️ ${config.raidTargetLikes ?? 10} | 🔁 ${config.raidTargetRetweets ?? 5} | 💬 ${config.raidTargetReplies ?? 5}`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (data === "cfg:raid:clear") {
      await db.update(botConfigTable).set({ raidTweetUrl: null, raidInterval: null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      botRegistry.restartRaidTimer(config.id, null);
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running, msgId);
      await bot.answerCallbackQuery(query.id, { text: "🗑 Raid cleared" });
      return;
    }

    if (data.startsWith("set:raid:interval:")) {
      const secs = parseInt(data.split(":")[3] ?? "0");
      const interval = secs > 0 ? secs : null;
      await db.update(botConfigTable).set({ raidInterval: interval, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      botRegistry.restartRaidTimer(config.id, interval);
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running, msgId);
      const label = secs === 0 ? "disabled" : formatInterval(secs);
      await bot.answerCallbackQuery(query.id, { text: `🎯 Raid: ${label}` });
      return;
    }

    // ── Vote alert ───────────────────────────────────────────────────────────────
    if (data === "cfg:vote") {
      const cur = config.voteInterval ?? 0;
      const pos = config.votePosition ?? 1;
      const needed = config.voteNeeded ?? 50;
      const count = config.voteCount ?? 1000;
      const incr = config.voteIncrement ?? 10;
      const btnCount = (() => {
        try { return config.voteButtons ? (JSON.parse(config.voteButtons) as unknown[]).length : 0; } catch { return 0; }
      })();
      await bot.editMessageText(
        `🗳 <b>Vote Alert</b>\n\n` +
        `Current Votes: <b>${count.toLocaleString()}</b> (+${incr} per post)\n` +
        `Position: <b>#${pos}</b> | Needed: <b>${needed}</b>\n` +
        `Image: ${config.voteImageFileId ? "✅" : "❌"}  Buttons: ${btnCount}\n` +
        `Interval: <b>${formatInterval(cur)}</b>\n\n` +
        `Pick an interval (or Off to pause), then configure the rest below:`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: voteMenuKeyboard(config) },
      ).catch(() => null);
      return;
    }

    if (data.startsWith("set:vote:interval:")) {
      const secs = parseInt(data.split(":")[3] ?? "0");
      const interval = secs > 0 ? secs : null;
      await db.update(botConfigTable).set({ voteInterval: interval, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      botRegistry.restartVoteTimer(config.id, interval);
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running, msgId);
      await bot.answerCallbackQuery(query.id, { text: `🗳 Vote: ${secs === 0 ? "Off" : formatInterval(secs)}` });
      return;
    }

    if (data === "cfg:vote:count") {
      pendingState.set(chatId, { step: "await_vote_count" });
      await bot.sendMessage(chatId,
        `🔢 <b>Votes & Increment</b>\n\nSend two numbers: <b>Starting Count</b> and <b>Votes per Post</b>\nExample: <code>5000 25</code>\n\nThis sets where the vote counter begins and how much it grows each post.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (data === "cfg:vote:position") {
      pendingState.set(chatId, { step: "await_vote_position" });
      await bot.sendMessage(chatId,
        `📊 <b>Leaderboard Position</b>\n\nSend two numbers: <b>Position</b> and <b>Votes Needed for Leaderboard</b>\nExample: <code>3 50</code>\n\nThis shows "Position: #3" and "Votes needed to enter Leaderboard: 50".`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (data === "cfg:vote:image") {
      pendingState.set(chatId, { step: "await_vote_image" });
      await bot.sendMessage(chatId,
        `🖼 <b>Banner Image</b>\n\nSend a photo and the bot will use it as the banner above each vote alert.\n\nTo remove the current image, tap the "Clear Image" button in the Vote menu.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (data === "cfg:vote:clearimage") {
      await db.update(botConfigTable).set({ voteImageFileId: null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      await bot.editMessageText(
        `🗳 <b>Vote Alert</b>\n\nImage cleared. Configure below:`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: voteMenuKeyboard(updated) },
      ).catch(() => null);
      await bot.answerCallbackQuery(query.id, { text: "🗑 Image cleared" });
      return;
    }

    if (data === "cfg:vote:reset") {
      await db.update(botConfigTable).set({ voteCount: 0, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      await bot.editMessageText(
        `🗳 <b>Vote Alert</b>\n\nVote count reset to 0.`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: voteMenuKeyboard(updated) },
      ).catch(() => null);
      await bot.answerCallbackQuery(query.id, { text: "🗑 Votes reset to 0" });
      return;
    }

    if (data === "cfg:vote:buttons") {
      pendingState.set(chatId, { step: "await_vote_buttons" });
      await bot.sendMessage(chatId,
        `🔗 <b>Custom Buttons</b>\n\nSend one button per line in this format:\n<code>Button Text | https://link.com</code>\n\nExample:\n<code>🗳 Vote for TOKEN | https://coinvote.cc/token/TOKEN\n🎰 Create Raffle | https://t.me/rafflebot\n⚡ Boost Votes | https://example.com\n🔥 Buy Trending | https://dexscreener.com</code>\n\nUp to 4 buttons, shown 2 per row. Send <code>clear</code> to remove all buttons.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // Social links flow
    if (data === "cfg:social") {
      pendingState.set(chatId, { step: "await_social_telegram" });
      const current = config.telegramUrl || config.twitterUrl || config.websiteUrl;
      await bot.sendMessage(chatId,
        `👥 <b>Social Links</b>\n\nThese appear in the <b>Trending</b> alert style.\n\n` +
        (current ? `Current: ${[config.telegramUrl && "Telegram", config.twitterUrl && "X", config.websiteUrl && "Website"].filter(Boolean).join(", ")} ✅\n\n` : "") +
        `<b>Step 1/3</b> — Reply with your <b>Telegram</b> group/channel URL, or <code>skip</code>.\n\nExample: <code>https://t.me/YourGroup</code>`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } },
      );
      return;
    }
  });

  // ── Message handler: replies + plain text (force_reply flow) ─────────────
  bot.on("message", async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);

    // Skip commands (handled separately)
    if (msg.text?.startsWith("/")) return;

    const state = pendingState.get(chatId);
    if (!state) return;

    // In groups, only process if admin
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) return;

    const config = await getOrCreate(chatId, msg.chat.title);

    // ── Token address (force_reply reply or direct text) ──────────────────
    if (state.step === "await_token_address") {
      if (!msg.text) return;
      pendingState.delete(chatId);
      await processTokenAddress(chatId, msg.text.trim(), state.chain, config);
      return;
    }

    // ── Emoji ─────────────────────────────────────────────────────────────
    if (state.step === "await_emoji") {
      if (!msg.text) return;
      const emoji = msg.text.trim();
      pendingState.set(chatId, { step: "await_emoji_count", emoji });
      await bot.sendMessage(chatId,
        `✅ Emoji: <b>${emoji}</b>\n\nNow reply with how many to show per buy (1–10):\n\nPreview with 5:\n• Small buy: ${emoji.repeat(5)}\n• Medium buy: ${emoji.repeat(10)}\n• 🐋 Whale: ${emoji.repeat(15)}`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } },
      );
      return;
    }

    // ── Emoji count ───────────────────────────────────────────────────────
    if (state.step === "await_emoji_count") {
      if (!msg.text) return;
      const n = parseInt(msg.text.trim());
      if (isNaN(n) || n < 1 || n > 10) {
        await bot.sendMessage(chatId, "❌ Send a number between 1 and 10.");
        return;
      }
      pendingState.delete(chatId);
      const emoji = state.emoji;
      await db.update(botConfigTable)
        .set({ alertEmoji: emoji, emojiPerTier: n, updatedAt: new Date() })
        .where(eq(botConfigTable.id, config.id));
      await bot.sendMessage(chatId,
        `✅ Emoji saved!\n• Small buy: ${emoji.repeat(n)}\n• Medium buy: ${emoji.repeat(n * 2)}\n• 🐋 Whale: ${emoji.repeat(n * 3)}\n\nScales automatically — no thresholds needed.`);
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running);
      return;
    }

    // ── Media ─────────────────────────────────────────────────────────────
    if (state.step === "await_media") {
      let fileId: string | null = null;
      let mediaType = "photo";

      if (msg.photo) {
        fileId = msg.photo[msg.photo.length - 1]?.file_id ?? null;
        mediaType = "photo";
      } else if (msg.video) {
        fileId = msg.video.file_id; mediaType = "video";
      } else if (msg.animation) {
        fileId = msg.animation.file_id; mediaType = "animation";
      } else if (msg.document) {
        const mime = msg.document.mime_type ?? "";
        fileId = msg.document.file_id;
        mediaType = mime.startsWith("video/") ? "video" : mime === "image/gif" ? "animation" : "photo";
      } else if (msg.text) {
        const text = msg.text.trim();
        pendingState.delete(chatId);
        if (text.toLowerCase() === "remove") {
          await db.update(botConfigTable)
            .set({ alertImageUrl: null, alertMediaFileId: null, alertMediaType: null, updatedAt: new Date() })
            .where(eq(botConfigTable.id, config.id));
          await bot.sendMessage(chatId, "✅ Alert media cleared.");
        } else if (text.startsWith("http")) {
          const type = text.match(/\.(mp4|webm)$/i) ? "video" : text.match(/\.gif$/i) ? "animation" : "photo";
          await db.update(botConfigTable)
            .set({ alertImageUrl: text, alertMediaFileId: null, alertMediaType: type, updatedAt: new Date() })
            .where(eq(botConfigTable.id, config.id));
          await bot.sendMessage(chatId, `✅ Alert media URL saved (${type}).`);
        } else {
          await bot.sendMessage(chatId, "❌ Send a file, a URL (http://…), or <code>remove</code>.", { parse_mode: "HTML" });
          return;
        }
        const updated = await getOrCreate(chatId);
        const { running } = botRegistry.getStatus(updated.id);
        await sendSettings(bot, chatId, updated, running);
        return;
      }

      if (fileId) {
        pendingState.delete(chatId);
        await db.update(botConfigTable)
          .set({ alertMediaFileId: fileId, alertMediaType: mediaType, alertImageUrl: null, updatedAt: new Date() })
          .where(eq(botConfigTable.id, config.id));
        await bot.sendMessage(chatId, `✅ Alert ${mediaType} saved!`);
        const updated = await getOrCreate(chatId);
        const { running } = botRegistry.getStatus(updated.id);
        await sendSettings(bot, chatId, updated, running);
      }
      return;
    }

    // ── Buy link ──────────────────────────────────────────────────────────
    if (state.step === "await_buy_link") {
      if (!msg.text) return;
      pendingState.delete(chatId);
      const url = msg.text.trim();
      if (!url.startsWith("http")) {
        await bot.sendMessage(chatId, "❌ Please paste a valid URL starting with http.");
        return;
      }
      await db.update(botConfigTable)
        .set({ buyUrl: url, updatedAt: new Date() })
        .where(eq(botConfigTable.id, config.id));
      await bot.sendMessage(chatId, "✅ Buy link saved.");
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running);
      return;
    }

    // ── Social links ─────────────────────────────────────────────────────
    if (state.step === "await_social_telegram") {
      if (!msg.text) return;
      const text = msg.text.trim();
      const tgUrl = text.toLowerCase() === "skip" ? null : text.startsWith("http") ? text : null;
      if (!tgUrl && text.toLowerCase() !== "skip") {
        await bot.sendMessage(chatId, "❌ Please paste a valid URL starting with http, or type <code>skip</code>.", { parse_mode: "HTML" });
        return;
      }
      pendingState.set(chatId, { step: "await_social_twitter", telegramUrl: tgUrl });
      await bot.sendMessage(chatId,
        `${tgUrl ? "✅ Telegram saved!" : "⏭ Skipped."}\n\n<b>Step 2/3</b> — Reply with your <b>X / Twitter</b> URL, or <code>skip</code>.\n\nExample: <code>https://x.com/YourProject</code>`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } },
      );
      return;
    }

    if (state.step === "await_social_twitter") {
      if (!msg.text) return;
      const text = msg.text.trim();
      const xUrl = text.toLowerCase() === "skip" ? null : text.startsWith("http") ? text : null;
      if (!xUrl && text.toLowerCase() !== "skip") {
        await bot.sendMessage(chatId, "❌ Please paste a valid URL starting with http, or type <code>skip</code>.", { parse_mode: "HTML" });
        return;
      }
      pendingState.set(chatId, { step: "await_social_website", telegramUrl: state.telegramUrl, twitterUrl: xUrl });
      await bot.sendMessage(chatId,
        `${xUrl ? "✅ X/Twitter saved!" : "⏭ Skipped."}\n\n<b>Step 3/3</b> — Reply with your <b>Website</b> URL, or <code>skip</code>.\n\nExample: <code>https://yourproject.com</code>`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } },
      );
      return;
    }

    if (state.step === "await_social_website") {
      if (!msg.text) return;
      const text = msg.text.trim();
      const webUrl = text.toLowerCase() === "skip" ? null : text.startsWith("http") ? text : null;
      if (!webUrl && text.toLowerCase() !== "skip") {
        await bot.sendMessage(chatId, "❌ Please paste a valid URL starting with http, or type <code>skip</code>.", { parse_mode: "HTML" });
        return;
      }
      pendingState.delete(chatId);
      await db.update(botConfigTable)
        .set({
          telegramUrl: state.telegramUrl,
          twitterUrl: state.twitterUrl,
          websiteUrl: webUrl,
          updatedAt: new Date(),
        })
        .where(eq(botConfigTable.id, config.id));
      const saved = [state.telegramUrl && "Telegram", state.twitterUrl && "X", webUrl && "Website"].filter(Boolean);
      await bot.sendMessage(chatId,
        saved.length > 0
          ? `✅ Social links saved: ${saved.join(", ")}\n\nThese will appear in <b>Trending</b> style alerts.`
          : `✅ Social links cleared.`,
        { parse_mode: "HTML" },
      );
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running);
      return;
    }

    if (state.step === "await_tier_thresholds") {
      const rawText = (msg.text ?? "").trim();
      const nums = rawText.split(/\s+/).map(Number);
      if (nums.length < 3 || nums.some(isNaN) || nums.some((n) => n <= 0)) {
        await bot.sendMessage(chatId,
          `❌ Please send three positive USD amounts.\nExample: <code>500 1000 5000</code>`,
          { parse_mode: "HTML" },
        );
        return;
      }
      const [t1 = 100, t2 = 500, t3 = 1000] = nums;
      if (t1 >= t2 || t2 >= t3) {
        await bot.sendMessage(chatId,
          `❌ Each tier must be larger than the previous.\nExample: <code>500 1000 5000</code>`,
          { parse_mode: "HTML" },
        );
        return;
      }
      pendingState.delete(chatId);
      await db.update(botConfigTable)
        .set({ tier1Min: t1, tier2Min: t2, tier3Min: t3, updatedAt: new Date() })
        .where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      await bot.sendMessage(chatId,
        `✅ Tiers updated:\n• Small: $${config.minBuyUsd ?? 1} – $${t1}\n• Medium: $${t1} – $${t2}\n• 🐋 Whale: $${t2}+`,
        { parse_mode: "HTML", reply_markup: filterKeyboard(updated) },
      );
      return;
    }

    if (state.step === "await_vote_count") {
      const rawText = (msg.text ?? "").trim();
      const nums = rawText.split(/\s+/).map(Number);
      if (nums.length < 2 || nums.some(isNaN) || nums.some((n) => n < 0)) {
        await bot.sendMessage(chatId, `❌ Please send two positive numbers: Starting Count then Votes per Post.\nExample: <code>5000 25</code>`, { parse_mode: "HTML" });
        return;
      }
      pendingState.delete(chatId);
      const [startCount = 1000, increment = 10] = nums;
      await db.update(botConfigTable).set({ voteCount: startCount, voteIncrement: increment, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      await bot.sendMessage(chatId, `✅ Votes set: starting at <b>${startCount.toLocaleString()}</b>, +<b>${increment}</b> per post.`, { parse_mode: "HTML" });
      await bot.sendMessage(chatId, "Back to Vote settings:", { parse_mode: "HTML", reply_markup: voteMenuKeyboard(updated) });
      return;
    }

    if (state.step === "await_vote_position") {
      const rawText = (msg.text ?? "").trim();
      const nums = rawText.split(/\s+/).map(Number);
      if (nums.length < 2 || nums.some(isNaN) || nums.some((n) => n < 0)) {
        await bot.sendMessage(chatId, `❌ Please send two numbers: Position then Votes Needed.\nExample: <code>3 50</code>`, { parse_mode: "HTML" });
        return;
      }
      pendingState.delete(chatId);
      const [position = 1, needed = 50] = nums;
      await db.update(botConfigTable).set({ votePosition: position, voteNeeded: needed, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      await bot.sendMessage(chatId, `✅ Leaderboard set: Position <b>#${position}</b>, votes needed: <b>${needed}</b>.`, { parse_mode: "HTML" });
      await bot.sendMessage(chatId, "Back to Vote settings:", { parse_mode: "HTML", reply_markup: voteMenuKeyboard(updated) });
      return;
    }

    if (state.step === "await_vote_image") {
      const photo = msg.photo;
      if (!photo || photo.length === 0) {
        await bot.sendMessage(chatId, `❌ Please send a photo (image file). Try again.`, { parse_mode: "HTML" });
        return;
      }
      pendingState.delete(chatId);
      const fileId = photo[photo.length - 1]!.file_id;
      await db.update(botConfigTable).set({ voteImageFileId: fileId, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      await bot.sendMessage(chatId, `✅ Banner image saved! It will appear above each vote alert.`, { parse_mode: "HTML" });
      await bot.sendMessage(chatId, "Back to Vote settings:", { parse_mode: "HTML", reply_markup: voteMenuKeyboard(updated) });
      return;
    }

    if (state.step === "await_vote_buttons") {
      const rawText = (msg.text ?? "").trim();
      if (rawText.toLowerCase() === "clear") {
        pendingState.delete(chatId);
        await db.update(botConfigTable).set({ voteButtons: null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
        const updated = await getOrCreate(chatId);
        await bot.sendMessage(chatId, `✅ Buttons cleared.`, { parse_mode: "HTML" });
        await bot.sendMessage(chatId, "Back to Vote settings:", { parse_mode: "HTML", reply_markup: voteMenuKeyboard(updated) });
        return;
      }
      const lines = rawText.split("\n").filter(Boolean).slice(0, 4);
      const buttons: { text: string; url: string }[] = [];
      for (const line of lines) {
        const [btnText, btnUrl] = line.split("|").map((s) => s.trim());
        if (!btnText || !btnUrl || !btnUrl.startsWith("http")) {
          await bot.sendMessage(chatId,
            `❌ Invalid line: <code>${line}</code>\nFormat must be: <code>Button Text | https://url.com</code>`,
            { parse_mode: "HTML" },
          );
          return;
        }
        buttons.push({ text: btnText, url: btnUrl });
      }
      pendingState.delete(chatId);
      await db.update(botConfigTable).set({ voteButtons: JSON.stringify(buttons), updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      await bot.sendMessage(chatId, `✅ ${buttons.length} button(s) saved.`, { parse_mode: "HTML" });
      await bot.sendMessage(chatId, "Back to Vote settings:", { parse_mode: "HTML", reply_markup: voteMenuKeyboard(updated) });
      return;
    }

    if (state.step === "await_raid_url") {
      const rawText = (msg.text ?? "").trim();
      const tweetId = rawText.match(/\/status\/(\d+)/)?.[1];
      if (!tweetId) {
        await bot.sendMessage(chatId,
          `❌ Invalid tweet URL. It must contain <code>/status/</code> followed by the tweet ID.\nExample: <code>https://x.com/user/status/1234567890</code>`,
          { parse_mode: "HTML" },
        );
        return;
      }
      pendingState.delete(chatId);
      await db.update(botConfigTable).set({ raidTweetUrl: rawText, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      pendingState.set(chatId, { step: "await_raid_targets", tweetUrl: rawText });
      await bot.sendMessage(chatId,
        `✅ Tweet URL saved!\n\n🎯 <b>Set Targets</b>\nSend three numbers: <b>Likes Retweets Replies</b>\nExample: <code>50 20 10</code>\n\nOr send <code>skip</code> to use defaults (10 likes, 5 retweets, 5 replies)`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (state.step === "await_raid_targets") {
      const rawText = (msg.text ?? "").trim();
      let likes = 10, retweets = 5, replies = 5;
      if (rawText.toLowerCase() !== "skip") {
        const nums = rawText.split(/\s+/).map(Number);
        if (nums.length < 3 || nums.some(isNaN)) {
          await bot.sendMessage(chatId,
            `❌ Please send three numbers separated by spaces.\nExample: <code>50 20 10</code>\nOr send <code>skip</code> to use defaults.`,
            { parse_mode: "HTML" },
          );
          return;
        }
        [likes = 10, retweets = 5, replies = 5] = nums;
      }
      pendingState.delete(chatId);
      await db.update(botConfigTable).set({
        raidTargetLikes: likes,
        raidTargetRetweets: retweets,
        raidTargetReplies: replies,
        updatedAt: new Date(),
      }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await bot.sendMessage(chatId,
        `✅ Targets saved: ❤️ ${likes} | 🔁 ${retweets} | 💬 ${replies}\n\nNow set the update interval in settings:`,
        { parse_mode: "HTML" },
      );
      await sendSettings(bot, chatId, updated, running);
      return;
    }
  });

  logger.info("Command bot started");
}
