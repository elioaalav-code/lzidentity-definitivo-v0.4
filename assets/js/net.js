/* ============================================================ *
 *  net.js — resilient fetch helpers (no build step, zero deps).
 *
 *  Every remote call in the app should go through this so a hung
 *  RPC / CoinGecko / relay can't leave a skeleton spinning forever.
 *
 *    fetchJSON(url, { timeout, retries, cache, ...init })  → parsed JSON
 *    fetchText(url, opts)                                  → string
 *    withTimeout(promise, ms)                              → races a timeout
 *    clearNetCache(prefix?)                                → drop cached entries
 *
 *  - timeout   : ms before AbortController fires (default 9000)
 *  - retries   : extra attempts on network/5xx, exp backoff (default 1)
 *  - cache     : ms to memoise a successful GET by URL (default 0 = off)
 *
 *  Exposed on window.LZ.net for non-module callers.
 * ============================================================ */

const _cache = new Map(); // url -> { t, ttl, data }

export function withTimeout(promise, ms = 9000){
  let to;
  const timer = new Promise((_, rej) => { to = setTimeout(() => rej(new Error("timeout")), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(to));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function _fetch(url, { timeout = 9000, retries = 1, ...init } = {}){
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++){
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(to);
      // retry only on transient server errors
      if (res.status >= 500 && attempt < retries){ lastErr = new Error("HTTP " + res.status); await sleep(280 * (attempt + 1)); continue; }
      return res;
    } catch (e){
      clearTimeout(to);
      lastErr = e;
      if (attempt < retries){ await sleep(280 * (attempt + 1)); continue; }
      throw e;
    }
  }
  throw lastErr || new Error("fetch failed");
}

export async function fetchJSON(url, opts = {}){
  const { cache = 0 } = opts;
  if (cache > 0){
    const hit = _cache.get(url);
    if (hit && (Date.now() - hit.t) < hit.ttl) return hit.data;
  }
  const res = await _fetch(url, opts);
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  const data = await res.json();
  if (cache > 0) _cache.set(url, { t: Date.now(), ttl: cache, data });
  return data;
}

export async function fetchText(url, opts = {}){
  const res = await _fetch(url, opts);
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  return res.text();
}

export function clearNetCache(prefix){
  if (!prefix){ _cache.clear(); return; }
  for (const k of _cache.keys()) if (k.startsWith(prefix)) _cache.delete(k);
}

if (typeof window !== "undefined"){
  window.LZ = window.LZ || {};
  window.LZ.net = { fetchJSON, fetchText, withTimeout, clearNetCache };
}
