import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { botConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { botRegistry, getDexScreenerData } from "./botRegistry";
import { logger } from "../lib/logger";
import type { BotConfig } from "@workspace/db";

// ── In-memory: waiting for free-text reply (token address / image / buy link / extra links)
const pendingInput = new Map<string, { field: string }>();

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

// ── DEXTOOLS chain slug map ────────────────────────────────────────────────────
const DEXTOOLS_CHAIN: Record<string, string> = {
  ethereum: "ether", bsc: "bnb", polygon: "polygon",
  arbitrum: "arbitrum", base: "base", avalanche: "avalanche",
  optimism: "optimism", solana: "solana",
};

// ── Main setup panel ──────────────────────────────────────────────────────────
function mainMenu(config: BotConfig, running: boolean): TelegramBot.SendMessageOptions["reply_markup"] {
  const tokenBtn = config.tokenName
    ? `✅ ${config.tokenName} (${config.tokenSymbol ?? "?"})`
    : "🔧 Set Token Address";
  const toggleLabel = running ? "⏹ Stop Monitoring" : "▶️ Start Monitoring";
  const toggleData = running ? "action:stop" : "action:start";

  return {
    inline_keyboard: [
      [{ text: tokenBtn, callback_data: "prompt:token" }],
      [
        { text: `💵 Min Buy: $${config.minBuyUsd ?? 1}`, callback_data: "menu:min" },
        { text: `📊 Tiers`, callback_data: "menu:tiers" },
      ],
      [
        { text: `🟢 Emojis/tier: ${config.emojiPerTier}`, callback_data: "menu:emoji" },
        { text: config.alertImageUrl ? "🖼 Image ✅" : "🖼 Set Image", callback_data: "prompt:image" },
      ],
      [
        { text: config.buyUrl ? "🛒 Buy Link ✅" : "🛒 Set Buy Link", callback_data: "prompt:buy" },
        { text: "🔗 Extra Links", callback_data: "prompt:links" },
      ],
      [{ text: toggleLabel, callback_data: toggleData }],
      [{ text: "📋 Status", callback_data: "action:status" }],
    ],
  };
}

// ── Emoji picker (1–20) ────────────────────────────────────────────────────────
function emojiPicker(): TelegramBot.SendMessageOptions["reply_markup"] {
  return {
    inline_keyboard: [
      [1, 2, 3, 4, 5].map((n) => ({ text: `${n} ${"🟢".repeat(n)}`, callback_data: `set:emoji:${n}` })),
      [6, 7, 8, 9, 10].map((n) => ({ text: `${n}`, callback_data: `set:emoji:${n}` })),
      [12, 15, 20].map((n) => ({ text: `${n}`, callback_data: `set:emoji:${n}` })),
      [{ text: "⬅️ Back", callback_data: "action:back" }],
    ],
  };
}

// ── Min buy picker ─────────────────────────────────────────────────────────────
function minBuyPicker(): TelegramBot.SendMessageOptions["reply_markup"] {
  const amounts = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < amounts.length; i += 4) {
    rows.push(
      amounts.slice(i, i + 4).map((n) => ({ text: `$${n}`, callback_data: `set:min:${n}` })),
    );
  }
  rows.push([{ text: "⬅️ Back", callback_data: "action:back" }]);
  return { inline_keyboard: rows };
}

// ── Tier presets picker ────────────────────────────────────────────────────────
function tierPicker(): TelegramBot.SendMessageOptions["reply_markup"] {
  const presets: Array<[string, number, number, number]> = [
    ["Micro  $50/$200/$500", 50, 200, 500],
    ["Small  $100/$500/$1K", 100, 500, 1000],
    ["Mid  $250/$1K/$5K", 250, 1000, 5000],
    ["Large  $500/$2K/$10K", 500, 2000, 10000],
    ["Whale  $1K/$5K/$25K", 1000, 5000, 25000],
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

function statusText(config: BotConfig, running: boolean): string {
  const lines: string[] = [];
  lines.push(`<b>🤖 Safeguard Buy Alert Bot</b>`);
  lines.push(`Status: ${running ? "🟢 Running" : "⚫ Stopped"}`);
  lines.push("");
  lines.push(`<b>Token:</b> ${config.tokenName ?? "—"} ${config.tokenSymbol ? `(${config.tokenSymbol})` : ""}`);
  lines.push(`<b>Chain:</b> ${config.chain ?? "—"}`);
  if (config.tokenAddress) lines.push(`<b>Address:</b> <code>${config.tokenAddress}</code>`);
  lines.push(`<b>Min Buy:</b> $${config.minBuyUsd}`);
  lines.push(`<b>Tiers:</b> $${config.tier1Min} / $${config.tier2Min} / $${config.tier3Min}`);
  lines.push(`<b>Emojis/tier:</b> ${config.emojiPerTier}`);
  if (config.buyUrl) lines.push(`<b>Buy link:</b> ✅`);
  if (config.alertImageUrl) lines.push(`<b>Alert image:</b> ✅`);
  return lines.join("\n");
}

// ── Send / refresh setup panel ─────────────────────────────────────────────────
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
      chat_id: chatId,
      message_id: editMsgId,
      parse_mode: "HTML",
      reply_markup: markup as TelegramBot.InlineKeyboardMarkup,
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
      await bot.sendMessage(chatId, "⚠️ No token set. Use /setup first.");
      return;
    }
    const result = await botRegistry.start(config.id);
    if (result.running) {
      await bot.sendMessage(chatId,
        `✅ <b>Started!</b> Monitoring <b>${config.tokenName ?? config.tokenAddress}</b> on <b>${config.chain}</b>.`,
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

    // ── Preset value buttons (set:field:value) ─────────────────────────────
    if (data.startsWith("set:emoji:")) {
      const n = parseInt(data.split(":")[2] ?? "4");
      await db.update(botConfigTable).set({ emojiPerTier: n, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendPanel(bot, chatId, updated, running, msgId);
      return;
    }

    if (data.startsWith("set:min:")) {
      const n = parseFloat(data.split(":")[2] ?? "1");
      await db.update(botConfigTable).set({ minBuyUsd: n, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendPanel(bot, chatId, updated, running, msgId);
      return;
    }

    if (data.startsWith("set:tiers:")) {
      const parts = data.split(":").slice(2).map(Number);
      const [t1, t2, t3] = parts as [number, number, number];
      await db.update(botConfigTable).set({ tier1Min: t1, tier2Min: t2, tier3Min: t3, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendPanel(bot, chatId, updated, running, msgId);
      return;
    }

    // ── Sub-menus ──────────────────────────────────────────────────────────
    if (data === "menu:emoji") {
      await bot.editMessageText(
        `<b>🟢 Emojis per tier</b>\nChoose how many 🟢 per tier level:`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: emojiPicker() as TelegramBot.InlineKeyboardMarkup },
      ).catch(() => null);
      return;
    }

    if (data === "menu:min") {
      await bot.editMessageText(
        `<b>💵 Minimum Buy Amount</b>\nAlerts will only fire for buys above this amount:`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: minBuyPicker() as TelegramBot.InlineKeyboardMarkup },
      ).catch(() => null);
      return;
    }

    if (data === "menu:tiers") {
      await bot.editMessageText(
        `<b>📊 Tier Thresholds</b>\nChoose a preset (Tier 1 / Tier 2 / Tier 3):`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: tierPicker() as TelegramBot.InlineKeyboardMarkup },
      ).catch(() => null);
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

    // ── Prompts for free-text input ────────────────────────────────────────
    const promptText: Record<string, string> = {
      "prompt:token":
        "📋 <b>Set Token Address</b>\n\nSend the token contract address.\nWorks for Solana, ETH, BSC, Base, Arbitrum, Polygon, Avalanche, Optimism.",
      "prompt:image":
        "🖼 <b>Set Alert Image URL</b>\n\nSend a direct image URL (JPG or PNG) — this image will appear with every buy alert.\n\nSend <code>remove</code> to clear it.",
      "prompt:buy":
        "🛒 <b>Set Buy Link</b>\n\nSend the buy URL (Raydium, Uniswap, Jupiter, etc.)\n\nExample: <code>https://raydium.io/swap/?outputMint=…</code>",
      "prompt:links":
        "🔗 <b>Set Extra Links</b>\n\nSend in this format (include only what you want):\n<code>dext=https://… screener=https://… trending=https://…</code>",
    };

    const prompt = promptText[data];
    if (!prompt) return;

    pendingInput.set(chatId, { field: data });
    await bot.sendMessage(chatId, prompt, {
      parse_mode: "HTML",
      reply_markup: { force_reply: true, selective: true },
    });
  });

  // ── Text replies for free-text fields ─────────────────────────────────────
  bot.on("message", async (msg) => {
    if (!msg.text || !msg.from) return;
    if (msg.text.startsWith("/")) return;

    const chatId = String(msg.chat.id);
    const pending = pendingInput.get(chatId);
    if (!pending) return;

    if (!(await isAdmin(bot, chatId, msg.from.id))) return;

    pendingInput.delete(chatId);
    const text = msg.text.trim();
    const config = await getOrCreate(chatId, msg.chat.title);

    try {
      switch (pending.field) {
        case "prompt:token": {
          await bot.sendMessage(chatId, "🔍 Looking up token…");
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
            : `✅ Token set — chain: <b>${chainId}</b>\n`;
          if (priceUsd) reply += `💵 $${priceUsd.toFixed(6)}\n`;
          if (mcap) reply += `📊 Market Cap: $${mcap >= 1_000_000 ? (mcap / 1_000_000).toFixed(2) + "M" : (mcap / 1_000).toFixed(0) + "K"}\n`;
          await bot.sendMessage(chatId, reply, { parse_mode: "HTML" });
          break;
        }

        case "prompt:image": {
          if (text.toLowerCase() === "remove") {
            await db.update(botConfigTable).set({ alertImageUrl: null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
            await bot.sendMessage(chatId, "✅ Alert image removed.");
          } else if (text.startsWith("http")) {
            await db.update(botConfigTable).set({ alertImageUrl: text, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
            await bot.sendMessage(chatId, "✅ Alert image set.");
          } else {
            await bot.sendMessage(chatId, "❌ Send a valid URL starting with http, or type <code>remove</code>.", { parse_mode: "HTML" });
            return;
          }
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

        case "prompt:links": {
          const updates: Partial<{
            dextUrl: string | null;
            screenerUrl: string | null;
            trendingUrl: string | null;
            updatedAt: Date;
          }> = { updatedAt: new Date() };
          for (const part of text.split(/\s+/)) {
            const eqIdx = part.indexOf("=");
            if (eqIdx < 0) continue;
            const key = part.slice(0, eqIdx);
            const val = part.slice(eqIdx + 1);
            if (!val) continue;
            if (key === "dext") updates.dextUrl = val;
            else if (key === "screener") updates.screenerUrl = val;
            else if (key === "trending") updates.trendingUrl = val;
          }
          await db.update(botConfigTable).set(updates).where(eq(botConfigTable.id, config.id));
          await bot.sendMessage(chatId, "✅ Links updated.");
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
