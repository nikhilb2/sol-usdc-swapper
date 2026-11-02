// report.js — SOL-denominated scorecard
//
// Answers the only question that matters: do I have more SOL than if I had
// just bought every day and done nothing?
//
// Everything is denominated in SOL, not USD. An LST's USD price rises from
// BOTH the SOL price moving and staking rewards accruing; multiplying by the
// live LST/SOL ratio separates those, so "my stack grew" never gets confused
// with "SOL went up".
//
// Residual un-deployed cash is valued at the current price and counted. This
// is not optional bookkeeping: a strategy that quietly holds cash looks great
// on SOL-bought alone, and that flattery is exactly how a losing rule survives.

import "dotenv/config";
import { CONFIG, strategyAsset } from "./config.js";
import { loadWallet, publicKeyStr } from "./wallet.js";
import { getBalances, getPriceUsd } from "./query.js";
import { loadTransactions } from "./transactions.js";
import { loadState } from "./state.js";
import { loadCloses, closeOn } from "./prices.js";
import { plSummary } from "./pl.js";
import { close as closeStorage } from "./storage/index.js";

const DAY_MS = 86_400_000;
const dateKey = d => new Date(d).toISOString().slice(0, 10);

/**
 * What a flat "buy bare SOL every day and do nothing else" strategy would hold.
 *
 * Two benchmarks, because they answer different questions and a single number
 * would hide one of them:
 *
 *   sameCapital  — spread the SAME dollars the bot actually deployed evenly
 *                  across the window. Isolates the decision (which asset, at
 *                  what prices) from how much got funded. This is the primary
 *                  metric: it is the one that cannot be gamed by under- or
 *                  over-deploying.
 *
 *   sameSchedule — $dailyUsd every single day regardless of what the bot did.
 *                  Catches the opposite failure: days missed because the
 *                  wallet ran dry or the machine was asleep are a real cost,
 *                  and this is where they show up.
 */
export function flatCounterfactual({ startDate, endDate, dailyUsd, usdDeployed, closes }) {
  const days = [];
  for (let t = Date.parse(`${startDate}T00:00:00Z`); t <= Date.parse(`${endDate}T00:00:00Z`); t += DAY_MS) {
    const close = closeOn(dateKey(t), closes);
    if (close) days.push(close);
  }
  if (!days.length) return null;

  const perDay = usdDeployed / days.length;
  return {
    days: days.length,
    sameCapital:  { sol: days.reduce((s, c) => s + perDay / c, 0),  spent: usdDeployed },
    sameSchedule: { sol: days.reduce((s, c) => s + dailyUsd / c, 0), spent: dailyUsd * days.length },
  };
}

/**
 * The scorecard.
 *
 * Attribution rule: **the log defines the position, the wallet defines the
 * reconciliation.** Every performance number below is computed from the units
 * this bot actually bought. Units that appear in the wallet but not in the log
 * — a pre-existing bag, a manual swap, a transfer in — are reported on their
 * own line and never enter a benchmark or a P&L, because the bot cannot know
 * what they cost.
 *
 * Mixing the two is not a cosmetic error: an undeclared bag has no cost basis,
 * so measuring it against capital the bot did deploy reads as free profit, and
 * a transfer out reads as a catastrophic loss.
 *
 * A declared custody transfer is the one case where the wallet is EXPECTED to
 * hold less than the log implies. Those units are still owned and still carry
 * their cost basis, so nothing in the P&L moves; what changes is that the
 * reconciler stops looking for them here. An UNdeclared shortfall still fails
 * reconciliation, which is the whole point of keeping the check.
 *
 * @param {number} held — the wallet's balance of `asset`, from the chain
 * @param {number} [openingUnits] — units held before the bot started; declared
 *   by a human via STRATEGY_OPENING_UNITS, since the bot never saw the trade
 * @param {number|null} [destUnits] — the safe wallet's balance of `asset`, from
 *   the chain. Optional: it needs no key, but it needs an RPC round-trip, and
 *   an RPC hiccup must never take down the report. null = not checked.
 */
export function buildReport({
  txs, state, asset, assetPrice, solPrice, held, closes,
  openingUnits = CONFIG.strategy.openingUnits,
  destUnits = null,
}) {
  const ratio = assetPrice / solPrice;          // SOL per unit of the LST

  // Position, cost and P&L come from pl.js — the same function strategy.js
  // sizes the dip boost from. Recomputing them here would let the scorecard
  // and the bot disagree about how far underwater the position is.
  //
  // plSummary scopes to `asset` on BOTH legs; an unscoped `type === "buy"`
  // filter would count a buy of some other token as if it had bought this one.
  const pl = plSummary({ txs, asset, assetPrice });
  const {
    buys, sells, transfers, unitsBought, unitsSold, botUnits,
    movedUnits, custodyUnits, movedValueUsd, custodyValueUsd,
    usdIn, usdOut, netDeployedUsd, costBasisUsd,
    currentValueUsd, realizedPlUsd, unrealizedPlUsd, plUsd, plPct,
  } = pl;

  const dca = buys.filter(t => t.intent === "dca");

  // ── Attribution ────────────────────────────────────────────────────────────
  const walletUnits   = held;                      // what the chain says we hold
  const externalUnits = walletUnits - botUnits;    // everything the bot didn't do

  // An LST accrues value through its SOL ratio, never by rebasing units, so a
  // unit-count gap is always external activity — not staking. (This scheme
  // would be wrong for a rebasing token.)
  // What THIS wallet should hold: everything the bot bought, minus what it
  // deliberately moved to safer custody, plus a declared pre-existing bag.
  // Identical to the old `externalUnits - openingUnits` whenever nothing has
  // been moved, so a bot-only wallet reconciles exactly as it always did.
  const expectedUnits    = custodyUnits + openingUnits;
  const unexplainedUnits = walletUnits - expectedUnits;
  const explainedUnits   = expectedUnits;

  // Signed deliberately: holding LESS than the log implies (an UNdeclared
  // transfer out, or the wrong wallet in .env) is a different problem from
  // holding more. After a full declared move `explainedUnits` is 0 and the
  // band collapses to the dust floor — correct, because an emptied wallet
  // must reconcile at exactly zero, and transfer.js moves the exact raw
  // balance precisely so that it does.
  const DUST = 1e-6;
  const reconciled = Math.abs(unexplainedUnits) <= Math.max(DUST, 0.02 * Math.abs(explainedUnits));

  // Second-stage reconciliation. The honest cost of treating a move as a
  // custody change is that the report now marks to market units it cannot see
  // from this wallet. Reading the destination's balance closes that gap.
  // A shortfall is a problem; a surplus is not — the safe wallet is a real
  // wallet and may hold the same asset from elsewhere.
  const destShortfall  = destUnits === null ? null : Math.max(0, movedUnits - destUnits);
  const destReconciled = destUnits === null
    ? null
    : (movedUnits - destUnits) <= Math.max(DUST, 0.02 * Math.abs(movedUnits));

  // ── SOL-equivalents ────────────────────────────────────────────────────────
  // Clamped: a negative log-implied position must not poison the benchmark.
  const botSolEquiv    = Math.max(botUnits, 0) * ratio;
  const walletSolEquiv = walletUnits * ratio;
  const movedSolEquiv   = Math.max(movedUnits, 0) * ratio;
  const custodySolEquiv = Math.max(custodyUnits, 0) * ratio;
  const carryUsd       = state.budget.carryUsd;
  const carrySolEquiv  = solPrice > 0 ? carryUsd / solPrice : 0;
  const totalSolEquiv  = botSolEquiv + carrySolEquiv;

  // ── Cost and P&L, USD ──────────────────────────────────────────────────────
  // Destructured from plSummary above. Cost is net of sells, and FIFO, so a
  // sell retires the cost of the units it actually sold.
  //
  // Banked carry is excluded on purpose. P&L asks "did the position I bought go
  // up?", and cash is not a position — folding it in would flatter the number
  // for simply not trading. It IS counted in the SOL benchmark below, which
  // asks a different question ("did the rule beat doing nothing?") and one that
  // hoarding cash genuinely can game.

  // ── P&L in SOL — the actual thesis ─────────────────────────────────────────
  // What those same dollars would have been in bare SOL at the moments they
  // were really deployed. Distinct from flat.sameCapital below, which spreads
  // them evenly across the window instead.
  let deployedSolAtCost = null;
  if (closes?.length && buys.length) {
    let sol = 0, ok = true;
    for (const t of [...buys, ...sells]) {
      const close = closeOn(dateKey(t.timestamp), closes);
      if (!close) { ok = false; break; }
      sol += (t.type === "buy" ? t.fromAmount : -t.toAmount) / close;
    }
    if (ok) deployedSolAtCost = sol;
  }
  const plSol    = deployedSolAtCost === null ? null : botSolEquiv - deployedSolAtCost;
  const plSolPct = deployedSolAtCost > 0 ? (plSol / deployedSolAtCost) * 100 : null;

  const startDate = state.startDate || (buys.length ? dateKey(buys[0].timestamp) : null);
  // The window ends at the last real buy, not today: giving the benchmark
  // days the bot never traded would make it beat a strategy that did nothing
  // wrong. Compare over the period actually contested.
  const endDate = buys.length ? dateKey(buys[buys.length - 1].timestamp) : startDate;

  const flat = startDate && buys.length
    ? flatCounterfactual({ startDate, endDate, dailyUsd: CONFIG.strategy.dailyUsd, usdDeployed: netDeployedUsd, closes })
    : null;

  // Fold the benchmark delta in here so the CLI and the dashboard cannot
  // disagree about it.
  if (flat) {
    for (const b of [flat.sameCapital, flat.sameSchedule]) {
      b.deltaSol = totalSolEquiv - b.sol;
      b.deltaPct = b.sol > 0 ? (b.deltaSol / b.sol) * 100 : 0;
    }
  }

  return {
    asset, ratio, assetPrice, solPrice,

    // attribution
    walletUnits, botUnits, openingUnits, externalUnits, unexplainedUnits, reconciled,
    expectedUnits,

    // custody — where the bot's units physically sit
    movedUnits, custodyUnits, movedValueUsd, custodyValueUsd,
    movedSolEquiv, custodySolEquiv,
    transferCount: transfers.length,
    lastTransferAt: transfers.length ? transfers[transfers.length - 1].timestamp : null,
    destination: CONFIG.transfer.destination
      ? `${CONFIG.transfer.destination.slice(0, 4)}…${CONFIG.transfer.destination.slice(-4)}`
      : null,
    destUnits, destShortfall, destReconciled,

    // SOL-equivalents
    botSolEquiv, walletSolEquiv, carryUsd, carrySolEquiv, totalSolEquiv,

    // cost
    usdIn, usdOut, netDeployedUsd, unitsBought, unitsSold, costBasisUsd,
    avgCostUsd: botUnits > 0 ? costBasisUsd / botUnits : 0,
    buyCount: buys.length, sellCount: sells.length, dcaCount: dca.length,

    // P&L
    currentValueUsd, realizedPlUsd, unrealizedPlUsd, plUsd, plPct,
    deployedSolAtCost, plSol, plSolPct,

    startDate, endDate, flat,

    // Deprecated aliases, kept so /api/status and --json stay a superset.
    // NOTE: usdDeployed is now net of sells (identical while sellCount === 0).
    held: walletUnits, heldSolEquiv: walletSolEquiv, usdDeployed: netDeployedUsd,
  };
}

function fmt(n, d = 4) { return Number(n).toFixed(d); }

function render(r) {
  const line = "═".repeat(52);
  const out = [];
  const money = (n) => `$${fmt(n, 2)}`;
  const signedUsd = (n) => `${n >= 0 ? "+" : "-"}$${fmt(Math.abs(n), 2)}`;
  const signedNum = (n, d = 4) => `${n >= 0 ? "+" : ""}${fmt(n, d)}`;

  out.push(`\n${line}`);
  out.push(`   SOL Accumulation Scorecard`);
  out.push(line);

  out.push(`\n  Position — bot-attributed`);
  out.push(`    ${r.asset.padEnd(20)} ${fmt(r.botUnits, 6)}`);
  out.push(`    ${(r.asset + "/SOL ratio").padEnd(20)} ${fmt(r.ratio, 5)}   (accrues with staking rewards)`);
  out.push(`    ${"SOL-equivalent".padEnd(20)} ${fmt(r.botSolEquiv)} SOL`);
  if (r.carryUsd > 0.005) {
    out.push(`    ${"banked cash".padEnd(20)} ${money(r.carryUsd)}  (= ${fmt(r.carrySolEquiv)} SOL)`);
    out.push(`    ${"TOTAL".padEnd(20)} ${fmt(r.totalSolEquiv)} SOL`);
  }

  // Where the units actually sit. Shown only once something has been moved.
  if (r.movedUnits > 1e-9) {
    out.push(`\n  Custody`);
    out.push(`    ${"attributed, here".padEnd(20)} ${fmt(r.custodyUnits, 6)}   (= ${fmt(r.custodySolEquiv)} SOL)`);
    if (Math.abs(r.walletUnits - r.custodyUnits) > 1e-6) {
      out.push(`    ${"wallet really holds".padEnd(20)} ${fmt(r.walletUnits, 6)}   ⚠️  see the reconciliation below`);
    }
    out.push(`    ${"moved to safe wallet".padEnd(20)} ${fmt(r.movedUnits, 6)}   (= ${fmt(r.movedSolEquiv)} SOL)  ← still yours; P&L tracks it`);
    if (r.destination) out.push(`    ${"destination".padEnd(20)} ${r.destination}`);
    if (r.destUnits !== null) {
      out.push(r.destReconciled
        ? `    ${"safe wallet holds".padEnd(20)} ${fmt(r.destUnits, 6)}   ✅ covers the moved amount`
        : `    ${"safe wallet holds".padEnd(20)} ${fmt(r.destUnits, 6)}   ⚠️  short by ${fmt(r.destShortfall, 6)}`);
    }
    if (r.lastTransferAt) out.push(`    ${"last moved".padEnd(20)} ${r.lastTransferAt}`);
  }

  // Hidden entirely for a clean bot-only wallet — no noise when there is
  // nothing to reconcile.
  if (Math.abs(r.externalUnits) > 1e-6 || r.openingUnits > 0) {
    out.push(`\n  Wallet reconciliation`);
    out.push(`    ${"wallet holds".padEnd(20)} ${fmt(r.walletUnits, 6)} ${r.asset}`);
    out.push(`    ${"bot-attributed".padEnd(20)} ${fmt(r.botUnits, 6)}   ← everything else uses this`);
    if (r.movedUnits > 1e-9) {
      out.push(`    ${"moved to custody".padEnd(20)} ${fmt(r.movedUnits, 6)}   (declared, not expected here)`);
      out.push(`    ${"expected here".padEnd(20)} ${fmt(r.expectedUnits, 6)}`);
    }
    if (r.openingUnits > 0) {
      out.push(`    ${"opening balance".padEnd(20)} ${fmt(r.openingUnits, 6)}   (declared, STRATEGY_OPENING_UNITS)`);
    }
    if (r.reconciled) {
      out.push(`    ${"unexplained".padEnd(20)} ${fmt(r.unexplainedUnits, 6)}   ✅ reconciled`);
    } else {
      const dir = r.unexplainedUnits < 0 ? "wallet holds LESS than the log implies" : "not from the trade log";
      out.push(`    ${"unexplained".padEnd(20)} ${signedNum(r.unexplainedUnits, 6)}   ⚠️  ${dir}`);
      out.push(`    ${"".padEnd(20)} a transfer, a trade made outside the bot, or the`);
      out.push(`    ${"".padEnd(20)} wrong wallet in .env. Declare a known pre-existing`);
      out.push(`    ${"".padEnd(20)} balance with STRATEGY_OPENING_UNITS; declare a move`);
      out.push(`    ${"".padEnd(20)} you made by hand with:`);
      out.push(`    ${"".padEnd(20)}   node transfer.js --record-only --units <n> --sig <sig>`);
    }
  }

  out.push(`\n  Cost`);
  if (r.sellCount > 0) {
    out.push(`    ${"USDC in".padEnd(20)} ${money(r.usdIn)}`);
    out.push(`    ${"USDC out (sells)".padEnd(20)} ${money(r.usdOut)}`);
  }
  out.push(`    ${"net deployed".padEnd(20)} ${money(r.netDeployedUsd)}`);
  out.push(`    ${"avg cost (FIFO)".padEnd(20)} ${money(r.avgCostUsd)}/${r.asset}`);
  out.push(`    ${"buys".padEnd(20)} ${r.buyCount}  (${r.dcaCount} automated)` +
           (r.sellCount ? ` · ${r.sellCount} sell${r.sellCount > 1 ? "s" : ""}` : ""));

  out.push(`\n  Profit / loss — position only, banked cash excluded`);
  out.push(`    ${"value now".padEnd(20)} ${money(r.currentValueUsd)}   (${fmt(r.botUnits, 6)} × ${money(r.assetPrice)})`);
  out.push(`    ${"cost basis".padEnd(20)} ${money(r.costBasisUsd)}`);
  if (r.sellCount > 0) {
    out.push(`    ${"realized".padEnd(20)} ${signedUsd(r.realizedPlUsd)}`);
    out.push(`    ${"unrealized".padEnd(20)} ${signedUsd(r.unrealizedPlUsd)}`);
  }
  out.push(`    ${"TOTAL".padEnd(20)} ${signedUsd(r.plUsd)}   (${signedNum(r.plPct, 2)}%)`);

  if (r.deployedSolAtCost !== null) {
    out.push(`\n    in SOL terms — the thesis`);
    out.push(`      ${"same $ in bare SOL".padEnd(18)} ${fmt(r.deployedSolAtCost)} SOL  (at the moments you bought)`);
    out.push(`      ${"you hold".padEnd(18)} ${fmt(r.botSolEquiv)} SOL`);
    out.push(`      ${"difference".padEnd(18)} ${signedNum(r.plSol)} SOL   (${signedNum(r.plSolPct, 2)}%)`);
  }

  if (r.flat) {
    const bench = (label, b, note) => {
      out.push(`\n    ${label}`);
      out.push(`      ${"deploys".padEnd(18)} ${money(b.spent)}  →  ${fmt(b.sol)} SOL`);
      out.push(`      ${"you hold".padEnd(18)} ${fmt(r.totalSolEquiv)} SOL`);
      out.push(`      ${"difference".padEnd(18)} ${signedNum(b.deltaSol)} SOL   (${signedNum(b.deltaPct, 2)}%)`);
      if (note) out.push(`      ${note}`);
    };

    out.push(`\n  Benchmark — buying bare SOL instead`);
    out.push(`    window ${r.startDate} → ${r.endDate}  (${r.flat.days} days)`);
    bench("Same capital (primary)", r.flat.sameCapital,
          "the honest read: same dollars, spread evenly");
    bench("Same schedule", r.flat.sameSchedule,
          `$${CONFIG.strategy.dailyUsd}/day every day — gaps show up here`);
  } else {
    out.push(`\n  Benchmark unavailable — no completed buys yet.`);
  }

  out.push(`\n${line}\n`);
  return out.join("\n");
}

async function main() {
  const asset  = strategyAsset();
  const pubkey = publicKeyStr(loadWallet());

  const [balances, assetPrice, solPrice] = await Promise.all([
    getBalances(pubkey),
    getPriceUsd(asset),
    getPriceUsd("SOL"),
  ]);

  const [txs, loaded, closes] = await Promise.all([
    loadTransactions({ includeDryRun: false }),
    loadState(),
    loadCloses(),
  ]);

  const r = buildReport({
    txs,
    state: loaded.state,
    asset,
    assetPrice,
    solPrice,
    held: balances.bySymbol[asset] ?? 0,
    closes,
  });

  if (process.argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else console.log(render(r));
}

if (process.argv[1]?.endsWith("report.js")) {
  try { await main(); }
  catch (e) { console.error(`\n❌ ${e.message}\n`); process.exitCode = 1; }
  finally { await closeStorage(); }
}
