// backtest-takeprofit.js — Score the take-profit rule: when total P&L reaches
// +T%, sell F% of the position, then not again for a cooldown. The DCA is
// unchanged.
//
//   node backtest-takeprofit.js
//   node backtest-takeprofit.js --threshold 10 --fraction 10 --fee-bps 15 --null 100
//
// Runs the production code end to end: runBacktest() from backtest.js, which
// drives decide() for the buys and decideSell() for the sales, with P&L from
// plSummary(). The only thing varied here is config.
//
// Daily prices are the 03:00 UTC hourly close (near the first cron run at
// 09:15 IST), from the same hourly cache backtest-spike.js keeps — ~1,000
// days, against the ~200 daily closes backtest.js has on disk. jupSOL is SOL ×
// a ratio accruing at the realized 6.3%/yr, anchored to today's live ratio.
//
// Sale proceeds stay as USDC. The score is SOL-equivalent — jupSOL × ratio +
// cash / SOL — at the end, against the same DCA that never sells. Ending
// with cash is a bet that SOL fell; counting it at the final price is what
// keeps that bet visible instead of letting it pass as skill.
//
// Three checks keep this honest:
//   1. A random-timing null: the same number of sales, of the same size, on
//      random days. If the +T% trigger doesn't beat that, the signal adds
//      nothing; any gain is just "held less SOL while SOL fell".
//   2. Rolling windows: one path is one outcome. A new 365-day window every
//      30 days, so the end price varies. Windows overlap, so they are not
//      independent — read the spread, not the count, as the evidence.
//   3. Walk-forward: pick the best cooldown on the first half, report it on
//      the second. The best of five in-sample is expected to look good by luck.

import { CONFIG } from "./config.js";
import { runBacktest } from "./backtest.js";
import { loadHourly } from "./backtest-spike.js";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };

const RATIO_NOW = 1.21484;     // jupSOL/SOL, live report 2026-10-21
const LST_YIELD = 0.063;       // realized 12mo, STRATEGY.md §3
const COOLDOWNS = [7, 14, 30, 60, 90];

/** One row per UTC day, priced in jupSOL (`close`) with the SOL leg kept for scoring. */
function dailyFromHourly(candles) {
  const days = candles
    .filter(c => new Date(c.t).getUTCHours() === 3)
    .map(c => ({ date: new Date(c.t).toISOString().slice(0, 10), sol: c.c }));
  const k = Math.log(1 + LST_YIELD) / 365.25;
  const n = days.length;
  return days.map((d, i) => {
    const ratio = RATIO_NOW * Math.exp(-k * (n - 1 - i));
    return { ...d, ratio, close: d.sol * ratio };
  });
}

function cfg({ boostOnLoss, takeProfit }) {
  return {
    ...CONFIG, swap: { ...CONFIG.swap },
    strategy: { ...CONFIG.strategy, boostOnLoss, takeProfit: { ...CONFIG.strategy.takeProfit, ...takeProfit } },
  };
}

/** SOL-equivalent at the end: runBacktest scores in jupSOL, the last ratio converts. */
function score(days, config, feeBps, sellDays) {
  const r = runBacktest({ closes: days, config, feeBps, sellDays });
  return { ...r, solEq: r.effective * days[days.length - 1].ratio };
}

// Deterministic PRNG so the null is reproducible run to run.
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function randomNull(days, config, feeBps, sales, nNull, seed = 42) {
  const rand = rng(seed);
  const out = [];
  for (let k = 0; k < nNull; k++) {
    const set = new Set();
    // After the first week, so there is a position to sell from.
    while (set.size < Math.min(sales, days.length - 7)) set.add(7 + Math.floor(rand() * (days.length - 7)));
    out.push(score(days, config, feeBps, set).solEq);
  }
  return out;
}

const pct = (a, b) => ((a / b) - 1) * 100;
const sgn = (x, d = 2) => (x >= 0 ? "+" : "") + x.toFixed(d);
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };

async function main() {
  const T      = arg("--threshold", CONFIG.strategy.takeProfit.thresholdPct);
  const F      = arg("--fraction", CONFIG.strategy.takeProfit.sellFraction * 100) / 100;
  const feeBps = arg("--fee-bps", 15);
  const nNull  = arg("--null", 100);

  const days = dailyFromHourly(await loadHourly(arg("--days", 1000)));
  const first = days[0], last = days[days.length - 1];
  const meanSol = days.reduce((s, d) => s + d.sol, 0) / days.length;
  console.log(`\n  ${days.length} days: ${first.date} → ${last.date}   SOL $${first.sol.toFixed(2)} → $${last.sol.toFixed(2)}` +
              `  (period mean $${meanSol.toFixed(2)})`);
  console.log(`  DCA $${CONFIG.strategy.dailyUsd}/day as configured · sell ${F * 100}% at P&L >= +${T}% · ${feeBps} bps/swap`);
  console.log(`  proceeds kept as USDC · score = jupSOL×ratio + cash/SOL at the end\n`);

  const tp = cooldownDays => ({ enabled: true, thresholdPct: T, sellFraction: F, cooldownDays });

  for (const boostOnLoss of [true, false]) {
    console.log(`  ── dip boost ${boostOnLoss ? "ON (as live)" : "OFF (isolates the sale rule)"} ──`);
    console.log(`  ${"rule".padEnd(20)} sales  deployed    SOL-eq    vs DCA   random-timing null   USDC held`);
    const base = score(days, cfg({ boostOnLoss, takeProfit: { enabled: false } }), feeBps);
    console.log(`  ${"DCA only".padEnd(20)} ${"0".padStart(5)}  $${base.spent.toFixed(0).padStart(6)}  ${base.solEq.toFixed(3).padStart(8)}`);
    for (const cd of COOLDOWNS) {
      const config = cfg({ boostOnLoss, takeProfit: tp(cd) });
      const r = score(days, config, feeBps);
      let nullCol = "";
      if (r.sells > 0) {
        const nul = randomNull(days, config, feeBps, r.sells, nNull);
        const beat = nul.filter(x => x >= r.solEq).length;
        nullCol = `${sgn(pct(median(nul), base.solEq)).padStart(7)}%  p=${((beat + 1) / (nNull + 1)).toFixed(2)}`;
      }
      console.log(
        `  ${("cooldown " + cd + "d").padEnd(20)} ${String(r.sells).padStart(5)}  $${r.spent.toFixed(0).padStart(6)}` +
        `  ${r.solEq.toFixed(3).padStart(8)}  ${(sgn(pct(r.solEq, base.solEq)) + "%").padStart(7)}   ${nullCol.padEnd(18)}` +
        `  $${r.cash.toFixed(0).padStart(6)}`
      );
    }
    console.log();
  }

  // ── Rolling 365-day windows, as live ──
  console.log(`  ── rolling 365-day windows, a new start every 30 days, dip boost as live ──`);
  console.log(`  ${"rule".padEnd(20)} beat DCA   median    worst     best`);
  const starts = [];
  for (let s = 0; s + 365 <= days.length; s += 30) starts.push(s);
  const baseWin = starts.map(s => score(days.slice(s, s + 365), cfg({ boostOnLoss: true, takeProfit: { enabled: false } }), feeBps).solEq);
  for (const cd of COOLDOWNS) {
    const diffs = starts.map((s, j) =>
      pct(score(days.slice(s, s + 365), cfg({ boostOnLoss: true, takeProfit: tp(cd) }), feeBps).solEq, baseWin[j]));
    const sorted = [...diffs].sort((a, b) => a - b);
    console.log(
      `  ${("cooldown " + cd + "d").padEnd(20)} ${String(diffs.filter(x => x > 1e-9).length).padStart(3)}/${diffs.length}` +
      `   ${(sgn(median(diffs)) + "%").padStart(7)}  ${(sgn(sorted[0]) + "%").padStart(7)}  ${(sgn(sorted[sorted.length - 1]) + "%").padStart(7)}`
    );
  }

  // ── Walk-forward ──
  const half = days.length >> 1;
  const A = days.slice(0, half), B = days.slice(half);
  const vsDca = (w, cd) => pct(
    score(w, cfg({ boostOnLoss: true, takeProfit: tp(cd) }), feeBps).solEq,
    score(w, cfg({ boostOnLoss: true, takeProfit: { enabled: false } }), feeBps).solEq);
  const inSample = COOLDOWNS.map(cd => ({ cd, d: vsDca(A, cd) })).sort((a, b) => b.d - a.d);
  const best = inSample[0];
  console.log(`\n  ── walk-forward, dip boost as live ──`);
  console.log(`  first half  ${A[0].date} → ${A[A.length - 1].date}: best is cooldown ${best.cd}d at ${sgn(best.d)}% vs DCA`);
  console.log(`  second half ${B[0].date} → ${B[B.length - 1].date}: cooldown ${best.cd}d scores ${sgn(vsDca(B, best.cd))}% vs DCA` +
              `  (30d: ${sgn(vsDca(B, 30))}%)\n`);
}

if (process.argv[1]?.endsWith("backtest-takeprofit.js")) await main();
