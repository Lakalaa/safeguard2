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
  ethereum: "Ethereum",
  solana: "Solana",
  bsc: "Binance",
  base: "Base",
  arbitrum: "Arbitrum",
  avalanche: "Avalanche",
  polygon: "Polygon",
  optimism: "Optimism",
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
    .select()
    .from(botConfigTable)
    .where(eq(botConfigTable.chatId, chatId))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(botConfigTable)
    .values({ name: chatTitle ?? `Group ${chatId}`, chatId })
    .returning();
  return created!;
}

// ── Settings panel ────────────────────────────────────────────────────────────
function settingsKeyboard(config: BotConfig, running: boolean): TelegramBot.InlineKeyboardMarkup {
  const emoji = config.alertEmoji ?? "🟢";
  const hasMedia = !!(config.alertMediaFileId || config.alertImageUrl);
  return {
    inline_keyboard: [
      [
        { text: `🎨 Emoji: ${emoji} ×${config.emojiPerTier}`, callback_data: "cfg:emoji" },
        { text: hasMedia ? "📸 Media ✅" : "📸 Add Media", callback_data: "cfg:media" },
      ],
      [
        { text: config.buyUrl ? "🛒 Buy Link ✅" : "🛒 Set Buy Link", callback_data: "cfg:buy" },
      ],
      [
        { text: `💵 Min Buy: $${config.minBuyUsd ?? 1}`, callback_data: "cfg:min" },
        { text: "📊 Tiers", callback_data: "cfg:tiers" },
      ],
      [
        {
          text: running ? "⏹ Stop Monitoring" : "▶️ Start Monitoring",
          callback_data: running ? "action:stop" : "action:start",
        },
      ],
      [{ text: "📋 Status", callback_data: "action:status" }],
    ],
  };
}

function minBuyKeyboard(): TelegramBot.InlineKeyboardMarkup {
  const amounts = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < amounts.length; i += 4) {
    rows.push(amounts.slice(i, i + 4).map((n) => ({ text: `$${n}`, callback_data: `set:min:${n}` })));
  }
  rows.push([{ text: "⬅️ Back", callback_data: "action:settings" }]);
  return { inline_keyboard: rows };
}

function tiersKeyboard(): TelegramBot.InlineKeyboardMarkup {
  const presets: Array<[string, number, number, number]> = [
    ["Micro: $50 / $200 / $500", 50, 200, 500],
    ["Small: $100 / $500 / $1K", 100, 500, 1000],
    ["Mid: $250 / $1K / $5K", 250, 1000, 5000],
    ["Large: $500 / $2K / $10K", 500, 2000, 10000],
    ["Whale: $1K / $5K / $25K", 1000, 5000, 25000],
  ];
  return {
    inline_keyboard: [
      ...presets.map(([label, t1, t2, t3]) => [
        { text: label, callback_data: `set:tiers:${t1}:${t2}:${t3}` },
      ]),
      [{ text: "⬅️ Back", callback_data: "action:settings" }],
    ],
  };
}

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

function statusText(config: BotConfig, running: boolean): string {
  const emoji = config.alertEmoji ?? "🟢";
  const lines: string[] = [];
  lines.push(`<b>🛡 Buy Alert Bot — Settings</b>`);
  lines.push(`Status: ${running ? "🟢 Running" : "⚫ Stopped"}`);
  if (config.tokenName) lines.push(`\n<b>Token:</b> ${config.tokenName} (${config.tokenSymbol ?? "?"})`);
  if (config.chain) lines.push(`<b>Chain:</b> ${CHAIN_LABELS[config.chain] ?? config.chain}`);
  if (config.tokenAddress) lines.push(`<b>Address:</b> <code>${config.tokenAddress}</code>`);
  lines.push(`\n<b>Min Buy:</b> $${config.minBuyUsd}`);
  lines.push(`<b>Tiers:</b> $${config.tier1Min} / $${config.tier2Min} / $${config.tier3Min}`);
  lines.push(`<b>Emoji:</b> ${emoji.repeat(config.emojiPerTier)} × tier level`);
  if (config.alertMediaFileId || config.alertImageUrl) lines.push(`<b>Alert media:</b> ✅ set`);
  if (config.buyUrl) lines.push(`<b>Buy link:</b> ✅ set`);
  if (config.dextUrl) lines.push(`<b>DexTools:</b> ✅ auto-filled`);
  if (config.screenerUrl) lines.push(`<b>DexScreener:</b> ✅ auto-filled`);
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

export function startCommandBot(): void {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — command bot disabled");
    return;
  }

  const bot = new TelegramBot(token, { polling: true });

  // Register commands with Telegram (shows in "/" menu for admins)
  bot.setMyCommands([
    { command: "add", description: "Add token to monitor" },
    { command: "setup", description: "Open settings panel" },
    { command: "start", description: "Start monitoring" },
    { command: "stop", description: "Stop monitoring" },
    { command: "status", description: "Check current status" },
  ]).catch(() => null);

  bot.on("polling_error", (err) => {
    logger.error({ err: err.message }, "Telegram polling error");
  });

  // ── Bot added to a group ───────────────────────────────────────────────────
  bot.on("new_chat_members", async (msg) => {
    try {
      const me = await bot.getMe();
      const isAdded = (msg.new_chat_members ?? []).some((m) => m.id === me.id);
      if (!isAdded) return;
      const chatId = String(msg.chat.id);
      await getOrCreate(chatId, msg.chat.title);
      await bot.sendMessage(
        chatId,
        `🛠 <b>Click button below to add your token for buy bot</b>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "➡️ Add Token", callback_data: "action:add_token" }]],
          },
        },
      );
    } catch (err) {
      logger.error({ err }, "new_chat_members error");
    }
  });

  // ── /add ────────────────────────────────────────────────────────────────────
  bot.onText(/^\/add(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) {
      await bot.sendMessage(chatId, "⛔ This command can only be used by group admins.").catch(() => null);
      return;
    }
    await getOrCreate(chatId, msg.chat.title);
    await bot.sendMessage(
      chatId,
      `🛠 <b>Click button below to add your token for buy bot</b>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "➡️ Add Token", callback_data: "action:add_token" }]],
        },
      },
    );
  });

  // ── /setup → open settings panel ────────────────────────────────────────────
  bot.onText(/^\/setup(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) return;
    const config = await getOrCreate(chatId, msg.chat.title);
    const { running } = botRegistry.getStatus(config.id);
    await sendSettings(bot, chatId, config, running);
  });

  // ── /start ──────────────────────────────────────────────────────────────────
  bot.onText(/^\/start(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) return;
    const config = await getOrCreate(chatId, msg.chat.title);
    if (!config.tokenAddress) {
      await bot.sendMessage(chatId, "⚠️ No token configured. Use /add to set one first.");
      return;
    }
    await bot.sendMessage(chatId, "⏳ Starting…");
    const result = await botRegistry.start(config.id);
    if (result.running) {
      await bot.sendMessage(chatId,
        `✅ <b>Started!</b> Monitoring <b>${config.tokenName ?? config.tokenAddress}</b> on <b>${CHAIN_LABELS[config.chain ?? ""] ?? config.chain}</b>.\n\nBuy alerts will appear here live 🔔`,
        { parse_mode: "HTML" });
    } else {
      await bot.sendMessage(chatId, `❌ ${result.error ?? "Failed to start"}`);
    }
  });

  // ── /stop ───────────────────────────────────────────────────────────────────
  bot.onText(/^\/stop(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) return;
    const config = await getOrCreate(chatId, msg.chat.title);
    await botRegistry.stop(config.id);
    await bot.sendMessage(chatId, "⏹ Monitoring stopped.");
  });

  // ── /status ─────────────────────────────────────────────────────────────────
  bot.onText(/^\/status(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) return;
    const config = await getOrCreate(chatId, msg.chat.title);
    const { running } = botRegistry.getStatus(config.id);
    await sendSettings(bot, chatId, config, running);
  });

  // ── Inline button callbacks ─────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    if (!query.message || !query.from) return;
    const chatId = String(query.message.chat.id);
    const msgId = query.message.message_id;
    const data = query.data ?? "";

    if (!(await isAdmin(bot, chatId, query.from.id))) {
      await bot.answerCallbackQuery(query.id, { text: "⛔ Only group admins can do this.", show_alert: true });
      return;
    }
    await bot.answerCallbackQuery(query.id);

    const config = await getOrCreate(chatId, query.message.chat.title);

    // ── Add Token → show chain selection ─────────────────────────────────
    if (data === "action:add_token") {
      await bot.editMessageText(
        `🔧 <b>Buy Bot Setup</b>\n\nPlease select the chain of your token below`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: "HTML", reply_markup: chainKeyboard(),
        },
      ).catch(() => null);
      return;
    }

    // ── Chain selected → prompt for token address ─────────────────────────
    if (data.startsWith("chain:")) {
      const chain = data.replace("chain:", "");
      pendingState.set(chatId, { step: "await_token_address", chain });
      const chainLabel = CHAIN_LABELS[chain] ?? chain;
      await bot.editMessageText(
        `⚙️ <b>Send the token address to track</b> [${chainLabel}]`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML" },
      ).catch(() => null);
      await bot.sendMessage(chatId, `📋 Paste the <b>${chainLabel}</b> token contract address:`, {
        parse_mode: "HTML",
        reply_markup: { force_reply: true, selective: true },
      });
      return;
    }

    // ── Settings sub-menu buttons ─────────────────────────────────────────
    if (data === "action:settings") {
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running, msgId);
      return;
    }

    if (data === "action:status") {
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running, msgId);
      return;
    }

    if (data === "action:start") {
      const updated = await getOrCreate(chatId);
      if (!updated.tokenAddress) {
        await bot.sendMessage(chatId, "⚠️ Set token first with /add");
        return;
      }
      await bot.sendMessage(chatId, "⏳ Starting…");
      const result = await botRegistry.start(updated.id);
      const fresh = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(fresh.id);
      await sendSettings(bot, chatId, fresh, running, msgId);
      if (!result.running) {
        await bot.sendMessage(chatId, `❌ ${result.error ?? "Failed to start"}`);
      }
      return;
    }

    if (data === "action:stop") {
      await botRegistry.stop(config.id);
      const updated = await getOrCreate(chatId);
      await sendSettings(bot, chatId, updated, false, msgId);
      return;
    }

    // ── Min buy picker ───────────────────────────────────────────────────
    if (data === "cfg:min") {
      await bot.editMessageText(`<b>💵 Minimum Buy Amount</b>\n\nChoose the minimum USD amount to trigger an alert:`, {
        chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: minBuyKeyboard(),
      }).catch(() => null);
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

    // ── Tiers picker ─────────────────────────────────────────────────────
    if (data === "cfg:tiers") {
      await bot.editMessageText(
        `<b>📊 Tier Thresholds</b>\n\nBigger buys show more emojis. Choose a preset:\n(Tier 1 / Tier 2 / Tier 3)`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: tiersKeyboard() },
      ).catch(() => null);
      return;
    }

    if (data.startsWith("set:tiers:")) {
      const parts = data.split(":").slice(2).map(Number) as [number, number, number];
      await db.update(botConfigTable).set({ tier1Min: parts[0], tier2Min: parts[1], tier3Min: parts[2], updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running, msgId);
      return;
    }

    // ── Emoji prompt ────────────────────────────────────────────────────
    if (data === "cfg:emoji") {
      pendingState.set(chatId, { step: "await_emoji" });
      await bot.sendMessage(chatId,
        `🎨 <b>Set Alert Emoji</b>\n\nSend the emoji you want to use for buy alerts.\n\nExamples: 🔥 💎 🚀 ⚡ 🐋 🟢\n\nThe emoji repeats more for bigger buys:\n• Tier 1 → emoji × count\n• Tier 2 → emoji × count × 2\n• Tier 3 → emoji × count × 3`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } },
      );
      return;
    }

    // ── Media prompt ─────────────────────────────────────────────────────
    if (data === "cfg:media") {
      pendingState.set(chatId, { step: "await_media" });
      await bot.sendMessage(chatId,
        `📸 <b>Set Alert Media</b>\n\nUpload an image, video, or GIF — it will be shown with every buy alert.\n\nYou can:\n• Upload the file directly here\n• Paste a direct URL (http://…)\n\nSend <code>remove</code> to clear current media.`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } },
      );
      return;
    }

    // ── Buy link prompt ──────────────────────────────────────────────────
    if (data === "cfg:buy") {
      pendingState.set(chatId, { step: "await_buy_link" });
      await bot.sendMessage(chatId,
        `🛒 <b>Set Buy Link</b>\n\nPaste the buy URL for your token.\nThis is the link users tap to buy.\n\nExamples:\n• <code>https://raydium.io/swap/?outputMint=…</code>\n• <code>https://app.uniswap.org/swap?outputCurrency=…</code>\n• <code>https://jup.ag/swap/SOL-…</code>`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } },
      );
      return;
    }
  });

  // ── Message handler: text & media replies ──────────────────────────────────
  bot.on("message", async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    const state = pendingState.get(chatId);
    if (!state) return;

    if (!(await isAdmin(bot, chatId, msg.from.id))) return;

    const config = await getOrCreate(chatId, msg.chat.title);

    // ── Await token address ───────────────────────────────────────────────
    if (state.step === "await_token_address") {
      if (!msg.text || msg.text.startsWith("/")) return;
      pendingState.delete(chatId);
      const address = msg.text.trim();
      const chain = state.chain;

      await bot.sendMessage(chatId, `🔍 Looking up token on DexScreener…`);
      try {
        const dexData = await getDexScreenerData(address);
        const chainId = dexData?.chainId ?? chain;
        const pairAddress = dexData?.pairAddress ?? null;
        const dextoolsChain = DEXTOOLS_CHAIN[chainId] ?? chainId;
        const screenerUrl = pairAddress ? `https://dexscreener.com/${chainId}/${pairAddress}` : null;
        const dextUrl = pairAddress ? `https://www.dextools.io/app/en/${dextoolsChain}/pair-explorer/${pairAddress}` : null;

        await db.update(botConfigTable).set({
          tokenAddress: address,
          tokenName: dexData?.baseToken.name ?? null,
          tokenSymbol: dexData?.baseToken.symbol ?? null,
          chain: chainId,
          screenerUrl,
          dextUrl,
          updatedAt: new Date(),
        }).where(eq(botConfigTable.id, config.id));

        const name = dexData?.baseToken.name ?? address.slice(0, 10) + "…";
        const sym = dexData?.baseToken.symbol ?? "?";
        const priceUsd = dexData?.priceUsd ? parseFloat(dexData.priceUsd) : null;
        const mcap = dexData?.marketCap ?? dexData?.fdv ?? null;

        let reply = dexData
          ? `✅ <b>${name} (${sym})</b> found on <b>${CHAIN_LABELS[chainId] ?? chainId}</b>\n`
          : `✅ Token set on <b>${CHAIN_LABELS[chain] ?? chain}</b>\n`;
        if (priceUsd) reply += `💵 Price: $${priceUsd.toFixed(8)}\n`;
        if (mcap) reply += `📊 Market Cap: $${mcap >= 1_000_000 ? (mcap / 1_000_000).toFixed(2) + "M" : (mcap / 1_000).toFixed(0) + "K"}\n`;
        if (screenerUrl) reply += `\n✅ DexTools & DexScreener links auto-filled`;

        await bot.sendMessage(chatId, reply, { parse_mode: "HTML" });

        const updated = await getOrCreate(chatId);
        const { running } = botRegistry.getStatus(updated.id);
        await sendSettings(bot, chatId, updated, running);
      } catch (err) {
        logger.error({ err }, "Token lookup error");
        await bot.sendMessage(chatId, "❌ Failed to look up token. Check the address and try again.");
      }
      return;
    }

    // ── Await emoji ───────────────────────────────────────────────────────
    if (state.step === "await_emoji") {
      if (!msg.text || msg.text.startsWith("/")) return;
      const emoji = msg.text.trim();
      pendingState.set(chatId, { step: "await_emoji_count", emoji });
      await bot.sendMessage(chatId,
        `✅ Emoji set to <b>${emoji}</b>\n\nNow how many per tier? (number 1–10)\n\nPreview with 3:\n• Tier 1: ${emoji.repeat(3)}\n• Tier 2: ${emoji.repeat(6)}\n• Tier 3: ${emoji.repeat(9)}`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } },
      );
      return;
    }

    // ── Await emoji count ─────────────────────────────────────────────────
    if (state.step === "await_emoji_count") {
      if (!msg.text || msg.text.startsWith("/")) return;
      pendingState.delete(chatId);
      const n = parseInt(msg.text.trim());
      if (isNaN(n) || n < 1 || n > 10) {
        await bot.sendMessage(chatId, "❌ Send a number between 1 and 10.");
        return;
      }
      const emoji = state.emoji;
      await db.update(botConfigTable).set({ alertEmoji: emoji, emojiPerTier: n, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      await bot.sendMessage(chatId,
        `✅ Emoji confirmed!\n• Tier 1: ${emoji.repeat(n)}\n• Tier 2: ${emoji.repeat(n * 2)}\n• Tier 3: ${emoji.repeat(n * 3)}`,
      );
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running);
      return;
    }

    // ── Await media ───────────────────────────────────────────────────────
    if (state.step === "await_media") {
      let fileId: string | null = null;
      let mediaType = "photo";

      if (msg.photo) {
        fileId = msg.photo[msg.photo.length - 1]?.file_id ?? null;
        mediaType = "photo";
      } else if (msg.video) {
        fileId = msg.video.file_id;
        mediaType = "video";
      } else if (msg.animation) {
        fileId = msg.animation.file_id;
        mediaType = "animation";
      } else if (msg.document) {
        const mime = msg.document.mime_type ?? "";
        fileId = msg.document.file_id;
        mediaType = mime.startsWith("video/") ? "video" : mime === "image/gif" ? "animation" : "photo";
      } else if (msg.text) {
        const text = msg.text.trim();
        if (msg.text.startsWith("/")) return;
        pendingState.delete(chatId);
        if (text.toLowerCase() === "remove") {
          await db.update(botConfigTable).set({ alertImageUrl: null, alertMediaFileId: null, alertMediaType: null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
          await bot.sendMessage(chatId, "✅ Alert media removed.");
        } else if (text.startsWith("http")) {
          const lower = text.toLowerCase();
          const type = (lower.endsWith(".mp4") || lower.endsWith(".webm")) ? "video" : lower.endsWith(".gif") ? "animation" : "photo";
          await db.update(botConfigTable).set({ alertImageUrl: text, alertMediaFileId: null, alertMediaType: type, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
          await bot.sendMessage(chatId, `✅ Alert media URL set (${type}).`);
        } else {
          await bot.sendMessage(chatId, "❌ Send a media file, a URL (http://…), or <code>remove</code>.", { parse_mode: "HTML" });
          return;
        }
        const updated = await getOrCreate(chatId);
        const { running } = botRegistry.getStatus(updated.id);
        await sendSettings(bot, chatId, updated, running);
        return;
      } else {
        return;
      }

      pendingState.delete(chatId);
      if (fileId) {
        await db.update(botConfigTable).set({ alertMediaFileId: fileId, alertMediaType: mediaType, alertImageUrl: null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
        await bot.sendMessage(chatId, `✅ Alert ${mediaType} saved!`);
        const updated = await getOrCreate(chatId);
        const { running } = botRegistry.getStatus(updated.id);
        await sendSettings(bot, chatId, updated, running);
      }
      return;
    }

    // ── Await buy link ────────────────────────────────────────────────────
    if (state.step === "await_buy_link") {
      if (!msg.text || msg.text.startsWith("/")) return;
      pendingState.delete(chatId);
      const url = msg.text.trim();
      if (!url.startsWith("http")) {
        await bot.sendMessage(chatId, "❌ Please paste a valid URL starting with http.");
        return;
      }
      await db.update(botConfigTable).set({ buyUrl: url, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      await bot.sendMessage(chatId, "✅ Buy link saved.");
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running);
      return;
    }
  });

  logger.info("Command bot polling started");
}
