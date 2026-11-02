// backtest-spike.js — Sell-the-spike, rebuy-when-stable, on HOURLY candles.
//
//   node backtest-spike.js
//   node backtest-spike.js --days 1000 --fee-bps 15 --null 300 --delay 1
//
// The rule under test: when SOL (and so jupSOL) jumps T% within L hours, sell
// STRATEGY_DAILY_USD worth of jupSOL. Buy it all back once the price has been
// "stable" — its high/low range over the last S hours, all after the sale,
// within B%. Force the buyback after maxHold regardless.
//
// Scored in jupSOL units vs simply holding, because that is what the bot is
// trying to grow. The daily-close backtests in STRATEGY.md cannot see an
// intraday spike, hence hourly data here.
//
// Two checks keep this honest:
//   1. A random-entry null. Same exit rule, same number of sales, random sale
//      hours. If spike entries don't beat that, the "edge" is just drift over
//      the holding period, not the spike signal.
//   2. Walk-forward. Pick the best config on the first half, report it on the
//      second. The best of 27 in-sample is expected to look good by luck alone.

import fetch from "node-fetch";
import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";

const HOUR = 3_600_000;
const YEAR_H = 24 * 365.25;
const CACHE = path.join(process.env.DATA_DIR || "./data", "candles-1h-SOL-USD.json");

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Data ─────────────────────────────────────────────────────────────────────

/** Coinbase hourly candles, 300 per request, DESCENDING, in-progress hour included. */
async function fetchHourly(startMs, endMs) {
  const byT = new Map();
  for (let s = startMs; s < endMs; s += 300 * HOUR) {
    const url = new URL(CONFIG.prices.coinbaseUrl);
    url.searchParams.set("granularity", "3600");
    url.searchParams.set("start", new Date(s).toISOString());
    url.searchParams.set("end", new Date(Math.min(s + 299 * HOUR, endMs)).toISOString());

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { "User-Agent": "sol-usdc-swapper" } });
      if (res.status === 429 && attempt < 5) { await sleep(1000 * 2 ** attempt); continue; }
      if (!res.ok) throw new Error(`Coinbase ${res.status}: ${(await res.text()).slice(0, 120)}`);
      for (const r of await res.json()) byT.set(r[0] * 1000, { t: r[0] * 1000, h: r[2], l: r[1], c: r[4] });
      break;
    }
    process.stderr.write(".");
    await sleep(150);
  }
  process.stderr.write("\n");
  const doneBefore = Date.now() - HOUR;   // drop the in-progress hour
  return [...byT.values()].filter(r => r.t <= doneBefore).sort((a, b) => a.t - b.t);
}

export async function loadHourly(days) {
  let rows = [];
  try { rows = JSON.parse(await fs.readFile(CACHE, "utf8")); } catch {}

  const wantStart = Math.floor((Date.now() - days * 24 * HOUR) / HOUR) * HOUR;
  const haveStart = rows[0]?.t ?? Infinity;
  const haveEnd   = rows[rows.length - 1]?.t ?? -Infinity;

  const fresh = [];
  if (wantStart < haveStart) fresh.push(...await fetchHourly(wantStart, Math.min(haveStart, Date.now())));
  if (haveEnd < Date.now() - 2 * HOUR && rows.length) fresh.push(...await fetchHourly(haveEnd + HOUR, Date.now()));

  if (fresh.length) {
    const byT = new Map(rows.map(r => [r.t, r]));
    for (const r of fresh) byT.set(r.t, r);
    rows = [...byT.values()].sort((a, b) => a.t - b.t);
    await fs.mkdir(path.dirname(CACHE), { recursive: true });
    await fs.writeFile(CACHE, JSON.stringify(rows));
  }

  // Forward-fill onto a regular grid so "L hours ago" is always index i - L.
  const out = [];
  let j = 0, last = null;
  const from = Math.max(wantStart, rows[0].t);
  for (let t = from; t <= rows[rows.length - 1].t; t += HOUR) {
    while (j < rows.length && rows[j].t <= t) last = rows[j++];
    out.push(last.t === t ? last : { t, h: last.c, l: last.c, c: last.c });
  }
  return out;
}

// ── Simulation ───────────────────────────────────────────────────────────────

/** High/low range over the S candles ending at each index, as a fraction. */
export function rollingRange(candles, S) {
  const r = new Float64Array(candles.length).fill(Infinity);
  for (let i = S - 1; i < candles.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let k = i - S + 1; k <= i; k++) { if (candles[k].h > hi) hi = candles[k].h; if (candles[k].l < lo) lo = candles[k].l; }
    r[i] = hi / lo - 1;
  }
  return r;
}

/**
 * @param entries  optional Set of hour indices to sell at (the random null);
 *                 otherwise the spike rule decides.
 * @param canAct   optional (i) => bool — hours the bot is awake to act.
 */
export function simulate(candles, p, ranges, { entries, from = 0, to = candles.length, canAct } = {}) {
  const f = p.feeBps / 10_000;
  const k = Math.log(1 + p.lstYield) / YEAR_H;          // jupSOL/SOL accrual per hour
  const px = i => candles[i].c * Math.exp(k * i);       // jupSOL in USD (arbitrary rate origin)
  const range = ranges.get(p.S);
  const trades = [];
  let open = [], lastSell = -Infinity;

  const start = Math.max(from, p.L, p.S);
  const end   = to - p.delay;
  for (let i = start; i < end; i++) {
    if (canAct && !canAct(i)) continue;

    if (open.length) {
      const stable  = i - open[0].i >= p.S && range[i] <= p.B;   // window entirely after the first sale
      const timeout = i - open[0].i >= p.maxHold;
      if (stable || timeout) {
        const x = i + p.delay;
        for (const o of open) {
          const ret = (1 - f) ** 2 * (o.px / px(x)) - 1;         // jupSOL back / jupSOL sold - 1
          trades.push({ i: o.i, x, ret, units: o.units, timeout: !stable, holdH: x - o.i });
        }
        open = [];
        continue;
      }
    }

    const signal = entries ? entries.has(i) : candles[i].c / candles[i - p.L].c - 1 >= p.T;
    if (signal && i - lastSell >= p.cooldown && open.length < p.maxOpen) {
      const x = i + p.delay;
      open.push({ i: x, px: px(x), units: p.usd / candles[x].c });   // units ≈ SOL-equivalent sold
      lastSell = i;
    }
  }
  // Mark anything still open to the last price, so a rule can't hide losers.
  const x = end - 1 + p.delay;
  for (const o of open) trades.push({ i: o.i, x, ret: (1 - f) ** 2 * (o.px / px(x)) - 1, units: o.units, timeout: true, holdH: x - o.i, open: true });
  return trades;
}

export function summarize(trades) {
  const n = trades.length;
  if (!n) return { n: 0, mean: 0, win: 0, gainSol: 0, hold: 0, tOut: 0, t: 0 };
  const rets = trades.map(t => t.ret);
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  return {
    n, mean,
    t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    win: rets.filter(r => r > 0).length / n,
    gainSol: trades.reduce((a, t) => a + t.units * t.ret, 0),
    hold: trades.reduce((a, t) => a + t.holdH, 0) / n,
    tOut: trades.filter(t => t.timeout).length / n,
  };
}

/** Fraction of random-entry runs whose mean per-trade return >= the rule's. */
function nullP(candles, p, ranges, actual, sims, window) {
  if (actual.n === 0) return { p: NaN, nullMean: NaN };
  const lo = Math.max(window.from ?? 0, p.L, p.S), hi = (window.to ?? candles.length) - p.delay - 1;
  let ge = 0, sum = 0;
  for (let s = 0; s < sims; s++) {
    const entries = new Set();
    // Exactly as many sales as the rule made, spaced by the cooldown so none
    // is rejected. Oversampling would shrink the null's variance and make
    // every p-value look more decisive than it is.
    const taken = [];
    for (let tries = 0; taken.length < actual.n && tries < actual.n * 1000; tries++) {
      const h = lo + Math.floor(Math.random() * (hi - lo));
      if (taken.every(e => Math.abs(e - h) >= p.cooldown)) taken.push(h);
    }
    for (const h of taken) entries.add(h);
    const m = summarize(simulate(candles, p, ranges, { ...window, entries }));
    sum += m.mean;
    if (m.mean >= actual.mean) ge++;
  }
  return { p: ge / sims, nullMean: sum / sims };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const pct = (x, d = 2) => (x >= 0 ? "+" : "") + (x * 100).toFixed(d) + "%";
const bps = x => (x >= 0 ? "+" : "") + (x * 10_000).toFixed(0).padStart(4) + " bps";

async function main() {
  const days  = arg("--days", 1000);
  const sims  = arg("--null", 300);
  const base = {
    usd: arg("--usd", CONFIG.strategy.dailyUsd),
    feeBps: arg("--fee-bps", 15),
    delay: arg("--delay", 1),          // act on the NEXT hour's close after the signal
    lstYield: 0.063,                   // jupSOL realized 12-month yield, config.js
    cooldown: 24,                      // at most one sale per day — it's the daily budget
    maxOpen: 7,
    maxHold: 7 * 24,
  };

  const candles = await loadHourly(days);
  const n = candles.length;
  const d = t => new Date(t).toISOString().slice(0, 10);
  const move = candles[n - 1].c / candles[0].c - 1;
  console.log(`\n  ${n} hourly candles: ${d(candles[0].t)} → ${d(candles[n - 1].t)}   SOL $${candles[0].c.toFixed(2)} → $${candles[n - 1].c.toFixed(2)} (${pct(move, 1)})`);
  console.log(`  sell $${base.usd} per spike · ${base.feeBps} bps/swap · act ${base.delay}h after signal · force rebuy after ${base.maxHold / 24}d\n`);

  const spikes = [[1, 0.02], [1, 0.03], [1, 0.04], [4, 0.04], [4, 0.06], [4, 0.08], [24, 0.08], [24, 0.12], [24, 0.16]];
  const stables = [[6, 0.015], [12, 0.02], [24, 0.03]];
  const ranges = new Map(stables.map(([S]) => [S, rollingRange(candles, S)]));
  const grid = spikes.flatMap(([L, T]) => stables.map(([S, B]) => ({ ...base, L, T, S, B })));
  const label = p => `+${(p.T * 100).toFixed(0)}%/${p.L}h → ±${(p.B * 100).toFixed(1)}%/${p.S}h`;

  // Full period, every config.
  console.log(`  ${"spike → stable".padEnd(22)} ${"sales".padStart(5)} ${"per trade".padStart(9)}  ${"t".padStart(5)}  ${"win".padStart(4)}  ${"hold".padStart(5)}  ${"forced".padStart(6)}  ${"vs hold".padStart(12)}  ${"random entry".padStart(12)}  p`);
  const rows = [];
  for (const p of grid) {
    const s = summarize(simulate(candles, p, ranges));
    const nl = nullP(candles, p, ranges, s, sims, {});
    rows.push({ p, s, nl });
    console.log(
      `  ${label(p).padEnd(22)} ${String(s.n).padStart(5)} ${bps(s.mean).padStart(9)}  ${s.t.toFixed(2).padStart(5)}  ${(s.win * 100).toFixed(0).padStart(3)}%` +
      `  ${(s.hold / 24).toFixed(1).padStart(4)}d  ${(s.tOut * 100).toFixed(0).padStart(5)}%` +
      `  ${(s.gainSol >= 0 ? "+" : "") + s.gainSol.toFixed(4)} SOL  ${bps(nl.nullMean).padStart(12)}  ${nl.p.toFixed(2)}`
    );
  }

  const tot = rows.reduce((a, r) => a + r.s.gainSol, 0) / rows.length;
  const beatNull = rows.filter(r => r.nl.p < 0.05).length;
  const positive = rows.filter(r => r.s.mean > 0).length;
  console.log(`\n  ${positive}/${rows.length} configs positive vs holding · ${beatNull}/${rows.length} beat random entry at p<0.05 (≈${(rows.length * 0.05).toFixed(1)} expected by chance)`);
  console.log(`  average config: ${(tot >= 0 ? "+" : "") + tot.toFixed(4)} SOL ≈ $${(tot * candles[n - 1].c).toFixed(2)} over the whole period`);

  // Walk-forward: choose on the first half, judge on the second.
  const mid = Math.floor(n / 2);
  const inS = grid.map(p => ({ p, s: summarize(simulate(candles, p, ranges, { from: 0, to: mid })) }))
    .filter(r => r.s.n >= 10).sort((a, b) => b.s.gainSol - a.s.gainSol);
  const best = inS[0];
  const oos = summarize(simulate(candles, best.p, ranges, { from: mid, to: n }));
  const oosNull = nullP(candles, best.p, ranges, oos, sims, { from: mid, to: n });
  console.log(`\n  walk-forward — best on ${d(candles[0].t)}…${d(candles[mid].t)}: ${label(best.p)}`);
  console.log(`    in-sample      ${String(best.s.n).padStart(3)} sales  ${bps(best.s.mean)}/trade  t=${best.s.t.toFixed(2)}  ${(best.s.gainSol >= 0 ? "+" : "") + best.s.gainSol.toFixed(4)} SOL`);
  console.log(`    out-of-sample  ${String(oos.n).padStart(3)} sales  ${bps(oos.mean)}/trade  t=${oos.t.toFixed(2)}  ${(oos.gainSol >= 0 ? "+" : "") + oos.gainSol.toFixed(4)} SOL  (random entry ${bps(oosNull.nullMean)}, p=${oosNull.p.toFixed(2)})`);

  // What the bot can actually do today: it only wakes at 03:45/07:45/11:45 UTC.
  const cronHours = new Set([3, 7, 11]);
  const canAct = i => cronHours.has(new Date(candles[i].t).getUTCHours());
  const cron = summarize(simulate(candles, best.p, ranges, { canAct }));
  const hourly = summarize(simulate(candles, best.p, ranges));
  console.log(`\n  same config, full period — hourly checks: ${hourly.n} sales ${bps(hourly.mean)}/trade · current cron (3 checks/day): ${cron.n} sales ${bps(cron.mean)}/trade\n`);
}

if (process.argv[1]?.endsWith("backtest-spike.js")) await main();
