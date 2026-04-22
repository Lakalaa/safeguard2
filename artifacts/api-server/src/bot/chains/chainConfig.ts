export interface ChainConfig {
  id: string;           // DexScreener chainId
  name: string;         // Human-readable name
  nativeCurrency: string; // SOL, ETH, BNB, MATIC, AVAX
  nativeCoinGeckoId: string;
  explorerTx: string;   // URL template with {tx}
  explorerAddress: string; // URL template with {address}
  type: "solana" | "evm";
  rpcHttp: string;
  rpcWss: string;
}

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
    rpcWss: "wss://api.mainnet-beta.solana.com",
  },
  ethereum: {
    id: "ethereum",
    name: "Ethereum",
    nativeCurrency: "ETH",
    nativeCoinGeckoId: "ethereum",
    explorerTx: "https://etherscan.io/tx/{tx}",
    explorerAddress: "https://etherscan.io/address/{address}",
    type: "evm",
    rpcHttp: "https://ethereum.publicnode.com",
    rpcWss: "wss://ethereum.publicnode.com",
  },
  bsc: {
    id: "bsc",
    name: "BSC",
    nativeCurrency: "BNB",
    nativeCoinGeckoId: "binancecoin",
    explorerTx: "https://bscscan.com/tx/{tx}",
    explorerAddress: "https://bscscan.com/address/{address}",
    type: "evm",
    rpcHttp: "https://bsc.publicnode.com",
    rpcWss: "wss://bsc.publicnode.com",
  },
  base: {
    id: "base",
    name: "Base",
    nativeCurrency: "ETH",
    nativeCoinGeckoId: "ethereum",
    explorerTx: "https://basescan.org/tx/{tx}",
    explorerAddress: "https://basescan.org/address/{address}",
    type: "evm",
    rpcHttp: "https://base.publicnode.com",
    rpcWss: "wss://base.publicnode.com",
  },
  arbitrum: {
    id: "arbitrum",
    name: "Arbitrum",
    nativeCurrency: "ETH",
    nativeCoinGeckoId: "ethereum",
    explorerTx: "https://arbiscan.io/tx/{tx}",
    explorerAddress: "https://arbiscan.io/address/{address}",
    type: "evm",
    rpcHttp: "https://arbitrum.publicnode.com",
    rpcWss: "wss://arbitrum.publicnode.com",
  },
  polygon: {
    id: "polygon",
    name: "Polygon",
    nativeCurrency: "MATIC",
    nativeCoinGeckoId: "matic-network",
    explorerTx: "https://polygonscan.com/tx/{tx}",
    explorerAddress: "https://polygonscan.com/address/{address}",
    type: "evm",
    rpcHttp: "https://polygon.publicnode.com",
    rpcWss: "wss://polygon.publicnode.com",
  },
  avalanche: {
    id: "avalanche",
    name: "Avalanche",
    nativeCurrency: "AVAX",
    nativeCoinGeckoId: "avalanche-2",
    explorerTx: "https://snowscan.xyz/tx/{tx}",
    explorerAddress: "https://snowscan.xyz/address/{address}",
    type: "evm",
    rpcHttp: "https://avalanche.publicnode.com",
    rpcWss: "wss://avalanche.publicnode.com",
  },
  optimism: {
    id: "optimism",
    name: "Optimism",
    nativeCurrency: "ETH",
    nativeCoinGeckoId: "ethereum",
    explorerTx: "https://optimistic.etherscan.io/tx/{tx}",
    explorerAddress: "https://optimistic.etherscan.io/address/{address}",
    type: "evm",
    rpcHttp: "https://optimism.publicnode.com",
    rpcWss: "wss://optimism.publicnode.com",
  },
};

export function getChainConfig(chainId: string): ChainConfig | null {
  return CHAIN_CONFIGS[chainId.toLowerCase()] ?? null;
}

export function detectChainFromAddress(address: string): string {
  // EVM addresses start with 0x and are 42 chars
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return "ethereum"; // default EVM → ETH, DexScreener will clarify
  // Solana addresses are base58, 32-44 chars
  return "solana";
}
