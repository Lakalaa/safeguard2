import { Connection, PublicKey, type Logs } from "@solana/web3.js";
import { logger } from "../../lib/logger";
import { getNativePrice } from "./priceService";

export interface BuyEvent {
  signature: string;
  buyerAddress: string;
  tokensReceived: number;
  amountNative: number;
  amountUsd: number;
}

export class SolanaMonitor {
  private connection: Connection | null = null;
  private subscriptionId: number | null = null;
  private seenSignatures = new Set<string>();
  private tokenAddress: string;
  private onBuy: (event: BuyEvent) => void;

  constructor(tokenAddress: string, onBuy: (event: BuyEvent) => void) {
    this.tokenAddress = tokenAddress;
    this.onBuy = onBuy;
  }

  async start(): Promise<void> {
    this.connection = new Connection("https://api.mainnet-beta.solana.com", {
      commitment: "confirmed",
      wsEndpoint: "wss://api.mainnet-beta.solana.com",
    });

    const mintPubkey = new PublicKey(this.tokenAddress);

    this.subscriptionId = this.connection.onLogs(
      mintPubkey,
      (logs: Logs) => {
        if (logs.err) return;
        if (this.seenSignatures.has(logs.signature)) return;
        this.seenSignatures.add(logs.signature);

        if (this.seenSignatures.size > 2000) {
          const arr = [...this.seenSignatures];
          this.seenSignatures.clear();
          arr.slice(-500).forEach((s) => this.seenSignatures.add(s));
        }

        this.processTx(logs.signature).catch((err) => {
          logger.warn({ err, sig: logs.signature }, "[Solana] Failed to process tx");
        });
      },
      "confirmed",
    );

    logger.info({ subscriptionId: this.subscriptionId, token: this.tokenAddress }, "[Solana] Subscribed to logs");
  }

  async stop(): Promise<void> {
    if (this.subscriptionId !== null && this.connection) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
      } catch {}
      this.subscriptionId = null;
    }
    this.connection = null;
    this.seenSignatures.clear();
  }

  private async processTx(signature: string): Promise<void> {
    if (!this.connection) return;

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
      if (post.mint !== this.tokenAddress) continue;

      const pre = preTokenBalances.find((p) => p.accountIndex === post.accountIndex);
      const postAmt = Number(post.uiTokenAmount.uiAmount ?? 0);
      const preAmt = Number(pre?.uiTokenAmount?.uiAmount ?? 0);
      const diff = postAmt - preAmt;

      if (diff > 0) {
        tokensReceived = diff;
        buyerAddress = post.owner ?? null;

        if (buyerAddress) {
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

        // Fallback: use fee payer SOL diff
        if (amountNative === 0 && preBalances[0] !== undefined && postBalances[0] !== undefined) {
          const feeDiff = (preBalances[0] - postBalances[0]) / 1e9;
          if (feeDiff > 0) amountNative = feeDiff;
        }

        break;
      }
    }

    if (!buyerAddress || tokensReceived <= 0) return;

    const solPrice = await getNativePrice("solana");
    const amountUsd = amountNative * solPrice;

    this.onBuy({ signature, buyerAddress, tokensReceived, amountNative, amountUsd });
  }
}
