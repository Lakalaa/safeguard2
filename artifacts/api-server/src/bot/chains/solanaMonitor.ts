/**
 * Solana buy monitor — HTTP polling via getSignaturesForAddress.
 * Much more reliable than WebSocket log subscriptions on public RPCs.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "../../lib/logger";
import { getNativePrice } from "./priceService";

export interface BuyEvent {
  signature: string;
  buyerAddress: string;
  tokensReceived: number;
  amountNative: number;
  amountUsd: number;
}

const POLL_INTERVAL_MS = 4_000;
const SIG_BATCH = 30; // signatures to fetch per poll

// Multiple free Solana mainnet RPC endpoints to try in order
const SOLANA_RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana.drpc.org",
  "https://solana-rpc.publicnode.com",
];

export class SolanaMonitor {
  private connection: Connection | null = null;
  private running = false;
  private tokenAddress: string;
  private onBuy: (event: BuyEvent) => void;
  private lastSignature: string | null = null; // cursor: newest seen sig
  private seenSignatures = new Set<string>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(tokenAddress: string, onBuy: (event: BuyEvent) => void) {
    this.tokenAddress = tokenAddress;
    this.onBuy = onBuy;
  }

  async start(): Promise<void> {
    // Try each RPC until one works
    for (const rpc of SOLANA_RPCS) {
      try {
        const conn = new Connection(rpc, { commitment: "confirmed" });
        // Quick health-check
        await conn.getSlot();
        this.connection = conn;
        logger.info({ rpc, token: this.tokenAddress }, "[Solana] Connected to RPC");
        break;
      } catch {
        logger.warn({ rpc }, "[Solana] RPC unreachable — trying next");
      }
    }

    if (!this.connection) {
      throw new Error("[Solana] All RPC endpoints failed");
    }

    // Seed the cursor so we only process NEW transactions going forward
    try {
      const mintPubkey = new PublicKey(this.tokenAddress);
      const recent = await this.connection.getSignaturesForAddress(mintPubkey, { limit: 1 });
      if (recent.length > 0 && recent[0]) {
        this.lastSignature = recent[0].signature;
        logger.info({ cursor: this.lastSignature }, "[Solana] Starting cursor set");
      }
    } catch (err) {
      logger.warn({ err: String(err) }, "[Solana] Could not seed cursor — will process from next poll");
    }

    this.running = true;
    logger.info({ token: this.tokenAddress }, "[Solana] Monitor started (HTTP polling)");
    this.schedulePoll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.connection = null;
    logger.info({ token: this.tokenAddress }, "[Solana] Monitor stopped");
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => {
      this.poll()
        .catch((err) => logger.warn({ err: String(err) }, "[Solana] Poll error"))
        .finally(() => {
          if (this.running) this.schedulePoll();
        });
    }, POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    if (!this.connection || !this.running) return;

    const mintPubkey = new PublicKey(this.tokenAddress);

    // `until` = "return sigs newer than this one" (exclusive)
    const opts: { limit: number; until?: string } = { limit: SIG_BATCH };
    if (this.lastSignature) opts.until = this.lastSignature;

    let sigs: Awaited<ReturnType<Connection["getSignaturesForAddress"]>>;
    try {
      sigs = await this.connection.getSignaturesForAddress(mintPubkey, opts);
    } catch (err) {
      logger.warn({ err: String(err) }, "[Solana] getSignaturesForAddress error");
      return;
    }

    if (sigs.length === 0) return;

    logger.info({ count: sigs.length, newest: sigs[0]?.signature?.slice(0, 12) }, "[Solana] New transactions found");

    // Update cursor to the newest signature (sigs are newest-first)
    this.lastSignature = sigs[0]!.signature;

    // Process oldest → newest
    for (const sigInfo of [...sigs].reverse()) {
      if (sigInfo.err) continue;
      if (this.seenSignatures.has(sigInfo.signature)) continue;
      this.seenSignatures.add(sigInfo.signature);

      // Prune set
      if (this.seenSignatures.size > 2000) {
        const arr = [...this.seenSignatures];
        this.seenSignatures.clear();
        arr.slice(-500).forEach((s) => this.seenSignatures.add(s));
      }

      try {
        await this.processTx(sigInfo.signature);
      } catch (err) {
        logger.warn({ err: String(err), sig: sigInfo.signature }, "[Solana] processTx error");
      }
    }
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

      if (diff <= 0) continue;

      tokensReceived = diff;
      buyerAddress = post.owner ?? null;

      if (buyerAddress) {
        // Find the buyer's SOL balance change
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

      // Fallback: use fee payer SOL diff if no buyer balance found
      if (amountNative === 0 && preBalances[0] !== undefined && postBalances[0] !== undefined) {
        const feeDiff = (preBalances[0] - postBalances[0]) / 1e9;
        if (feeDiff > 0.0001) amountNative = feeDiff; // ignore pure fee txs
      }

      break;
    }

    if (!buyerAddress || tokensReceived <= 0) return;

    const solPrice = await getNativePrice("solana");
    const amountUsd = amountNative > 0 ? amountNative * solPrice : 0;

    logger.info(
      { sig: signature.slice(0, 12), buyer: buyerAddress.slice(0, 8), tokens: tokensReceived, solSpent: amountNative, usd: amountUsd },
      "[Solana] Buy detected",
    );

    this.onBuy({ signature, buyerAddress, tokensReceived, amountNative, amountUsd });
  }
}
