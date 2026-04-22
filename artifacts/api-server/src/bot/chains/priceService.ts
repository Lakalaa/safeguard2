const cache: Record<string, { price: number; fetchedAt: number }> = {};

export async function getNativePrice(coinGeckoId: string): Promise<number> {
  const now = Date.now();
  const cached = cache[coinGeckoId];
  if (cached && now - cached.fetchedAt < 60_000 && cached.price > 0) {
    return cached.price;
  }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinGeckoId}&vs_currencies=usd`,
    );
    if (res.ok) {
      const data = (await res.json()) as Record<string, { usd?: number }>;
      const price = data[coinGeckoId]?.usd ?? 0;
      if (price > 0) {
        cache[coinGeckoId] = { price, fetchedAt: now };
        return price;
      }
    }
  } catch {}

  // fallback: try DexScreener for SOL
  if (coinGeckoId === "solana") {
    try {
      const res = await fetch(
        "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112",
      );
      if (res.ok) {
        const data = (await res.json()) as { pairs?: { priceUsd?: string }[] };
        const p = parseFloat(data.pairs?.[0]?.priceUsd ?? "0");
        if (p > 0) {
          cache[coinGeckoId] = { price: p, fetchedAt: now };
          return p;
        }
      }
    } catch {}
  }

  return cached?.price || 100;
}
