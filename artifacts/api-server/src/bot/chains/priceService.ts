/**
 * Native token price service.
 * Priority: DexScreener (always free, no rate limit) → CoinGecko (fallback, rate limited)
 */

const cache: Record<string, { price: number; fetchedAt: number }> = {};
const CACHE_TTL_MS = 60_000; // 1 minute

// DexScreener token addresses for each native coin
const DEXSCREENER_TOKENS: Record<string, { chain: string; address: string }> = {
  solana: { chain: "solana", address: "So11111111111111111111111111111111111111112" },
  ethereum: { chain: "ethereum", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" }, // WETH
  binancecoin: { chain: "bsc", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" }, // WBNB
  "matic-network": { chain: "polygon", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" }, // WMATIC
  "avalanche-2": { chain: "avalanche", address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7" }, // WAVAX
  "ethereum-optimism": { chain: "optimism", address: "0x4200000000000000000000000000000000000006" }, // WETH on Optimism
  "ethereum-arbitrum": { chain: "arbitrum", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" }, // WETH on Arbitrum
  "ethereum-base": { chain: "base", address: "0x4200000000000000000000000000000000000006" }, // WETH on Base
};

// Shared CoinGecko IDs for chains that use ETH
const ETH_CHAINS = ["optimism", "arbitrum", "base"];

async function fetchFromDexScreener(coinGeckoId: string): Promise<number> {
  const tokenInfo = DEXSCREENER_TOKENS[coinGeckoId];
  if (!tokenInfo) return 0;

  const res = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${tokenInfo.address}`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!res.ok) return 0;

  const data = (await res.json()) as { pairs?: Array<{ priceUsd?: string; chainId?: string; liquidity?: { usd?: number } }> };
  if (!data.pairs?.length) return 0;

  // Filter to the correct chain and pick highest liquidity pair
  const filtered = data.pairs
    .filter((p) => p.chainId === tokenInfo.chain && parseFloat(p.priceUsd ?? "0") > 0)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

  return parseFloat(filtered[0]?.priceUsd ?? "0") || 0;
}

async function fetchFromCoinGecko(coinGeckoId: string): Promise<number> {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${coinGeckoId}&vs_currencies=usd`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!res.ok) return 0;
  const data = (await res.json()) as Record<string, { usd?: number }>;
  return data[coinGeckoId]?.usd ?? 0;
}

/**
 * Get the USD price of a native token (SOL, ETH, BNB, etc.).
 * @param coinGeckoId - The CoinGecko ID of the token (e.g. "solana", "ethereum")
 */
export async function getNativePrice(coinGeckoId: string): Promise<number> {
  // ETH-family chains all use the ethereum price
  const effectiveId = ETH_CHAINS.includes(coinGeckoId) ? "ethereum" : coinGeckoId;

  const now = Date.now();
  const cached = cache[effectiveId];
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS && cached.price > 0) {
    return cached.price;
  }

  let price = 0;

  // 1. Try DexScreener (no rate limit)
  try {
    price = await fetchFromDexScreener(effectiveId);
  } catch {}

  // 2. Fallback: CoinGecko
  if (price <= 0) {
    try {
      price = await fetchFromCoinGecko(effectiveId);
    } catch {}
  }

  if (price > 0) {
    cache[effectiveId] = { price, fetchedAt: now };
    return price;
  }

  // Last resort: return stale cache or rough defaults
  if (cached?.price) return cached.price;

  const defaults: Record<string, number> = {
    solana: 150,
    ethereum: 3000,
    binancecoin: 600,
    "matic-network": 0.8,
    "avalanche-2": 35,
  };
  return defaults[effectiveId] ?? 1;
}
