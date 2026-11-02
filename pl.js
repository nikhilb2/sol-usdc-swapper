// pl.js — FIFO P&L calculator over the SOL/USDC swap log
// Usage: node pl.js                          all-time P&L (with live unrealized)
//        node pl.js --today
//        node pl.js --start 2026-08-01 --end 2026-08-28
//        node pl.js --history 20             list the last 20 swaps

import { loadTransactions } from "./transactions.js";

function parseDate(str) {
  return new Date(str);
}

function withinRange(ts, start, end) {
  const d = parseDate(ts);
  if (start && d < new Date(start + "T00:00:00Z")) return false;
  if (end   && d > new Date(end   + "T23:59:59.999Z")) return false;
  return true;
}

function round(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return 0;
  return Math.round(n * 10 ** digits) / 10 ** digits;
}

/**
 * Replay swaps in order against a FIFO lot book.
 *
 * @param {Object[]} txs — swaps, oldest first
 * @param {Object} [opts]
 * @param {Object} [opts.initial] — starting state from an earlier replay
 * @param {string} [opts.asset] — only replay legs in this symbol. Without it the
 *   book is symbol-agnostic, so a JUPSOL buy shares lots with an MSOL buy. That
 *   is harmless for a single-asset log and wrong for a wallet that has held more
 *   than one, which is why report.js always passes it.
 */
export function replayFifo(txs, { initial = {}, asset } = {}) {
  let realizedPl = 0;
  let units      = initial.units ?? 0;
  let costBasis  = initial.costBasis ?? 0;
  const lots = (initial.lots ?? []).map(l => ({ ...l }));

  let totalBuys = 0, totalSells = 0;
  let buyVolumeUsdc = 0, sellVolumeUsdc = 0;
  let movedUnits = initial.movedUnits ?? 0;
  let transferCount = 0;

  for (const tx of txs) {
    if (tx.type === "buy") {
      // USDC → asset
      if (asset && tx.toSym !== asset) continue;
      const bought    = tx.toAmount;
      const usdcSpent = tx.fromAmount;
      if (!bought) continue;

      lots.push({ units: bought, costPerUnit: usdcSpent / bought });
      units     += bought;
      costBasis += usdcSpent;
      totalBuys++;
      buyVolumeUsdc += usdcSpent;
    } else if (tx.type === "sell") {
      // asset → USDC
      if (asset && tx.fromSym !== asset) continue;
      const sold         = tx.fromAmount;
      const usdcReceived = tx.toAmount;

      let remaining   = sold;
      let matchedCost = 0;

      while (remaining > 0 && lots.length > 0) {
        const lot     = lots[0];
        const fromLot = Math.min(remaining, lot.units);

        matchedCost += fromLot * lot.costPerUnit;
        lot.units   -= fromLot;
        remaining   -= fromLot;

        if (lot.units <= 1e-9) lots.shift();
      }

      realizedPl += usdcReceived - matchedCost;
      units      -= sold;
      costBasis  -= matchedCost;
      totalSells++;
      sellVolumeUsdc += usdcReceived;
    } else if (tx.type === "transfer_out" || tx.type === "transfer_in") {
      // A custody move: the units change wallets, not owners. No lot is
      // consumed, no basis retired, no P&L realized, no volume recorded —
      // moving your own coins between your own wallets is not a disposal.
      //
      // Tracked only so the reconciler knows which units are *expected* to be
      // missing from the bot's wallet. Handled explicitly rather than left to
      // fall through the if/else, which would be accidentally right for the
      // basis and silently wrong for the tracking.
      if (asset && tx.fromSym !== asset) continue;
      movedUnits += (tx.type === "transfer_out" ? 1 : -1) * tx.fromAmount;
      transferCount++;
    }
  }

  return {
    realizedPl,
    units,
    costBasis,
    avgCostUsd: units > 0 ? costBasis / units : 0,
    totalBuys,
    totalSells,
    buyVolumeUsdc,
    sellVolumeUsdc,
    lots,
    movedUnits,
    transferCount,
  };
}

/**
 * Position and P&L for one asset, from the trade log and a current price.
 *
 * This is the single definition of "how far up or down am I" in this codebase.
 * report.js prints it and strategy.js sizes the dip boost from it — if they
 * each computed it, the bot could be averaging down on a number the dashboard
 * never showed.
 *
 * Attribution follows the report's rule: only units this bot's log accounts
 * for. A pre-existing bag has no cost basis the bot can know, so folding it in
 * would read as free profit and suppress the boost exactly when it should fire.
 *
 * A custody transfer to a safer wallet does NOT leave the position: the units
 * are still owned, so `botUnits` and every P&L figure below are unchanged by
 * one. This matters beyond bookkeeping — strategy.js sizes the dip boost from
 * `plPct`, so treating a move as a disposal would silently rewrite how much
 * the bot buys tomorrow, purely because the coins were put somewhere safe.
 * What a move DOES change is where the units sit, which is `custodyUnits`.
 *
 * `plPct` is measured against capital NET of sells, and is 0 (not NaN, not
 * Infinity) before any capital has been deployed.
 *
 * @param {Object[]} txs — the full trade log; dry runs are filtered out here
 * @param {string} asset — symbol to scope both legs to
 * @param {number} assetPrice — current USD price of one unit
 */
export function plSummary({ txs, asset, assetPrice }) {
  const real  = txs.filter(t => !t.dryRun);
  const buys  = real.filter(t => t.type === "buy"  && t.toSym   === asset);
  const sells = real.filter(t => t.type === "sell" && t.fromSym === asset);
  const transfers = real.filter(t => t.type === "transfer_out" && t.fromSym === asset);

  const unitsBought = buys.reduce((s, t) => s + t.toAmount, 0);
  const unitsSold   = sells.reduce((s, t) => s + t.fromAmount, 0);
  const botUnits    = unitsBought - unitsSold;

  // Units deliberately moved to safer custody. Still owned, still in botUnits;
  // just no longer expected to show up in this wallet's balance.
  const movedUnits   = transfers.reduce((s, t) => s + t.fromAmount, 0);
  const custodyUnits = botUnits - movedUnits;

  const usdIn  = buys.reduce((s, t) => s + t.fromAmount, 0);
  const usdOut = sells.reduce((s, t) => s + t.toAmount, 0);
  const netDeployedUsd = usdIn - usdOut;

  const fifo = replayFifo(real, { asset });
  const costBasisUsd = fifo.costBasis;

  const currentValueUsd = botUnits * assetPrice;
  const realizedPlUsd   = fifo.realizedPl;
  const unrealizedPlUsd = currentValueUsd - costBasisUsd;
  const plUsd           = realizedPlUsd + unrealizedPlUsd;
  const plPct           = netDeployedUsd > 0 ? (plUsd / netDeployedUsd) * 100 : 0;

  return {
    fifo, buys, sells, transfers,
    unitsBought, unitsSold, botUnits,
    movedUnits, custodyUnits,
    movedValueUsd:   movedUnits * assetPrice,
    custodyValueUsd: custodyUnits * assetPrice,
    usdIn, usdOut, netDeployedUsd, costBasisUsd,
    currentValueUsd, realizedPlUsd, unrealizedPlUsd, plUsd, plPct,
  };
}

/**
 * P&L for a date range, or all time when no range is given.
 * Swaps before `start` are replayed first so the cost basis carried into the
 * window is correct.
 * @param {Object} opts
 * @param {string} [opts.start] — "YYYY-MM-DD"
 * @param {string} [opts.end]   — "YYYY-MM-DD"
 * @param {number} [opts.currentPrice] — SOL price for the unrealized leg
 */
export async function calculatePL({ start, end, currentPrice } = {}) {
  const allTxs = await loadTransactions();
  if (allTxs.length === 0) {
    return { realizedPL: 0, unrealizedPL: 0, totalPL: 0, trades: 0, buys: 0, sells: 0,
             buyVolume: 0, sellVolume: 0, solHoldings: 0, avgCostBasis: 0, movedUnits: 0 };
  }

  let state;
  if (start || end) {
    const beforeStart = start
      ? allTxs.filter(tx => parseDate(tx.timestamp) < new Date(start + "T00:00:00Z"))
      : [];
    const inRange = allTxs.filter(tx => withinRange(tx.timestamp, start, end));
    state = replayFifo(inRange, { initial: replayFifo(beforeStart) });
  } else {
    state = replayFifo(allTxs);
  }

  const unrealizedPL = currentPrice
    ? state.units * currentPrice - state.costBasis
    : 0;

  return {
    realizedPL:   round(state.realizedPl),
    unrealizedPL: round(unrealizedPL),
    totalPL:      round(state.realizedPl + unrealizedPL),
    trades:       state.totalBuys + state.totalSells,
    buys:         state.totalBuys,
    sells:        state.totalSells,
    buyVolume:    round(state.buyVolumeUsdc),
    sellVolume:   round(state.sellVolumeUsdc),
    // Moved units are still held — they are just held elsewhere.
    solHoldings:  round(state.units, 6),
    avgCostBasis: round(state.avgCostUsd),
    movedUnits:   round(state.movedUnits, 6),
  };
}

/** Today's P&L (realized from today's swaps, plus current unrealized). */
export async function getTodayPL(currentPrice) {
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return await calculatePL({ start: day, end: day, currentPrice });
}

/** Logged swaps, most recent first. Dry runs are included by default — this is
 *  a log view, not a P&L view. */
export async function getTransactions({ start, end, limit = 1000, includeDryRun = true } = {}) {
  let txs = await loadTransactions({ includeDryRun });
  if (start || end) txs = txs.filter(tx => withinRange(tx.timestamp, start, end));
  return txs.reverse().slice(0, limit);
}

// ── Main (standalone) ─────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("pl.js")) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const historyArg = argv.indexOf("--history");
  if (historyArg >= 0) {
    const limit = parseInt(argv[historyArg + 1]) || 20;
    const txs = await getTransactions({ limit });
    if (!txs.length) {
      console.log("No swaps logged yet.");
      process.exit(0);
    }
    console.log(`\nLast ${txs.length} swaps (most recent first):\n`);
    const DIR = { buy: "BUY ", sell: "SELL", transfer_out: "MOVE", transfer_in: "RECV" };
    for (const tx of txs) {
      const dir = DIR[tx.type] ?? tx.type.toUpperCase().slice(0, 4);
      const isMove = tx.type === "transfer_out" || tx.type === "transfer_in";
      console.log(
        `${tx.timestamp}  ${dir}  ${tx.fromAmount.toFixed(6)} ${tx.fromSym} → ` +
        (isMove ? `${(tx.dest ?? "?").slice(0, 4)}…${(tx.dest ?? "?").slice(-4)}`
                : `${tx.toAmount.toFixed(6)} ${tx.toSym}`) +
        (tx.price ? `  @ $${tx.price.toFixed(2)}` : "") +
        (tx.dryRun ? "  [dry]" : "") +
        (tx.sig ? `  ${tx.sig.slice(0, 8)}…` : "")
      );
    }
    process.exit(0);
  }

  const { getSolPriceUsd } = await import("./query.js");
  const price = await getSolPriceUsd().catch(e => {
    console.error("Price fetch failed, unrealized P&L omitted:", e.message);
    return undefined;
  });

  let pl, label;
  if (argv.includes("--today")) {
    pl = await getTodayPL(price);
    label = "Today";
  } else {
    const start = flag("--start");
    const end   = flag("--end");
    pl = await calculatePL({ start, end, currentPrice: price });
    label = start || end ? `${start || "start"} → ${end || "now"}` : "All time";
  }

  console.log("\n══════════════════════════════════════════");
  console.log(`   SOL/USDC P&L — ${label}`);
  console.log("══════════════════════════════════════════");
  if (price) console.log(`SOL price:         $${price.toFixed(2)}`);
  console.log(`Swaps:             ${pl.trades}  (${pl.buys} buy / ${pl.sells} sell)`);
  console.log(`Buy volume:        $${pl.buyVolume.toFixed(2)}`);
  console.log(`Sell volume:       $${pl.sellVolume.toFixed(2)}`);
  console.log(`──────────────────────────────────────────`);
  console.log(`SOL held (FIFO):   ${pl.solHoldings.toFixed(6)} SOL`);
  console.log(`Avg cost basis:    $${pl.avgCostBasis.toFixed(2)}`);
  console.log(`Realized P&L:      $${pl.realizedPL.toFixed(2)}`);
  console.log(`Unrealized P&L:    $${pl.unrealizedPL.toFixed(2)}`);
  console.log(`Total P&L:         $${pl.totalPL.toFixed(2)}`);
  console.log("══════════════════════════════════════════\n");
}
