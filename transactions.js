// transactions.js — Append-only trade log.
//
// Backed by Postgres when DATABASE_URL is set, JSONL files otherwise.
// See storage/index.js. All functions are async because the database is.

import { insertTransaction, selectTransactions, deleteTransactions } from "./storage/index.js";

/**
 * Append a trade-log record.
 * @param {Object} tx
 * @param {string} tx.type       — "buy" (USDC→asset) | "sell" (asset→USDC) |
 *   "transfer_out" (asset → the pinned safe wallet) | "transfer_in".
 *   A transfer is a custody move, not a disposal: both legs are the same
 *   symbol and the same amount, and it never books P&L.
 * @param {string} tx.fromSym    — source token symbol
 * @param {string} tx.toSym      — target token symbol
 * @param {number} tx.fromAmount — amount of source token spent
 * @param {number} tx.toAmount   — amount of target token received
 * @param {number} [tx.price]    — USD price of the non-USDC side at swap time
 * @param {string} [tx.sig]      — transaction signature
 * @param {boolean} [tx.dryRun]  — true if the swap was not submitted on-chain
 * @param {string} [tx.intent]   — "dca" (automated) | "manual" (hand-run CLI) |
 *   "custody" (a sweep to the safe wallet)
 * @param {string} [tx.dest]     — destination address, transfers only
 * @param {string} [tx.timestamp] — ISO timestamp; defaults to now (tests backdate it)
 */
export async function saveTransaction(tx) {
  const record = {
    timestamp:  tx.timestamp || new Date().toISOString(),
    type:       tx.type,
    fromSym:    tx.fromSym,
    toSym:      tx.toSym,
    fromAmount: tx.fromAmount,
    toAmount:   tx.toAmount,
    price:      tx.price ?? null,
    sig:        tx.sig || null,
    dryRun:     tx.dryRun === true,
    intent:     tx.intent || "manual",
    dest:       tx.dest || null,
  };
  return insertTransaction(record);
}

/** All logged swaps, oldest first. Dry-run records excluded by default. */
export async function loadTransactions({ includeDryRun = false } = {}) {
  try { return await selectTransactions({ includeDryRun }); }
  catch { return []; }
}

/** Delete the trade log (tests only). */
export async function clearTransactions() {
  await deleteTransactions();
}
