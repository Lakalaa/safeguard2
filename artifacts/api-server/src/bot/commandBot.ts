import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { botConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { botRegistry, getDexScreenerData } from "./botRegistry";
import { logger } from "../lib/logger";
import type { BotConfig } from "@workspace/db";

const HELP_TEXT =
  `<b>Safeguard Buy Alert Bot — Commands</b>\n\n` +
  `<code>/setup &lt;address&gt;</code>\n` +
  `  Set the token address to monitor (auto-detects chain)\n\n` +
  `<code>/setmin &lt;usd&gt;</code>\n` +
  `  Minimum buy in USD to trigger alert (default: $1)\n\n` +
  `<code>/settiers &lt;t1&gt; &lt;t2&gt; &lt;t3&gt;</code>\n` +
  `  Set tier thresholds e.g. /settiers 100 500 1000\n\n` +
  `<code>/setemoji &lt;n&gt;</code>\n` +
  `  Number of 🟢 per tier (default: 4)\n\n` +
  `<code>/setimage &lt;url&gt;</code>\n` +
  `  Image URL sent with each alert\n\n` +
  `<code>/setbuy &lt;url&gt;</code>\n` +
  `  Custom buy link (Raydium, Uniswap, Jupiter, etc.)\n\n` +
  `<code>/setlinks dext=&lt;url&gt; screener=&lt;url&gt; trending=&lt;url&gt;</code>\n` +
  `  Set DexTools, DexScreener and Trending links\n\n` +
  `<code>/start</code> — Start monitoring\n` +
  `<code>/stop</code> — Stop monitoring\n` +
  `<code>/status</code> — Show current config and status\n` +
  `<code>/test</code> — Send a test connection message\n` +
  `<code>/help</code> — Show this message`;

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

function formatConfig(config: BotConfig, running: boolean): string {
  const lines: string[] = [];
  lines.push(`<b>Status:</b> ${running ? "🟢 Running" : "⚫ Stopped"}`);
  lines.push(`<b>Token:</b> ${config.tokenName ?? "—"} ${config.tokenSymbol ? `(${config.tokenSymbol})` : ""}`);
  lines.push(`<b>Chain:</b> ${config.chain ?? "—"}`);
  if (config.tokenAddress) lines.push(`<b>Address:</b> <code>${config.tokenAddress}</code>`);
  lines.push(`<b>Min Buy:</b> $${config.minBuyUsd}`);
  lines.push(`<b>Tiers:</b> $${config.tier1Min} / $${config.tier2Min} / $${config.tier3Min}`);
  lines.push(`<b>Emojis/tier:</b> ${config.emojiPerTier}`);
  if (config.buyUrl) lines.push(`<b>Buy link:</b> ${config.buyUrl}`);
  if (config.alertImageUrl) lines.push(`<b>Image:</b> set`);
  return lines.join("\n");
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
      await getOrCreate(chatId, msg.chat.title);

      await bot.sendMessage(
        chatId,
        `👋 <b>Safeguard Buy Alert Bot</b> is here!\n\n` +
        `To start monitoring token buys in this group:\n\n` +
        `1️⃣ <code>/setup &lt;token_address&gt;</code>\n` +
        `   Paste any token address (Solana, ETH, BSC, Base…)\n\n` +
        `2️⃣ <code>/start</code>\n` +
        `   Begin live on-chain monitoring\n\n` +
        `Type /help to see all available commands.`,
        { parse_mode: "HTML" },
      );
    } catch (err) {
      logger.error({ err }, "new_chat_members handler error");
    }
  });

  // ── /help ──────────────────────────────────────────────────────────────────
  bot.onText(/^\/help(@\S+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    await bot.sendMessage(chatId, HELP_TEXT, { parse_mode: "HTML" }).catch(() => null);
  });

  // ── /status ────────────────────────────────────────────────────────────────
  bot.onText(/^\/status(@\S+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const config = await getOrCreate(chatId, msg.chat.title);
      const { running } = botRegistry.getStatus(config.id);
      await bot.sendMessage(chatId, formatConfig(config, running), { parse_mode: "HTML" });
    } catch (err) {
      logger.error({ err }, "/status error");
    }
  });

  // ── /setup <address> ───────────────────────────────────────────────────────
  bot.onText(/^\/setup(@\S+)?(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const address = match?.[2]?.trim();

    if (!address) {
      await bot.sendMessage(chatId, "Usage: <code>/setup &lt;token_address&gt;</code>", { parse_mode: "HTML" });
      return;
    }

    await bot.sendMessage(chatId, "🔍 Looking up token…");

    try {
      const config = await getOrCreate(chatId, msg.chat.title);
      const dexData = await getDexScreenerData(address);

      const chainId = dexData?.chainId ?? (address.startsWith("0x") ? "ethereum" : "solana");
      const name = dexData?.baseToken.name ?? null;
      const symbol = dexData?.baseToken.symbol ?? null;

      // Auto-fill DexScreener and DexTools links
      const DEXTOOLS_CHAIN: Record<string, string> = {
        ethereum: "ether", bsc: "bnb", polygon: "polygon",
        arbitrum: "arbitrum", base: "base", avalanche: "avalanche",
        optimism: "optimism", solana: "solana",
      };
      const pairAddress = dexData?.pairAddress ?? null;
      const dextoolsChain = DEXTOOLS_CHAIN[chainId] ?? chainId;
      const screenerUrl = pairAddress ? `https://dexscreener.com/${chainId}/${pairAddress}` : null;
      const dextUrl = pairAddress ? `https://www.dextools.io/app/en/${dextoolsChain}/pair-explorer/${pairAddress}` : null;

      await db.update(botConfigTable).set({
        tokenAddress: address,
        tokenName: name,
        tokenSymbol: symbol,
        chain: chainId,
        screenerUrl,
        dextUrl,
        updatedAt: new Date(),
      }).where(eq(botConfigTable.id, config.id));

      const priceUsd = dexData?.priceUsd ? parseFloat(dexData.priceUsd) : null;
      const mcap = dexData?.marketCap ?? dexData?.fdv ?? null;

      let reply = dexData
        ? `✅ <b>${name} (${symbol})</b> found on <b>${chainId}</b>\n`
        : `✅ Token address set (not found on DexScreener — chain auto-detected as <b>${chainId}</b>)\n`;
      if (priceUsd) reply += `💵 Price: <b>$${priceUsd.toFixed(6)}</b>\n`;
      if (mcap) reply += `📊 Market Cap: <b>$${mcap >= 1_000_000 ? (mcap / 1_000_000).toFixed(2) + "M" : (mcap / 1_000).toFixed(0) + "K"}</b>\n`;
      reply += `\nType /start to begin monitoring buys.`;

      await bot.sendMessage(chatId, reply, { parse_mode: "HTML" });
    } catch (err) {
      logger.error({ err }, "/setup error");
      await bot.sendMessage(chatId, "❌ Failed to look up token. Check the address and try again.");
    }
  });

  // ── /setmin <usd> ──────────────────────────────────────────────────────────
  bot.onText(/^\/setmin(@\S+)?(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const val = parseFloat(match?.[2] ?? "");
    if (isNaN(val) || val < 0) {
      await bot.sendMessage(chatId, "Usage: <code>/setmin &lt;usd&gt;</code>  e.g. /setmin 50", { parse_mode: "HTML" });
      return;
    }
    const config = await getOrCreate(chatId, msg.chat.title);
    await db.update(botConfigTable).set({ minBuyUsd: val, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
    await bot.sendMessage(chatId, `✅ Minimum buy set to <b>$${val}</b>`, { parse_mode: "HTML" });
  });

  // ── /settiers <t1> <t2> <t3> ───────────────────────────────────────────────
  bot.onText(/^\/settiers(@\S+)?(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const parts = (match?.[2] ?? "").trim().split(/\s+/).map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) {
      await bot.sendMessage(chatId, "Usage: <code>/settiers &lt;t1&gt; &lt;t2&gt; &lt;t3&gt;</code>  e.g. /settiers 100 500 1000", { parse_mode: "HTML" });
      return;
    }
    const [t1, t2, t3] = parts as [number, number, number];
    const config = await getOrCreate(chatId, msg.chat.title);
    await db.update(botConfigTable).set({ tier1Min: t1, tier2Min: t2, tier3Min: t3, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
    await bot.sendMessage(chatId, `✅ Tiers set: 🟢 $${t1} / 🟢🟢 $${t2} / 🟢🟢🟢 $${t3}`, { parse_mode: "HTML" });
  });

  // ── /setemoji <n> ──────────────────────────────────────────────────────────
  bot.onText(/^\/setemoji(@\S+)?(?:\s+(\d+))?$/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const n = parseInt(match?.[2] ?? "");
    if (isNaN(n) || n < 1 || n > 20) {
      await bot.sendMessage(chatId, "Usage: <code>/setemoji &lt;1-20&gt;</code>  e.g. /setemoji 4", { parse_mode: "HTML" });
      return;
    }
    const config = await getOrCreate(chatId, msg.chat.title);
    await db.update(botConfigTable).set({ emojiPerTier: n, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
    await bot.sendMessage(chatId, `✅ Emojis per tier set to <b>${n}</b>  ${("🟢").repeat(n)}`, { parse_mode: "HTML" });
  });

  // ── /setimage <url> ────────────────────────────────────────────────────────
  bot.onText(/^\/setimage(@\S+)?(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const url = match?.[2]?.trim() ?? "";
    if (!url.startsWith("http")) {
      await bot.sendMessage(chatId, "Usage: <code>/setimage &lt;url&gt;</code>  — provide a direct image URL", { parse_mode: "HTML" });
      return;
    }
    const config = await getOrCreate(chatId, msg.chat.title);
    await db.update(botConfigTable).set({ alertImageUrl: url, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
    await bot.sendMessage(chatId, `✅ Alert image set.`);
  });

  // ── /setbuy <url> ──────────────────────────────────────────────────────────
  bot.onText(/^\/setbuy(@\S+)?(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const url = match?.[2]?.trim() ?? "";
    if (!url.startsWith("http")) {
      await bot.sendMessage(chatId, "Usage: <code>/setbuy &lt;url&gt;</code>  e.g. /setbuy https://raydium.io/swap/…", { parse_mode: "HTML" });
      return;
    }
    const config = await getOrCreate(chatId, msg.chat.title);
    await db.update(botConfigTable).set({ buyUrl: url, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
    await bot.sendMessage(chatId, `✅ Buy link set.`);
  });

  // ── /setlinks [dext=url] [screener=url] [trending=url] ────────────────────
  bot.onText(/^\/setlinks(@\S+)?(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const raw = match?.[2] ?? "";
    if (!raw.trim()) {
      await bot.sendMessage(chatId,
        "Usage: <code>/setlinks dext=&lt;url&gt; screener=&lt;url&gt; trending=&lt;url&gt;</code>\n" +
        "All fields optional — only provided ones are updated.",
        { parse_mode: "HTML" });
      return;
    }

    const updates: Partial<typeof botConfigTable.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
    for (const part of raw.split(/\s+/)) {
      const [key, ...rest] = part.split("=");
      const val = rest.join("=");
      if (!val) continue;
      if (key === "dext") updates.dextUrl = val;
      else if (key === "screener") updates.screenerUrl = val;
      else if (key === "trending") updates.trendingUrl = val;
    }

    const config = await getOrCreate(chatId, msg.chat.title);
    await db.update(botConfigTable).set(updates).where(eq(botConfigTable.id, config.id));
    await bot.sendMessage(chatId, `✅ Links updated.`);
  });

  // ── /start ─────────────────────────────────────────────────────────────────
  bot.onText(/^\/start(@\S+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const config = await getOrCreate(chatId, msg.chat.title);

      if (!config.tokenAddress) {
        await bot.sendMessage(chatId,
          "⚠️ No token configured yet.\nUse <code>/setup &lt;token_address&gt;</code> first.",
          { parse_mode: "HTML" });
        return;
      }

      await bot.sendMessage(chatId, "⏳ Starting monitor…");
      const result = await botRegistry.start(config.id);

      if (result.running) {
        await bot.sendMessage(chatId,
          `✅ <b>Bot started!</b>\n\nMonitoring <b>${config.tokenName ?? config.tokenAddress}</b> on <b>${config.chain ?? "chain"}</b>\nBuy alerts will appear here live.`,
          { parse_mode: "HTML" });
      } else {
        await bot.sendMessage(chatId, `❌ Failed to start: ${result.error ?? "unknown error"}`);
      }
    } catch (err) {
      logger.error({ err }, "/start error");
      await bot.sendMessage(chatId, "❌ An error occurred. Check the token address and try again.");
    }
  });

  // ── /stop ──────────────────────────────────────────────────────────────────
  bot.onText(/^\/stop(@\S+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const config = await getOrCreate(chatId, msg.chat.title);
      await botRegistry.stop(config.id);
      await bot.sendMessage(chatId, "⏹ Bot stopped. Use /start to resume.");
    } catch (err) {
      logger.error({ err }, "/stop error");
    }
  });

  // ── /test ──────────────────────────────────────────────────────────────────
  bot.onText(/^\/test(@\S+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const config = await getOrCreate(chatId, msg.chat.title);
      const result = await botRegistry.sendTestAlert(config.id);
      if (!result.success) {
        await bot.sendMessage(chatId, `❌ ${result.message}`);
      }
    } catch (err) {
      logger.error({ err }, "/test error");
    }
  });

  logger.info("Command bot polling started");
}
