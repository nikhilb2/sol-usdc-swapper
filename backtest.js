// backtest.js — Replay the REAL strategy over price history.
//
//   node backtest.js
//   node backtest.js --fee-bps 15 --daily 12
//   node backtest.js --compare-cadence
//
// This imports decide() and applyAction() from strategy.js rather than
// reimplementing them. If it forked, the backtest would be measuring code the
// bot doesn't run — which is the most common way a backtest lies.
//
// With the current (deliberately boring) strategy this should reproduce flat
// DCA *exactly*. That equality is the point: it is the harness's own
// correctness check, and the baseline any future rule has to beat.

import { CONFIG } from "./config.js";
import { decide, decideSell, applyAction } from "./strategy.js";
import { plSummary } from "./pl.js";
import { defaultState } from "./state.js";
import { loadCloses } from "./prices.js";
import { close } from "./storage/index.js";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };

export function runBacktest({ closes, config, feeBps = 15, sellDays }) {
  const slip  = feeBps / 10_000;
  const asset = config.strategy.asset;

  let state = { ...defaultState(), budget: { ...defaultState().budget, dailyUsd: config.strategy.dailyUsd } };
  let units = 0, spent = 0, cash = 0, trades = 0, sells = 0;
  // The simulated trade log, in the shape executeSwap writes. P&L comes from
  // the production plSummary() over it, so the dip boost and the take-profit
  // trigger see exactly the number the dashboard would have shown.
  const txs = [];

  for (let i = 0; i < closes.length; i++) {
    const row = closes[i];
    const now = `${row.date}T12:00:00Z`;
    // Assume the wallet is kept funded; this isolates the strategy from
    // top-up timing, which is a funding question, not a strategy one.
    //
    // That assumption carries more weight once the dip boost is on: a boosted
    // buy can ask for several times the daily budget, and here it is always
    // granted. A real wallet funded at exactly dailyUsd/day would have the
    // boost clamped by the USDC_AVAILABLE rail, so treat the boosted result
    // as an upper bound on what the rule can do.
    const balances = () => ({ usdc: 1e6, sol: 1, bySymbol: { USDC: 1e6, SOL: 1, [asset]: units } });
    const pl = () => plSummary({ txs, asset, assetPrice: row.close });

    const { action } = decide({ state, balances: balances(), now, config, plPct: pl().plPct });

    if (action.type === "BUY") {
      const got = (action.usd * (1 - slip)) / row.close;
      txs.push({ type: "buy", fromSym: config.strategy.quote, toSym: asset, fromAmount: action.usd, toAmount: got });
      units += got;
      spent += action.usd;
      trades++;
      state = applyAction(state, action, { usdSpent: action.usd }, { now });
    } else {
      state = applyAction(state, action, null, { now });
    }

    // In run.js a sale is only considered on a run with no buy to make, so on
    // a buy day it lands on the next of the cron's three daily runs. Modelled
    // here as the sale following the buy on the same close.
    // `sellDays` replaces the trigger with fixed days — the random-timing null.
    let sold = 0;
    if (sellDays) {
      if (sellDays.has(i)) sold = units * config.strategy.takeProfit.sellFraction;
    } else if (config.strategy.takeProfit?.enabled && units > 0) {
      const p = pl();
      const s = decideSell({ state, balances: balances(), now, config, plPct: p.plPct, positionUnits: p.botUnits, assetPrice: row.close });
      if (s.action.type === "SELL") { sold = s.action.units; state = applyAction(state, s.action, null, { now }); }
    }
    if (sold > 0) {
      const got = sold * row.close * (1 - slip);
      txs.push({ type: "sell", fromSym: asset, toSym: config.strategy.quote, fromAmount: sold, toAmount: got });
      units -= sold;
      cash  += got;
      sells++;
    }
  }

  const finalClose = closes[closes.length - 1].close;
  const residual   = state.budget.carryUsd;

  return {
    units, spent, trades, sells, cash, residual,
    // Residual cash valued at the final price. Ignoring it would let any
    // cash-hoarding variant look like skill when it is really just short beta.
    // Take-profit proceeds are counted the same way, for the same reason.
    effective: units + (residual + cash) / finalClose,
  };
}

export function flatBaseline({ closes, dailyUsd, feeBps = 15 }) {
  const slip = feeBps / 10_000;
  let units = 0, spent = 0;
  for (const row of closes) {
    units += (dailyUsd * (1 - slip)) / row.close;
    spent += dailyUsd;
  }
  return { units, spent, trades: closes.length, residual: 0, effective: units };
}

// Take-profit is forced off here: these rows score the BUY rule, and the flat
// equality check below only holds for a strategy that never sells. The sale
// rule is scored in backtest-takeprofit.js.
function cfg(over = {}) {
  return {
    ...CONFIG, swap: { ...CONFIG.swap },
    strategy: { ...CONFIG.strategy, takeProfit: { ...CONFIG.strategy.takeProfit, enabled: false }, ...over },
  };
}

async function main() {
  const closes = await loadCloses();
  if (closes.length < 30) {
    console.error(`Only ${closes.length} daily closes on disk. Run \`node run.js --explain\` once to bootstrap history.`);
    process.exit(1);
  }

  const feeBps = arg("--fee-bps", 15);
  const daily  = arg("--daily", CONFIG.strategy.dailyUsd);

  console.log(`\n  ${closes.length} daily closes: ${closes[0].date} → ${closes[closes.length - 1].date}`);
  console.log(`  $${daily}/day · ${feeBps} bps per trade\n`);

  const flat = flatBaseline({ closes, dailyUsd: daily, feeBps });
  // Boost off, so this row stays the harness's own correctness check against
  // flat DCA. The boosted variant is scored separately below, because it does
  // not deploy the same capital and so cannot share a baseline.
  const strat = runBacktest({ closes, config: cfg({ dailyUsd: daily, boostOnLoss: false }), feeBps });

  const row = (name, r) => {
    const d = ((r.effective / flat.effective) - 1) * 100;
    console.log(
      `  ${name.padEnd(22)} ${r.effective.toFixed(4).padStart(10)} SOL` +
      `  ${r.trades.toString().padStart(4)} trades` +
      `  $${r.residual.toFixed(2).padStart(7)} idle` +
      `  ${(d >= 0 ? "+" : "") + d.toFixed(3)}%`
    );
  };

  console.log(`  ${"".padEnd(22)} ${"effective".padStart(10)}       trades      idle     vs flat`);
  row("flat $/day (baseline)", flat);
  row("strategy (daily)", strat);

  if (process.argv.includes("--compare-cadence")) {
    row("strategy (weekly)", runBacktest({
      closes, config: cfg({ dailyUsd: daily, cadence: "weekly", boostOnLoss: false }), feeBps,
    }));
  }

  // ── Dip boost ──────────────────────────────────────────────────────────────
  // Scored on its own, and deliberately NOT with the `vs flat` column above.
  // The boost deploys more capital, so of course it ends with more SOL — that
  // comparison would be measuring the size of the cheque, not the rule. The
  // question a dip-buying rule actually has to answer is whether each dollar
  // bought more SOL than the same dollar spread evenly, so score it per dollar.
  if (CONFIG.strategy.boostOnLoss) {
    const boosted   = runBacktest({ closes, config: cfg({ dailyUsd: daily }), feeBps });
    const perDollar = r => (r.spent > 0 ? r.effective / r.spent : 0);
    const edge      = ((perDollar(boosted) / perDollar(flat)) - 1) * 100;
    const extraPct  = (boosted.spent / flat.spent - 1) * 100;

    console.log(`\n  dip boost — ${CONFIG.strategy.boostFactor}x drawdown, capped ${CONFIG.strategy.maxBoostMultiplier}x`);
    console.log(`    capital deployed    $${boosted.spent.toFixed(2)} vs $${flat.spent.toFixed(2)} flat  (+${extraPct.toFixed(1)}%)`);
    console.log(`    effective           ${boosted.effective.toFixed(4)} SOL  ${boosted.trades} trades`);
    console.log(`    SOL per $100        ${(perDollar(boosted) * 100).toFixed(5)} vs ${(perDollar(flat) * 100).toFixed(5)} flat` +
                `  ${(edge >= 0 ? "+" : "") + edge.toFixed(3)}%`);
    console.log(`    ${edge >= 0
      ? "Each dollar bought more SOL — the rule leaned into cheaper prices."
      : "Each dollar bought LESS SOL — the boost fired into further decline."}`);
  }

  const drift = Math.abs(strat.effective - flat.effective);
  console.log(
    drift < 1e-9
      ? `\n  ✅ Strategy reproduces the flat baseline exactly — harness is sound.\n`
      : `\n  ⚠️  Strategy diverges from flat by ${drift.toExponential(3)} SOL.\n` +
        `     Expected with the current config. Investigate before trusting any result.\n`
  );
}

if (process.argv[1]?.endsWith("backtest.js")) {
  await main();
  await close();
}
