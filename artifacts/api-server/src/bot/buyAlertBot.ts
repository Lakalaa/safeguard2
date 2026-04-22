import TelegramBot from "node-telegram-bot-api";
import { Connection, PublicKey } from "@solana/web3.js";
import { db } from "@workspace/db";
import { botConfigTable, alertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

interface DexScreenerPair {
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  priceChange: { h24?: number };
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
}

async function getDexScreenerData(tokenAddress: string): Promise<DexScreenerPair | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { pairs?: DexScreenerPair[] };
    const pairs = data.pairs?.filter((p) => p.baseToken.address === tokenAddress);
    if (!pairs || pairs.length === 0) return null;
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    return pairs[0] ?? null;
  } catch {
    return null;
  }
}

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function getTier(amountUsd: number, tier1: number, tier2: number, tier3: number): number {
  if (amountUsd >= tier3) return 3;
  if (amountUsd >= tier2) return 2;
  if (amountUsd >= tier1) return 1;
  return 1;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function buildAlertMessage(params: {
  tokenName: string;
  tokenSymbol: string;
  tier: number;
  emojiPerTier: number;
  amountUsd: number;
  amountNative: number;
  tokensReceived: number;
  buyerAddress: string;
  txSignature: string;
  marketCap: number | null;
  priceChangePct: number | null;
  dextUrl?: string | null;
  screenerUrl?: string | null;
  buyUrl?: string | null;
  trendingUrl?: string | null;
}): string {
  const circles = "🟢".repeat(params.tier * params.emojiPerTier);
  const buyerShort = shortenAddress(params.buyerAddress);
  const txShort = `${params.txSignature.slice(0, 8)}...`;

  const buyerUrl = `https://solscan.io/account/${params.buyerAddress}`;
  const txUrl = `https://solscan.io/tx/${params.txSignature}`;

  const positionLine =
    params.priceChangePct !== null
      ? `\n🪙 Position ${params.priceChangePct >= 0 ? "+" : ""}${params.priceChangePct.toFixed(0)}%`
      : "";

  const mcapLine =
    params.marketCap !== null
      ? `\n💰 Market Cap ${formatNumber(params.marketCap)}`
      : "";

  const links: string[] = [];
  if (params.dextUrl) links.push(`<a href="${params.dextUrl}">DexT</a>`);
  if (params.screenerUrl) links.push(`<a href="${params.screenerUrl}">Screener</a>`);
  if (params.buyUrl) links.push(`<a href="${params.buyUrl}">Buy</a>`);
  if (params.trendingUrl) links.push(`<a href="${params.trendingUrl}">Trending</a>`);
  if (links.length === 0) {
    links.push(`<a href="${buyerUrl}">Buyer</a>`);
    links.push(`<a href="${txUrl}">TX</a>`);
  }

  return (
    `<b>${params.tokenName} Buy!</b>\n` +
    `${circles}\n\n` +
    `🔀 Spent <b>${formatNumber(params.amountUsd)}</b> (<b>${params.amountNative.toFixed(3)} SOL</b>)\n` +
    `🔀 Got <b>${params.tokensReceived.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${params.tokenSymbol}</b>\n` +
    `👤 <a href="${buyerUrl}">Buyer</a> / <a href="${txUrl}">TX</a>${positionLine}${mcapLine}\n\n` +
    links.join(" | ")
  );
}

class BuyAlertBot {
  private bot: TelegramBot | null = null;
  private connection: Connection | null = null;
  private running = false;
  private monitoringToken: string | null = null;
  private lastCheckAt: Date | null = null;
  private lastError: string | null = null;
  private seenSignatures = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  getStatus() {
    return {
      running: this.running,
      monitoringToken: this.monitoringToken,
      lastCheckAt: this.lastCheckAt,
      error: this.lastError,
    };
  }

  async start(): Promise<{ running: boolean; error?: string }> {
    if (this.running) return { running: true };

    const [config] = await db.select().from(botConfigTable).limit(1);

    if (!config?.telegramToken) {
      this.lastError = "Telegram bot token not set. Configure in Settings.";
      return { running: false, error: this.lastError };
    }
    if (!config.tokenAddress) {
      this.lastError = "Token contract address not set. Configure in Settings.";
      return { running: false, error: this.lastError };
    }
    if (!config.chatId) {
      this.lastError = "Telegram chat ID not set. Configure in Settings.";
      return { running: false, error: this.lastError };
    }

    try {
      this.bot = new TelegramBot(config.telegramToken, { polling: false });
      this.connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
      this.monitoringToken = config.tokenAddress;
      this.running = true;
      this.lastError = null;

      this.startPolling();
      logger.info({ token: config.tokenAddress }, "Buy alert bot started");
      return { running: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.running = false;
      return { running: false, error: msg };
    }
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.bot = null;
    this.connection = null;
    this.running = false;
    this.monitoringToken = null;
    this.seenSignatures.clear();
    logger.info("Buy alert bot stopped");
  }

  private startPolling() {
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        logger.error({ err }, "Poll error");
      });
    }, 15_000);

    this.poll().catch(() => {});
  }

  private async poll() {
    if (!this.running || !this.connection || !this.monitoringToken) return;

    this.lastCheckAt = new Date();

    const [config] = await db.select().from(botConfigTable).limit(1);
    if (!config) return;

    try {
      const mintPubkey = new PublicKey(this.monitoringToken);

      const signatures = await this.connection.getSignaturesForAddress(mintPubkey, {
        limit: 20,
      });

      const dexData = await getDexScreenerData(this.monitoringToken);
      const marketCap = dexData?.marketCap ?? dexData?.fdv ?? null;
      const priceChangePct = dexData?.priceChange?.h24 ?? null;
      const priceUsd = dexData?.priceUsd ? parseFloat(dexData.priceUsd) : 0;

      for (const sigInfo of signatures) {
        if (this.seenSignatures.has(sigInfo.signature)) continue;
        if (sigInfo.err) {
          this.seenSignatures.add(sigInfo.signature);
          continue;
        }

        this.seenSignatures.add(sigInfo.signature);

        try {
          const tx = await this.connection!.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          });

          if (!tx?.meta) continue;

          const postTokenBalances = tx.meta.postTokenBalances ?? [];
          const preTokenBalances = tx.meta.preTokenBalances ?? [];

          let buyerAddress: string | null = null;
          let tokensReceived = 0;
          let amountNative = 0;

          const preBalances = tx.meta.preBalances;
          const postBalances = tx.meta.postBalances;
          const accountKeys = tx.transaction.message.accountKeys;

          for (const post of postTokenBalances) {
            if (post.mint !== this.monitoringToken) continue;
            const pre = preTokenBalances.find(
              (p) => p.accountIndex === post.accountIndex,
            );
            const postAmt = Number(post.uiTokenAmount.uiAmount ?? 0);
            const preAmt = Number(pre?.uiTokenAmount?.uiAmount ?? 0);
            const diff = postAmt - preAmt;

            if (diff > 0) {
              tokensReceived = diff;

              // post.owner is the real wallet address that owns this token account
              // (not the token account / ATA address itself)
              buyerAddress = post.owner ?? null;

              if (buyerAddress) {
                // Find the SOL balance change for the buyer's actual wallet
                for (let i = 0; i < accountKeys.length; i++) {
                  const key = accountKeys[i];
                  if (!key) continue;
                  const keyStr = typeof key === "string" ? key : (key as { pubkey: { toString(): string } }).pubkey?.toString() ?? "";
                  if (keyStr === buyerAddress) {
                    const solDiff = ((preBalances[i] ?? 0) - (postBalances[i] ?? 0)) / 1e9;
                    if (solDiff > 0) amountNative = solDiff;
                    break;
                  }
                }
              }

              // Fallback: if buyer wallet not in account keys, use fee payer SOL diff
              if (amountNative === 0 && preBalances[0] !== undefined && postBalances[0] !== undefined) {
                const feeDiff = (preBalances[0] - postBalances[0]) / 1e9;
                if (feeDiff > 0) amountNative = feeDiff;
              }

              break;
            }
          }

          if (!buyerAddress || tokensReceived <= 0) continue;

          const solPriceUsd = await this.getSolPrice();
          const amountUsd = amountNative * solPriceUsd;

          if (amountUsd < (config.minBuyUsd ?? 1)) continue;

          const tier = getTier(amountUsd, config.tier1Min, config.tier2Min, config.tier3Min);

          const [savedAlert] = await db
            .insert(alertsTable)
            .values({
              txSignature: sigInfo.signature,
              buyerAddress,
              amountUsd,
              amountNative,
              tokensReceived,
              marketCap: marketCap ?? null,
              priceChangePct: priceChangePct ?? null,
              tier,
            })
            .returning();

          if (savedAlert && this.bot && config.chatId) {
            const message = buildAlertMessage({
              tokenName: config.tokenName ?? dexData?.baseToken.name ?? "Token",
              tokenSymbol: config.tokenSymbol ?? dexData?.baseToken.symbol ?? "TKN",
              tier,
              emojiPerTier: config.emojiPerTier,
              amountUsd,
              amountNative,
              tokensReceived,
              buyerAddress,
              txSignature: sigInfo.signature,
              marketCap: marketCap ?? null,
              priceChangePct: priceChangePct ?? null,
              dextUrl: config.dextUrl,
              screenerUrl: config.screenerUrl,
              buyUrl: config.buyUrl,
              trendingUrl: config.trendingUrl,
            });

            if (config.alertImageUrl) {
              await this.bot.sendPhoto(config.chatId, config.alertImageUrl, {
                caption: message,
                parse_mode: "HTML",
              });
            } else {
              await this.bot.sendMessage(config.chatId, message, {
                parse_mode: "HTML",
                disable_web_page_preview: true,
              });
            }
          }
        } catch (txErr) {
          logger.warn({ err: txErr, sig: sigInfo.signature }, "Failed to process transaction");
        }
      }

      if (this.seenSignatures.size > 2000) {
        const arr = [...this.seenSignatures];
        this.seenSignatures.clear();
        arr.slice(-500).forEach((s) => this.seenSignatures.add(s));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      logger.error({ err }, "Buy alert poll failed");
    }
  }

  private solPriceCache: { price: number; fetchedAt: number } = { price: 0, fetchedAt: 0 };

  private async getSolPrice(): Promise<number> {
    const now = Date.now();
    if (now - this.solPriceCache.fetchedAt < 60_000 && this.solPriceCache.price > 0) {
      return this.solPriceCache.price;
    }
    try {
      const res = await fetch(
        "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112",
      );
      if (!res.ok) return this.solPriceCache.price || 150;
      const data = (await res.json()) as { pairs?: { priceUsd?: string }[] };
      const p = parseFloat(data.pairs?.[0]?.priceUsd ?? "150");
      this.solPriceCache = { price: p, fetchedAt: now };
      return p;
    } catch {
      return this.solPriceCache.price || 150;
    }
  }

  async sendTestAlert(): Promise<{ success: boolean; message: string }> {
    const [config] = await db.select().from(botConfigTable).limit(1);

    if (!config?.telegramToken || !config?.chatId) {
      return { success: false, message: "Bot token or chat ID not configured." };
    }

    try {
      const testBot = new TelegramBot(config.telegramToken, { polling: false });
      const message = buildAlertMessage({
        tokenName: config.tokenName ?? "SOSANA",
        tokenSymbol: config.tokenSymbol ?? "SOSANA",
        tier: 2,
        emojiPerTier: config.emojiPerTier,
        amountUsd: 85.5,
        amountNative: 0.992,
        tokensReceived: 534,
        buyerAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        txSignature: "5KtMGnmhBhPQcnFNFZ6JwxfY1VkuViGWMQXhBhv8oEF3QSMbnXZF7zWvdA52hAz9Dc1F4kxJm6wP4wX7uKvdR2",
        marketCap: 13_397_935,
        priceChangePct: 92,
        dextUrl: config.dextUrl,
        screenerUrl: config.screenerUrl,
        buyUrl: config.buyUrl,
        trendingUrl: config.trendingUrl,
      });

      if (config.alertImageUrl) {
        await testBot.sendPhoto(config.chatId, config.alertImageUrl, {
          caption: message,
          parse_mode: "HTML",
        });
      } else {
        await testBot.sendMessage(config.chatId, message, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      }

      return { success: true, message: "Test alert sent successfully!" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: msg };
    }
  }
}

export const buyAlertBot = new BuyAlertBot();
