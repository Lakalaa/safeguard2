import { ethers } from "ethers";
import { logger } from "../../lib/logger";
import { getNativePrice } from "./priceService";
import type { ChainConfig } from "./chainConfig";

// Minimal ERC-20 ABI — only Transfer event needed
const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)",
];

export interface BuyEvent {
  signature: string;
  buyerAddress: string;
  tokensReceived: number;
  amountNative: number;
  amountUsd: number;
}

export class EvmMonitor {
  private provider: ethers.WebSocketProvider | null = null;
  private contract: ethers.Contract | null = null;
  private decimals = 18;
  private tokenAddress: string;
  private pairAddress: string | null; // DEX pool that sells the token
  private chainConfig: ChainConfig;
  private onBuy: (event: BuyEvent) => void;

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
    this.provider = new ethers.WebSocketProvider(this.chainConfig.rpcWss);
    this.contract = new ethers.Contract(this.tokenAddress, ERC20_ABI, this.provider);

    // Get token decimals
    try {
      this.decimals = await (this.contract as ethers.Contract & { decimals(): Promise<number> }).decimals();
    } catch {
      this.decimals = 18;
    }

    // Listen for Transfer events
    this.contract.on("Transfer", async (from: string, to: string, value: bigint, event: ethers.EventLog) => {
      try {
        await this.handleTransfer(from, to, value, event);
      } catch (err) {
        logger.warn({ err }, `[${this.chainConfig.name}] Transfer handler error`);
      }
    });

    logger.info(
      { chain: this.chainConfig.name, token: this.tokenAddress, pair: this.pairAddress },
      `[${this.chainConfig.name}] EVM monitor started`,
    );
  }

  async stop(): Promise<void> {
    if (this.contract) {
      try {
        this.contract.removeAllListeners();
      } catch {}
      this.contract = null;
    }
    if (this.provider) {
      try {
        await this.provider.destroy();
      } catch {}
      this.provider = null;
    }
  }

  private async handleTransfer(
    from: string,
    to: string,
    value: bigint,
    event: ethers.EventLog,
  ): Promise<void> {
    // If we know the pair address, only treat transfers FROM the pair as buys
    // (tokens moving from pool → buyer = swap buy)
    if (this.pairAddress) {
      if (from.toLowerCase() !== this.pairAddress.toLowerCase()) return;
    } else {
      // Without pair address: skip mints (from = zero address) and burns (to = zero address)
      if (from === ethers.ZeroAddress || to === ethers.ZeroAddress) return;
    }

    const tokensReceived = Number(ethers.formatUnits(value, this.decimals));
    if (tokensReceived <= 0) return;

    const txHash = event.transactionHash;
    const buyerAddress = to;

    // Get ETH/BNB/etc. spent from the tx
    let amountNative = 0;
    if (this.provider) {
      try {
        const tx = await this.provider.getTransaction(txHash);
        if (tx) {
          // Value sent with the tx (for direct ETH→token swaps)
          const valueSent = Number(ethers.formatEther(tx.value));
          if (valueSent > 0) {
            amountNative = valueSent;
          } else {
            // For token→token routes, estimate from gas * gasPrice as min cost proxy
            // This is imperfect; real amount requires decoding swap calldata
            const receipt = await this.provider.getTransactionReceipt(txHash);
            if (receipt) {
              const gasCost = Number(
                ethers.formatEther(BigInt(receipt.gasUsed) * (tx.gasPrice ?? BigInt(0))),
              );
              // Can't reliably infer native amount for token→token; set to 0 (USD-only display)
              amountNative = gasCost;
            }
          }
        }
      } catch {}
    }

    const nativePrice = await getNativePrice(this.chainConfig.nativeCoinGeckoId);
    const amountUsd = amountNative * nativePrice;

    this.onBuy({
      signature: txHash,
      buyerAddress,
      tokensReceived,
      amountNative,
      amountUsd,
    });
  }
}
