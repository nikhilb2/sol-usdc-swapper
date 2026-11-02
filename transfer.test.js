// transfer.test.js — The custody transfer path and the HTTP guards.
// Run: node transfer.test.js
//
// No network. The chain is a stub, so the instruction layout, the raw-amount
// arithmetic and every refusal are asserted without touching mainnet.

import fs from "fs";
import os from "os";
import path from "path";

const TEST_DIR = path.join(os.tmpdir(), "sol-usdc-swapper-transfer-test");
process.env.DATA_DIR = TEST_DIR;
process.env.STORAGE_BACKEND = "files";
process.env.STRATEGY_ASSET = "JUPSOL";
process.env.TRANSFER_ENABLED = "true";
process.env.TRANSFER_DESTINATION = "6C49kcijBHQNHFPieMn4BRjT3owZQ6wCckbCHbYnpzf1";
fs.mkdirSync(TEST_DIR, { recursive: true });

const w3  = await import("@solana/web3.js");
const spl = await import("@solana/spl-token");
const { CONFIG, transferDestination } = await import("./config.js");
const { executeTransfer, assertDestination } = await import("./transfer.js");
const { loadTransactions, clearTransactions } = await import("./transactions.js");
const guard = await import("./transfer-guard.js");

const { PublicKey, Keypair, SystemProgram, TransactionMessage } = w3;

const DEST  = new PublicKey("6C49kcijBHQNHFPieMn4BRjT3owZQ6wCckbCHbYnpzf1");
const MINT  = new PublicKey(CONFIG.tokens.JUPSOL);
const WALLET = Keypair.generate();

let failures = 0;
async function test(name, fn) {
  try { await clearTransactions(); await fn(); console.log(`✅ ${name}`); }
  catch (e) { failures++; console.error(`❌ ${name}: ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); }
async function throws(fn, re, m) {
  try { await fn(); } catch (e) { if (re.test(e.message)) return; throw new Error(`${m}: wrong error — ${e.message}`); }
  throw new Error(`${m}: expected a throw`);
}

// ── A stub chain ─────────────────────────────────────────────────────────────

function stubConnection(over = {}) {
  const sent = [];
  const state = {
    // 9-decimal balance a float round-trip would mangle: 3.117400123 SOL-scale.
    srcAmount: "3117400123",
    destAtaExists: true,
    solLamports: 200_000_000,
    mintOwner: spl.TOKEN_PROGRAM_ID,
    destOwner: SystemProgram.programId,
    destExists: true,
    simErr: null,
    confirmErr: null,
    ...over,
  };
  const srcAta  = spl.getAssociatedTokenAddressSync(MINT, WALLET.publicKey, false, spl.TOKEN_PROGRAM_ID);
  const destAta = spl.getAssociatedTokenAddressSync(MINT, DEST, false, spl.TOKEN_PROGRAM_ID);

  return {
    state, sent, srcAta, destAta,
    async getAccountInfo(pk) {
      if (pk.equals(MINT)) return { owner: state.mintOwner, executable: false, lamports: 1 };
      if (pk.equals(DEST)) return state.destExists ? { owner: state.destOwner, executable: !!state.destExecutable, lamports: 1 } : null;
      if (pk.equals(destAta)) return state.destAtaExists ? { owner: spl.TOKEN_PROGRAM_ID, lamports: 1 } : null;
      return null;
    },
    async getTokenAccountBalance() {
      return { value: { amount: state.srcAmount, decimals: 9, uiAmountString: String(Number(state.srcAmount) / 1e9), uiAmount: Number(state.srcAmount) / 1e9 } };
    },
    async getBalance() { return state.solLamports; },
    async getMinimumBalanceForRentExemption() { return 2_039_280; },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 }; },
    async simulateTransaction(tx) { sent.push({ kind: "sim", tx }); return { value: { err: state.simErr, logs: ["log"] } }; },
    async sendRawTransaction(raw) { sent.push({ kind: "send", raw }); return "SiGnAtUrE1111"; },
    async confirmTransaction() { return { value: { err: state.confirmErr } }; },
  };
}

// ── Destination validation — the unrecoverable-loss surface ──────────────────

await test("transferDestination accepts a real wallet address", async () => {
  assertEq(transferDestination().toBase58(), DEST.toBase58(), "round-trips");
});

await test("transferDestination rejects every malformed destination", async () => {
  const orig = CONFIG.transfer.destination;
  const bad = {
    "": /not set/,
    "not-an-address": /not a valid Solana address/,
    "1111": /not a valid Solana address/,
  };
  for (const [value, re] of Object.entries(bad)) {
    CONFIG.transfer.destination = value;
    await throws(async () => transferDestination(), re, `"${value}"`);
  }

  // A PDA is off the curve: it has no private key, so an ATA derived from it
  // could never be signed for and the funds would be lost permanently.
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("seed")], spl.ASSOCIATED_TOKEN_PROGRAM_ID);
  CONFIG.transfer.destination = pda.toBase58();
  await throws(async () => transferDestination(), /off the ed25519 curve/, "a PDA");

  CONFIG.transfer.destination = orig;
});

await test("a mint address passes the curve check — which is why the owner check exists", async () => {
  // Documents WHY assertDestination has to ask the chain: this address is a
  // perfectly valid ed25519 point, so isOnCurve alone would wave it through.
  assert(PublicKey.isOnCurve(MINT.toBytes()), "the jupSOL mint IS on the curve");

  const orig = CONFIG.transfer.destination;
  CONFIG.transfer.destination = MINT.toBase58();
  await throws(async () => transferDestination(), /is a token mint/, "caught by the mint list");
  CONFIG.transfer.destination = orig;
});

await test("assertDestination rejects a program-owned destination", async () => {
  const conn = stubConnection({ destOwner: spl.TOKEN_PROGRAM_ID });
  await throws(() => assertDestination(conn, WALLET), /not a wallet/, "token-account destination");

  const exec = stubConnection({ destExecutable: true });
  await throws(() => assertDestination(exec, WALLET), /executable program/, "program destination");
});

await test("assertDestination allows an unfunded wallet", async () => {
  const conn = stubConnection({ destExists: false });
  assertEq((await assertDestination(conn, WALLET)).toBase58(), DEST.toBase58(), "null account is legitimate");
});

await test("assertDestination refuses the bot's own wallet", async () => {
  const orig = CONFIG.transfer.destination;
  CONFIG.transfer.destination = WALLET.publicKey.toBase58();
  await throws(() => assertDestination(stubConnection(), WALLET), /own wallet/, "self-transfer");
  CONFIG.transfer.destination = orig;
});

// ── The transaction ──────────────────────────────────────────────────────────

await test("the full balance moves as the exact raw amount, never a float", async () => {
  const conn = stubConnection();
  const r = await executeTransfer({ connection: conn, wallet: WALLET, intent: "custody" });
  assertEq(r.rawAmount, "3117400123", "raw string preserved bit for bit");
  assertEq(r.dest, DEST.toBase58(), "destination");
});

await test("the instruction layout is exactly what was intended", async () => {
  const conn = stubConnection();
  await executeTransfer({ connection: conn, wallet: WALLET });
  const { tx } = conn.sent.find(x => x.kind === "sim");
  const msg = TransactionMessage.decompile(tx.message);
  assertEq(msg.instructions.length, 4, "compute limit, compute price, idempotent ATA, transferChecked");

  const [cuLimit, cuPrice, ata, transfer] = msg.instructions;
  assert(cuLimit.programId.equals(w3.ComputeBudgetProgram.programId), "compute budget");
  assert(cuPrice.programId.equals(w3.ComputeBudgetProgram.programId), "compute budget");
  assert(ata.programId.equals(spl.ASSOCIATED_TOKEN_PROGRAM_ID), "idempotent ATA creation");
  assert(transfer.programId.equals(spl.TOKEN_PROGRAM_ID), "token program");

  // TransferChecked: [source, mint, destination, owner]
  assert(transfer.keys[0].pubkey.equals(conn.srcAta), "source ATA");
  assert(transfer.keys[1].pubkey.equals(MINT), "mint");
  assert(transfer.keys[2].pubkey.equals(conn.destAta), "destination ATA");
  assert(transfer.keys[3].pubkey.equals(WALLET.publicKey), "owner signs");
  // Instruction 12 = TransferChecked; last byte is the decimals it verifies.
  assertEq(transfer.data[0], 12, "TransferChecked opcode");
  assertEq(transfer.data[transfer.data.length - 1], 9, "decimals checked on-chain");
});

await test("the gas reserve is guarded, and the ATA rent counts against it", async () => {
  // Just above the reserve with an existing destination ATA...
  const ok = stubConnection({ solLamports: 50_000_000 + 2_039_280 });
  await executeTransfer({ connection: ok, wallet: WALLET });

  // ...and the identical balance is NOT enough once rent has to be paid.
  const rent = stubConnection({ solLamports: 50_000_000 + 2_039_280, destAtaExists: false });
  await throws(() => executeTransfer({ connection: rent, wallet: WALLET }),
    /below the .* gas reserve|rent for a new destination/, "rent pushes it under");

  const broke = stubConnection({ solLamports: 10_000_000 });
  await throws(() => executeTransfer({ connection: broke, wallet: WALLET }), /gas reserve/, "plainly underfunded");
});

await test("Token-2022 is refused rather than mis-recorded", async () => {
  const conn = stubConnection({ mintOwner: spl.TOKEN_2022_PROGRAM_ID });
  await throws(() => executeTransfer({ connection: conn, wallet: WALLET }), /Token-2022/, "refused");
  assertEq((await loadTransactions()).length, 0, "and nothing logged");
});

await test("a zero balance moves nothing", async () => {
  const conn = stubConnection({ srcAmount: "0" });
  await throws(() => executeTransfer({ connection: conn, wallet: WALLET }), /balance is zero/, "refused");
});

await test("a successful move writes exactly one correctly-shaped row", async () => {
  const conn = stubConnection();
  await executeTransfer({ connection: conn, wallet: WALLET, intent: "custody", price: 142.31 });
  const rows = await loadTransactions();
  assertEq(rows.length, 1, "one row");
  const r = rows[0];
  assertEq(r.type, "transfer_out", "type");
  assertEq(r.fromSym, "JUPSOL", "fromSym");
  assertEq(r.toSym, "JUPSOL", "toSym — a move is not a conversion");
  assertEq(r.fromAmount, r.toAmount, "amounts match");
  assertEq(r.intent, "custody", "intent");
  assertEq(r.dest, DEST.toBase58(), "destination recorded");
  assertEq(r.sig, "SiGnAtUrE1111", "signature recorded");
  assertEq(r.dryRun, false, "real");
});

await test("a failed confirmation writes NO row", async () => {
  const conn = stubConnection({ confirmErr: { InstructionError: [0, "Custom"] } });
  await throws(() => executeTransfer({ connection: conn, wallet: WALLET }), /failed on-chain/, "propagates");
  assertEq((await loadTransactions()).length, 0, "the ledger must not claim a move that failed");
});

await test("a failed simulation never reaches the network", async () => {
  const conn = stubConnection({ simErr: { InstructionError: [3, "Custom"] } });
  await throws(() => executeTransfer({ connection: conn, wallet: WALLET }), /Simulation failed/, "caught pre-flight");
  assertEq(conn.sent.filter(x => x.kind === "send").length, 0, "nothing sent");
  assertEq((await loadTransactions()).length, 0, "nothing logged");
});

await test("a dry run logs but never submits", async () => {
  CONFIG.dryRun = true;
  const conn = stubConnection();
  const r = await executeTransfer({ connection: conn, wallet: WALLET, intent: "custody" });
  CONFIG.dryRun = false;
  assert(r.dryRun, "flagged");
  assertEq(conn.sent.length, 0, "no simulate, no send");
  const rows = await loadTransactions({ includeDryRun: true });
  assertEq(rows[0].dryRun, true, "logged as a dry run");
});

await test("transfers refuse to run when disabled", async () => {
  CONFIG.transfer.enabled = false;
  await throws(() => executeTransfer({ connection: stubConnection(), wallet: WALLET }), /disabled/, "off by default");
  CONFIG.transfer.enabled = true;
});

// ── HTTP guards ──────────────────────────────────────────────────────────────

await test("checkOrigin — only a same-origin request passes", async () => {
  const H = { host: "sol.example.com" };
  assert(guard.checkOrigin({ ...H, origin: "https://sol.example.com" }, "").ok, "matching host");
  assert(!guard.checkOrigin(H, "").ok, "missing Origin");
  assert(!guard.checkOrigin({ ...H, origin: "https://evil.example" }, "").ok, "attacker origin");
  assert(!guard.checkOrigin({ ...H, origin: "garbage" }, "").ok, "malformed");
  assert(!guard.checkOrigin({ ...H, origin: "https://sol.example.com", "sec-fetch-site": "cross-site" }, "").ok, "sec-fetch-site");

  // With a configured origin the match must be exact.
  assert(guard.checkOrigin({ ...H, origin: "https://sol.example.com" }, "https://sol.example.com").ok, "exact");
  assert(!guard.checkOrigin({ ...H, origin: "http://sol.example.com" }, "https://sol.example.com").ok, "scheme matters");
});

await test("checkContentType — no form encoding can reach the handler", async () => {
  assert(guard.checkContentType({ "content-type": "application/json" }).ok, "json");
  assert(guard.checkContentType({ "content-type": "application/json; charset=utf-8" }).ok, "json with charset");
  for (const t of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain", ""]) {
    assert(!guard.checkContentType({ "content-type": t }).ok, `${t || "(none)"} must be refused`);
  }
});

await test("checkConfirmHeader — a form cannot set a custom header", async () => {
  assert(guard.checkConfirmHeader({ "x-swapper-confirm": "1" }).ok, "present");
  assert(!guard.checkConfirmHeader({}).ok, "absent");
  assert(!guard.checkConfirmHeader({ "x-swapper-confirm": "0" }).ok, "wrong value");
});

await test("readJsonBody caps the body both ways", async () => {
  const { Readable } = await import("stream");
  const req = (body, headers = {}) => {
    const r = Readable.from([Buffer.from(body)]);
    r.headers = { "content-length": String(Buffer.byteLength(body)), ...headers };
    r.setTimeout = () => {};
    r.destroy = () => {};
    return r;
  };

  assert((await guard.readJsonBody(req('{"a":1}'))).ok, "small json");
  assertEq((await guard.readJsonBody(req("not json"))).code, "BAD_JSON", "malformed");

  const big = JSON.stringify({ pad: "x".repeat(5000) });
  assertEq((await guard.readJsonBody(req(big))).code, "BODY_TOO_LARGE", "declared oversize");
  // A lying Content-Length must not get past the streamed check.
  assertEq((await guard.readJsonBody(req(big, { "content-length": "10" }))).code, "BODY_TOO_LARGE", "lying header");
});

await test("nonces are single-use and expire", async () => {
  guard._resetNonces();
  const n = guard.issueNonce();
  assert(guard.consumeNonce(n), "first use works");
  assert(!guard.consumeNonce(n), "a replay — or a double-click — fails");
  assert(!guard.consumeNonce("fabricated"), "cannot be guessed");
  assert(!guard.consumeNonce(undefined), "no nonce, no transfer");

  const old = guard.issueNonce(0);
  assert(!guard.consumeNonce(old, CONFIG.transfer.nonceTtlMs + 1), "expires");

  // The map is bounded, so an attacker cannot grow it without limit.
  guard._resetNonces();
  const first = guard.issueNonce();
  for (let i = 0; i < 40; i++) guard.issueNonce();
  assert(!guard.consumeNonce(first), "oldest evicted");
});

await test("cooldown and daily cap are measured from the ledger", async () => {
  const now = Date.parse("2026-09-10T12:00:00Z");
  const at = (iso) => ({ type: "transfer_out", timestamp: iso, dryRun: false });

  assert(guard.checkCooldown([], now).ok, "no history, no limit");
  assert(!guard.checkCooldown([at("2026-09-10T11:30:00Z")], now).ok, "30 min ago is inside the 60 min cooldown");
  assert(guard.checkCooldown([at("2026-09-10T10:00:00Z")], now).ok, "2 h ago is clear");

  const capped = [at("2026-09-10T02:00:00Z"), at("2026-09-10T05:00:00Z")];
  assertEq(guard.checkCooldown(capped, now).code, "DAILY_CAP", "2 per day is the cap");

  // A dry run is not a transfer and must not consume the budget.
  assert(guard.checkCooldown([{ ...at("2026-09-10T11:59:00Z"), dryRun: true }], now).ok, "dry runs excluded");
});

await test("the per-process rate limit bounds fee-burn", async () => {
  guard._resetRateLimit();
  for (let i = 0; i < 10; i++) assert(guard.checkRateLimit(1000).ok, `attempt ${i + 1} allowed`);
  assertEq(guard.checkRateLimit(1000).code, "RATE_LIMITED", "the 11th is refused");
  assert(guard.checkRateLimit(1000 + 11 * 60_000).ok, "the window rolls over");
});

await clearTransactions();
if (failures > 0) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log("\nAll tests passed!");
