type Tick = {
  cents: bigint;
  sources: string[];
  at: number;
};

let cache: Tick | null = null;

async function usd(url: string, pick: (body: unknown) => unknown): Promise<number | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return null;
  const price = Number(pick(await res.json()));
  if (!Number.isFinite(price) || price < 1_000 || price > 10_000_000) return null;
  return price;
}

function median(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2n;
}

/** Median BTCUSD from Coinbase, Kraken, and Binance. Needs two live venues. Cached for 10 seconds unless `fresh` is set. */
export async function spotCents(now = Date.now(), opts?: { fresh?: boolean }): Promise<Tick> {
  const fresh = Boolean(opts?.fresh);
  if (!fresh && cache && now - cache.at < 10_000) return cache;
  const reads = await Promise.all([
    usd("https://api.coinbase.com/v2/prices/BTC-USD/spot", (body) => {
      const data = body as { data?: { amount?: unknown } };
      return data.data?.amount;
    }).then((price) => (price == null ? null : { name: "Coinbase", price })).catch(() => null),
    usd("https://api.kraken.com/0/public/Ticker?pair=XBTUSD", (body) => {
      const result = (body as { result?: Record<string, { c?: unknown[] }> }).result;
      const pair = result && (result.XXBTZUSD ?? Object.values(result)[0]);
      return pair?.c?.[0];
    }).then((price) => (price == null ? null : { name: "Kraken", price })).catch(() => null),
    usd("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", (body) => {
      return (body as { price?: unknown }).price;
    }).then((price) => (price == null ? null : { name: "Binance", price })).catch(() => null),
  ]);
  const live = reads.filter((item): item is { name: string; price: number } => item != null);
  if (live.length < 2) {
    if (!fresh && cache && now - cache.at < 60_000) return cache;
    throw new Error("spot unavailable");
  }
  cache = {
    cents: median(live.map((item) => BigInt(Math.round(item.price * 100)))),
    sources: live.map((item) => item.name),
    at: now,
  };
  return cache;
}
