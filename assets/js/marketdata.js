/* ============================================================ *
 *  marketdata.js — read-only market data for the AI copilot
 *
 *  Browser-direct, CORS-friendly, NO API KEYS:
 *   · CoinGecko   (https://api.coingecko.com/api/v3)   — free tier
 *   · DefiLlama   (https://api.llama.fi + sub-hosts)   — fully free
 *   · Fear & Greed(https://api.alternative.me/fng)     — free
 *
 *  CoinMarketCap's pro-api is intentionally NOT used: it needs a
 *  secret X-CMC_PRO_API_KEY header and sends no CORS headers, so it
 *  cannot be called from a keyless static browser app. CoinGecko +
 *  the free Fear & Greed index cover the same ground client-side.
 *
 *  Everything returns small, already-compacted plain objects so the
 *  assistant spends as few tokens as possible. Results are cached
 *  briefly to stay friendly with the free rate limits.
 * ============================================================ */

import { fetchJSON } from "./net.js";

const CG = "https://api.coingecko.com/api/v3";
const DL = "https://api.llama.fi";

/* Routed through net.js: AbortController timeout + retry-with-backoff on
 * transient 5xx/network errors + a short by-URL cache. Same signature as
 * before (callers unchanged); `ttl` maps to net.js's `cache` window. */
async function getJSON(url, { ttl = 45_000, timeout = 9_000 } = {}){
  return fetchJSON(url, {
    timeout, retries: 1, cache: ttl,
    headers: { accept: "application/json" },
  });
}

const num = (n) => (n == null || isNaN(n) ? null : Number(n));
const round = (n, d = 2) => (n == null || isNaN(n) ? null : Number(Number(n).toFixed(d)));

/* ─── CoinGecko ────────────────────────────────────────────── */
export async function cgMarketData(coin_id){
  const id = String(coin_id || "").toLowerCase();
  const d = await getJSON(`${CG}/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`);
  const m = d.market_data || {};
  return {
    id: d.id, symbol: (d.symbol || "").toUpperCase(), name: d.name,
    price_usd: num(m.current_price?.usd), market_cap_usd: num(m.market_cap?.usd),
    market_cap_rank: num(d.market_cap_rank), volume_24h_usd: num(m.total_volume?.usd),
    change_24h_pct: round(m.price_change_percentage_24h), change_7d_pct: round(m.price_change_percentage_7d),
    change_30d_pct: round(m.price_change_percentage_30d),
    ath_usd: num(m.ath?.usd), ath_change_pct: round(m.ath_change_percentage?.usd),
    circulating_supply: num(m.circulating_supply), total_supply: num(m.total_supply),
    max_supply: num(m.max_supply),
    high_24h_usd: num(m.high_24h?.usd), low_24h_usd: num(m.low_24h?.usd),
    image: d.image?.small || d.image?.thumb || null,
    homepage: (d.links?.homepage || []).find(Boolean) || null,
    explorer: (d.links?.blockchain_site || []).find(Boolean) || null,
    categories: (d.categories || []).filter(Boolean).slice(0, 4),
    description: (d.description?.en || "").trim() || null,
  };
}
export async function cgChart(coin_id, days = 7){
  const id = String(coin_id || "").toLowerCase();
  // Primary: OHLC candles. Falls back to market_chart line when OHLC is
  // rate-limited or CORS-blocked, synthesising candles from close points so
  // the chart is never an empty "no data" void.
  try {
    const rows = await getJSON(`${CG}/coins/${encodeURIComponent(id)}/ohlc?vs_currency=usd&days=${encodeURIComponent(days)}`, { ttl: 120_000 });
    const out = (rows || []).slice(-60).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
    if (out.length) return { coin_id: id, days, candles: out };
    throw new Error("empty ohlc");
  } catch {
    const d = await getJSON(`${CG}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${encodeURIComponent(days)}`, { ttl: 120_000 });
    const prices = d.prices || [];
    const step = Math.max(1, Math.ceil(prices.length / 60));
    const pts = prices.filter((_, i) => i % step === 0 || i === prices.length - 1);
    let prev = pts.length ? pts[0][1] : 0;
    const out = pts.map(([t, p]) => { const o = prev, c = p; prev = c; return { t, o, c, h: Math.max(o, c), l: Math.min(o, c) }; });
    return { coin_id: id, days, candles: out, line: true };
  }
}
export async function cgTrending(){
  const d = await getJSON(`${CG}/search/trending`, { ttl: 120_000 });
  return { coins: (d.coins || []).map(({ item }) => ({ id: item.id, symbol: (item.symbol || "").toUpperCase(), name: item.name, market_cap_rank: item.market_cap_rank })) };
}
export async function cgGlobal(){
  const d = (await getJSON(`${CG}/global`)).data || {};
  return {
    total_market_cap_usd: num(d.total_market_cap?.usd), total_volume_24h_usd: num(d.total_volume?.usd),
    market_cap_change_24h_pct: round(d.market_cap_change_percentage_24h_usd),
    btc_dominance_pct: round(d.market_cap_percentage?.btc), eth_dominance_pct: round(d.market_cap_percentage?.eth),
    active_cryptocurrencies: num(d.active_cryptocurrencies),
  };
}
export async function cgTopCoins(limit = 10){
  const n = Math.min(Math.max(1, limit || 10), 50);
  const rows = await getJSON(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${n}&page=1&sparkline=false&price_change_percentage=24h`);
  return { coins: (rows || []).map(c => ({ rank: c.market_cap_rank, symbol: (c.symbol || "").toUpperCase(), name: c.name, price_usd: num(c.current_price), change_24h_pct: round(c.price_change_percentage_24h), market_cap_usd: num(c.market_cap), volume_24h_usd: num(c.total_volume) })) };
}

/* ─── DefiLlama ────────────────────────────────────────────── */
export async function dlProtocols(limit = 15){
  const n = Math.min(Math.max(1, limit || 15), 50);
  const rows = await getJSON(`${DL}/protocols`, { ttl: 300_000 });
  return { protocols: (rows || []).filter(p => p.tvl > 0).sort((a, b) => b.tvl - a.tvl).slice(0, n)
    .map(p => ({ name: p.name, symbol: p.symbol === "-" ? null : p.symbol, category: p.category, chains: (p.chains || []).slice(0, 5), tvl_usd: round(p.tvl, 0), change_1d_pct: round(p.change_1d), change_7d_pct: round(p.change_7d) })) };
}
export async function dlProtocol(slug){
  const s = String(slug || "").toLowerCase().replace(/\s+/g, "-");
  const d = await getJSON(`${DL}/protocol/${encodeURIComponent(s)}`, { ttl: 300_000 });
  const chainTvls = d.currentChainTvls || {};
  const tvl = Object.entries(chainTvls).filter(([k]) => !/-(borrowed|staking|pool2|treasury|vesting)/i.test(k))
    .reduce((sum, [, v]) => sum + (Number(v) || 0), 0);
  return { name: d.name, symbol: d.symbol === "-" ? null : d.symbol, category: d.category, url: d.url,
    tvl_usd: round(tvl, 0), chains: (d.chains || []).slice(0, 8),
    by_chain: Object.fromEntries(Object.entries(chainTvls).filter(([k]) => !k.includes("-")).slice(0, 8).map(([k, v]) => [k, round(v, 0)])) };
}
export async function dlChains(limit = 15){
  const n = Math.min(Math.max(1, limit || 15), 50);
  const rows = await getJSON(`${DL}/v2/chains`, { ttl: 300_000 });
  return { chains: (rows || []).sort((a, b) => b.tvl - a.tvl).slice(0, n).map(c => ({ name: c.name, tvl_usd: round(c.tvl, 0), token: c.tokenSymbol || null })) };
}
export async function dlStablecoins(limit = 12){
  const n = Math.min(Math.max(1, limit || 12), 30);
  const d = await getJSON(`https://stablecoins.llama.fi/stablecoins?includePrices=true`, { ttl: 300_000 });
  return { stablecoins: (d.peggedAssets || [])
    .map(s => ({ symbol: s.symbol, name: s.name, price_usd: round(s.price, 4), peg: s.pegType?.replace("pegged", "") || null, circulating_usd: round(s.circulating?.peggedUSD, 0) }))
    .filter(s => s.circulating_usd).sort((a, b) => b.circulating_usd - a.circulating_usd).slice(0, n) };
}
export async function dlYields(limit = 12){
  const n = Math.min(Math.max(1, limit || 12), 30);
  const d = await getJSON(`https://yields.llama.fi/pools`, { ttl: 300_000 });
  return { pools: (d.data || []).filter(p => p.tvlUsd > 1_000_000 && p.apy != null)
    .sort((a, b) => b.apy - a.apy).slice(0, n)
    .map(p => ({ project: p.project, symbol: p.symbol, chain: p.chain, apy_pct: round(p.apy), tvl_usd: round(p.tvlUsd, 0) })) };
}

/* ─── sentiment ────────────────────────────────────────────── */
export async function fearGreed(){
  const d = await getJSON(`https://api.alternative.me/fng/?limit=1`, { ttl: 300_000 });
  const f = (d.data || [])[0] || {};
  return { value: num(f.value), classification: f.value_classification || null, updated: f.timestamp ? new Date(Number(f.timestamp) * 1000).toISOString() : null };
}
