import { ethers } from "ethers";
import { logger } from "../../lib/logger";
import { getNativePrice } from "./priceService";
import type { ChainConfig } from "./chainConfig";

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)",
];

const POLL_INTERVAL_MS = 6_000;
const BLOCK_LOOKBACK = 8;

export interface BuyEvent {
  signature: string;
  buyerAddress: string;
  tokensReceived: number;
  amountNative: number;
  amountUsd: number;
}

export class EvmMonitor {
  private provider: ethers.JsonRpcProvider | null = null;
  private contract: ethers.Contract | null = null;
  private decimals = 18;
  private tokenAddress: string;
  private pairAddress: string | null;
  private chainConfig: ChainConfig;
  private onBuy: (event: BuyEvent) => void;
  private running = false;
  private lastProcessedBlock = 0;
  private seenTxHashes = new Set<string>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    tokenAddress: string,
    pairAddress: string | null,
    chainConfig: ChainConfig,
    onBuy: (event: BuyEvent) => void,
  ) {
    this.tokenAddress = tokenAddress;
    this.pairAddress = pairAddress;
    this.chainConfig = chainConfig;
    this.onBuy = onBuy;
  }

  async start(): Promise<void> {
    this.provider = new ethers.JsonRpcProvider(this.chainConfig.rpcHttp);
    this.contract = new ethers.Contract(this.tokenAddress, ERC20_ABI, this.provider);

    try {
      this.decimals = await (this.contract as ethers.Contract & { decimals(): Promise<number> }).decimals();
    } catch {
      this.decimals = 18;
    }

    // Start from a few blocks before current so we don't miss recent buys
    try {
      this.lastProcessedBlock = (await this.provider.getBlockNumber()) - BLOCK_LOOKBACK;
    } catch {
      this.lastProcessedBlock = 0;
    }

    this.running = true;
    logger.info(
      { chain: this.chainConfig.name, token: this.tokenAddress, pair: this.pairAddress },
      `[${this.chainConfig.name}] EVM monitor started (HTTP polling)`,
    );
    this.schedulePoll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.provider = null;
    this.contract = null;
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => {
      this.poll().catch((err) => {
        logger.warn({ err }, `[${this.chainConfig.name}] Poll error`);
      }).finally(() => {
        if (this.running) this.schedulePoll();
      });
    }, POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    if (!this.provider || !this.contract || !this.running) return;

    const latestBlock = await this.provider.getBlockNumber();
    if (latestBlock <= this.lastProcessedBlock) return;

    const fromBlock = this.lastProcessedBlock + 1;
    const toBlock = Math.min(latestBlock, fromBlock + 50); // max 50 blocks per poll

    // Query Transfer events from the token contract in this block range
    let events: ethers.EventLog[];
    try {
      const raw = await this.contract.queryFilter(
        this.contract.filters["Transfer"](),
        fromBlock,
        toBlock,
      );
      events = raw.filter((e): e is ethers.EventLog => e instanceof ethers.EventLog);
    } catch (err) {
      logger.warn({ err, fromBlock, toBlock }, `[${this.chainConfig.name}] queryFilter error`);
      this.lastProcessedBlock = toBlock;
      return;
    }

    this.lastProcessedBlock = toBlock;

    for (const event of events) {
      try {
        const from = event.args[0] as string;
        const to = event.args[1] as string;
        const value = event.args[2] as bigint;
        await this.handleTransfer(from, to, value, event);
      } catch (err) {
        logger.warn({ err }, `[${this.chainConfig.name}] Transfer handler error`);
      }
    }
  }

  private async handleTransfer(
    from: string,
    to: string,
    value: bigint,
    event: ethers.EventLog,
  ): Promise<void> {
    // Deduplicate by txHash
    const txHash = event.transactionHash;
    if (this.seenTxHashes.has(txHash)) return;
    this.seenTxHashes.add(txHash);
    // Keep seen set from growing unbounded
    if (this.seenTxHashes.size > 2000) {
      const oldest = [...this.seenTxHashes].slice(0, 500);
      oldest.forEach((h) => this.seenTxHashes.delete(h));
    }

    // Only treat transfer FROM pair address as a buy
    if (this.pairAddress) {
      if (from.toLowerCase() !== this.pairAddress.toLowerCase()) return;
    } else {
      // Without pair: skip mints and burns
      if (from === ethers.ZeroAddress || to === ethers.ZeroAddress) return;
    }

    const tokensReceived = Number(ethers.formatUnits(value, this.decimals));
    if (tokensReceived <= 0) return;

    const buyerAddress = to;

    // Try to get native amount from tx.value (ETH swaps only)
    let amountNative = 0;
    let amountUsd = 0;
    if (this.provider) {
      try {
        const tx = await this.provider.getTransaction(txHash);
        if (tx) {
          const valueSent = Number(ethers.formatEther(tx.value));
          if (valueSent > 0) {
            amountNative = valueSent;
            const nativePrice = await getNativePrice(this.chainConfig.nativeCoinGeckoId);
            amountUsd = amountNative * nativePrice;
          }
          // For WETH/ERC-20 input swaps, tx.value = 0.
          // Leave amountNative=0, amountUsd=0 so botRegistry falls back to
          // tokensReceived * tokenPriceUsd from DexScreener.
        }
      } catch {}
    }

    logger.debug(
      { txHash, buyer: buyerAddress, tokens: tokensReceived, amountUsd, chain: this.chainConfig.name },
      `[${this.chainConfig.name}] Buy detected`,
    );

    this.onBuy({
      signature: txHash,
      buyerAddress,
      tokensReceived,
      amountNative,
      amountUsd,
    });
  }
}
