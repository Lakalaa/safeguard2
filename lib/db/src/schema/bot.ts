import {
  pgTable,
  serial,
  text,
  integer,
  real,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const botConfigTable = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().default("My Bot"),
  isActive: boolean("is_active").notNull().default(false),
  telegramToken: text("telegram_token"),
  chatId: text("chat_id"),
  tokenAddress: text("token_address"),
  tokenName: text("token_name"),
  tokenSymbol: text("token_symbol"),
  chain: text("chain").default("solana"),
  minBuyUsd: real("min_buy_usd").notNull().default(1),
  alertImageUrl: text("alert_image_url"),
  dextUrl: text("dext_url"),
  screenerUrl: text("screener_url"),
  buyUrl: text("buy_url"),
  trendingUrl: text("trending_url"),
  emojiPerTier: integer("emoji_per_tier").notNull().default(4),
  alertEmoji: text("alert_emoji").notNull().default("🟢"),
  alertMediaFileId: text("alert_media_file_id"),
  alertMediaType: text("alert_media_type"),
  alertStyle: text("alert_style").notNull().default("sosana"), // "sosana" | "trending"
  repeatInterval: integer("repeat_interval"), // seconds between periodic stat posts; null = off
  telegramUrl: text("telegram_url"),
  twitterUrl: text("twitter_url"),
  websiteUrl: text("website_url"),
  tier1Min: real("tier1_min").notNull().default(100),
  tier2Min: real("tier2_min").notNull().default(500),
  tier3Min: real("tier3_min").notNull().default(1000),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const alertsTable = pgTable("alerts", {
  id: serial("id").primaryKey(),
  botConfigId: integer("bot_config_id").references(() => botConfigTable.id),
  txSignature: text("tx_signature"),
  chain: text("chain").notNull().default("solana"),
  buyerAddress: text("buyer_address").notNull(),
  amountUsd: real("amount_usd").notNull(),
  amountNative: real("amount_native").notNull(),
  nativeCurrency: text("native_currency").notNull().default("SOL"),
  tokensReceived: real("tokens_received").notNull(),
  marketCap: real("market_cap"),
  priceChangePct: real("price_change_pct"),
  tier: integer("tier").notNull().default(1),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAlertSchema = createInsertSchema(alertsTable).omit({
  id: true,
  sentAt: true,
});
export type InsertAlert = z.infer<typeof insertAlertSchema>;
export type Alert = typeof alertsTable.$inferSelect;
export type BotConfig = typeof botConfigTable.$inferSelect;
