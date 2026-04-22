import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { botConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { botRegistry, getDexScreenerData } from "./botRegistry";
import { logger } from "../lib/logger";
import type { BotConfig } from "@workspace/db";

// ── In-memory state: waiting for text input after an inline button press ──────
const pendingInput = new Map<string, { field: string; messageId: number }>();

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

// ── Setup panel inline keyboard ────────────────────────────────────────────────
function setupKeyboard(config: BotConfig, running: boolean): TelegramBot.InlineKeyboardMarkup {
  const tokenLabel = config.tokenName
    ? `✅ Token: ${config.tokenName} (${config.tokenSymbol ?? "?"})`
    : "🔧 Set Token Address";
  const minLabel = `💵 Min Buy: $${config.minBuyUsd ?? 1}`;
  const tiersLabel = `📊 Tiers: $${config.tier1Min}/$${config.tier2Min}/$${config.tier3Min}`;
  const emojiLabel = `🟢 Emojis/tier: ${config.emojiPerTier}`;
  const imageLabel = config.alertImageUrl ? "🖼 Image: set ✅" : "🖼 Set Alert Image";
  const buyLabel = config.buyUrl ? "🛒 Buy Link: set ✅" : "🛒 Set Buy Link";
  const linksLabel = "🔗 Set DexTools/Screener/Trending";
  const toggleLabel = running ? "⏹ Stop Monitoring" : "▶️ Start Monitoring";
  const toggleData = running ? "action:stop" : "action:start";

  return {
    inline_keyboard: [
      [{ text: tokenLabel, callback_data: "setup:token" }],
      [
        { text: minLabel, callback_data: "setup:min" },
        { text: tiersLabel, callback_data: "setup:tiers" },
      ],
      [
        { text: emojiLabel, callback_data: "setup:emoji" },
        { text: imageLabel, callback_data: "setup:image" },
      ],
      [
        { text: buyLabel, callback_data: "setup:buy" },
        { text: linksLabel, callback_data: "setup:links" },
      ],
      [{ text: toggleLabel, callback_data: toggleData }],
      [{ text: "📋 Status", callback_data: "action:status" }],
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
  if (config.buyUrl) lines.push(`<b>Buy link:</b> set ✅`);
  if (config.alertImageUrl) lines.push(`<b>Alert image:</b> set ✅`);
  return lines.join("\n");
}

// ── DEXTOOLS chain slug map ────────────────────────────────────────────────────
const DEXTOOLS_CHAIN: Record<string, string> = {
  ethereum: "ether", bsc: "bnb", polygon: "polygon",
  arbitrum: "arbitrum", base: "base", avalanche: "avalanche",
  optimism: "optimism", solana: "solana",
};

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

  // ── Bot added to group → send setup panel ─────────────────────────────────
  bot.on("new_chat_members", async (msg) => {
    try {
      const me = await bot.getMe();
      const isAdded = (msg.new_chat_members ?? []).some((m) => m.id === me.id);
      if (!isAdded) return;

      const chatId = String(msg.chat.id);
      const config = await getOrCreate(chatId, msg.chat.title);
      const { running } = botRegistry.getStatus(config.id);

      await bot.sendMessage(
        chatId,
        `👋 <b>Safeguard Buy Alert Bot</b> is here!\n\nUse the panel below to configure and start monitoring token buys.\n<i>Only group admins can use these controls.</i>`,
        {
          parse_mode: "HTML",
          reply_markup: setupKeyboard(config, running),
        },
      );
    } catch (err) {
      logger.error({ err }, "new_chat_members error");
    }
  });

  // ── /setup command → show inline panel ────────────────────────────────────
  bot.onText(/^\/setup(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (!(await isAdmin(bot, chatId, msg.from.id))) {
      await bot.sendMessage(chatId, "⛔ Only group admins can use this command.");
      return;
    }
    const config = await getOrCreate(chatId, msg.chat.title);
    const { running } = botRegistry.getStatus(config.id);
    await bot.sendMessage(chatId, statusText(config, running), {
      parse_mode: "HTML",
      reply_markup: setupKeyboard(config, running),
    });
  });

  // ── /start command ─────────────────────────────────────────────────────────
  bot.onText(/^\/start(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) {
      await bot.sendMessage(chatId, "⛔ Only group admins can use this command.");
      return;
    }
    const config = await getOrCreate(chatId, msg.chat.title);
    if (!config.tokenAddress) {
      await bot.sendMessage(chatId,
        `⚠️ No token set yet. Use /setup to configure the bot.`,
        { parse_mode: "HTML" });
      return;
    }
    const result = await botRegistry.start(config.id);
    if (result.running) {
      await bot.sendMessage(chatId,
        `✅ <b>Started!</b> Monitoring <b>${config.tokenName ?? config.tokenAddress}</b> on <b>${config.chain ?? "chain"}</b>.\nBuy alerts will appear here live.`,
        { parse_mode: "HTML" });
    } else {
      await bot.sendMessage(chatId, `❌ Failed to start: ${result.error ?? "unknown error"}`);
    }
  });

  // ── /stop command ──────────────────────────────────────────────────────────
  bot.onText(/^\/stop(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (!(await isAdmin(bot, chatId, msg.from.id))) {
      await bot.sendMessage(chatId, "⛔ Only group admins can use this command.");
      return;
    }
    const config = await getOrCreate(chatId, msg.chat.title);
    await botRegistry.stop(config.id);
    await bot.sendMessage(chatId, "⏹ Monitoring stopped.");
  });

  // ── /status command ────────────────────────────────────────────────────────
  bot.onText(/^\/status(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (!(await isAdmin(bot, chatId, msg.from.id))) return;
    const config = await getOrCreate(chatId, msg.chat.title);
    const { running } = botRegistry.getStatus(config.id);
    await bot.sendMessage(chatId, statusText(config, running), {
      parse_mode: "HTML",
      reply_markup: setupKeyboard(config, running),
    });
  });

  // ── Inline button callbacks ────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    if (!query.message || !query.from) return;
    const chatId = String(query.message.chat.id);
    const msgId = query.message.message_id;
    const data = query.data ?? "";

    const admin = await isAdmin(bot, chatId, query.from.id);
    if (!admin) {
      await bot.answerCallbackQuery(query.id, { text: "⛔ Admins only", show_alert: true });
      return;
    }

    await bot.answerCallbackQuery(query.id);

    const config = await getOrCreate(chatId, query.message.chat.title);

    // ── Action buttons ──────────────────────────────────────────────────────
    if (data === "action:start") {
      if (!config.tokenAddress) {
        await bot.sendMessage(chatId, "⚠️ Set the token address first (tap 🔧 Set Token Address).");
        return;
      }
      const result = await botRegistry.start(config.id);
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      const text = result.running
        ? `✅ <b>Started!</b> Monitoring <b>${config.tokenName ?? config.tokenAddress}</b>.`
        : `❌ ${result.error ?? "Failed to start"}`;
      await bot.editMessageText(statusText(updated, running), {
        chat_id: chatId, message_id: msgId,
        parse_mode: "HTML", reply_markup: setupKeyboard(updated, running),
      }).catch(() => null);
      await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
      return;
    }

    if (data === "action:stop") {
      await botRegistry.stop(config.id);
      const updated = await getOrCreate(chatId);
      await bot.editMessageText(statusText(updated, false), {
        chat_id: chatId, message_id: msgId,
        parse_mode: "HTML", reply_markup: setupKeyboard(updated, false),
      }).catch(() => null);
      return;
    }

    if (data === "action:status") {
      const { running } = botRegistry.getStatus(config.id);
      await bot.editMessageText(statusText(config, running), {
        chat_id: chatId, message_id: msgId,
        parse_mode: "HTML", reply_markup: setupKeyboard(config, running),
      }).catch(() => null);
      return;
    }

    // ── Setup field buttons → prompt for value ──────────────────────────────
    const prompts: Record<string, string> = {
      "setup:token":
        "📋 <b>Set Token Address</b>\n\nReply with the token contract address to monitor.\nWorks for Solana, ETH, BSC, Base, Arbitrum, Polygon, Avalanche, Optimism.\n\nExample: <code>EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v</code>",
      "setup:min":
        "💵 <b>Set Minimum Buy (USD)</b>\n\nReply with the minimum buy amount in USD to trigger an alert.\n\nExample: <code>50</code>",
      "setup:tiers":
        "📊 <b>Set Tier Thresholds</b>\n\nReply with 3 USD amounts separated by spaces.\n\nExample: <code>100 500 1000</code>\n(Tier 1 = $100+, Tier 2 = $500+, Tier 3 = $1000+)",
      "setup:emoji":
        "🟢 <b>Set Emojis Per Tier</b>\n\nReply with a number (1–20). Each tier adds this many 🟢 to the alert.\n\nExample: <code>5</code>",
      "setup:image":
        "🖼 <b>Set Alert Image URL</b>\n\nReply with a direct image URL (JPEG or PNG). This image will be sent with every buy alert.\n\nExample: <code>https://example.com/logo.png</code>\n\nSend <code>remove</code> to clear the image.",
      "setup:buy":
        "🛒 <b>Set Buy Link</b>\n\nReply with the URL users click to buy the token (Raydium, Uniswap, Jupiter, etc.).\n\nExample: <code>https://raydium.io/swap/?outputMint=…</code>",
      "setup:links":
        "🔗 <b>Set Extra Links</b>\n\nReply using this format (omit any you don't want):\n<code>dext=https://… screener=https://… trending=https://…</code>",
    };

    const prompt = prompts[data];
    if (!prompt) return;

    const sentMsg = await bot.sendMessage(chatId, prompt, {
      parse_mode: "HTML",
      reply_markup: { force_reply: true, selective: true },
    });
    pendingInput.set(chatId, { field: data, messageId: sentMsg.message_id });
  });

  // ── Text replies: handle pending input from inline buttons ─────────────────
  bot.on("message", async (msg) => {
    if (!msg.text || !msg.from) return;
    if (msg.text.startsWith("/")) return;

    const chatId = String(msg.chat.id);
    const pending = pendingInput.get(chatId);
    if (!pending) return;

    const admin = await isAdmin(bot, chatId, msg.from.id);
    if (!admin) return;

    pendingInput.delete(chatId);

    const config = await getOrCreate(chatId, msg.chat.title);
    const text = msg.text.trim();

    try {
      switch (pending.field) {
        case "setup:token": {
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
            : `✅ Token set on <b>${chainId}</b>\n`;
          if (priceUsd) reply += `💵 Price: $${priceUsd.toFixed(6)}\n`;
          if (mcap) reply += `📊 Market Cap: $${mcap >= 1_000_000 ? (mcap / 1_000_000).toFixed(2) + "M" : (mcap / 1_000).toFixed(0) + "K"}\n`;
          await bot.sendMessage(chatId, reply, { parse_mode: "HTML" });
          break;
        }

        case "setup:min": {
          const val = parseFloat(text);
          if (isNaN(val) || val < 0) {
            await bot.sendMessage(chatId, "❌ Invalid amount. Please send a number like <code>50</code>.", { parse_mode: "HTML" });
            return;
          }
          await db.update(botConfigTable).set({ minBuyUsd: val, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
          await bot.sendMessage(chatId, `✅ Minimum buy set to <b>$${val}</b>`, { parse_mode: "HTML" });
          break;
        }

        case "setup:tiers": {
          const parts = text.split(/\s+/).map(Number);
          if (parts.length !== 3 || parts.some(isNaN)) {
            await bot.sendMessage(chatId, "❌ Send exactly 3 numbers, e.g. <code>100 500 1000</code>", { parse_mode: "HTML" });
            return;
          }
          const [t1, t2, t3] = parts as [number, number, number];
          await db.update(botConfigTable).set({ tier1Min: t1, tier2Min: t2, tier3Min: t3, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
          await bot.sendMessage(chatId, `✅ Tiers: 🟢 $${t1} | 🟢🟢 $${t2} | 🟢🟢🟢 $${t3}`, { parse_mode: "HTML" });
          break;
        }

        case "setup:emoji": {
          const n = parseInt(text);
          if (isNaN(n) || n < 1 || n > 20) {
            await bot.sendMessage(chatId, "❌ Send a number between 1 and 20.", { parse_mode: "HTML" });
            return;
          }
          await db.update(botConfigTable).set({ emojiPerTier: n, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
          await bot.sendMessage(chatId, `✅ Emojis per tier: ${"🟢".repeat(n)}`);
          break;
        }

        case "setup:image": {
          if (text.toLowerCase() === "remove") {
            await db.update(botConfigTable).set({ alertImageUrl: null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
            await bot.sendMessage(chatId, "✅ Alert image removed.");
          } else if (text.startsWith("http")) {
            await db.update(botConfigTable).set({ alertImageUrl: text, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
            await bot.sendMessage(chatId, "✅ Alert image set.");
          } else {
            await bot.sendMessage(chatId, "❌ Please send a valid URL starting with http.");
            return;
          }
          break;
        }

        case "setup:buy": {
          if (!text.startsWith("http")) {
            await bot.sendMessage(chatId, "❌ Please send a valid URL starting with http.");
            return;
          }
          await db.update(botConfigTable).set({ buyUrl: text, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
          await bot.sendMessage(chatId, "✅ Buy link set.");
          break;
        }

        case "setup:links": {
          const updates: Record<string, string | null | Date> = { updatedAt: new Date() };
          for (const part of text.split(/\s+/)) {
            const [key, ...rest] = part.split("=");
            const val = rest.join("=");
            if (!val) continue;
            if (key === "dext") updates["dextUrl"] = val;
            else if (key === "screener") updates["screenerUrl"] = val;
            else if (key === "trending") updates["trendingUrl"] = val;
          }
          await db.update(botConfigTable).set(updates as Parameters<typeof db.update>[0] extends never ? never : Record<string, unknown>).where(eq(botConfigTable.id, config.id));
          await bot.sendMessage(chatId, "✅ Links updated.");
          break;
        }
      }

      // Refresh the setup panel with updated config
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await bot.sendMessage(chatId, statusText(updated, running), {
        parse_mode: "HTML",
        reply_markup: setupKeyboard(updated, running),
      });

    } catch (err) {
      logger.error({ err }, "Input handler error");
      await bot.sendMessage(chatId, "❌ Something went wrong. Please try again.");
    }
  });

  logger.info("Command bot polling started");
}
