export interface ChainConfig {
  id: string;           // DexScreener chainId
  name: string;         // Human-readable name
  nativeCurrency: string; // SOL, ETH, BNB, MATIC, AVAX
  nativeCoinGeckoId: string;
  explorerTx: string;   // URL template with {tx}
  explorerAddress: string; // URL template with {address}
  type: "solana" | "evm";
  rpcHttp: string;
  rpcHttpFallback?: string; // secondary RPC if primary fails
  defaultBuyUrl: string;    // URL template with {address} — used when no custom buy link is set
  defaultBuyLabel: string;  // Button label for the default buy link
}

// Free public RPCs that support eth_getLogs without API keys.
// Primary: LlamaRPC (DefiLlama) — no rate limit on free tier, supports all eth_ calls.
// Fallback: drpc.org — another free public endpoint.
export const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  solana: {
    id: "solana",
    name: "Solana",
    nativeCurrency: "SOL",
    nativeCoinGeckoId: "solana",
    explorerTx: "https://solscan.io/tx/{tx}",
    explorerAddress: "https://solscan.io/account/{address}",
    type: "solana",
    rpcHttp: "https://api.mainnet-beta.solana.com",
    rpcHttpFallback: "https://solana.drpc.org",
    defaultBuyUrl: "https://jup.ag/swap/SOL-{address}",
    defaultBuyLabel: "Buy",
  },
  ethereum: {
    id: "ethereum",
    name: "Ethereum",
    nativeCurrency: "ETH",
    nativeCoinGeckoId: "ethereum",
    explorerTx: "https://etherscan.io/tx/{tx}",
    explorerAddress: "https://etherscan.io/address/{address}",
    type: "evm",
    rpcHttp: "https://eth.llamarpc.com",
    rpcHttpFallback: "https://eth.drpc.org",
    defaultBuyUrl: "https://app.uniswap.org/swap?outputCurrency={address}",
    defaultBuyLabel: "Buy",
  },
  bsc: {
    id: "bsc",
    name: "BSC",
    nativeCurrency: "BNB",
    nativeCoinGeckoId: "binancecoin",
    explorerTx: "https://bscscan.com/tx/{tx}",
    explorerAddress: "https://bscscan.com/address/{address}",
    type: "evm",
    rpcHttp: "https://bsc.llamarpc.com",
    rpcHttpFallback: "https://bsc.drpc.org",
    defaultBuyUrl: "https://pancakeswap.finance/swap?outputCurrency={address}",
    defaultBuyLabel: "Buy",
  },
  base: {
    id: "base",
    name: "Base",
    nativeCurrency: "ETH",
    nativeCoinGeckoId: "ethereum",
    explorerTx: "https://basescan.org/tx/{tx}",
    explorerAddress: "https://basescan.org/address/{address}",
    type: "evm",
    rpcHttp: "https://base.llamarpc.com",
    rpcHttpFallback: "https://base.drpc.org",
    defaultBuyUrl: "https://app.uniswap.org/swap?chain=base&outputCurrency={address}",
    defaultBuyLabel: "Buy",
  },
  arbitrum: {
    id: "arbitrum",
    name: "Arbitrum",
    nativeCurrency: "ETH",
    nativeCoinGeckoId: "ethereum",
    explorerTx: "https://arbiscan.io/tx/{tx}",
    explorerAddress: "https://arbiscan.io/address/{address}",
    type: "evm",
    rpcHttp: "https://arbitrum.llamarpc.com",
    rpcHttpFallback: "https://arbitrum.drpc.org",
    defaultBuyUrl: "https://app.uniswap.org/swap?chain=arbitrum&outputCurrency={address}",
    defaultBuyLabel: "Buy",
  },
  polygon: {
    id: "polygon",
    name: "Polygon",
    nativeCurrency: "MATIC",
    nativeCoinGeckoId: "matic-network",
    explorerTx: "https://polygonscan.com/tx/{tx}",
    explorerAddress: "https://polygonscan.com/address/{address}",
    type: "evm",
    rpcHttp: "https://polygon.llamarpc.com",
    rpcHttpFallback: "https://polygon.drpc.org",
    defaultBuyUrl: "https://app.uniswap.org/swap?chain=polygon&outputCurrency={address}",
    defaultBuyLabel: "Buy",
  },
  avalanche: {
    id: "avalanche",
    name: "Avalanche",
    nativeCurrency: "AVAX",
    nativeCoinGeckoId: "avalanche-2",
    explorerTx: "https://snowscan.xyz/tx/{tx}",
    explorerAddress: "https://snowscan.xyz/address/{address}",
    type: "evm",
    rpcHttp: "https://avalanche.llamarpc.com",
    rpcHttpFallback: "https://avax.drpc.org",
    defaultBuyUrl: "https://traderjoexyz.com/avalanche/trade?outputCurrency={address}",
    defaultBuyLabel: "Buy",
  },
  optimism: {
    id: "optimism",
    name: "Optimism",
    nativeCurrency: "ETH",
    nativeCoinGeckoId: "ethereum",
    explorerTx: "https://optimistic.etherscan.io/tx/{tx}",
    explorerAddress: "https://optimistic.etherscan.io/address/{address}",
    type: "evm",
    rpcHttp: "https://optimism.llamarpc.com",
    rpcHttpFallback: "https://optimism.drpc.org",
    defaultBuyUrl: "https://app.uniswap.org/swap?chain=optimism&outputCurrency={address}",
    defaultBuyLabel: "Buy",
  },
  robinwood: {
    id: "robinwood",
    name: "Robinwood",
    nativeCurrency: "RBW",
    nativeCoinGeckoId: "robinwood",
    explorerTx: "https://robinwood.io/tx/{tx}",
    explorerAddress: "https://robinwood.io/address/{address}",
    type: "evm",
    rpcHttp: "https://rpc.robinwood.io",
    defaultBuyUrl: "https://robinwood.io/swap?outputCurrency={address}",
    defaultBuyLabel: "Buy",
  },
  // alias — "robinhood" resolves to the same chain
  robinhood: {
    id: "robinhood",
    name: "Robinhood",
    nativeCurrency: "RBW",
    nativeCoinGeckoId: "robinwood",
    explorerTx: "https://robinwood.io/tx/{tx}",
    explorerAddress: "https://robinwood.io/address/{address}",
    type: "evm",
    rpcHttp: "https://rpc.robinwood.io",
    defaultBuyUrl: "https://robinwood.io/swap?outputCurrency={address}",
    defaultBuyLabel: "Buy",
  },
  ton: {
    id: "ton",
    name: "TON",
    nativeCurrency: "TON",
    nativeCoinGeckoId: "the-open-network",
    explorerTx: "https://tonviewer.com/transaction/{tx}",
    explorerAddress: "https://tonviewer.com/{address}",
    type: "evm",   // placeholder — TON monitoring not yet supported; alerts shown via DexScreener data only
    rpcHttp: "https://toncenter.com/api/v2/jsonRPC",
    defaultBuyUrl: "https://ston.fi/swap?outputCurrency={address}",
    defaultBuyLabel: "Buy",
  },
};

export function getChainConfig(chainId: string): ChainConfig | null {
  return CHAIN_CONFIGS[chainId.toLowerCase()] ?? null;
}

export function detectChainFromAddress(address: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return "ethereum";
  return "solana";
}
