import { ethers } from "ethers";
import { logger } from "../../lib/logger";
import { getNativePrice } from "./priceService";
import type { ChainConfig } from "./chainConfig";

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)",
];

const POLL_INTERVAL_MS = 6_000;  // poll every 6 seconds
const MAX_BLOCKS_PER_POLL = 30;  // max blocks fetched per poll
const START_LOOKBACK = 5;         // blocks to look back on startup

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

  private async makeProvider(): Promise<ethers.JsonRpcProvider> {
    // Try primary RPC first, fall back to secondary if it fails
    const primary = new ethers.JsonRpcProvider(this.chainConfig.rpcHttp);
    try {
      await primary.getBlockNumber();
      logger.info({ rpc: this.chainConfig.rpcHttp }, `[${this.chainConfig.name}] Connected to primary RPC`);
      return primary;
    } catch {
      if (this.chainConfig.rpcHttpFallback) {
        logger.warn(
          { primary: this.chainConfig.rpcHttp, fallback: this.chainConfig.rpcHttpFallback },
          `[${this.chainConfig.name}] Primary RPC failed — using fallback`,
        );
        return new ethers.JsonRpcProvider(this.chainConfig.rpcHttpFallback);
      }
      throw new Error(`Primary RPC ${this.chainConfig.rpcHttp} failed and no fallback configured`);
    }
  }

  async start(): Promise<void> {
    this.provider = await this.makeProvider();
    this.contract = new ethers.Contract(this.tokenAddress, ERC20_ABI, this.provider);

    try {
      this.decimals = await (this.contract as ethers.Contract & { decimals(): Promise<number> }).decimals();
    } catch {
      this.decimals = 18;
    }

    try {
      const latest = await this.provider.getBlockNumber();
      this.lastProcessedBlock = Math.max(0, latest - START_LOOKBACK);
      logger.info(
        { chain: this.chainConfig.name, token: this.tokenAddress, pair: this.pairAddress, startBlock: this.lastProcessedBlock },
        `[${this.chainConfig.name}] EVM monitor started`,
      );
    } catch (err) {
      logger.warn({ err }, `[${this.chainConfig.name}] Could not get start block`);
      this.lastProcessedBlock = 0;
    }

    this.running = true;
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
    logger.info({ chain: this.chainConfig.name }, `[${this.chainConfig.name}] EVM monitor stopped`);
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => {
      this.poll()
        .catch((err) => logger.warn({ err: String(err) }, `[${this.chainConfig.name}] Unhandled poll error`))
        .finally(() => {
          if (this.running) this.schedulePoll();
        });
    }, POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    if (!this.provider || !this.contract || !this.running) return;

    let latest: number;
    try {
      latest = await this.provider.getBlockNumber();
    } catch (err) {
      logger.warn({ err: String(err) }, `[${this.chainConfig.name}] getBlockNumber failed`);
      return;
    }

    // Use latest-2 to avoid "beyond head" issues on slower nodes
    const safeLatest = latest - 2;
    if (safeLatest <= this.lastProcessedBlock) return;

    const fromBlock = this.lastProcessedBlock + 1;
    const toBlock = Math.min(safeLatest, fromBlock + MAX_BLOCKS_PER_POLL - 1);

    logger.info(
      { chain: this.chainConfig.name, fromBlock, toBlock },
      `[${this.chainConfig.name}] Polling blocks`,
    );

    let events: ethers.EventLog[];
    try {
      const raw = await this.contract.queryFilter(
        this.contract.filters["Transfer"](),
        fromBlock,
        toBlock,
      );
      events = raw.filter((e): e is ethers.EventLog => e instanceof ethers.EventLog);
    } catch (err) {
      // Do NOT advance lastProcessedBlock on error — retry same range next poll
      logger.warn({ err: String(err), fromBlock, toBlock }, `[${this.chainConfig.name}] queryFilter error — will retry`);
      return;
    }

    // Only advance after successful query
    this.lastProcessedBlock = toBlock;

    if (events.length > 0) {
      logger.info(
        { chain: this.chainConfig.name, fromBlock, toBlock, transfers: events.length },
        `[${this.chainConfig.name}] Found ${events.length} Transfer event(s)`,
      );
    }

    for (const event of events) {
      try {
        const from = event.args[0] as string;
        const to = event.args[1] as string;
        const value = event.args[2] as bigint;
        await this.handleTransfer(from, to, value, event);
      } catch (err) {
        logger.warn({ err: String(err) }, `[${this.chainConfig.name}] handleTransfer error`);
      }
    }
  }

  private async handleTransfer(
    from: string,
    to: string,
    value: bigint,
    event: ethers.EventLog,
  ): Promise<void> {
    const txHash = event.transactionHash;

    // Deduplicate
    if (this.seenTxHashes.has(txHash)) return;
    this.seenTxHashes.add(txHash);
    if (this.seenTxHashes.size > 2000) {
      const arr = [...this.seenTxHashes];
      arr.slice(0, 500).forEach((h) => this.seenTxHashes.delete(h));
    }

    // Skip mints and burns
    if (from === ethers.ZeroAddress || to === ethers.ZeroAddress) return;

    // If pair address is known, only count transfers FROM the liquidity pool (= buy)
    if (this.pairAddress && from.toLowerCase() !== this.pairAddress.toLowerCase()) {
      return;
    }

    const tokensReceived = Number(ethers.formatUnits(value, this.decimals));
    if (tokensReceived <= 0) return;

    const buyerAddress = to;

    logger.info(
      { chain: this.chainConfig.name, txHash, from, to: buyerAddress, tokens: tokensReceived },
      `[${this.chainConfig.name}] Transfer detected — fetching TX for native amount`,
    );

    // Try to get native ETH amount from tx.value
    let amountNative = 0;
    let amountUsd = 0;
    if (this.provider) {
      try {
        const tx = await this.provider.getTransaction(txHash);
        if (tx && tx.value > 0n) {
          amountNative = Number(ethers.formatEther(tx.value));
          const nativePrice = await getNativePrice(this.chainConfig.nativeCoinGeckoId);
          amountUsd = amountNative * nativePrice;
          logger.info(
            { chain: this.chainConfig.name, txHash, amountNative, nativePrice, amountUsd },
            `[${this.chainConfig.name}] ETH buy detected`,
          );
        } else {
          // WETH/ERC-20 input swap → botRegistry falls back to DexScreener price × tokens
          logger.info(
            { chain: this.chainConfig.name, txHash, tokens: tokensReceived },
            `[${this.chainConfig.name}] Token swap detected (no ETH value — will use DexScreener price)`,
          );
        }
      } catch (err) {
        logger.warn({ err: String(err) }, `[${this.chainConfig.name}] getTransaction failed`);
      }
    }

    this.onBuy({ signature: txHash, buyerAddress, tokensReceived, amountNative, amountUsd });
  }
}
