// swap.js — Execute a single SOL <-> USDC Jupiter swap with blockhash-aware
// confirmation, send retry, and trade logging.
//
// Usage: node swap.js <FROM> <TO> <AMOUNT>
//   node swap.js SOL USDC 1.5    sell 1.5 SOL for USDC
//   node swap.js USDC SOL 50     buy SOL with $50 USDC
//   node swap.js SOL USDC max    sell all SOL above the gas reserve
//   node swap.js USDC SOL max    spend the entire USDC balance
//
// Flags: --yes  skip the confirmation prompt
//        --slippage <bps>  override slippage for this swap

import { VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import readline from "readline";
import fetch from "node-fetch";
import "dotenv/config";
import { loadWallet, publicKeyStr } from "./wallet.js";
import { conn, getQuote, getBalances, getPriceUsd } from "./query.js";
import { CONFIG, decimalsFor, mintFor } from "./config.js";
import { saveTransaction } from "./transactions.js";

// ── Amount resolution ─────────────────────────────────────────────────────────

/**
 * Resolve "max" into a spendable amount, leaving the SOL gas reserve intact.
 * @returns {Promise<number>} amount of `fromSym` to swap
 */
export async function resolveMaxAmount(fromSym, pubkey) {
  const { sol, bySymbol } = await getBalances(pubkey, [fromSym]);

  if (fromSym === "SOL") {
    const reserve = CONFIG.swap.minSolReserveLamports / LAMPORTS_PER_SOL;
    const spendable = sol - reserve;
    if (spendable <= 0) {
      throw new Error(`SOL balance ${sol.toFixed(6)} is at or below the ${reserve} SOL gas reserve — nothing to swap`);
    }
    return spendable;
  }

  // Every other token (USDC and the LSTs) is a plain SPL balance. This used to
  // fall through to `usdc` for ANY non-SOL symbol, which would have silently
  // swapped the wrong token's balance once a third mint was added.
  const balance = bySymbol[fromSym] ?? 0;
  if (balance <= 0) throw new Error(`${fromSym} balance is zero — nothing to swap`);
  return balance;
}

// ── Settled amounts ───────────────────────────────────────────────────────────

/**
 * How much of `sym` the owner's balance moved in a confirmed transaction,
 * read from the transaction's own pre/post balances. Positive = received.
 *
 * This is what the trade log must record, not the quote. A quote's outAmount
 * is what Jupiter expected; the fill lands anywhere inside the slippage band,
 * and almost always slightly under. Logging the quote made the log overstate
 * every buy by 0–17 bps, and since the reconciler compares the log to the
 * wallet, that error accumulated as an "unexplained" shortfall.
 *
 * Pure over the RPC response so it can be tested without a network.
 * @returns {number|null} null when the owner has no balance entry for `sym`
 */
export function balanceDelta(tx, owner, sym) {
  const meta = tx?.meta;
  if (!meta) return null;

  if (sym === "SOL") {
    // Native lamports, fee added back: the fee is a cost of sending, not of
    // the swap. wrapAndUnwrapSol means the WSOL account is closed back into
    // this balance within the same transaction.
    const keys = tx.transaction.message.staticAccountKeys ?? tx.transaction.message.accountKeys;
    const i = keys.findIndex(k => k.toString() === owner);
    if (i < 0) return null;
    return (meta.postBalances[i] - meta.preBalances[i] + meta.fee) / LAMPORTS_PER_SOL;
  }

  const mint = mintFor(sym);
  const raw = arr => (arr ?? [])
    .filter(b => b.owner === owner && b.mint === mint)
    .reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  const pre  = (meta.preTokenBalances  ?? []).some(b => b.owner === owner && b.mint === mint);
  const post = (meta.postTokenBalances ?? []).some(b => b.owner === owner && b.mint === mint);
  if (!pre && !post) return null;
  return Number(raw(meta.postTokenBalances) - raw(meta.preTokenBalances)) / 10 ** decimalsFor(sym);
}

/**
 * The amounts a confirmed swap actually settled, falling back to the request
 * and the quote for whichever leg can't be read. A fallback is logged loudly:
 * it reintroduces exactly the drift this function exists to remove.
 */
async function settledAmounts({ sig, owner, fromSym, toSym, amount, outAmount }) {
  let tx = null;
  for (let attempt = 1; attempt <= 3 && !tx; attempt++) {
    tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })
      .catch(() => null);
    if (!tx && attempt < 3) await new Promise(r => setTimeout(r, 2000));
  }
  const spent    = tx ? balanceDelta(tx, owner, fromSym) : null;
  const received = tx ? balanceDelta(tx, owner, toSym)   : null;

  if (received === null || received <= 0) {
    console.log(`  ⚠️  Could not read the settled ${toSym} amount — logging the quote (${outAmount.toFixed(6)})`);
  }
  return {
    fromAmount: spent !== null && spent < 0 ? -spent : amount,
    toAmount:   received !== null && received > 0 ? received : outAmount,
  };
}

// ── Execute swap ──────────────────────────────────────────────────────────────

export async function executeSwap({ fromSym, toSym, amount, slippageBps, price, intent }) {
  const wallet = loadWallet();
  const pubkey = publicKeyStr(wallet);
  slippageBps ??= CONFIG.swap.slippageBps;

  const fromMint = mintFor(fromSym);
  const toMint   = mintFor(toSym);
  if (fromSym === toSym) throw new Error(`Cannot swap ${fromSym} for itself`);

  const fromDecimals = decimalsFor(fromSym);
  const toDecimals   = decimalsFor(toSym);
  const amountRaw    = Math.floor(amount * 10 ** fromDecimals);
  if (amountRaw <= 0) throw new Error(`Swap amount too small: ${amount} ${fromSym}`);

  // 1. Quote
  console.log(`🔄 Getting quote: ${amount} ${fromSym} → ${toSym}...`);
  const quote     = await getQuote({ inputMint: fromMint, outputMint: toMint, amountLamports: amountRaw, slippageBps });
  const outAmount = parseInt(quote.outAmount) / 10 ** toDecimals;
  const impact    = parseFloat(quote.priceImpactPct || 0);

  console.log(`  Expected out: ${outAmount.toFixed(6)} ${toSym}`);
  console.log(`  Price impact: ${impact.toFixed(4)}%`);
  console.log(`  Slippage:     ${slippageBps} bps`);

  if (impact > CONFIG.swap.maxPriceImpactPct) {
    throw new Error(`Price impact too high: ${impact}% > ${CONFIG.swap.maxPriceImpactPct}%`);
  }

  const type = fromSym === "USDC" ? "buy" : "sell";

  if (CONFIG.dryRun) {
    console.log(`🚫 DRY RUN — transaction not submitted`);
    await saveTransaction({ type, fromSym, toSym, fromAmount: amount, toAmount: outAmount, price, dryRun: true, intent });
    return { dryRun: true, outAmount, impact };
  }

  // 2. Fetch latest blockhash (needed for proper confirmation + expiry)
  const latestBlockhash = await conn.getLatestBlockhash("confirmed");

  // 3. Get the swap transaction from Jupiter
  console.log(`📡 Fetching swap transaction...`);
  const swapRes = await fetch(CONFIG.jupiter.swapUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(CONFIG.jupiter.apiKey ? { "x-api-key": CONFIG.jupiter.apiKey } : {}) },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: pubkey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });

  if (!swapRes.ok) {
    throw new Error(`Swap API error: ${swapRes.status} — ${await swapRes.text()}`);
  }

  const { swapTransaction } = await swapRes.json();

  // 4. Deserialize and sign
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);
  const rawTx = tx.serialize();

  // 5. Send, retrying transient RPC errors
  const attempts = CONFIG.swap.sendAttempts;
  let sig;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(`📤 Sending transaction (attempt ${attempt}/${attempts})...`);
      sig = await conn.sendRawTransaction(rawTx, {
        skipPreflight: false,
        maxRetries: 0,  // we handle retries ourselves
      });
      break;
    } catch (e) {
      if (attempt === attempts) throw new Error(`Failed to send after ${attempts} attempts: ${e.message}`);
      console.log(`  ⚠️  Send failed (${e.message}), retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // 6. Confirm against the blockhash we fetched, so an expired tx fails fast
  console.log(`⏳ Confirming: https://solscan.io/tx/${sig}`);
  const result = await conn.confirmTransaction(
    { signature: sig, ...latestBlockhash },
    "confirmed"
  );

  if (result.value.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(result.value.err)}`);
  }

  const settled = await settledAmounts({ sig, owner: pubkey, fromSym, toSym, amount, outAmount });

  console.log(`✅ Swap confirmed! ${settled.fromAmount} ${fromSym} → ${settled.toAmount.toFixed(6)} ${toSym}` +
    ` (quoted ${outAmount.toFixed(6)})`);
  console.log(`   TX: https://solscan.io/tx/${sig}`);

  await saveTransaction({ type, fromSym, toSym, ...settled, price, sig, intent });
  return { sig, outAmount: settled.toAmount, quotedOutAmount: outAmount, impact };
}

// ── Main (standalone) ─────────────────────────────────────────────────────────

function confirmPrompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(/^y(es)?$/i.test(answer.trim()));
  }));
}

async function main() {
  const argv     = process.argv.slice(2);
  const skipPrompt = argv.includes("--yes") || argv.includes("-y");
  const slipIdx  = argv.indexOf("--slippage");
  const slippageBps = slipIdx >= 0 ? parseInt(argv[slipIdx + 1]) : undefined;
  const positional = argv.filter((a, i) =>
    !a.startsWith("-") && !(slipIdx >= 0 && i === slipIdx + 1)
  );
  const [fromArg, toArg, amountArg] = positional;

  if (!fromArg || !toArg || !amountArg) {
    console.error("Usage: node swap.js <FROM> <TO> <AMOUNT|max> [--yes] [--slippage <bps>]");
    console.error("  e.g. node swap.js SOL USDC 1.5");
    console.error("       node swap.js USDC SOL 50");
    console.error("       node swap.js USDC JUPSOL 12");
    console.error("       node swap.js SOL USDC max --yes");
    process.exit(1);
  }

  const fromSym = fromArg.toUpperCase();
  const toSym   = toArg.toUpperCase();
  const pubkey  = publicKeyStr(loadWallet());

  let amount;
  if (amountArg.toLowerCase() === "max") {
    amount = await resolveMaxAmount(fromSym, pubkey);
    console.log(`ℹ️  max resolves to ${amount.toFixed(6)} ${fromSym}`);
  } else {
    amount = parseFloat(amountArg);
    if (!Number.isFinite(amount) || amount <= 0) {
      console.error(`Invalid amount: ${amountArg}`);
      process.exit(1);
    }
  }

  // Record the price of the non-USDC side alongside the trade, so P&L has a
  // reference point. For an LST this is the LST's own price, not SOL's — the
  // two differ by the accrued staking ratio and must never be conflated.
  const priced = fromSym === "USDC" ? toSym : fromSym;
  const price  = await getPriceUsd(priced).catch(() => null);

  if (!skipPrompt && !CONFIG.dryRun) {
    const usd = price ? (fromSym === "USDC" ? amount : amount * price) : null;
    const usdNote = usd ? ` (~$${usd.toFixed(2)})` : "";
    const ok = await confirmPrompt(`⚠️  Swap ${amount.toFixed(6)} ${fromSym} → ${toSym}${usdNote} on mainnet? [y/N] `);
    if (!ok) {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  await executeSwap({ fromSym, toSym, amount, slippageBps, price });
}

if (process.argv[1]?.endsWith("swap.js")) {
  try {
    await main();
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    process.exit(1);
  }
}
