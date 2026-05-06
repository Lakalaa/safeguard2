import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { botConfigTable, customCommandsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
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
  | { step: "await_buy_buttons" }
  | { step: "await_social_telegram" }
  | { step: "await_social_twitter"; telegramUrl: string | null }
  | { step: "await_social_website"; telegramUrl: string | null; twitterUrl: string | null }
  | { step: "await_raid_url" }
  | { step: "await_raid_targets"; tweetUrl: string }
  | { step: "await_vote_count" }
  | { step: "await_vote_position" }
  | { step: "await_vote_image" }
  | { step: "await_vote_buttons" }
  | { step: "await_filter_buttons"; commandName: string; messageText: string }
  | { step: "await_utility_token" }
  | { step: "await_broadcast_text" }
  | { step: "await_broadcast_image" }
  | { step: "await_broadcast_buttons" }
  | { step: "await_co_bot_token" }
  | { step: "await_tier2_min" }
  | { step: "await_tier3_min" }
  | { step: "await_post_text" }
  | { step: "await_post_image"; text: string }
  | { step: "await_post_buttons"; text: string; imageFileId?: string };

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

// ── Button row builder — 2 buttons per row ────────────────────────────────────
function buildButtonRows(buttons: { text: string; url: string }[]): TelegramBot.InlineKeyboardButton[][] {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2).map((b) => ({ text: b.text, url: b.url })));
  }
  return rows;
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
        { text: config.buyButtons ? "🔗 Buy Buttons ✅" : "🔗 Buy Buttons", callback_data: "cfg:buy:buttons" },
      ],
      [
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
        { text: config.utilityBotToken ? "🤖 Util Bot ✅" : "🤖 Util Bot", callback_data: "cfg:utility" },
      ],
      [
        { text: config.broadcastInterval ? "📢 Broadcast ✅" : "📢 Broadcast", callback_data: "cfg:broadcast" },
        { text: config.coBotToken ? "🤝 Co-Bot ✅" : "🤝 Co-Bot", callback_data: "cfg:cobot" },
      ],
      [
        { text: `🐋 Tiers: $${config.tier2Min ?? 500} / $${config.tier3Min ?? 1000}`, callback_data: "cfg:tiers" },
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
    ],
  };
}

function broadcastKeyboard(config: BotConfig): TelegramBot.InlineKeyboardMarkup {
  const presets = [
    { label: "Off", secs: 0 },
    { label: "30s", secs: 30 },
    { label: "1min", secs: 60 },
    { label: "5min", secs: 300 },
    { label: "15min", secs: 900 },
    { label: "30min", secs: 1800 },
    { label: "1hr", secs: 3600 },
    { label: "6hr", secs: 21600 },
    { label: "24hr", secs: 86400 },
  ];
  const cur = config.broadcastInterval ?? 0;
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < presets.length; i += 5) {
    rows.push(presets.slice(i, i + 5).map(p => ({
      text: p.secs === cur ? `✅ ${p.label}` : p.label,
      callback_data: `set:broadcast:interval:${p.secs}`,
    })));
  }
  rows.push([
    { text: config.broadcastText ? "✏️ Edit Message ✅" : "✏️ Set Message", callback_data: "cfg:broadcast:text" },
    { text: config.broadcastImageFileId ? "🖼 Image ✅" : "🖼 Add Image", callback_data: "cfg:broadcast:image" },
  ]);
  rows.push([
    { text: config.broadcastButtons ? "🔗 Buttons ✅" : "🔗 Add Buttons", callback_data: "cfg:broadcast:buttons" },
    { text: "🗑 Clear All", callback_data: "cfg:broadcast:clear" },
  ]);
  if (config.broadcastText) {
    rows.push([{ text: "📨 Send Now", callback_data: "cfg:broadcast:sendnow" }]);
  }
  rows.push([{ text: "⬅️ Back", callback_data: "action:settings" }]);
  return { inline_keyboard: rows };
}

function postRepeatKeyboard(): TelegramBot.InlineKeyboardMarkup {
  const presets = [
    { label: "30m", secs: 1800 },
    { label: "1hr", secs: 3600 },
    { label: "3hr", secs: 10800 },
    { label: "6hr", secs: 21600 },
    { label: "12hr", secs: 43200 },
    { label: "24hr", secs: 86400 },
  ];
  return {
    inline_keyboard: [
      presets.map(p => ({ text: p.label, callback_data: `post:repeat:${p.secs}` })),
      [{ text: "⛔ No Repeat", callback_data: "post:norepeat" }],
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
    ],
  };
}

// ── Standalone raid / vote menu senders ───────────────────────────────────────
async function sendRaidMenu(
  bot: TelegramBot, chatId: string, config: BotConfig, msgId?: number,
): Promise<void> {
  const keyboard = raidIntervalKeyboard(config.raidTweetUrl ?? "", config.raidInterval);
  let text: string;
  if (!config.raidTweetUrl) {
    text =
      `🎯 <b>Raid Tracker</b>\n\n` +
      `Track live Twitter engagement and post progress updates to your group.\n\n` +
      `No tweet configured yet. Tap <b>Set Tweet URL</b> to begin.`;
  } else {
    const tweetShort = config.raidTweetUrl.length > 50
      ? config.raidTweetUrl.slice(0, 47) + "…" : config.raidTweetUrl;
    text =
      `🎯 <b>Raid Tracker</b>\n\n` +
      `Tweet: <a href="${config.raidTweetUrl}">${tweetShort}</a>\n` +
      `Targets: ❤️ ${config.raidTargetLikes ?? 10} | 🔁 ${config.raidTargetRetweets ?? 5} | 💬 ${config.raidTargetReplies ?? 5}\n` +
      `Interval: ${formatInterval(config.raidInterval)}\n\n` +
      `Pick an update interval below (or Off to pause):`;
  }
  if (msgId) {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: msgId, parse_mode: "HTML",
      disable_web_page_preview: true, reply_markup: keyboard,
    }).catch(() => null);
  } else {
    await bot.sendMessage(chatId, text, {
      parse_mode: "HTML", disable_web_page_preview: true, reply_markup: keyboard,
    }).catch(() => null);
  }
}

async function sendVoteMenu(
  bot: TelegramBot, chatId: string, config: BotConfig, msgId?: number,
): Promise<void> {
  const cur = config.voteInterval ?? 0;
  const pos = config.votePosition ?? 1;
  const needed = config.voteNeeded ?? 50;
  const count = config.voteCount ?? 1000;
  const incr = config.voteIncrement ?? 10;
  const btnCount = (() => {
    try { return config.voteButtons ? (JSON.parse(config.voteButtons) as unknown[]).length : 0; } catch { return 0; }
  })();
  const text =
    `🗳 <b>Vote Alert</b>\n\n` +
    `Current Votes: <b>${count.toLocaleString()}</b> (+${incr} per post)\n` +
    `Position: <b>#${pos}</b> | Needed: <b>${needed}</b>\n` +
    `Image: ${config.voteImageFileId ? "✅" : "❌"}  Buttons: ${btnCount}\n` +
    `Interval: <b>${formatInterval(cur)}</b>\n\n` +
    `Pick an interval (or Off to pause), then configure the rest below:`;
  if (msgId) {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: msgId, parse_mode: "HTML",
      reply_markup: voteMenuKeyboard(config),
    }).catch(() => null);
  } else {
    await bot.sendMessage(chatId, text, {
      parse_mode: "HTML", reply_markup: voteMenuKeyboard(config),
    }).catch(() => null);
  }
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

// ── Bot factory — can be called for main bot or any co-bot ───────────────────
export function createCommandBot(token: string): TelegramBot {
  // Init without polling first so we can clear any stale webhook
  const bot = new TelegramBot(token, { polling: false });

  // Clear any stale webhook, then start polling
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
    { command: "setup", description: "Open buy-alert settings panel" },
    { command: "start", description: "Start buy alert monitoring" },
    { command: "stop", description: "Stop monitoring" },
    { command: "status", description: "Check current status" },
    { command: "raid", description: "Open Raid Tracker setup" },
    { command: "vote", description: "Open Vote Alert setup" },
    { command: "filter", description: "Admin: create/manage custom commands" },
    { command: "post", description: "Post a message with buttons to the group" },
  ]).catch(() => null);

  bot.on("polling_error", (err) => {
    logger.error({ msg: String(err) }, "Telegram polling error");
  });

  // ── Auto-mute: "fake", "scam", "not real" ─────────────────────────────────
  bot.on("message", async (msg) => {
    if (!msg.from || !msg.text) return;
    if (msg.chat.type === "private") return;

    const text = msg.text.toLowerCase();
    const BANNED = ["fake", "scam", "not real"];
    const triggered = BANNED.some((kw) => text.includes(kw));
    if (!triggered) return;

    const chatId = String(msg.chat.id);
    const userId = msg.from.id;

    // Never mute admins
    const admin = await isAdmin(bot, chatId, userId);
    if (admin) return;

    try {
      // Mute for 24 hours
      const until = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
      await bot.restrictChatMember(chatId, userId, {
        permissions: {
          can_send_messages: false,
          can_send_audios: false,
          can_send_documents: false,
          can_send_photos: false,
          can_send_videos: false,
          can_send_video_notes: false,
          can_send_voice_notes: false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
          can_change_info: false,
          can_invite_users: false,
          can_pin_messages: false,
        },
        until_date: until,
      });

      // Delete the offending message
      await bot.deleteMessage(chatId, msg.message_id).catch(() => null);

      const name = msg.from.first_name ?? "User";
      await bot.sendMessage(
        chatId,
        `🔇 <b>${name}</b> has been muted for 24 hours.\n\n⚠️ Spreading FUD (fake, scam, not real) is not allowed in this group.`,
        { parse_mode: "HTML" },
      );

      logger.info({ chatId, userId, text: msg.text }, "Auto-muted user for FUD");
    } catch (err) {
      logger.warn({ err, chatId, userId }, "Failed to mute user (bot may lack admin rights)");
    }
  });


  // ── /filter — admin custom command builder ────────────────────────────────
  // Usage: /filter <name> <message or link>
  bot.onText(/^\/filter(?:@\w+)?(?:\s+(.+))?$/is, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const userId = msg.from?.id;
    if (!userId || !await isAdmin(bot, chatId, userId)) {
      await bot.sendMessage(chatId, `🔒 Only admins can manage custom commands.`);
      return;
    }

    const arg = (match?.[1] ?? "").trim();
    const config = await getOrCreate(chatId);

    // /filter list
    if (arg.toLowerCase() === "list") {
      const cmds = await db.select().from(customCommandsTable)
        .where(eq(customCommandsTable.botConfigId, config.id))
        .orderBy(customCommandsTable.commandName);
      if (cmds.length === 0) {
        await bot.sendMessage(chatId,
          `📋 No custom commands yet.\n\nCreate one:\n<code>/filter website https://yoursite.com</code>`,
          { parse_mode: "HTML" });
        return;
      }
      const lines = cmds.map(c => {
        const btns = c.buttonsJson
          ? (JSON.parse(c.buttonsJson) as { text: string }[]).map(b => b.text).join(", ")
          : "no buttons";
        return `• <code>/${c.commandName}</code> — ${btns}`;
      });
      await bot.sendMessage(chatId,
        `📋 <b>Custom Commands (${cmds.length})</b>\n\n${lines.join("\n")}\n\nUsers type <code>/name</code> or just <code>name</code>`,
        { parse_mode: "HTML" });
      return;
    }

    // /filter delete <name>
    const deleteMatch = arg.match(/^delete\s+(\S+)$/i);
    if (deleteMatch) {
      const name = deleteMatch[1]!.toLowerCase();
      await db.delete(customCommandsTable)
        .where(and(eq(customCommandsTable.botConfigId, config.id), eq(customCommandsTable.commandName, name)));
      await bot.sendMessage(chatId, `🗑 Command <code>/${name}</code> deleted.`, { parse_mode: "HTML" });
      return;
    }

    // /filter <name> <message> — one-liner, saves immediately
    const spaceIdx = arg.search(/\s/);
    if (spaceIdx === -1 || !arg.slice(spaceIdx + 1).trim()) {
      // No message provided — show usage
      await bot.sendMessage(chatId,
        `🛠 <b>Custom Commands</b>\n\n` +
        `<b>Create:</b>\n<code>/filter &lt;name&gt; &lt;message or link&gt;</code>\n\n` +
        `<b>Examples:</b>\n` +
        `<code>/filter website https://horny.xyz</code>\n` +
        `<code>/filter ca Contract: 69HZn...</code>\n` +
        `<code>/filter buy Get it on Jupiter 🚀</code>\n\n` +
        `<b>List all:</b> <code>/filter list</code>\n` +
        `<b>Delete:</b> <code>/filter delete &lt;name&gt;</code>\n\n` +
        `Users type <code>/name</code> or just <code>name</code> to trigger it.`,
        { parse_mode: "HTML" });
      return;
    }

    const commandName = arg.slice(0, spaceIdx).toLowerCase().replace(/[^a-z0-9_]/g, "");
    const messageText = arg.slice(spaceIdx + 1).trim();

    if (!commandName) {
      await bot.sendMessage(chatId, `❌ Command name must be letters/numbers only.`);
      return;
    }

    // Upsert
    await db.delete(customCommandsTable)
      .where(and(eq(customCommandsTable.botConfigId, config.id), eq(customCommandsTable.commandName, commandName)));
    await db.insert(customCommandsTable).values({ botConfigId: config.id, commandName, messageText, buttonsJson: null });

    await bot.sendMessage(chatId,
      `✅ <b>/<code>${commandName}</code></b> saved!\n\nUsers can now type <code>/${commandName}</code> or <code>${commandName}</code>\n\nWant to add buttons under the message?`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "➕ Add Buttons", callback_data: `filter_add_btn:${commandName}` },
            { text: "✅ Done", callback_data: `filter_done:${commandName}` },
          ]],
        },
      });
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

  // ── Join / invite / leave — auto-delete service messages ─────────────────
  bot.on("new_chat_members", async (msg) => {
    try {
      const chatId = String(msg.chat.id);
      // Always silently delete the join/invite service message
      await bot.deleteMessage(chatId, msg.message_id).catch(() => null);

      // If the bot itself was just added → send setup prompt
      const me = await bot.getMe();
      if ((msg.new_chat_members ?? []).some((m) => m.id === me.id)) {
        await getOrCreate(chatId, msg.chat.title);
        await bot.sendMessage(chatId,
          `🛠 <b>Click button below to add your token for buy bot</b>`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "➡️ Add Token", callback_data: "action:add_token" }]] },
          },
        );
      }
    } catch (err) { logger.error({ err }, "new_chat_members error"); }
  });

  bot.on("left_chat_member", async (msg) => {
    try {
      await bot.deleteMessage(String(msg.chat.id), msg.message_id).catch(() => null);
    } catch { /* ignore */ }
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

  // ── /raid ─────────────────────────────────────────────────────────────────
  bot.onText(/^\/raid(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) return;
    const config = await getOrCreate(chatId, msg.chat.title);
    await sendRaidMenu(bot, chatId, config);
  });

  // ── /vote ─────────────────────────────────────────────────────────────────
  bot.onText(/^\/vote(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) return;
    const config = await getOrCreate(chatId, msg.chat.title);
    await sendVoteMenu(bot, chatId, config);
  });

  // ── /post ─────────────────────────────────────────────────────────────────
  bot.onText(/^\/post(@\S+)?$/, async (msg) => {
    if (!msg.from) return;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== "private" && !(await isAdmin(bot, chatId, msg.from.id))) return;
    pendingState.set(chatId, { step: "await_post_text" });
    await bot.sendMessage(chatId,
      `📨 <b>Post a Message</b>\n\nSend the message text you want to post to the group.\n\n` +
      `You can use HTML formatting:\n` +
      `• <code>&lt;b&gt;bold&lt;/b&gt;</code>\n` +
      `• <code>&lt;i&gt;italic&lt;/i&gt;</code>\n` +
      `• <code>&lt;a href="url"&gt;link&lt;/a&gt;</code>\n\n` +
      `Send <code>cancel</code> to abort.`,
      { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } });
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

    // filter_add_btn — admin wants to add buttons to a custom command
    if (data.startsWith("filter_add_btn:")) {
      const commandName = data.slice("filter_add_btn:".length);
      const [cmd] = await db.select().from(customCommandsTable)
        .where(and(eq(customCommandsTable.botConfigId, config.id), eq(customCommandsTable.commandName, commandName)))
        .limit(1);
      if (!cmd) {
        await bot.sendMessage(chatId, `❌ Command not found.`);
        return;
      }
      pendingState.set(chatId, { step: "await_filter_buttons", commandName, messageText: cmd.messageText });
      await bot.sendMessage(chatId,
        `➕ Adding buttons to <code>/${commandName}</code>\n\nSend one button per line:\n<code>Button Label | https://url</code>\n\nExample:\n<code>🌐 Website | https://horny.xyz</code>\n<code>🛒 Buy | https://jup.ag</code>\n<code>📊 Chart | https://dexscreener.com/...</code>\n\nAdd as many buttons as you want, shown 2 per row.`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } });
      return;
    }

    // filter_done — admin dismissed the add-buttons prompt
    if (data.startsWith("filter_done:")) {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => null);
      return;
    }

    // post:norepeat — admin dismissed the repeat timer picker after /post
    if (data === "post:norepeat") {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => null);
      await bot.answerCallbackQuery(query.id, { text: "No repeat set." });
      return;
    }

    // post:repeat:<secs> — admin picked a repeat interval after /post
    if (data.startsWith("post:repeat:")) {
      const secs = parseInt(data.split(":")[2]!, 10);
      await db.update(botConfigTable).set({ broadcastInterval: secs > 0 ? secs : null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      botRegistry.restartBroadcastTimer(config.id, secs > 0 ? secs : null);
      const label = secs === 1800 ? "30 minutes" : secs === 3600 ? "1 hour" : secs === 10800 ? "3 hours" : secs === 21600 ? "6 hours" : secs === 43200 ? "12 hours" : secs === 86400 ? "24 hours" : `${secs}s`;
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => null);
      await bot.answerCallbackQuery(query.id, { text: `✅ Repeat set to every ${label}` });
      return;
    }

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
        `<b>💵 Minimum Buy Amount</b>\n\nOnly buys at or above this amount will post an alert. Choose:`,
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

    // Buy alert custom buttons
    if (data === "cfg:buy:buttons") {
      pendingState.set(chatId, { step: "await_buy_buttons" });
      await bot.sendMessage(chatId,
        `🔗 <b>Buy Alert Custom Buttons</b>\n\nAdd extra inline buttons that appear below every buy alert.\n\nSend one button per line:\n<code>Button Text | https://link.com</code>\n\nExample:\n<code>🗳 Vote Now | https://coinvote.cc/token/HORNY\n🔥 Trending | https://dexscreener.com\n📢 Telegram | https://t.me/yourchat</code>\n\nAdd as many buttons as you want, shown 2 per row.\nSend <code>clear</code> to remove all buttons.`,
        { parse_mode: "HTML" },
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
      await sendRaidMenu(bot, chatId, config, msgId);
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
      await sendRaidMenu(bot, chatId, updated, msgId);
      await bot.answerCallbackQuery(query.id, { text: "🗑 Raid cleared" });
      return;
    }

    if (data.startsWith("set:raid:interval:")) {
      const secs = parseInt(data.split(":")[3] ?? "0");
      const interval = secs > 0 ? secs : null;
      await db.update(botConfigTable).set({ raidInterval: interval, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      botRegistry.restartRaidTimer(config.id, interval);
      const updated = await getOrCreate(chatId);
      await sendRaidMenu(bot, chatId, updated, msgId);
      const label = secs === 0 ? "disabled" : formatInterval(secs);
      await bot.answerCallbackQuery(query.id, { text: `🎯 Raid: ${label}` });
      return;
    }

    // ── Vote alert ───────────────────────────────────────────────────────────────
    if (data === "cfg:vote") {
      await sendVoteMenu(bot, chatId, config, msgId);
      return;
    }

    if (data.startsWith("set:vote:interval:")) {
      const secs = parseInt(data.split(":")[3] ?? "0");
      const interval = secs > 0 ? secs : null;
      await db.update(botConfigTable).set({ voteInterval: interval, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      botRegistry.restartVoteTimer(config.id, interval);
      const updated = await getOrCreate(chatId);
      await sendVoteMenu(bot, chatId, updated, msgId);
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
        `🔗 <b>Custom Buttons</b>\n\nSend one button per line in this format:\n<code>Button Text | https://link.com</code>\n\nExample:\n<code>🗳 Vote for TOKEN | https://coinvote.cc/token/TOKEN\n🎰 Create Raffle | https://t.me/rafflebot\n⚡ Boost Votes | https://example.com\n🔥 Buy Trending | https://dexscreener.com</code>\n\nAdd as many buttons as you want, shown 2 per row. Send <code>clear</code> to remove all buttons.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // ── Broadcast setup ──────────────────────────────────────────────────────
    if (data === "cfg:broadcast" || data.startsWith("set:broadcast:interval:") || data.startsWith("cfg:broadcast:")) {
      // Timer interval presets
      if (data.startsWith("set:broadcast:interval:")) {
        const secs = parseInt(data.split(":")[3]!, 10);
        await db.update(botConfigTable).set({ broadcastInterval: secs > 0 ? secs : null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
        const updated = await getOrCreate(chatId);
        botRegistry.restartBroadcastTimer(config.id, secs > 0 ? secs : null);
        await bot.editMessageReplyMarkup(broadcastKeyboard(updated), { chat_id: chatId, message_id: msgId }).catch(() => null);
        return;
      }

      // Open main broadcast menu
      if (data === "cfg:broadcast") {
        const lines: string[] = [`📢 <b>Broadcast Setup</b>\n`];
        if (config.broadcastText) lines.push(`📝 Message: <i>${config.broadcastText.slice(0, 80)}${config.broadcastText.length > 80 ? "…" : ""}</i>`);
        else lines.push(`📝 Message: <i>not set</i>`);
        lines.push(`🖼 Image: ${config.broadcastImageFileId ? "✅ set" : "not set"}`);
        lines.push(`🔗 Buttons: ${config.broadcastButtons ? `✅ ${(JSON.parse(config.broadcastButtons) as {text:string}[]).length} button(s)` : "none"}`);
        lines.push(`⏱ Timer: <b>${formatInterval(config.broadcastInterval)}</b>`);
        await bot.editMessageText(lines.join("\n"), { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: broadcastKeyboard(config) }).catch(() => null);
        return;
      }

      // Set message text
      if (data === "cfg:broadcast:text") {
        pendingState.set(chatId, { step: "await_broadcast_text" });
        await bot.sendMessage(chatId,
          `✏️ <b>Broadcast Message</b>\n\nSend the message text you want posted on repeat.\nSupports bold, links, emojis — anything Telegram HTML supports.`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } });
        return;
      }

      // Set image
      if (data === "cfg:broadcast:image") {
        pendingState.set(chatId, { step: "await_broadcast_image" });
        await bot.sendMessage(chatId,
          `🖼 <b>Broadcast Image</b>\n\nSend a photo to use as the banner for your broadcast.\n\nOr send <code>clear</code> to remove the current image.`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } });
        return;
      }

      // Set buttons
      if (data === "cfg:broadcast:buttons") {
        pendingState.set(chatId, { step: "await_broadcast_buttons" });
        await bot.sendMessage(chatId,
          `🔗 <b>Broadcast Buttons</b>\n\nSend one button per line:\n<code>Button Label | https://url</code>\n\nExample:\n<code>🌐 Website | https://horny.xyz</code>\n<code>🛒 Buy Now | https://jup.ag</code>\n<code>📊 Chart | https://dexscreener.com/...</code>\n\nAdd as many buttons as you want, 2 per row. Send <code>clear</code> to remove all.`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } });
        return;
      }

      // Clear all broadcast config
      if (data === "cfg:broadcast:clear") {
        await db.update(botConfigTable).set({ broadcastText: null, broadcastImageFileId: null, broadcastButtons: null, broadcastInterval: null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
        botRegistry.restartBroadcastTimer(config.id, null);
        const updated = await getOrCreate(chatId);
        await bot.editMessageText(`📢 <b>Broadcast cleared.</b>`, { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: broadcastKeyboard(updated) }).catch(() => null);
        return;
      }

      // Send broadcast immediately
      if (data === "cfg:broadcast:sendnow") {
        if (!config.broadcastText) {
          await bot.answerCallbackQuery(query.id, { text: "❌ No message set yet.", show_alert: true });
          return;
        }
        if (!config.chatId) {
          await bot.answerCallbackQuery(query.id, { text: "❌ No group linked.", show_alert: true });
          return;
        }
        try {
          let keyboard: TelegramBot.InlineKeyboardMarkup | undefined;
          if (config.broadcastButtons) {
            const btns = JSON.parse(config.broadcastButtons) as { text: string; url: string }[];
            if (btns.length) keyboard = { inline_keyboard: buildButtonRows(btns) };
          }
          if (config.broadcastImageFileId) {
            await bot.sendPhoto(config.chatId, config.broadcastImageFileId, {
              caption: config.broadcastText,
              parse_mode: "HTML",
              ...(keyboard ? { reply_markup: keyboard } : {}),
            });
          } else {
            await bot.sendMessage(config.chatId, config.broadcastText, {
              parse_mode: "HTML",
              disable_web_page_preview: false,
              ...(keyboard ? { reply_markup: keyboard } : {}),
            });
          }
          await bot.answerCallbackQuery(query.id, { text: "✅ Sent to group!" });
        } catch (err) {
          logger.error({ err }, "Broadcast send now failed");
          await bot.answerCallbackQuery(query.id, { text: "❌ Failed to send. Check bot permissions.", show_alert: true });
        }
        return;
      }
    }

    // Utility bot token (for raid + vote alerts)
    if (data === "cfg:utility") {
      const current = config.utilityBotToken;
      pendingState.set(chatId, { step: "await_utility_token" });
      await bot.sendMessage(chatId,
        `🤖 <b>Utility Bot Setup</b>\n\n` +
        `This bot handles <b>Raid</b> and <b>Vote</b> alerts on a separate token, so buy alert floods never block them.\n\n` +
        (current ? `Current: <code>${current.slice(0, 10)}…</code> ✅\n\n` : ``) +
        `<b>Steps:</b>\n` +
        `1. Open @BotFather → /newbot\n` +
        `2. Name it anything (e.g. HORNY Alerts)\n` +
        `3. Add it to your group as admin\n` +
        `4. Paste the token here\n\n` +
        `Or send <code>clear</code> to remove and use your main bot for everything.`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } });
      return;
    }

    // Co-bot token (shares all commands in the group)
    if (data === "cfg:cobot") {
      const current = config.coBotToken;
      pendingState.set(chatId, { step: "await_co_bot_token" });
      await bot.sendMessage(chatId,
        `🤝 <b>Co-Bot Setup</b>\n\n` +
        `A co-bot is a <b>second bot account</b> that mirrors everything — buy alerts, broadcast, vote alerts, raid alerts, repeat alerts, and all commands (<code>/setup</code>, <code>/filter</code>, etc.). Every message your main bot sends, the co-bot sends too.\n\n` +
        `Useful for: backup if your main bot gets banned, or running two bots simultaneously for more visibility.\n\n` +
        (current ? `Current: <code>${current.slice(0, 10)}…</code> ✅\n\n` : ``) +
        `<b>Steps:</b>\n` +
        `1. Open @BotFather → /newbot\n` +
        `2. Name it anything (e.g. HORNY Alerts 2)\n` +
        `3. Add it to your group as admin\n` +
        `4. Paste the token here\n\n` +
        `Both bots will post simultaneously. Send <code>clear</code> to remove.`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } });
      return;
    }

    // Tier thresholds — medium buy and whale thresholds
    if (data === "cfg:tiers") {
      const t2 = config.tier2Min ?? 500;
      const t3 = config.tier3Min ?? 1000;
      pendingState.set(chatId, { step: "await_tier2_min" });
      await bot.sendMessage(chatId,
        `🐋 <b>Buy Tier Thresholds</b>\n\n` +
        `Controls when buys get the 🐋 <b>Whale</b> or medium label.\n\n` +
        `Current settings:\n` +
        `• Medium buy: <b>$${t2}+</b>\n` +
        `• Whale buy: <b>$${t3}+</b>\n\n` +
        `<b>Step 1/2</b> — Reply with the <b>medium buy threshold</b> in USD.\nExample: <code>500</code>\n\n` +
        `(Buys below this amount are labeled "small buy")`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } });
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
      const raw = msg.text.trim();
      // Accept both "Label | URL" and plain URL
      let buyLabel = "🛒 Buy";
      let buyHref = raw;
      if (raw.includes("|")) {
        const sepIdx = raw.indexOf("|");
        const labelPart = raw.slice(0, sepIdx).trim();
        const urlPart = raw.slice(sepIdx + 1).trim();
        if (urlPart.startsWith("http")) {
          buyLabel = labelPart || "🛒 Buy";
          buyHref = urlPart;
        }
      }
      if (!buyHref.startsWith("http")) {
        await bot.sendMessage(chatId,
          "❌ Couldn't find a valid URL. Make sure it starts with http.

Format: <code>Button Label | https://your-link.com</code>",
          { parse_mode: "HTML" });
        return;
      }
      // Store as "Label|||URL" so the label is preserved on alerts
      await db.update(botConfigTable)
        .set({ buyUrl: `${buyLabel}|||${buyHref}`, updatedAt: new Date() })
        .where(eq(botConfigTable.id, config.id));
      await bot.sendMessage(chatId, `✅ Buy button saved!

Button label: <b>${buyLabel}</b>
URL: <code>${buyHref}</code>`, { parse_mode: "HTML" });
      const updated = await getOrCreate(chatId);
      const { running } = botRegistry.getStatus(updated.id);
      await sendSettings(bot, chatId, updated, running);
      return;
    }


    // ── Buy alert custom buttons ───────────────────────────────────────────
    if (state.step === "await_buy_buttons") {
      const rawText = (msg.text ?? "").trim();
      if (rawText.toLowerCase() === "clear") {
        pendingState.delete(chatId);
        await db.update(botConfigTable).set({ buyButtons: null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
        const updated = await getOrCreate(chatId);
        await bot.sendMessage(chatId, `✅ Buy alert buttons cleared.`, { parse_mode: "HTML" });
        const { running } = botRegistry.getStatus(updated.id);
        await sendSettings(bot, chatId, updated, running);
        return;
      }
      const lines = rawText.split("\n").filter(Boolean);
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
      await db.update(botConfigTable).set({ buyButtons: JSON.stringify(buttons), updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      await bot.sendMessage(chatId, `✅ ${buttons.length} button(s) saved. They'll appear on every buy alert.`, { parse_mode: "HTML" });
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
      const lines = rawText.split("\n").filter(Boolean);
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

    // ── Broadcast: message text ───────────────────────────────────────────────
    if (state.step === "await_broadcast_text") {
      const text = (msg.text ?? "").trim();
      if (!text) return;
      pendingState.delete(chatId);
      await db.update(botConfigTable).set({ broadcastText: text, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      await bot.sendMessage(chatId,
        `✅ Broadcast message saved!\n\nNow set a timer below to start posting it:`,
        { parse_mode: "HTML", reply_markup: broadcastKeyboard(updated) });
      return;
    }

    // ── Broadcast: image ──────────────────────────────────────────────────────
    if (state.step === "await_broadcast_image") {
      const rawText = (msg.text ?? "").trim().toLowerCase();
      if (rawText === "clear") {
        pendingState.delete(chatId);
        await db.update(botConfigTable).set({ broadcastImageFileId: null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
        const updated = await getOrCreate(chatId);
        await bot.sendMessage(chatId, `🗑 Broadcast image removed.`, { parse_mode: "HTML", reply_markup: broadcastKeyboard(updated) });
        return;
      }
      const photo = msg.photo;
      if (!photo || photo.length === 0) {
        await bot.sendMessage(chatId, `❌ Please send a photo, or type <code>clear</code> to remove the current one.`, { parse_mode: "HTML" });
        return;
      }
      const fileId = photo[photo.length - 1]!.file_id;
      pendingState.delete(chatId);
      await db.update(botConfigTable).set({ broadcastImageFileId: fileId, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      await bot.sendMessage(chatId, `✅ Broadcast image saved!`, { parse_mode: "HTML", reply_markup: broadcastKeyboard(updated) });
      return;
    }

    // ── Broadcast: buttons ────────────────────────────────────────────────────
    if (state.step === "await_broadcast_buttons") {
      const rawText = (msg.text ?? "").trim();
      pendingState.delete(chatId);
      if (rawText.toLowerCase() === "clear") {
        await db.update(botConfigTable).set({ broadcastButtons: null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
        const updated = await getOrCreate(chatId);
        await bot.sendMessage(chatId, `🗑 Broadcast buttons cleared.`, { parse_mode: "HTML", reply_markup: broadcastKeyboard(updated) });
        return;
      }
      const lines = rawText.split("\n").filter(Boolean);
      const buttons: { text: string; url: string }[] = [];
      for (const line of lines) {
        const parts = line.split("|").map(s => s.trim());
        const btnText = parts[0]; const btnUrl = parts[1];
        if (!btnText || !btnUrl || !btnUrl.startsWith("http")) {
          await bot.sendMessage(chatId, `❌ Invalid line: <code>${line}</code>\nFormat: <code>Label | https://url</code>`, { parse_mode: "HTML" });
          pendingState.set(chatId, { step: "await_broadcast_buttons" });
          return;
        }
        buttons.push({ text: btnText, url: btnUrl });
      }
      await db.update(botConfigTable).set({ broadcastButtons: JSON.stringify(buttons), updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      const updated = await getOrCreate(chatId);
      await bot.sendMessage(chatId, `✅ ${buttons.length} button(s) saved!`, { parse_mode: "HTML", reply_markup: broadcastKeyboard(updated) });
      return;
    }

    // ── Utility bot token ──────────────────────────────────────────────────────
    if (state.step === "await_utility_token") {
      const raw = (msg.text ?? "").trim();
      pendingState.delete(chatId);
      if (raw.toLowerCase() === "clear") {
        await db.update(botConfigTable).set({ utilityBotToken: null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
        await bot.sendMessage(chatId, `✅ Utility bot removed. Raid & vote alerts will use the main bot.`);
      } else if (raw.match(/^\d+:[A-Za-z0-9_-]{35,}$/)) {
        await db.update(botConfigTable).set({ utilityBotToken: raw, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
        await bot.sendMessage(chatId,
          `✅ <b>Utility bot set!</b>\n\nRaid and vote alerts will now send through the separate bot.\n\nMake sure it's added to your group as an admin.`,
          { parse_mode: "HTML" });
      } else {
        await bot.sendMessage(chatId,
          `❌ That doesn't look like a valid bot token.\n\nFormat: <code>123456789:ABCdef...</code>\n\nGet it from @BotFather.`,
          { parse_mode: "HTML" });
      }
      return;
    }

    // ── Co-bot token ──────────────────────────────────────────────────────────
    if (state.step === "await_co_bot_token") {
      const raw = (msg.text ?? "").trim();
      pendingState.delete(chatId);
      if (raw.toLowerCase() === "clear") {
        await db.update(botConfigTable).set({ coBotToken: null, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
        botRegistry.restartCoBot(config.id, null);
        await bot.sendMessage(chatId, `✅ Co-bot removed.`);
      } else if (raw.match(/^\d+:[A-Za-z0-9_-]{35,}$/)) {
        await db.update(botConfigTable).set({ coBotToken: raw, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
        botRegistry.restartCoBot(config.id, raw);
        await bot.sendMessage(chatId,
          `✅ <b>Co-bot connected!</b>\n\nIt now shares all commands in this group. Make sure it's added as an admin.`,
          { parse_mode: "HTML" });
      } else {
        await bot.sendMessage(chatId,
          `❌ That doesn't look like a valid bot token.\n\nFormat: <code>123456789:ABCdef...</code>\n\nGet it from @BotFather.`,
          { parse_mode: "HTML" });
      }
      return;
    }

    // ── Tier thresholds step 1: medium buy amount ─────────────────────────────
    if (state.step === "await_tier2_min") {
      const raw = (msg.text ?? "").trim();
      const n = parseFloat(raw);
      if (isNaN(n) || n <= 0) {
        await bot.sendMessage(chatId, `❌ Invalid amount. Enter a number like <code>500</code>`, { parse_mode: "HTML" });
        pendingState.set(chatId, { step: "await_tier2_min" });
        return;
      }
      pendingState.delete(chatId);
      pendingState.set(chatId, { step: "await_tier3_min" });
      await db.update(botConfigTable).set({ tier2Min: n, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      await bot.sendMessage(chatId,
        `✅ Medium buy set to <b>$${n}+</b>\n\n<b>Step 2/2</b> — Reply with the <b>🐋 whale buy threshold</b> in USD.\nExample: <code>1000</code>\n\n(Buys at or above this will show the 🐋 whale label)`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } });
      return;
    }

    // ── Tier thresholds step 2: whale amount ──────────────────────────────────
    if (state.step === "await_tier3_min") {
      const raw = (msg.text ?? "").trim();
      const n = parseFloat(raw);
      if (isNaN(n) || n <= 0) {
        await bot.sendMessage(chatId, `❌ Invalid amount. Enter a number like <code>1000</code>`, { parse_mode: "HTML" });
        pendingState.set(chatId, { step: "await_tier3_min" });
        return;
      }
      pendingState.delete(chatId);
      const freshCfg = await getOrCreate(chatId);
      await db.update(botConfigTable).set({ tier3Min: n, updatedAt: new Date() }).where(eq(botConfigTable.id, config.id));
      await bot.sendMessage(chatId,
        `✅ <b>Buy tiers updated!</b>\n\n• Small buy: <b>below $${freshCfg.tier2Min ?? 500}</b>\n• Medium buy: <b>$${freshCfg.tier2Min ?? 500}+</b>\n• 🐋 Whale: <b>$${n}+</b>`,
        { parse_mode: "HTML" });
      return;
    }

    // ── /post step 1: capture message text ────────────────────────────────────
    if (state.step === "await_post_text") {
      const text = (msg.text ?? "").trim();
      if (text.toLowerCase() === "cancel") {
        pendingState.delete(chatId);
        await bot.sendMessage(chatId, `❌ Post cancelled.`);
        return;
      }
      if (!text) return;
      pendingState.delete(chatId);
      pendingState.set(chatId, { step: "await_post_image", text });
      await bot.sendMessage(chatId,
        `✅ Message saved!\n\n🖼 <b>Add an Image?</b>\n\nSend a photo to attach as a banner, or send <code>skip</code> to post without an image.`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } });
      return;
    }

    // ── /post step 2: optional image ──────────────────────────────────────────
    if (state.step === "await_post_image") {
      const rawText = (msg.text ?? "").trim().toLowerCase();
      const photo = msg.photo;
      let imageFileId: string | undefined;
      if (rawText === "skip") {
        // no image
      } else if (photo && photo.length > 0) {
        imageFileId = photo[photo.length - 1]!.file_id;
      } else {
        await bot.sendMessage(chatId,
          `📸 Send a photo to attach, or type <code>skip</code> to continue without one.`,
          { parse_mode: "HTML" });
        return;
      }
      pendingState.delete(chatId);
      pendingState.set(chatId, { step: "await_post_buttons", text: state.text, imageFileId });
      await bot.sendMessage(chatId,
        `${imageFileId ? "✅ Image saved!\n\n" : ""}🔗 <b>Add Buttons?</b>\n\nSend one button per line:\n<code>Button Label | https://url</code>\n\nExample:\n<code>🌐 Website | https://example.com</code>\n<code>🛒 Buy Now | https://jup.ag/...</code>\n\nAdd as many buttons as you want, displayed 2 per row.\n\nOr send <code>skip</code> to post without buttons.`,
        { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } });
      return;
    }

    // ── /post step 3: optional buttons → send to group ────────────────────────
    if (state.step === "await_post_buttons") {
      const rawText = (msg.text ?? "").trim();
      pendingState.delete(chatId);
      let buttons: { text: string; url: string }[] = [];
      if (rawText.toLowerCase() !== "skip") {
        const lines = rawText.split("\n").filter(Boolean);
        for (const line of lines) {
          const parts = line.split("|").map((s) => s.trim());
          const btnText = parts[0];
          const btnUrl = parts[1];
          if (!btnText || !btnUrl || !btnUrl.startsWith("http")) {
            await bot.sendMessage(chatId,
              `❌ Invalid line: <code>${line}</code>\n\nFormat: <code>Button Label | https://url</code>\n\nSend all buttons again, or <code>skip</code> to post without buttons:`,
              { parse_mode: "HTML" });
            pendingState.set(chatId, { step: "await_post_buttons", text: state.text, imageFileId: state.imageFileId });
            return;
          }
          buttons.push({ text: btnText, url: btnUrl });
        }
      }
      const postKeyboard = buttons.length > 0
        ? { inline_keyboard: buildButtonRows(buttons) }
        : undefined;
      try {
        if (state.imageFileId) {
          await bot.sendPhoto(chatId, state.imageFileId, {
            caption: state.text,
            parse_mode: "HTML",
            ...(postKeyboard ? { reply_markup: postKeyboard } : {}),
          });
        } else {
          await bot.sendMessage(chatId, state.text, {
            parse_mode: "HTML",
            disable_web_page_preview: false,
            ...(postKeyboard ? { reply_markup: postKeyboard } : {}),
          });
        }
        // Save content to broadcast fields so repeat timer can use it
        const cfg = await getOrCreate(chatId);
        await db.update(botConfigTable).set({
          broadcastText: state.text,
          broadcastImageFileId: state.imageFileId ?? null,
          broadcastButtons: buttons.length > 0 ? JSON.stringify(buttons) : null,
          broadcastInterval: null,
          updatedAt: new Date(),
        }).where(eq(botConfigTable.id, cfg.id));
        await bot.sendMessage(chatId,
          `✅ <b>Posted!</b>${buttons.length > 0 ? ` ${buttons.length} button(s) included.` : ""}\n\n🔁 <b>Set a repeat timer?</b>\nChoose an interval and this post will automatically re-send:`,
          { parse_mode: "HTML", reply_markup: postRepeatKeyboard() });
      } catch (err) {
        logger.error({ err }, "/post send failed");
        await bot.sendMessage(chatId, `❌ Failed to post. Make sure the bot has permission to send messages in this group.`, { parse_mode: "HTML" });
      }
      return;
    }

    // ── /filter buttons: admin sends button lines after clicking "Add Buttons" ──
    if (state.step === "await_filter_buttons") {
      const rawText = (msg.text ?? "").trim();
      const { commandName, messageText } = state;

      const lines = rawText.split("\n").filter(Boolean);
      const buttons: { text: string; url: string }[] = [];
      for (const line of lines) {
        const parts = line.split("|").map((s) => s.trim());
        const btnText = parts[0];
        const btnUrl = parts[1];
        if (!btnText || !btnUrl || !btnUrl.startsWith("http")) {
          await bot.sendMessage(chatId,
            `❌ Invalid line: <code>${line}</code>\n\nFormat: <code>Button Label | https://url</code>\n\nOne button per line. Send again:`,
            { parse_mode: "HTML" });
          return;
        }
        buttons.push({ text: btnText, url: btnUrl });
      }

      pendingState.delete(chatId);
      const buttonsJson = JSON.stringify(buttons);
      const cfg = await getOrCreate(chatId);
      await db.update(customCommandsTable)
        .set({ buttonsJson })
        .where(and(eq(customCommandsTable.botConfigId, cfg.id), eq(customCommandsTable.commandName, commandName)));

      await bot.sendMessage(chatId,
        `✅ ${buttons.length} button(s) added to <code>/${commandName}</code>!\n\n` +
        `${buttons.map(b => `• ${b.text}`).join("\n")}`,
        { parse_mode: "HTML" });
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

  // ── Dynamic custom command trigger (any user) ─────────────────────────────
  // Fires when someone types "/ca", "ca", "/website", "website", etc.
  bot.on("message", async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text?.trim();
    if (!text) return;

    // Skip messages being handled by pending state flows
    if (pendingState.has(chatId)) return;

    // Extract name: "/website" → "website", "website" → "website"
    // Only single-word messages or slash-commands (no spaces)
    const rawName = text.startsWith("/") ? text.split("@")[0]!.slice(1) : text;
    if (rawName.includes(" ") || rawName.length === 0 || rawName.length > 30) return;
    const commandName = rawName.toLowerCase();

    // Skip built-in bot commands so they don't also fire here
    const builtIn = new Set(["start","stop","status","add","token","setup","filter"]);
    if (builtIn.has(commandName)) return;

    const config = await getOrCreate(chatId).catch(() => null);
    if (!config) return;

    const [cmd] = await db.select().from(customCommandsTable)
      .where(and(
        eq(customCommandsTable.botConfigId, config.id),
        eq(customCommandsTable.commandName, commandName),
      )).limit(1);

    if (!cmd) return;

    const buttons = cmd.buttonsJson
      ? (JSON.parse(cmd.buttonsJson) as { text: string; url: string }[])
      : [];

    await bot.sendMessage(chatId, cmd.messageText, {
      parse_mode: "HTML",
      disable_web_page_preview: false,
      ...(buttons.length > 0 ? { reply_markup: { inline_keyboard: buildButtonRows(buttons) } } : {}),
    }).catch(() => null);
  });

  logger.info("Command bot started");
  return bot;
}

/** Called at app startup — uses the global TELEGRAM_BOT_TOKEN env var */
export function startCommandBot(): void {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — command bot disabled");
    return;
  }
  createCommandBot(token);
}
