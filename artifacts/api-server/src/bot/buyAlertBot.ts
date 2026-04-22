import TelegramBot from "node-telegram-bot-api";
import { Connection, PublicKey, type Logs } from "@solana/web3.js";
import { db } from "@workspace/db";
import { botConfigTable, alertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

export interface DexScreenerPair {
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  priceChange: { h24?: number };
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  url?: string;
}

export async function getDexScreenerData(tokenAddress: string): Promise<DexScreenerPair | null> {
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
  private subscriptionId: number | null = null;

  // Cache SOL price for 60s
  private solPriceCache: { price: number; fetchedAt: number } = { price: 150, fetchedAt: 0 };

  // Cache DexScreener data for 30s
  private dexCache: { data: DexScreenerPair | null; fetchedAt: number } = { data: null, fetchedAt: 0 };

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
      this.lastError = "Token address not set. Configure in Settings.";
      return { running: false, error: this.lastError };
    }
    if (!config.chatId) {
      this.lastError = "Telegram chat ID not set. Configure in Settings.";
      return { running: false, error: this.lastError };
    }

    try {
      this.bot = new TelegramBot(config.telegramToken, { polling: false });
      // Use mainnet with WebSocket for live monitoring
      this.connection = new Connection("https://api.mainnet-beta.solana.com", {
        commitment: "confirmed",
        wsEndpoint: "wss://api.mainnet-beta.solana.com",
      });
      this.monitoringToken = config.tokenAddress;
      this.running = true;
      this.lastError = null;
      this.seenSignatures.clear();

      await this.subscribeToLogs();

      logger.info({ token: config.tokenAddress }, "Buy alert bot started (live WebSocket)");
      return { running: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.running = false;
      return { running: false, error: msg };
    }
  }

  async stop(): Promise<void> {
    if (this.subscriptionId !== null && this.connection) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
      } catch {}
      this.subscriptionId = null;
    }
    this.bot = null;
    this.connection = null;
    this.running = false;
    this.monitoringToken = null;
    this.seenSignatures.clear();
    this.dexCache = { data: null, fetchedAt: 0 };
    logger.info("Buy alert bot stopped");
  }

  private async subscribeToLogs() {
    if (!this.connection || !this.monitoringToken) return;

    const mintPubkey = new PublicKey(this.monitoringToken);

    this.subscriptionId = this.connection.onLogs(
      mintPubkey,
      (logs: Logs) => {
        if (logs.err) return;
        if (this.seenSignatures.has(logs.signature)) return;
        this.seenSignatures.add(logs.signature);
        this.lastCheckAt = new Date();

        // Keep seen set from growing unbounded
        if (this.seenSignatures.size > 2000) {
          const arr = [...this.seenSignatures];
          this.seenSignatures.clear();
          arr.slice(-500).forEach((s) => this.seenSignatures.add(s));
        }

        this.processTransaction(logs.signature).catch((err) => {
          logger.warn({ err, sig: logs.signature }, "Failed to process transaction");
        });
      },
      "confirmed",
    );

    logger.info({ subscriptionId: this.subscriptionId }, "Subscribed to on-chain logs");
  }

  private async processTransaction(signature: string) {
    if (!this.connection || !this.monitoringToken || !this.running) return;

    const [config] = await db.select().from(botConfigTable).limit(1);
    if (!config) return;

    const tx = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    if (!tx?.meta) return;

    const postTokenBalances = tx.meta.postTokenBalances ?? [];
    const preTokenBalances = tx.meta.preTokenBalances ?? [];
    const preBalances = tx.meta.preBalances;
    const postBalances = tx.meta.postBalances;
    const accountKeys = tx.transaction.message.accountKeys;

    let buyerAddress: string | null = null;
    let tokensReceived = 0;
    let amountNative = 0;

    for (const post of postTokenBalances) {
      if (post.mint !== this.monitoringToken) continue;

      const pre = preTokenBalances.find((p) => p.accountIndex === post.accountIndex);
      const postAmt = Number(post.uiTokenAmount.uiAmount ?? 0);
      const preAmt = Number(pre?.uiTokenAmount?.uiAmount ?? 0);
      const diff = postAmt - preAmt;

      if (diff > 0) {
        tokensReceived = diff;

        // post.owner = the real wallet that owns this token account (works for any DEX)
        buyerAddress = post.owner ?? null;

        if (buyerAddress) {
          // Look up the wallet's SOL balance change
          for (let i = 0; i < accountKeys.length; i++) {
            const key = accountKeys[i];
            if (!key) continue;
            const keyStr =
              typeof key === "string"
                ? key
                : (key as { pubkey: { toString(): string } }).pubkey?.toString() ?? "";
            if (keyStr === buyerAddress) {
              const solDiff = ((preBalances[i] ?? 0) - (postBalances[i] ?? 0)) / 1e9;
              if (solDiff > 0) amountNative = solDiff;
              break;
            }
          }
        }

        // Fallback: fee payer SOL change
        if (amountNative === 0 && preBalances[0] !== undefined && postBalances[0] !== undefined) {
          const feeDiff = (preBalances[0] - postBalances[0]) / 1e9;
          if (feeDiff > 0) amountNative = feeDiff;
        }

        break;
      }
    }

    if (!buyerAddress || tokensReceived <= 0) return;

    const solPriceUsd = await this.getSolPrice();
    const amountUsd = amountNative * solPriceUsd;

    if (amountUsd < (config.minBuyUsd ?? 1)) return;

    const dexData = await this.getCachedDexData();
    const marketCap = dexData?.marketCap ?? dexData?.fdv ?? null;
    const priceChangePct = dexData?.priceChange?.h24 ?? null;

    const tier = getTier(amountUsd, config.tier1Min, config.tier2Min, config.tier3Min);

    const [savedAlert] = await db
      .insert(alertsTable)
      .values({
        txSignature: signature,
        buyerAddress,
        amountUsd,
        amountNative,
        tokensReceived,
        marketCap: marketCap ?? null,
        priceChangePct: priceChangePct ?? null,
        tier,
      })
      .onConflictDoNothing()
      .returning();

    if (!savedAlert || !this.bot || !config.chatId) return;

    const message = buildAlertMessage({
      tokenName: config.tokenName ?? dexData?.baseToken.name ?? "Token",
      tokenSymbol: config.tokenSymbol ?? dexData?.baseToken.symbol ?? "TKN",
      tier,
      emojiPerTier: config.emojiPerTier,
      amountUsd,
      amountNative,
      tokensReceived,
      buyerAddress,
      txSignature: signature,
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

    logger.info(
      { buyer: buyerAddress, amountUsd, tokensReceived, tier },
      "Buy alert sent",
    );
  }

  private async getCachedDexData(): Promise<DexScreenerPair | null> {
    const now = Date.now();
    if (now - this.dexCache.fetchedAt < 30_000) return this.dexCache.data;
    if (!this.monitoringToken) return null;
    const data = await getDexScreenerData(this.monitoringToken);
    this.dexCache = { data, fetchedAt: now };
    return data;
  }

  private async getSolPrice(): Promise<number> {
    const now = Date.now();
    if (now - this.solPriceCache.fetchedAt < 60_000 && this.solPriceCache.price > 0) {
      return this.solPriceCache.price;
    }
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      );
      if (res.ok) {
        const data = (await res.json()) as { solana?: { usd?: number } };
        const p = data.solana?.usd ?? 0;
        if (p > 0) {
          this.solPriceCache = { price: p, fetchedAt: now };
          return p;
        }
      }
    } catch {}
    // fallback to DexScreener
    try {
      const res = await fetch(
        "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112",
      );
      if (res.ok) {
        const data = (await res.json()) as { pairs?: { priceUsd?: string }[] };
        const p = parseFloat(data.pairs?.[0]?.priceUsd ?? "0");
        if (p > 0) {
          this.solPriceCache = { price: p, fetchedAt: now };
          return p;
        }
      }
    } catch {}
    return this.solPriceCache.price || 150;
  }

  async sendTestAlert(): Promise<{ success: boolean; message: string }> {
    const [config] = await db.select().from(botConfigTable).limit(1);

    if (!config?.telegramToken || !config?.chatId) {
      return { success: false, message: "Bot token or chat ID not configured." };
    }

    try {
      const testBot = new TelegramBot(config.telegramToken, { polling: false });
      const tokenName = config.tokenName ?? "SOSANA";
      const tokenSymbol = config.tokenSymbol ?? "SOSANA";

      const message = buildAlertMessage({
        tokenName,
        tokenSymbol,
        tier: 2,
        emojiPerTier: config.emojiPerTier,
        amountUsd: 85.5,
        amountNative: 0.992,
        tokensReceived: 534_000,
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
