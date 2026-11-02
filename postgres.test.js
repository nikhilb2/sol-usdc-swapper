// postgres.test.js — Backend parity + the guarantees only Postgres provides.
// Run: node postgres.test.js      (skips cleanly if DATABASE_URL is unset)
//
// Uses a scratch schema so it can never touch real trade data.

import "dotenv/config";

if (!process.env.DATABASE_URL) {
  console.log("⏭  DATABASE_URL not set — skipping Postgres tests");
  process.exit(0);
}

process.env.STORAGE_BACKEND = "postgres";

const pg = (await import("pg")).default;

// Point every connection at a throwaway schema, so `TRUNCATE` in these tests
// can never reach the real tables.
const TEST_SCHEMA = "swapper_test";
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
await admin.end();

const u = new URL(process.env.DATABASE_URL);
u.searchParams.set("options", `-c search_path=${TEST_SCHEMA}`);
process.env.DATABASE_URL = u.toString();

const storage = await import("./storage/index.js");
const { LOCK_KEY } = await import("./storage/postgres.js");
const { saveTransaction, loadTransactions, clearTransactions } = await import("./transactions.js");
const { loadState, saveState, defaultState } = await import("./state.js");

await storage.migrate();

let failures = 0;

async function test(name, fn) {
  try { await clearTransactions(); await fn(); console.log(`✅ ${name}`); }
  catch (e) { failures++; console.error(`❌ ${name}: ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); }
function assertClose(a, b, m) { if (Math.abs(a - b) > 1e-9) throw new Error(`${m}: expected ${b}, got ${a}`); }

const tx = over => ({
  type: "buy", fromSym: "USDC", toSym: "JUPSOL",
  fromAmount: 12, toAmount: 0.0934502, price: 128.42,
  intent: "dca", timestamp: "2026-08-26T09:00:00.000Z", ...over,
});

console.log(`\n  backend: ${storage.describe()}  schema: ${TEST_SCHEMA}\n`);

await test("Round-trips a transaction with full precision", async () => {
  await saveTransaction(tx({ sig: "sig-precision" }));
  const [t] = await loadTransactions();
  assertEq(t.type, "buy", "type");
  assertEq(t.fromSym, "USDC", "fromSym");
  assertEq(t.toSym, "JUPSOL", "toSym");
  assertEq(t.intent, "dca", "intent");
  assertEq(t.dryRun, false, "dryRun");
  // 9-decimal amounts must survive NUMERIC -> Number unchanged.
  assertClose(t.toAmount, 0.0934502, "toAmount");
  assertClose(t.fromAmount, 12, "fromAmount");
});

await test("A confirmed signature can only be logged once", async () => {
  await saveTransaction(tx({ sig: "duplicate-me" }));
  await saveTransaction(tx({ sig: "duplicate-me" }));   // crash-retry replay
  const rows = await loadTransactions();
  assertEq(rows.length, 1, "duplicate rejected by the unique index");
});

await test("Round-trips a custody transfer, dest included", async () => {
  await saveTransaction({
    type: "transfer_out", fromSym: "JUPSOL", toSym: "JUPSOL",
    fromAmount: 3.117400123, toAmount: 3.117400123, price: 142.31,
    sig: "sig-move", intent: "custody",
    dest: "6C49kcijBHQNHFPieMn4BRjT3owZQ6wCckbCHbYnpzf1",
  });
  const [t] = await loadTransactions();
  assertEq(t.type, "transfer_out", "the widened CHECK accepts it");
  assertEq(t.fromSym, "JUPSOL", "fromSym");
  assertEq(t.toSym, "JUPSOL", "toSym — a move is not a conversion");
  assertEq(t.intent, "custody", "intent");
  assertEq(t.dest, "6C49kcijBHQNHFPieMn4BRjT3owZQ6wCckbCHbYnpzf1", "dest column");
  assertClose(t.fromAmount, 3.117400123, "9 decimals survive NUMERIC");
  assertClose(t.toAmount, 3.117400123, "both legs equal");
});

await test("A swap still round-trips with a null dest", async () => {
  await saveTransaction(tx({ sig: "sig-nodest" }));
  const [t] = await loadTransactions();
  assertEq(t.dest, null, "swaps carry no destination");
});

await test("The type CHECK still rejects anything else", async () => {
  let threw = false;
  try { await saveTransaction(tx({ sig: "sig-bogus", type: "nonsense" })); }
  catch { threw = true; }
  assertEq(threw, true, "an unknown type must not reach the ledger");
});

await test("A duplicate transfer signature is rejected too", async () => {
  const move = {
    type: "transfer_out", fromSym: "JUPSOL", toSym: "JUPSOL",
    fromAmount: 1, toAmount: 1, sig: "dup-move", intent: "custody", dest: "Dest111",
  };
  await saveTransaction(move);
  await saveTransaction(move);   // crash-retry replay
  assertEq((await loadTransactions()).length, 1, "the partial unique index is type-agnostic");
});

await test("Dry runs are exempt from signature uniqueness", async () => {
  await saveTransaction(tx({ sig: null, dryRun: true }));
  await saveTransaction(tx({ sig: null, dryRun: true }));
  assertEq((await loadTransactions({ includeDryRun: true })).length, 2, "both kept");
  assertEq((await loadTransactions()).length, 0, "excluded from real trades");
});

await test("Transactions come back oldest-first", async () => {
  await saveTransaction(tx({ sig: "b", timestamp: "2026-08-26T00:00:00.000Z" }));
  await saveTransaction(tx({ sig: "a", timestamp: "2026-08-20T00:00:00.000Z" }));
  const rows = await loadTransactions();
  assertEq(rows[0].sig, "a", "oldest first");
});

await test("State round-trips as JSONB with nested fields intact", async () => {
  const s = defaultState();
  s.budget.carryUsd = 24.5;
  s.lastBuyDate = "2026-08-26";
  s.pendingIntent = { createdAt: "2026-08-26T09:00:00Z", action: { usd: 12 }, preBalances: { usdc: 100 } };
  await saveState(s);

  const { state, fresh } = await loadState();
  assert(!fresh, "not fresh");
  assertClose(state.budget.carryUsd, 24.5, "nested number");
  assertEq(state.lastBuyDate, "2026-08-26", "date");
  assertEq(state.pendingIntent.action.usd, 12, "deep nesting");
  assert(state.updatedAt, "updatedAt stamped");
});

await test("State upsert replaces rather than accumulating rows", async () => {
  await saveState({ ...defaultState(), buyCount: 1 });
  await saveState({ ...defaultState(), buyCount: 2 });
  assertEq((await loadState()).state.buyCount, 2, "latest wins");
});

await test("Missing state returns defaults, not an error", async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`DELETE FROM strategy_state`);
  await c.end();
  const { state, fresh } = await loadState();
  assert(fresh, "flagged fresh");
  assertEq(state.buyCount, 0, "defaults");
});

await test("Advisory lock is exclusive, and released on disconnect", async () => {
  await storage.acquireLock();

  // A separate connection must not be able to take the same lock.
  const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await other.connect();
  const { rows } = await other.query(`SELECT pg_try_advisory_lock($1, $2) AS got`, LOCK_KEY);
  assertEq(rows[0].got, false, "second holder refused");

  await storage.releaseLock();

  const after = await other.query(`SELECT pg_try_advisory_lock($1, $2) AS got`, LOCK_KEY);
  assertEq(after.rows[0].got, true, "available once released");
  await other.query(`SELECT pg_advisory_unlock($1, $2)`, LOCK_KEY);
  await other.end();
});

await test("Prices dedupe on date and survive a re-sync", async () => {
  const { insertCloses, selectCloses } = storage;
  const added = await insertCloses([
    { date: "2026-08-01", close: 100.5, source: "coinbase" },
    { date: "2026-08-02", close: 101.25, source: "coinbase" },
  ]);
  assertEq(added, 2, "inserted");
  const again = await insertCloses([{ date: "2026-08-01", close: 999, source: "coinbase" }]);
  assertEq(again, 0, "duplicate date ignored");

  const rows = await selectCloses();
  assertEq(rows.length, 2, "no dupes");
  assertEq(rows[0].date, "2026-08-01", "date is a plain YYYY-MM-DD string");
  assertClose(rows[0].close, 100.5, "original value kept, not overwritten");
});

await test("Alerts round-trip with NUMERIC targets and ISO timestamps", async () => {
  const a = await storage.insertAlert({ symbol: "JUPSOL", op: "above", target: 212.123456789, repeat: true, note: "tp" });
  assertEq(typeof a.id, "number", "id is a number, not a BIGINT string");
  assertClose(a.target, 212.123456789, "9 decimals survive NUMERIC");
  assertEq(a.active, true, "active by default");
  assertEq(a.armed, true, "armed by default");
  assertEq(a.fireCount, 0, "fireCount");
  assert(/^\d{4}-\d\d-\d\dT/.test(a.createdAt), `createdAt is ISO: ${a.createdAt}`);

  await storage.markAlertsChecked({ JUPSOL: 130.5, SOL: 99 }, "2026-10-16T12:00:00.000Z");
  assert(await storage.updateAlert(a.id, { armed: false, fireCount: 1, lastFiredAt: "2026-10-16T12:00:00.000Z", target: 1 }), "updated");

  const [row] = await storage.selectAlerts({ activeOnly: true });
  assertEq(row.armed, false, "armed patched");
  assertEq(row.fireCount, 1, "fireCount patched");
  assertClose(row.target, 212.123456789, "target is not a patchable column");
  assertClose(row.lastPrice, 130.5, "last price stamped");
  assertEq(row.checkedAt, "2026-10-16T12:00:00.000Z", "checkedAt stamped");
  assertEq(row.lastFiredAt, "2026-10-16T12:00:00.000Z", "lastFiredAt");

  assert(await storage.deleteAlert(a.id), "deleted");
  assertEq(await storage.deleteAlert(a.id), false, "second delete finds nothing");
  assertEq(await storage.updateAlert(a.id, { armed: true }), false, "update of a deleted alert is a no-op");
});

await test("The alert CHECKs reject what validation would", async () => {
  let threw = 0;
  try { await storage.insertAlert({ symbol: "SOL", op: "crosses", target: 1, repeat: false, note: null }); } catch { threw++; }
  try { await storage.insertAlert({ symbol: "SOL", op: "above", target: -1, repeat: false, note: null }); } catch { threw++; }
  assertEq(threw, 2, "both refused by the engine");
});

// ── Teardown ────────────────────────────────────────────────────────────────
await storage.close();
const cleanup = new pg.Client({ connectionString: process.env.DATABASE_URL });
await cleanup.connect();
await cleanup.query(`DROP SCHEMA ${TEST_SCHEMA} CASCADE`);
await cleanup.end();

console.log(failures === 0 ? "\nAll Postgres tests passed" : `\n${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
