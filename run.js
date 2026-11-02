// run.js — Daily accumulation run. The cron entrypoint.
//
//   node run.js                 execute today's decision
//   node run.js --explain       read-only: show the decision and every rail
//   node run.js --dry-run       quote and log, never submit
//   node run.js --json          machine-readable summary (for the launchd log)
//   node run.js --resolve-intent none|executed [--sig <sig>]
//
// There is deliberately no --force. Every rail here exists to stop a trade
// that shouldn't happen, and an override is the flag you'd reach for at
// exactly the moment your judgement is worst.

import "dotenv/config";
import { CONFIG, strategyAsset } from "./config.js";
import { loadWallet, publicKeyStr } from "./wallet.js";
import { getBalances, getPriceUsd, conn } from "./query.js";
import { executeSwap } from "./swap.js";
import { loadTransactions } from "./transactions.js";
import { plSummary } from "./pl.js";
import { loadState, saveState, acquireLock, releaseLock, utcDate } from "./state.js";
import { decide, decideSell, applyAction } from "./strategy.js";
import { syncPrices } from "./prices.js";
import { close as closeStorage, describe as describeStorage } from "./storage/index.js";

const argv    = process.argv.slice(2);
const has     = f => argv.includes(f);
const valueOf = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

const EXPLAIN = has("--explain");
const JSON_OUT = has("--json");
if (has("--dry-run")) CONFIG.dryRun = true;   // CONFIG is a live object by design

function log(...a) { if (!JSON_OUT) console.log(...a); }
function round2(n) { return Math.round(n * 100) / 100; }

// ── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Resolve a pending intent left by a crashed run.
 *
 * executeSwap appends to the trade log only AFTER on-chain confirmation, so a
 * process death in between leaves a real trade unlogged. The intent written
 * before the swap is what makes that recoverable.
 */
async function reconcile(state, pubkey) {
  const intent = state.pendingIntent;
  if (!intent) return { state, halted: false };

  log(`⚠️  Unresolved intent from ${intent.createdAt} — reconciling...`);

  // A custody transfer is a different shape entirely: it has no `usd`, so the
  // swap matcher below would divide by undefined, never match, and halt.
  if (intent.action.type === "TRANSFER") return reconcileTransfer(state, pubkey, intent);

  const txs = await loadTransactions({ includeDryRun: false });

  // A buy spends `usd` and moves the asset in; a take-profit sale spends
  // `units` of the asset and moves USDC in. Same matcher, different legs.
  const isSell  = intent.action.type === "SELL";
  const spends  = intent.action.amount ?? intent.action.usd;
  const assetSym = isSell ? intent.action.fromSym : intent.action.toSym;

  // A. Did the swap land and get logged?
  const match = txs.find(tx =>
    tx.timestamp >= intent.createdAt &&
    tx.fromSym === intent.action.fromSym &&
    tx.toSym === intent.action.toSym &&
    Math.abs(tx.fromAmount - spends) / spends < 0.02
  );

  if (match) {
    log(`   Found it in the trade log (${match.sig ?? "no sig"}). Applying.`);
    const next = applyAction(state, intent.action, { usdSpent: match.fromAmount }, { now: intent.createdAt });
    return { state: await saveState({ ...next, pendingIntent: null }), halted: false };
  }

  // B. Nothing logged. Did it happen anyway?
  const now = await getBalances(pubkey);
  const usdcMoved = Math.abs(now.usdc - intent.preBalances.usdc) > 0.5;

  // Add back anything the ledger already knows was deliberately moved to
  // custody since the intent was written. Without this a legitimate sweep
  // makes the asset balance drop, which reads as "the swap happened" and
  // halts the bot over a transfer it has a signed record of.
  const movedSince = txs
    .filter(t => t.type === "transfer_out" &&
                 t.timestamp >= intent.createdAt &&
                 t.fromSym === assetSym)
    .reduce((sum, t) => sum + t.fromAmount, 0);
  const assetNow = (now.bySymbol[assetSym] ?? 0) + movedSince;
  const assetMoved = Math.abs(assetNow - (intent.preBalances.asset ?? 0)) > 1e-6;

  if (!usdcMoved && !assetMoved) {
    log("   Balances unchanged — the swap never happened. Clearing.");
    return { state: await saveState({ ...state, pendingIntent: null }), halted: false };
  }

  // C. Ambiguous. Do not guess — a bot that invents its own ledger is worse
  //    than one that stops and asks.
  console.error(`
❌ UNRESOLVED INTENT — halting.

   Intended: ${spends} ${intent.action.fromSym} → ${intent.action.toSym}
   Created:  ${intent.createdAt}
   Balances moved but no matching trade was logged.

   USDC  ${intent.preBalances.usdc.toFixed(2)} → ${now.usdc.toFixed(2)}
   ${assetSym.padEnd(5)} ${(intent.preBalances.asset ?? 0).toFixed(6)} → ${(now.bySymbol[assetSym] ?? 0).toFixed(6)}

   Check https://solscan.io/account/${pubkey} then run one of:
     node run.js --resolve-intent executed --sig <signature>
     node run.js --resolve-intent none
`);
  return { state, halted: true };
}

/**
 * Resolve a pending TRANSFER intent.
 *
 * Same shape as the swap reconciler, with one difference that matters: a
 * transfer changes nothing in the budget ledger, so `applyAction` must NOT be
 * called. Doing so would decrement carry and increment buyCount for a move
 * that spent no budget and bought nothing.
 */
async function reconcileTransfer(state, pubkey, intent) {
  const { units, fromSym } = intent.action;

  // A. Did the transfer land and get logged?
  const match = (await loadTransactions({ includeDryRun: false })).find(tx =>
    tx.type === "transfer_out" &&
    tx.timestamp >= intent.createdAt &&
    tx.fromSym === fromSym &&
    Math.abs(tx.fromAmount - units) / units < 1e-6
  );

  if (match) {
    log(`   Found the move in the trade log (${match.sig ?? "no sig"}). Clearing.`);
    return { state: await saveState({ ...state, pendingIntent: null }), halted: false };
  }

  // B. Nothing logged. Did the balance move anyway?
  const now = await getBalances(pubkey);
  const assetNow = now.bySymbol[fromSym] ?? 0;
  if (Math.abs(assetNow - (intent.preBalances.asset ?? 0)) <= 1e-6) {
    log("   Balance unchanged — the transfer never happened. Clearing.");
    return { state: await saveState({ ...state, pendingIntent: null }), halted: false };
  }

  // C. The coins moved but nothing was logged. Do not guess.
  console.error(`
❌ UNRESOLVED TRANSFER — halting.

   Intended: move ${units} ${fromSym} → ${intent.action.dest}
   Created:  ${intent.createdAt}
   The balance moved but no transfer was logged.

   ${fromSym.padEnd(5)} ${(intent.preBalances.asset ?? 0).toFixed(6)} → ${assetNow.toFixed(6)}

   Check https://solscan.io/account/${pubkey} then run one of:
     node run.js --resolve-intent executed --sig <signature>
     node run.js --resolve-intent none
`);
  return { state, halted: true };
}

async function resolveIntentManually(state, mode, sig) {
  if (!state.pendingIntent) { log("No pending intent to resolve."); return; }
  const intent = state.pendingIntent;

  if (mode === "none") {
    await saveState({ ...state, pendingIntent: null });
    log("✅ Intent cleared — recorded as never executed.");
    return;
  }
  if (mode === "executed") {
    if (!sig) throw new Error("--resolve-intent executed requires --sig <signature>");

    if (intent.action.type === "TRANSFER") {
      // Write the missing ledger row. Merely clearing the intent would leave
      // the moved units uncounted forever, and the wallet would never
      // reconcile again. A transfer spends no budget, so no applyAction.
      const { recordTransfer } = await import("./transfer.js");
      await recordTransfer({
        units: intent.action.units,
        dest:  intent.action.dest,
        sig,
        at:    intent.createdAt,
      });
      await saveState({ ...state, pendingIntent: null });
      log(`✅ Transfer recorded as executed (${sig}).`);
      return;
    }

    const next = applyAction(state, intent.action, { usdSpent: intent.action.usd }, { now: intent.createdAt });
    await saveState({ ...next, pendingIntent: null });
    log(`✅ Intent recorded as executed (${sig}).`);
    return;
  }
  throw new Error(`Unknown --resolve-intent mode: ${mode}. Use "none" or "executed".`);
}

// ── Reporting ────────────────────────────────────────────────────────────────

function printRails(rails, title = "Rails") {
  log(`\n  ${title}`);
  for (const r of rails) {
    log(`   ${r.passed ? "✅" : "⛔"} ${r.name.padEnd(20)} ${r.detail}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const asset  = strategyAsset();
  const wallet = loadWallet();
  const pubkey = publicKeyStr(wallet);
  const now    = new Date().toISOString();

  const loaded = await loadState();
  if (loaded.corrupt) {
    throw new Error(`state.json was corrupt and has been preserved at ${loaded.backup}. ` +
                    `Inspect it and restore before running — refusing to trade from a reset ledger.`);
  }
  let state = loaded.state;

  // Manual intent resolution short-circuits everything else.
  const resolveMode = valueOf("--resolve-intent");
  if (resolveMode) return resolveIntentManually(state, resolveMode, valueOf("--sig"));

  const rec = await reconcile(state, pubkey);
  if (rec.halted) process.exitCode = 1;
  if (rec.halted) return;
  state = rec.state;

  // Price history is for the report's counterfactual only — never let it block.
  const priceSync = await syncPrices({ now: Date.now() });
  if (priceSync.stale) log(`⚠️  Price history stale: ${priceSync.error}`);

  const [spot, balances, txs] = await Promise.all([
    getPriceUsd(asset), getBalances(pubkey), loadTransactions(),
  ]);

  // How far underwater the position is, measured from the real trade log. This
  // is what sizes the dip boost, and it is the same function report.js prints
  // from — the bot cannot average down on a number the dashboard never showed.
  const pl = plSummary({ txs, asset, assetPrice: spot });

  const { action, rails } = decide({ state, balances, now, config: CONFIG, plPct: pl.plPct });

  // One swap per run, and the DCA goes first: a take-profit is only considered
  // on a run with no buy to make. The cron runs three times a day, so a sale
  // due on a buy day simply lands on the next run.
  const sell = action.type === "BUY" ? null : decideSell({
    state, balances, now, config: CONFIG,
    plPct: pl.plPct, positionUnits: pl.botUnits, assetPrice: spot,
  });

  log(`\n📅 ${utcDate(now)}   ${asset} $${spot.toFixed(2)}   [${describeStorage()}]`);
  log(`   Wallet: ${balances.usdc.toFixed(2)} USDC · ${(balances.bySymbol[asset] ?? 0).toFixed(6)} ${asset} · ${balances.sol.toFixed(4)} SOL`);
  log(`   Budget: $${action.budget.carryUsd.toFixed(2)} banked · $${action.budget.spentUsd.toFixed(2)} deployed lifetime`);
  log(`   P&L:    ${pl.plPct >= 0 ? "+" : ""}${pl.plPct.toFixed(2)}% on $${pl.netDeployedUsd.toFixed(2)} deployed` +
      (action.boost > 1 ? `  ·  ${action.boost.toFixed(2)}x dip boost` : ""));

  if (EXPLAIN) {
    printRails(rails);
    log(`\n   → ${action.type}: ${action.reason}`);
    if (sell) {
      printRails(sell.rails, "Take-profit");
      log(`\n   → ${sell.action.type}: ${sell.action.reason}`);
    }
    log("");
    if (JSON_OUT) console.log(JSON.stringify({ date: utcDate(now), spot, plPct: pl.plPct, action, rails, sell: sell ?? null }, null, 2));
    return;   // read-only: no state written
  }

  if (sell?.action.type === "SELL") return takeProfit({ state, action, sell: sell.action, balances, spot, pl, now, asset });

  if (action.type !== "BUY") {
    printRails(rails.filter(r => !r.passed));
    log(`\n   → HOLD: ${action.reason}\n`);
    await saveState({ ...applyAction(state, action, null, { now }), lastRun: { at: now, spot, action: "HOLD", reason: action.reason } });
    if (JSON_OUT) console.log(JSON.stringify({ date: utcDate(now), spot, action: "HOLD", reason: action.reason }));
    return;
  }

  log(`\n   → BUY $${action.usd} of ${asset}` +
      (action.boost > 1 ? ` (${action.boost.toFixed(2)}x dip boost)` : "") +
      `${CONFIG.dryRun ? "  (DRY RUN)" : ""}`);

  // Write the intent BEFORE the swap so a crash mid-flight is recoverable.
  if (!CONFIG.dryRun) {
    await saveState({
      ...state,
      pendingIntent: {
        createdAt: now,
        action,
        preBalances: { usdc: balances.usdc, asset: balances.bySymbol[asset] ?? 0 },
      },
    });
  }

  const fill = await executeSwap({
    fromSym: action.fromSym,
    toSym:   action.toSym,
    amount:  action.usd,
    price:   spot,
    intent:  action.intent,
  });

  // A dry run must not advance the idempotency key, or it would suppress the
  // real buy later the same day.
  if (CONFIG.dryRun) {
    log(`\n   (dry run — state not advanced)\n`);
    return;
  }

  const next = applyAction(state, action, { usdSpent: action.usd }, { now });
  await saveState({
    ...next,
    pendingIntent: null,
    lastRun: { at: now, spot, action: "BUY", usd: action.usd, boost: action.boost, plPct: round2(pl.plPct), received: fill.outAmount, sig: fill.sig ?? null },
  });

  log(`\n✅ Bought ${fill.outAmount.toFixed(6)} ${asset} for $${action.usd}\n`);
  if (JSON_OUT) console.log(JSON.stringify({ date: utcDate(now), spot, action: "BUY", usd: action.usd, boost: action.boost, plPct: pl.plPct, received: fill.outAmount, sig: fill.sig ?? null }));
}

/**
 * Execute a take-profit sale. Same intent-before-swap discipline as a buy, so
 * a crash mid-flight is reconciled rather than guessed at.
 *
 * `action` is decide()'s HOLD: folding it in first advances the day's accrual,
 * exactly as a plain HOLD run would have.
 */
async function takeProfit({ state, action, sell, balances, spot, pl, now, asset }) {
  log(`\n   → SELL ${sell.units.toFixed(6)} ${asset} (~$${sell.usd}) — P&L +${pl.plPct.toFixed(2)}%` +
      `${CONFIG.dryRun ? "  (DRY RUN)" : ""}`);

  const held = applyAction(state, action, null, { now });
  if (!CONFIG.dryRun) {
    await saveState({
      ...held,
      pendingIntent: {
        createdAt: now,
        action: sell,
        preBalances: { usdc: balances.usdc, asset: balances.bySymbol[asset] ?? 0 },
      },
    });
  }

  const fill = await executeSwap({
    fromSym: sell.fromSym,
    toSym:   sell.toSym,
    amount:  sell.units,
    price:   spot,
    intent:  sell.intent,
  });

  // As with a buy: a dry run must not start the cooldown.
  if (CONFIG.dryRun) {
    log(`\n   (dry run — state not advanced)\n`);
    return;
  }

  const next = applyAction(held, sell, null, { now });
  await saveState({
    ...next,
    pendingIntent: null,
    lastRun: { at: now, spot, action: "SELL", units: sell.units, plPct: round2(pl.plPct), received: fill.outAmount, sig: fill.sig ?? null },
  });

  log(`\n✅ Sold ${sell.units.toFixed(6)} ${asset} for $${fill.outAmount.toFixed(2)} USDC\n`);
  if (JSON_OUT) console.log(JSON.stringify({ date: utcDate(now), spot, action: "SELL", units: sell.units, plPct: pl.plPct, received: fill.outAmount, sig: fill.sig ?? null }));
}

let locked = false;
try {
  await acquireLock();
  locked = true;
  await main();
} catch (e) {
  console.error(`\n❌ ${e.message}\n`);
  process.exitCode = 1;
} finally {
  if (locked) await releaseLock();
  await closeStorage();
}
