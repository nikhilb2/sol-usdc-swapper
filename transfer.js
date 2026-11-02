// transfer.js — Move the accumulated LST to the safe wallet pinned in config.
//
// Usage: node transfer.js                move the entire balance (prompts)
//        node transfer.js --yes          skip the prompt
//        node transfer.js --dry-run      log without submitting
//        node transfer.js --record-only --units <n> --sig <sig> [--at <iso>]
//                                        declare a move you already made by hand
//
// This is a CUSTODY change, not a sale. The units keep their cost basis and
// keep counting in P&L; what changes is that the bot's wallet is no longer
// expected to hold them. See pl.js `replayFifo` and report.js `buildReport`.
//
// All-or-nothing by design. There is no partial amount, which removes an
// entire class of parameter tampering from the HTTP path and matches what the
// feature is for — sweeping to cold storage, not trading.

import {
  ComputeBudgetProgram, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import readline from "readline";
import "dotenv/config";

import { loadWallet, publicKeyStr } from "./wallet.js";
import { conn, getPriceUsd } from "./query.js";
import { CONFIG, decimalsFor, mintFor, strategyAsset, transferDestination } from "./config.js";
import { saveTransaction, loadTransactions } from "./transactions.js";

// An SPL token account is 165 bytes. Creating one for a destination that has
// never held this mint costs rent — recoverable by the destination owner if
// they ever close it, but it leaves THIS wallet either way.
const TOKEN_ACCOUNT_BYTES = 165;

// Base fee plus headroom for the priority fee, so the reserve check is not
// defeated by the very transaction it is guarding.
const FEE_BUDGET_LAMPORTS = 15_000;

/**
 * Validate the destination against the chain.
 *
 * config.js `transferDestination()` does everything checkable offline. This
 * adds the one thing only an RPC can answer: whether an on-curve address is a
 * plain wallet or something program-owned. Sending to a token account or a
 * program derives an ATA with no possible signer — an unrecoverable loss with
 * no attacker involved, which makes this the highest-stakes check in the code.
 */
export async function assertDestination(connection, wallet) {
  const dest = transferDestination();

  if (wallet && dest.equals(wallet.publicKey)) {
    throw new Error("TRANSFER_DESTINATION is the bot's own wallet — nothing to move.");
  }

  const info = await connection.getAccountInfo(dest);
  // null is the legitimate never-funded-wallet case, and exactly when the ATA
  // rent below applies.
  if (info) {
    if (info.executable) {
      throw new Error(`TRANSFER_DESTINATION ${dest.toBase58()} is an executable program, not a wallet. Refusing.`);
    }
    if (!info.owner.equals(SystemProgram.programId)) {
      throw new Error(
        `TRANSFER_DESTINATION ${dest.toBase58()} is owned by ${info.owner.toBase58()} — ` +
        `a token account, PDA or program, not a wallet. Refusing: an associated ` +
        `token account derived from it would have no signer, and the funds would be unrecoverable.`
      );
    }
  }
  return dest;
}

/**
 * Sweep the entire strategy-asset balance to the pinned destination.
 *
 * `connection` and `wallet` are injectable so the whole path is testable
 * against a stub without touching mainnet.
 *
 * @returns {Promise<{sig?: string, units: number, dest: string, dryRun?: boolean, destAtaCreated: boolean}>}
 */
export async function executeTransfer({
  intent = "manual",
  price,
  connection = conn,
  wallet = loadWallet(),
} = {}) {
  if (!CONFIG.transfer.enabled) {
    throw new Error("Transfers are disabled. Set TRANSFER_ENABLED=true to enable them.");
  }

  const asset    = strategyAsset();
  const mint     = new PublicKey(mintFor(asset));
  const decimals = decimalsFor(asset);
  const dest     = await assertDestination(connection, wallet);

  // 1. Resolve the token program rather than assuming it.
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error(`Mint ${mint.toBase58()} not found on chain.`);
  const programId = mintInfo.owner;

  if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
    // A transfer-fee extension makes the received amount differ from the sent
    // amount. The ledger row asserts they are equal, so writing one would be a
    // lie. Refuse rather than record something false.
    throw new Error(
      `${asset} is a Token-2022 mint. Transfers of Token-2022 assets are not supported: ` +
      `a transfer-fee extension would make the amount received differ from the amount sent, ` +
      `and the ledger row would misstate it.`
    );
  }
  if (!programId.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`Mint ${mint.toBase58()} is owned by ${programId.toBase58()}, which is not a token program.`);
  }

  // 2. The exact raw balance, straight from the RPC. Never a float round-trip:
  //    this is what guarantees the wallet drains to EXACTLY zero, which is in
  //    turn what lets the reconciliation hold afterwards.
  const srcAta = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, programId);
  const bal = await connection.getTokenAccountBalance(srcAta);
  if (bal.value.decimals !== decimals) {
    throw new Error(`Decimals mismatch for ${asset}: chain says ${bal.value.decimals}, config says ${decimals}.`);
  }
  const rawAmount = BigInt(bal.value.amount);
  if (rawAmount === 0n) throw new Error(`${asset} balance is zero — nothing to move.`);
  const units = Number(bal.value.uiAmountString ?? bal.value.uiAmount);

  // 3. Destination ATA. The getAccountInfo is only for the rent arithmetic —
  //    the instruction below is idempotent, so a race that creates the account
  //    between this read and the send is a no-op rather than a hard failure.
  const destAta  = getAssociatedTokenAddressSync(mint, dest, false, programId);
  const destInfo = await connection.getAccountInfo(destAta);

  // 4. Charge the rent against the gas reserve BEFORE it is spent. strategy.js
  //    silently blocks every future buy once SOL falls below the reserve, so a
  //    sweep that quietly crosses it would stop the bot without saying why.
  const solLamports = await connection.getBalance(wallet.publicKey);
  const rent = destInfo ? 0 : await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES);
  const remaining = solLamports - rent - FEE_BUDGET_LAMPORTS;
  if (remaining < CONFIG.swap.minSolReserveLamports) {
    throw new Error(
      `Transfer would leave ${(remaining / 1e9).toFixed(6)} SOL, below the ` +
      `${(CONFIG.swap.minSolReserveLamports / 1e9).toFixed(3)} SOL gas reserve` +
      (rent ? ` (${(rent / 1e9).toFixed(6)} SOL of it is rent for a new destination token account — ` +
              `recoverable by the destination owner, but it leaves this wallet)` : "") +
      `. Fund the wallet first: dropping below the reserve stops the daily buy.`
    );
  }

  console.log(`🔄 Moving ${units} ${asset} → ${dest.toBase58()}`);
  console.log(`   ${srcAta.toBase58()} → ${destAta.toBase58()}`);
  if (rent) console.log(`   creating destination token account (${(rent / 1e9).toFixed(6)} SOL rent)`);

  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CONFIG.transfer.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.transfer.priorityFeeMicroLamports }),
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, destAta, dest, mint, programId),
    createTransferCheckedInstruction(srcAta, mint, destAta, wallet.publicKey, rawAmount, decimals, [], programId),
  ];

  if (CONFIG.dryRun) {
    console.log(`🚫 DRY RUN — transaction not submitted`);
    await saveTransaction({
      type: "transfer_out", fromSym: asset, toSym: asset,
      fromAmount: units, toAmount: units, price, dryRun: true,
      intent, dest: dest.toBase58(),
    });
    return { dryRun: true, units, dest: dest.toBase58(), destAtaCreated: !destInfo };
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message()
  );
  tx.sign([wallet]);

  // 5. Simulate first. swap.js can skip this because Jupiter builds its own
  //    transaction; this one is hand-built, so a wrong ATA, wrong decimals or
  //    wrong program id should surface before we pay a fee for it.
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: false,
  });
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).slice(-8).join("\n     ");
    throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}\n     ${logs}`);
  }

  // 6. Send, retrying transient RPC errors — same discipline as executeSwap.
  const rawTx = tx.serialize();
  const attempts = CONFIG.swap.sendAttempts;
  let sig;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(`📤 Sending transaction (attempt ${attempt}/${attempts})...`);
      sig = await connection.sendRawTransaction(rawTx, { skipPreflight: false, maxRetries: 0 });
      break;
    } catch (e) {
      if (attempt === attempts) throw new Error(`Failed to send after ${attempts} attempts: ${e.message}`);
      console.log(`  ⚠️  Send failed (${e.message}), retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`⏳ Confirming: https://solscan.io/tx/${sig}`);
  const result = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(result.value.err)}`);
  }

  console.log(`✅ Moved ${units} ${asset} to ${dest.toBase58()}`);
  console.log(`   TX: https://solscan.io/tx/${sig}`);

  await saveTransaction({
    type: "transfer_out", fromSym: asset, toSym: asset,
    fromAmount: units, toAmount: units, price, sig,
    intent, dest: dest.toBase58(),
  });

  // Log-only verification. The row is already written; this just says loudly
  // if the chain disagrees with what we think happened.
  try {
    const after = await connection.getTokenAccountBalance(srcAta);
    if (BigInt(after.value.amount) !== 0n) {
      console.log(`   ⚠️  source still holds ${after.value.uiAmountString} ${asset} — expected zero`);
    }
  } catch { /* the account may have been closed; not an error */ }

  return { sig, units, rawAmount: rawAmount.toString(), dest: dest.toBase58(), destAtaCreated: !destInfo };
}

/**
 * Declare a move that was made outside the bot, with no on-chain action.
 * Retires an "unexplained" reconciliation line honestly, instead of the only
 * previous option — inventing a sell, which would book P&L that never happened.
 */
export async function recordTransfer({ units, sig, at, price, dest }) {
  const asset = strategyAsset();
  if (!Number.isFinite(units) || units <= 0) throw new Error(`--units must be a positive number, got: ${units}`);
  const destStr = dest ?? transferDestination().toBase58();
  await saveTransaction({
    type: "transfer_out", fromSym: asset, toSym: asset,
    fromAmount: units, toAmount: units, price, sig: sig || null,
    intent: "custody", dest: destStr, timestamp: at,
  });
  console.log(`✅ Recorded a move of ${units} ${asset} → ${destStr}${sig ? ` (${sig})` : ""}`);
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
  const argv = process.argv.slice(2);
  const has  = (f) => argv.includes(f);
  const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

  if (has("--dry-run")) CONFIG.dryRun = true;   // CONFIG is a live object by design

  const asset = strategyAsset();
  const price = await getPriceUsd(asset).catch(() => null);

  if (has("--record-only")) {
    return recordTransfer({
      units: parseFloat(flag("--units")),
      sig:   flag("--sig"),
      at:    flag("--at"),
      price,
    });
  }

  const wallet = loadWallet();
  const dest   = await assertDestination(conn, wallet);

  if (!has("--yes") && !has("-y") && !CONFIG.dryRun) {
    const { getBalances } = await import("./query.js");
    const balances = await getBalances(publicKeyStr(wallet));
    const units = balances.bySymbol[asset] ?? 0;
    const usd   = price ? ` (~$${(units * price).toFixed(2)})` : "";
    console.log(`\n⚠️  Move ${units.toFixed(6)} ${asset}${usd} to your safe wallet`);
    console.log(`    destination: ${dest.toBase58()}`);
    console.log(`    This is a custody change, not a sale: P&L keeps tracking these units.\n`);
    const ok = await confirmPrompt(`    Proceed on mainnet? [y/N] `);
    if (!ok) { console.log("Aborted."); process.exit(0); }
  }

  await executeTransfer({ intent: "custody", price });

  const moved = (await loadTransactions()).filter(t => t.type === "transfer_out");
  console.log(`\n   ${moved.length} move${moved.length === 1 ? "" : "s"} on record. Run \`node report.js\` to see the custody split.`);
}

if (process.argv[1]?.endsWith("transfer.js")) {
  try {
    await main();
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    process.exit(1);
  }
}
