// query.js — Balances, Jupiter quotes, and SOL mid-price
// Usage: node query.js                        show wallet balances + SOL price
//        node query.js --quote SOL USDC 1.5   quote only, no transaction

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import fetch from "node-fetch";
import "dotenv/config";
import { loadWallet, publicKeyStr } from "./wallet.js";
import { CONFIG, decimalsFor, mintFor, strategyAsset } from "./config.js";

export const conn = new Connection(CONFIG.rpcUrl, "confirmed");

// ── Balances ──────────────────────────────────────────────────────────────────

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export async function getSolBalance(pubkey) {
  const lamports = await withTimeout(conn.getBalance(new PublicKey(pubkey)), 10000, "getSolBalance");
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Token balance for a wallet, or 0 if the associated token account does not
 * exist yet.
 *
 * Only a genuinely absent account returns 0. Everything else — an RPC timeout,
 * a rate limit, a bad endpoint — is rethrown, because a swallowed failure here
 * is indistinguishable from an empty wallet: it would make the report claim
 * every unit was transferred out, and make run.js skip a buy day on a USDC
 * balance that only *looked* like zero.
 */
export async function getTokenBalance(pubkey, mintAddress) {
  const ata = await getAssociatedTokenAddress(
    new PublicKey(mintAddress),
    new PublicKey(pubkey)
  );
  try {
    const info = await withTimeout(conn.getTokenAccountBalance(ata), 10000, "getTokenBalance");
    return parseFloat(info.value.uiAmount ?? 0);
  } catch (e) {
    if (/could not find account|account not found/i.test(e.message)) return 0;
    throw new Error(`getTokenBalance(${mintAddress.slice(0, 6)}…): ${e.message}`);
  }
}

/**
 * Balances for a wallet.
 *
 * Always returns { sol, usdc } for backwards compatibility, plus `bySymbol`
 * keyed by token symbol. Any extra symbols requested are fetched in parallel;
 * the strategy asset is always included so callers never have to ask.
 *
 * @param {string} pubkey
 * @param {string[]} [extraSyms] — additional token symbols to fetch
 * @returns {Promise<{sol:number, usdc:number, bySymbol:Object<string,number>}>}
 */
export async function getBalances(pubkey, extraSyms = []) {
  const syms = [...new Set(["USDC", strategyAsset(), ...extraSyms])]
    .filter(s => s !== "SOL");

  const [sol, ...tokenBalances] = await Promise.all([
    getSolBalance(pubkey),
    ...syms.map(s => getTokenBalance(pubkey, mintFor(s))),
  ]);

  const bySymbol = { SOL: sol };
  syms.forEach((s, i) => { bySymbol[s] = tokenBalances[i]; });

  return { sol, usdc: bySymbol.USDC ?? 0, bySymbol };
}

// ── Jupiter quote ─────────────────────────────────────────────────────────────

async function fetchQuoteOnce(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {};
  if (CONFIG.jupiter.apiKey) headers["x-api-key"] = CONFIG.jupiter.apiKey;
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Jupiter's keyless tier rate-limits aggressively; back off and retry on 429.
async function fetchQuote(url, timeoutMs = 10000, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchQuoteOnce(url, timeoutMs);
    } catch (e) {
      if (e.status !== 429 || attempt >= attempts) throw e;
      const waitMs = 1000 * attempt;
      console.error(`  ⚠️  Jupiter rate-limited, retrying in ${waitMs / 1000}s...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

export async function getQuote({ inputMint, outputMint, amountLamports, slippageBps = CONFIG.swap.slippageBps }) {
  const url = `${CONFIG.jupiter.quoteUrl}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  return await fetchQuote(url, 10000);
}

/** Quote by token symbol + human amount. Returns { quote, outAmount, impact }. */
export async function quoteSwap({ fromSym, toSym, amount, slippageBps }) {
  const amountRaw = Math.floor(amount * 10 ** decimalsFor(fromSym));
  const quote = await getQuote({
    inputMint:  mintFor(fromSym),
    outputMint: mintFor(toSym),
    amountLamports: amountRaw,
    slippageBps,
  });
  return {
    quote,
    outAmount: parseInt(quote.outAmount) / 10 ** decimalsFor(toSym),
    impact:    parseFloat(quote.priceImpactPct || 0),
  };
}

// ── SOL mid-price via Jupiter ─────────────────────────────────────────────────

/**
 * USD mid-price for any supported token, derived from Jupiter quotes in both
 * directions so the spread is averaged out rather than paid.
 *
 * Costs 2 quote calls. Fine once a day; do not poll this.
 */
export async function getPriceUsd(sym) {
  if (sym === "USDC") return 1;

  const mint     = mintFor(sym);
  const ONE_UNIT = 10 ** decimalsFor(sym);
  const ONE_USDC = 1_000_000;

  const [sellQuote, buyQuote] = await Promise.all([
    getQuote({ inputMint: mint, outputMint: CONFIG.tokens.USDC, amountLamports: ONE_UNIT }),
    getQuote({ inputMint: CONFIG.tokens.USDC, outputMint: mint, amountLamports: ONE_USDC }),
  ]);

  const sellPrice = parseInt(sellQuote.outAmount) / ONE_USDC;
  const unitsPerDollar = parseInt(buyQuote.outAmount) / ONE_UNIT;
  const buyPrice = 1 / unitsPerDollar;

  const midPrice = (sellPrice + buyPrice) / 2;
  if (!midPrice || midPrice <= 0 || !Number.isFinite(midPrice)) {
    throw new Error(`Could not derive ${sym} mid-price from Jupiter`);
  }
  return midPrice;
}

export async function getSolPriceUsd() {
  return getPriceUsd("SOL");
}

/**
 * Spot USD prices for several tokens in ONE call to Jupiter's price API.
 *
 * This is the one to poll — the price alerts check every minute. It is a
 * reference price, not an executable one, which is exactly right for "tell me
 * when SOL is below $150" and wrong for sizing a trade; swaps use quotes.
 *
 * A symbol Jupiter has no price for is simply absent from the result, so one
 * missing token cannot blind the alerts on the others.
 *
 * @param {string[]} syms
 * @returns {Promise<Object<string, number>>}
 */
export async function getSpotPricesUsd(syms) {
  const bySym = Object.fromEntries([...new Set(syms)].map(s => [s, mintFor(s)]));
  const url = `${CONFIG.jupiter.priceUrl}?ids=${Object.values(bySym).join(",")}`;
  const body = await fetchQuote(url, 10000);

  const out = {};
  for (const [sym, mint] of Object.entries(bySym)) {
    const p = Number(body?.[mint]?.usdPrice);
    if (Number.isFinite(p) && p > 0) out[sym] = p;
  }
  return out;
}

/**
 * How many SOL one unit of an LST is worth, at market.
 *
 * This is the number that actually matters for accumulation: it only ratchets
 * upward as staking rewards accrue, so tracking it separates "my stack grew
 * because of yield" from "my stack is worth more because SOL went up".
 */
export async function getLstSolRatio(sym) {
  const [lstUsd, solUsd] = await Promise.all([getPriceUsd(sym), getPriceUsd("SOL")]);
  return lstUsd / solUsd;
}

// ── Main (standalone query tool) ─────────────────────────────────────────────

async function main() {
  const wallet = loadWallet();
  const pubkey = publicKeyStr(wallet);

  console.log(`\n🔑 Wallet: ${pubkey}`);

  const [{ sol, usdc }, price] = await Promise.all([
    getBalances(pubkey),
    getSolPriceUsd().catch(e => { console.error("Price fetch failed:", e.message); return null; }),
  ]);

  console.log(`💰 SOL:  ${sol.toFixed(6)} SOL`);
  console.log(`💵 USDC: ${usdc.toFixed(2)} USDC`);
  if (price) {
    console.log(`📈 SOL mid-price: $${price.toFixed(2)}`);
    console.log(`📊 Portfolio value: $${(sol * price + usdc).toFixed(2)}`);
  }

  const args = process.argv.slice(2);
  if (args[0] === "--quote") {
    const fromSym = args[1]?.toUpperCase() || "SOL";
    const toSym   = args[2]?.toUpperCase() || "USDC";
    const amount  = parseFloat(args[3] || "1");
    console.log(`\n🔄 Quote: ${amount} ${fromSym} → ${toSym}`);
    const { quote, outAmount, impact } = await quoteSwap({ fromSym, toSym, amount });
    console.log(`  Out:          ${outAmount.toFixed(6)} ${toSym}`);
    console.log(`  Rate:         ${(outAmount / amount).toFixed(6)} ${toSym} per ${fromSym}`);
    console.log(`  Price impact: ${impact.toFixed(4)}%`);
    console.log(`  Route:        ${quote.routePlan?.map(r => r.swapInfo?.label).join(" → ")}`);
  }
}

if (process.argv[1]?.endsWith("query.js")) {
  try {
    await main();
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    process.exit(1);
  }
}
