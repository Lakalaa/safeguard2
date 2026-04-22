import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { botConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { botRegistry, getDexScreenerData } from "./botRegistry";
import { logger } from "../lib/logger";
import type { BotConfig } from "@workspace/db";

// ── In-memory: waiting for a reply after an inline button prompt ──────────────
const pendingInput = new Map<string, { field: string }>();

// ── DEXTOOLS chain slug map ────────────────────────────────────────────────────
const DEXTOOLS_CHAIN: Record<string, string> = {
  ethereum: "ether", bsc: "bnb", polygon: "polygon",
  arbitrum: "arbitrum", base: "base", avalanche: "avalanche",
  optimism: "optimism", solana: "solana",
};

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

// ── Main setup panel ──────────────────────────────────────────────────────────
function mainMenu(config: BotConfig, running: boolean): TelegramBot.InlineKeyboardMarkup {
  const tokenBtn = config.tokenName
    ? `✅ ${config.tokenName} (${config.tokenSymbol ?? "?"})`
    : "🔧 Set Token Address";
  const emojiBtn = `🎨 Alert Emoji: ${config.alertEmoji ?? "🟢"} ×${config.emojiPerTier}`;
  const mediaBtn = (config.alertMediaFileId || config.alertImageUrl) ? "📸 Media ✅" : "📸 Set Alert Media";
  const buyBtn = config.buyUrl ? "🛒 Buy Link ✅" : "🛒 Set Buy Link";
  const toggleLabel = running ? "⏹ Stop Monitoring" : "▶️ Start Monitoring";
  const toggleData = running ? "action:stop" : "action:start";

  return {
    inline_keyboard: [
      [{ text: tokenBtn, callback_data: "prompt:token" }],
      [
        { text: `💵 Min Buy: $${config.minBuyUsd ?? 1}`, callback_data: "menu:min" },
        { text: "📊 Tiers", callback_data: "menu:tiers" },
      ],
      [
        { text: emojiBtn, callback_data: "prompt:emoji" },
        { text: mediaBtn, callback_data: "prompt:media" },
      ],
      [{ text: buyBtn, callback_data: "prompt:buy" }],
      [{ text: toggleLabel, callback_data: toggleData }],
      [{ text: "📋 Status", callback_data: "action:status" }],
    ],
  };
}

// ── Min buy picker ─────────────────────────────────────────────────────────────
function minBuyPicker(): TelegramBot.InlineKeyboardMarkup {
  const amounts = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < amounts.length; i += 4) {
    rows.push(amounts.slice(i, i + 4).map((n) => ({ text: `$${n}`, callback_data: `set:min:${n}` })));
  }
  rows.push([{ text: "⬅️ Back", callback_data: "action:back" }]);
  return { inline_keyboard: rows };
}

// ── Tier presets picker ────────────────────────────────────────────────────────
function tierPicker(): TelegramBot.InlineKeyboardMarkup {
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
      [{ text: "⬅️ Back", callback_data: "action:back" }],
    ],
  };
}

// ── Status text ────────────────────────────────────────────────────────────────
function statusText(config: BotConfig, running: boolean): string {
  const emoji = config.alertEmoji ?? "🟢";
  const lines: string[] = [];
  lines.push(`<b>🤖 Safeguard Buy Alert Bot</b>`);
  lines.push(`Status: ${running ? "🟢 Running" : "⚫ Stopped"}`);
  lines.push("");
  lines.push(`<b>Token:</b> ${config.tokenName ?? "—"} ${config.tokenSymbol ? `(${config.tokenSymbol})` : ""}`);
  lines.push(`<b>Chain:</b> ${config.chain ?? "—"}`);
  if (config.tokenAddress) lines.push(`<b>Address:</b> <code>${config.tokenAddress}</code>`);
  lines.push(`<b>Min Buy:</b> $${config.minBuyUsd}`);
  lines.push(`<b>Tiers:</b> $${config.tier1Min} / $${config.tier2Min} / $${config.tier3Min}`);
  lines.push(`<b>Alert Emoji:</b> ${emoji} (${config.emojiPerTier} per tier, scales by tier)`);
  if (config.alertMediaFileId || config.alertImageUrl) lines.push(`<b>Alert media:</b> ✅`);
  if (config.buyUrl) lines.push(`<b>Buy link:</b> ✅`);
  if (config.dextUrl) lines.push(`<b>DexTools:</b> auto-filled ✅`);
  if (config.screenerUrl) lines.push(`<b>DexScreener:</b> auto-filled ✅`);
  return lines.join("\n");
}

// ── Send / refresh the setup panel ────────────────────────────────────────────
async function sendPanel(
  bot: TelegramBot,
  chatId: string,
  config: BotConfig,
  running: boolean,
  editMsgId?: number,
): Promise<void> {
  const text = statusText(config, running);
  const markup = mainMenu(config, running);
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

  bot.on("polling_error", (err) => {
    logger.error({ err: err.message }, "Telegram polling error");
  });

  // ── Bot added to group ─────────────────────────────────────────────────────
  bot.on("new_chat_members", async (msg) => {
    try {
      const me = await bot.getMe();
      const isAdded = (msg.new_chat_members ?? []).some((m) => m.id === me.id);
      if (!isAdded) return;
      const chatId = String(msg.chat.id);
      const config = await getOrCreate(chatId, msg.chat.title);
      const { running } = botRegistry.getStatus(config.id);
      await sendPanel(bot, chatId, config, running);
    } catch (err) {
      logger.error({ err }, "new_chat_members error");
    }
  });

  // ── /setup → show panel ────────────────────────────────────────────────────
  bot.onText(/^\/setup(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (!(await isAdmin(bot, chatId, msg.from.id))) {
      await bot.sendMessage(chatId, "⛔ Only group admins can use this.").catch(() => null);
      return;
    }
    const config = await getOrCreate(chatId, msg.chat.title);
    const { running } = botRegistry.getStatus(config.id);
    await sendPanel(bot, chatId, config, running);
  });

  // ── /start ─────────────────────────────────────────────────────────────────
  bot.onText(/^\/start(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) return;
    const config = await getOrCreate(chatId, msg.chat.title);
    if (!config.tokenAddress) {
      await bot.sendMessage(chatId, "⚠️ No token set. Use /setup to configure the bot.");
      return;
    }
    const result = await botRegistry.start(config.id);
    if (result.running) {
      await bot.sendMessage(chatId,
        `✅ <b>Started!</b> Monitoring <b>${config.tokenName ?? config.tokenAddress}</b> on <b>${config.chain}</b>.\nBuy alerts will appear here live.`,
        { parse_mode: "HTML" });
    } else {
      await bot.sendMessage(chatId, `❌ ${result.error ?? "Failed to start"}`);
    }
  });

  // ── /stop ──────────────────────────────────────────────────────────────────
  bot.onText(/^\/stop(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (!(await isAdmin(bot, chatId, msg.from.id))) return;
    const config = await getOrCreate(chatId, msg.chat.title);
    await botRegistry.stop(config.id);
    await bot.sendMessage(chatId, "⏹ Monitoring stopped.");
  });

  // ── Inline button callbacks ────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    if (!query.message || !query.from) return;
    const chatId = String(query.message.chat.id);
    const msgId = query.message.message_id;
    const data = query.data ?? "";

    if (!(await isAdmin(bot, chatId, query.from.id))) {
      await bot.answerCallbackQuery(query.id, { text: "⛔ Admins only", show_alert: true });
      return;
    }
    await bot.answerCallbackQuery(query.id);

    const config = await getOrCreate(chatId, query.message.chat.title);

    // ── Preset value buttons ───────────────────────────────────────────────
    if (data.startsWith("set:min:")) {
      const n = parseFloat(data.split(":")[2] ?? "1");
      await db.update(botConfigTable).set({ minBuyUsd: n, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendPanel(bot, chatId, updated, running, msgId);
      return;
    }

    if (data.startsWith("set:tiers:")) {
      const parts = data.split(":").slice(2).map(Number) as [number, number, number];
      await db.update(botConfigTable).set({ tier1Min: parts[0], tier2Min: parts[1], tier3Min: parts[2], updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendPanel(bot, chatId, updated, running, msgId);
      return;
    }

    // ── Sub-menus ──────────────────────────────────────────────────────────
    if (data === "menu:min") {
      await bot.editMessageText(`<b>💵 Minimum Buy Amount</b>\nAlerts only fire for buys at or above this amount:`, {
        chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: minBuyPicker(),
      }).catch(() => null);
      return;
    }

    if (data === "menu:tiers") {
      await bot.editMessageText(`<b>📊 Tier Thresholds</b>\nBigger buys show more emojis:\n\nTier 1 → Tier 2 → Tier 3`, {
        chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: tierPicker(),
      }).catch(() => null);
      return;
    }

    // ── Back to main panel ─────────────────────────────────────────────────
    if (data === "action:back") {
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendPanel(bot, chatId, updated, running, msgId);
      return;
    }

    // ── Start / Stop ───────────────────────────────────────────────────────
    if (data === "action:start") {
      const updated = await getOrCreate(chatId);
      if (!updated.tokenAddress) {
        await bot.sendMessage(chatId, "⚠️ Set the token address first — tap 🔧 Set Token Address.");
        return;
      }
      const result = await botRegistry.start(updated.id);
      const fresh = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(fresh.id);
      await sendPanel(bot, chatId, fresh, running, msgId);
      if (result.running) {
        await bot.sendMessage(chatId, `✅ <b>Started!</b> Monitoring <b>${fresh.tokenName ?? fresh.tokenAddress}</b>.`, { parse_mode: "HTML" });
      } else {
        await bot.sendMessage(chatId, `❌ ${result.error ?? "Failed to start"}`);
      }
      return;
    }

    if (data === "action:stop") {
      await botRegistry.stop(config.id);
      const updated = await getOrCreate(chatId);
      await sendPanel(bot, chatId, updated, false, msgId);
      return;
    }

    if (data === "action:status") {
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendPanel(bot, chatId, updated, running, msgId);
      return;
    }

    // ── Prompts for free-text / media input ───────────────────────────────
    const promptText: Record<string, string> = {
      "prompt:token":
        "🔧 <b>Set Token Address</b>\n\nSend the token contract address to monitor.\nChain is auto-detected. DexTools and DexScreener links will be set automatically.\n\nWorks for: Solana, ETH, BSC, Base, Arbitrum, Polygon, Avalanche, Optimism.",
      "prompt:emoji":
        "🎨 <b>Set Alert Emoji</b>\n\nSend any emoji (or a few) you want to use as the buy indicator.\n\nExamples: 🔥  💎  🚀  ⚡  🐋\n\nThe emoji repeats more for bigger buys:\n• Tier 1 buy → emoji ×1\n• Tier 2 buy → emoji ×2\n• Tier 3 buy → emoji ×3\n\nYou can also set how many per tier (sends after this).",
      "prompt:media":
        "📸 <b>Set Alert Media</b>\n\nSend an image, video, or GIF — it will be shown with every buy alert.\n\nYou can:\n• Upload a file directly here\n• Send a URL (http://…)\n\nSend <code>remove</code> to clear the current media.",
      "prompt:buy":
        "🛒 <b>Set Buy Link</b>\n\nSend the buy URL for your token (Raydium, Uniswap, Jupiter, etc.).\n\nExample: <code>https://raydium.io/swap/?outputMint=…</code>",
    };

    const prompt = promptText[data];
    if (!prompt) return;

    pendingInput.set(chatId, { field: data });
    await bot.sendMessage(chatId, prompt, {
      parse_mode: "HTML",
      reply_markup: { force_reply: true, selective: true },
    });
  });

  // ── Message handler: free-text & media replies ─────────────────────────────
  bot.on("message", async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    const pending = pendingInput.get(chatId);
    if (!pending) return;
    if (!(await isAdmin(bot, chatId, msg.from.id))) return;

    // ── Media upload (photo / video / animation / document) ───────────────
    if (pending.field === "prompt:media") {
      pendingInput.delete(chatId);
      const config = await getOrCreate(chatId, msg.chat.title);

      let fileId: string | null = null;
      let mediaType: string = "photo";

      if (msg.photo) {
        // Highest quality photo
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
        mediaType = mime.startsWith("video") ? "video" : mime === "image/gif" ? "animation" : "photo";
      } else if (msg.text) {
        const text = msg.text.trim();
        if (text.toLowerCase() === "remove") {
          await db.update(botConfigTable).set({ alertImageUrl: null, alertMediaFileId: null, alertMediaType: null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
          await bot.sendMessage(chatId, "✅ Alert media removed.");
        } else if (text.startsWith("http")) {
          const url = text.toLowerCase();
          const type = url.endsWith(".mp4") || url.endsWith(".webm") ? "video" : url.endsWith(".gif") ? "animation" : "photo";
          await db.update(botConfigTable).set({ alertImageUrl: text, alertMediaFileId: null, alertMediaType: type, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
          await bot.sendMessage(chatId, `✅ Media URL set (${type}).`);
        } else {
          await bot.sendMessage(chatId, "❌ Send an image/video/GIF file, a URL, or <code>remove</code>.", { parse_mode: "HTML" });
          return;
        }
        const updated = await getOrCreate(chatId);
        const { running } = botRegistry.getStatus(updated.id);
        await sendPanel(bot, chatId, updated, running);
        return;
      }

      if (fileId) {
        await db.update(botConfigTable).set({ alertMediaFileId: fileId, alertMediaType: mediaType, alertImageUrl: null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
        await bot.sendMessage(chatId, `✅ Alert ${mediaType} set.`);
        const updated = await getOrCreate(chatId);
        const { running } = botRegistry.getStatus(updated.id);
        await sendPanel(bot, chatId, updated, running);
      }
      return;
    }

    // ── Text-only prompts ─────────────────────────────────────────────────
    if (!msg.text) return;
    if (msg.text.startsWith("/")) return;

    pendingInput.delete(chatId);
    const text = msg.text.trim();
    const config = await getOrCreate(chatId, msg.chat.title);

    try {
      switch (pending.field) {
        case "prompt:token": {
          await bot.sendMessage(chatId, "🔍 Looking up token on DexScreener…");
          const dexData = await getDexScreenerData(text);
          const chainId = dexData?.chainId ?? (text.startsWith("0x") ? "ethereum" : "solana");
          const pairAddress = dexData?.pairAddress ?? null;
          const dextoolsChain = DEXTOOLS_CHAIN[chainId] ?? chainId;
          const screenerUrl = pairAddress ? `https://dexscreener.com/${chainId}/${pairAddress}` : null;
          const dextUrl = pairAddress ? `https://www.dextools.io/app/en/${dextoolsChain}/pair-explorer/${pairAddress}` : null;

          await db.update(botConfigTable).set({
            tokenAddress: text,
            tokenName: dexData?.baseToken.name ?? null,
            tokenSymbol: dexData?.baseToken.symbol ?? null,
            chain: chainId,
            screenerUrl,
            dextUrl,
            updatedAt: new Date(),
          }).where(eq(botConfigTable.id, config.id));

          const name = dexData?.baseToken.name ?? text.slice(0, 8) + "…";
          const sym = dexData?.baseToken.symbol ?? "?";
          const priceUsd = dexData?.priceUsd ? parseFloat(dexData.priceUsd) : null;
          const mcap = dexData?.marketCap ?? dexData?.fdv ?? null;

          let reply = dexData
            ? `✅ <b>${name} (${sym})</b> on <b>${chainId}</b>\n`
            : `✅ Token address set — chain: <b>${chainId}</b>\n`;
          if (priceUsd) reply += `💵 Price: $${priceUsd.toFixed(6)}\n`;
          if (mcap) reply += `📊 Market Cap: $${mcap >= 1_000_000 ? (mcap / 1_000_000).toFixed(2) + "M" : (mcap / 1_000).toFixed(0) + "K"}\n`;
          if (screenerUrl) reply += `📈 DexScreener & DexTools links auto-filled ✅`;
          await bot.sendMessage(chatId, reply, { parse_mode: "HTML" });
          break;
        }

        case "prompt:emoji": {
          // First message sets the emoji character(s)
          // Could be a single emoji or a few
          const emojiChars = text;
          await db.update(botConfigTable).set({ alertEmoji: emojiChars, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
          // Ask for count per tier
          await bot.sendMessage(chatId,
            `✅ Emoji set to <b>${emojiChars}</b>\n\nNow how many per tier? (e.g. <code>3</code> means Tier 1 = ${emojiChars.repeat(3)}, Tier 2 = ${emojiChars.repeat(6)}, Tier 3 = ${emojiChars.repeat(9)})\n\nReply with a number 1–10:`,
            { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
          );
          pendingInput.set(chatId, { field: "prompt:emoji_count" });
          break;
        }

        case "prompt:emoji_count": {
          const n = parseInt(text);
          if (isNaN(n) || n < 1 || n > 10) {
            await bot.sendMessage(chatId, "❌ Send a number between 1 and 10.");
            return;
          }
          await db.update(botConfigTable).set({ emojiPerTier: n, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
          const fresh = await getOrCreate(chatId);
          const emoji = fresh.alertEmoji ?? "🟢";
          await bot.sendMessage(chatId,
            `✅ Set! Preview:\n• Tier 1: ${emoji.repeat(n)}\n• Tier 2: ${emoji.repeat(n * 2)}\n• Tier 3: ${emoji.repeat(n * 3)}`,
            { parse_mode: "HTML" }
          );
          break;
        }

        case "prompt:buy": {
          if (!text.startsWith("http")) {
            await bot.sendMessage(chatId, "❌ Send a valid URL starting with http.");
            return;
          }
          await db.update(botConfigTable).set({ buyUrl: text, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
          await bot.sendMessage(chatId, "✅ Buy link set.");
          break;
        }
      }

      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendPanel(bot, chatId, updated, running);
    } catch (err) {
      logger.error({ err }, "Text input handler error");
      await bot.sendMessage(chatId, "❌ Something went wrong. Please try again.");
    }
  });

  logger.info("Command bot polling started");
}
