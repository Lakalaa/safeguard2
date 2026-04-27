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

const POLL_INTERVAL_MS = 6_000;
const SIG_BATCH = 15; // smaller batch = fewer tx fetches per poll = less rate pressure
const TX_FETCH_DELAY_MS = 400; // pause between getParsedTransaction calls

// Multiple free Solana mainnet RPC endpoints to rotate through
const SOLANA_RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana.drpc.org",
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana",
];

export class SolanaMonitor {
  private connections: Connection[] = [];
  private currentRpcIndex = 0;
  private running = false;
  private tokenAddress: string;
  private onBuy: (event: BuyEvent) => void;
  private lastSignature: string | null = null;
  private seenSignatures = new Set<string>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(tokenAddress: string, onBuy: (event: BuyEvent) => void) {
    this.tokenAddress = tokenAddress;
    this.onBuy = onBuy;
  }

  private get connection(): Connection | null {
    return this.connections[this.currentRpcIndex] ?? null;
  }

  private async rotateRpc(): Promise<void> {
    const start = this.currentRpcIndex;
    for (let i = 1; i < this.connections.length; i++) {
      const idx = (start + i) % this.connections.length;
      try {
        await this.connections[idx]!.getSlot();
        this.currentRpcIndex = idx;
        logger.info({ rpc: SOLANA_RPCS[idx] }, "[Solana] Rotated to fallback RPC");
        return;
      } catch {
        // try next
      }
    }
    logger.warn("[Solana] All RPCs appear down — staying on current");
  }

  async start(): Promise<void> {
    // Build connection pool — include any RPC that passes a health check
    for (const rpc of SOLANA_RPCS) {
      try {
        const conn = new Connection(rpc, { commitment: "confirmed" });
        await conn.getSlot();
        this.connections.push(conn);
        logger.info({ rpc, token: this.tokenAddress }, "[Solana] RPC added to pool");
      } catch {
        logger.warn({ rpc }, "[Solana] RPC unreachable — skipping");
      }
    }

    // Fall back: if none passed the health check just include all of them anyway
    if (this.connections.length === 0) {
      this.connections = SOLANA_RPCS.map(rpc => new Connection(rpc, { commitment: "confirmed" }));
      logger.warn("[Solana] No RPC passed health check — using full pool anyway");
    }

    logger.info({ rpc: SOLANA_RPCS[this.currentRpcIndex] }, "[Solana] Connected to RPC");

    // Seed cursor so we only fire on NEW transactions
    try {
      const mintPubkey = new PublicKey(this.tokenAddress);
      const recent = await this.connection!.getSignaturesForAddress(mintPubkey, { limit: 1 });
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
    this.connections = [];
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

    const opts: { limit: number; until?: string } = { limit: SIG_BATCH };
    if (this.lastSignature) opts.until = this.lastSignature;

    let sigs: Awaited<ReturnType<Connection["getSignaturesForAddress"]>>;
    try {
      sigs = await this.connection.getSignaturesForAddress(mintPubkey, opts);
    } catch (err) {
      const msg = String(err);
      logger.warn({ err: msg }, "[Solana] getSignaturesForAddress error");
      if (msg.includes("429")) await this.rotateRpc();
      return;
    }

    if (sigs.length === 0) return;

    logger.info({ count: sigs.length, newest: sigs[0]?.signature?.slice(0, 12) }, "[Solana] New transactions found");

    // Update cursor to the newest signature (sigs are newest-first)
    this.lastSignature = sigs[0]!.signature;

    // Process oldest → newest, with a small delay to avoid rate-limiting
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

      // Throttle between fetches
      await new Promise<void>((resolve) => setTimeout(resolve, TX_FETCH_DELAY_MS));

      try {
        await this.processTx(sigInfo.signature);
      } catch (err) {
        const msg = String(err);
        logger.warn({ err: msg, sig: sigInfo.signature }, "[Solana] processTx error");
        if (msg.includes("429")) {
          await this.rotateRpc();
          // Brief extra pause after a 429 before continuing
          await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        }
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
        if (feeDiff > 0.0001) amountNative = feeDiff;
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
