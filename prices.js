// prices.js — Daily SOL close history at $DATA_DIR/prices.jsonl
//
// Used only by report.js and backtest.js to build the "what if I had just
// bought every day and done nothing" counterfactual. Nothing in the live buy
// path depends on this, so an outage here must never block a purchase.

import fetch from "node-fetch";
import { CONFIG } from "./config.js";
import { selectCloses, insertCloses } from "./storage/index.js";

const DAY_MS = 86_400_000;
const dateKey = d => new Date(d).toISOString().slice(0, 10);

/** All known closes, ascending, de-duplicated by date. */
export async function loadCloses() {
  try { return await selectCloses(); } catch { return []; }
}

export async function lastCloseDate() {
  const rows = await loadCloses();
  return rows.length ? rows[rows.length - 1].date : null;
}

/**
 * Coinbase Exchange candles.
 *
 * Two things will bite you here: the response is sorted DESCENDING, and the
 * newest row is the *in-progress* UTC day, whose close moves while you watch
 * it. Both are handled below.
 *
 * Row shape: [time, low, high, open, close, volume] — close is index 4.
 */
export async function fetchCoinbaseCandles({ start, end }) {
  const url = new URL(CONFIG.prices.coinbaseUrl);
  url.searchParams.set("granularity", "86400");
  if (start) url.searchParams.set("start", new Date(start).toISOString());
  if (end)   url.searchParams.set("end", new Date(end).toISOString());

  const res = await fetch(url, { headers: { "User-Agent": "sol-usdc-swapper" } });
  if (!res.ok) throw new Error(`Coinbase ${res.status}: ${(await res.text()).slice(0, 120)}`);

  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("Coinbase returned a non-array");

  const today = dateKey(Date.now());
  return rows
    .map(r => ({ date: dateKey(r[0] * 1000), close: r[4], source: "coinbase" }))
    .filter(r => Number.isFinite(r.close) && r.date < today)   // drop in-progress day
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * CoinGecko fallback. Keyless works but rate-limits hard — a second call
 * within the minute returned 429 during testing, so this is a fallback only.
 *
 * Its final array element is a live spot snapshot rather than a daily close,
 * so it is dropped along with the in-progress day.
 */
export async function fetchCoingeckoDaily(days) {
  const url = new URL(`${CONFIG.prices.coingeckoUrl}`);
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("days", String(Math.min(days, 90)));
  url.searchParams.set("interval", "daily");

  const headers = { "User-Agent": "sol-usdc-swapper" };
  if (CONFIG.prices.coingeckoApiKey) headers["x-cg-demo-api-key"] = CONFIG.prices.coingeckoApiKey;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);

  const body = await res.json();
  if (!Array.isArray(body?.prices)) throw new Error("CoinGecko returned no prices");

  const today = dateKey(Date.now());
  return body.prices
    .slice(0, -1)                                  // last element is live spot
    .map(([t, p]) => ({ date: dateKey(t), close: p, source: "coingecko" }))
    .filter(r => Number.isFinite(r.close) && r.date < today)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Bring local history up to yesterday. Never throws — a price-feed outage
 * must not stop the bot from buying.
 *
 * @returns {Promise<{added:number, total:number, stale:boolean, source:string|null, error:string|null}>}
 */
export async function syncPrices({ now = Date.now() } = {}) {
  const last      = await lastCloseDate();
  const yesterday = dateKey(now - DAY_MS);

  if (last && last >= yesterday) {
    return { added: 0, total: (await loadCloses()).length, stale: false, source: null, error: null };
  }

  const startMs = last
    ? Date.parse(`${last}T00:00:00Z`) + DAY_MS
    : now - CONFIG.prices.bootstrapDays * DAY_MS;

  try {
    const added = await insertCloses(await fetchCoinbaseCandles({ start: startMs, end: now }));
    return { added, total: (await loadCloses()).length, stale: false, source: "coinbase", error: null };
  } catch (e1) {
    try {
      const daysNeeded = Math.ceil((now - startMs) / DAY_MS) + 5;
      const added = await insertCloses(await fetchCoingeckoDaily(daysNeeded));
      return { added, total: (await loadCloses()).length, stale: false, source: "coingecko", error: null };
    } catch (e2) {
      return {
        added: 0,
        total: (await loadCloses()).length,
        stale: true,
        source: null,
        error: `coinbase: ${e1.message}; coingecko: ${e2.message}`,
      };
    }
  }
}

/** Close price on a date, or the most recent close before it. Pure. */
export function closeOn(dateStr, rows) {
  let found = null;
  for (const r of rows) {
    if (r.date > dateStr) break;
    found = r.close;
  }
  return found;
}
