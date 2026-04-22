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
  | { step: "await_buy_link" };

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
        {
          text: running ? "⏹ Stop" : "▶️ Start Monitoring",
          callback_data: running ? "action:stop" : "action:start",
        },
        { text: "🔄 Refresh", callback_data: "action:status" },
      ],
    ],
  };
}

function minBuyKeyboard(): TelegramBot.InlineKeyboardMarkup {
  const amounts = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < amounts.length; i += 4)
    rows.push(amounts.slice(i, i + 4).map((n) => ({ text: `$${n}`, callback_data: `set:min:${n}` })));
  rows.push([{ text: "⬅️ Back", callback_data: "action:settings" }]);
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
  ]).catch(() => null);

  bot.on("polling_error", (err) => {
    logger.error({ msg: String(err) }, "Telegram polling error");
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

    // Min buy picker
    if (data === "cfg:min") {
      await bot.editMessageText(
        `<b>💵 Minimum Buy Amount</b>\n\nChoose the minimum USD amount to trigger an alert:`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: minBuyKeyboard() },
      ).catch(() => null);
      return;
    }
    if (data.startsWith("set:min:")) {
      const n = parseFloat(data.split(":")[2] ?? "1");
      await db.update(botConfigTable).set({ minBuyUsd: n, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running, msgId);
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
  });

  logger.info("Command bot started");
}
