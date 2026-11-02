// pl.test.js — FIFO P&L tests
// Run: node pl.test.js

import fs from "fs";
import os from "os";
import path from "path";

// DATA_DIR must be set before importing anything that reads it
const TEST_DIR = path.join(os.tmpdir(), "sol-usdc-swapper-test");
process.env.DATA_DIR = TEST_DIR;
process.env.STORAGE_BACKEND = "files";   // never let a stray DATABASE_URL hit a real DB
fs.mkdirSync(TEST_DIR, { recursive: true });

const { calculatePL, getTodayPL, getTransactions, replayFifo, plSummary } = await import("./pl.js");
const { saveTransaction, clearTransactions } = await import("./transactions.js");

function tx(type, fromAmount, toAmount, price, timestamp) {
  return {
    type,
    fromSym: type === "buy" ? "USDC" : "SOL",
    toSym:   type === "buy" ? "SOL"  : "USDC",
    fromAmount, toAmount, price, timestamp,
  };
}

let failures = 0;

async function test(name, fn) {
  try {
    await clearTransactions();
    await fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    failures++;
    console.error(`❌ ${name}: ${e.message}`);
  }
}

function assertEq(a, b, msg) {
  if (Math.abs(a - b) > 0.001) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

await test("No transactions → zero P&L", async () => {
  const pl = await calculatePL({ currentPrice: 150 });
  assertEq(pl.realizedPL, 0, "realized");
  assertEq(pl.unrealizedPL, 0, "unrealized");
  assertEq(pl.totalPL, 0, "total");
});

await test("Buy only → unrealized profit", async () => {
  await saveTransaction(tx("buy", 150, 1, 150, "2026-01-01T00:00:00Z"));
  const pl = await calculatePL({ currentPrice: 170 });
  assertEq(pl.realizedPL, 0, "realized");
  assertEq(pl.unrealizedPL, 20, "unrealized");
  assertEq(pl.totalPL, 20, "total");
  assertEq(pl.solHoldings, 1, "holdings");
});

await test("Buy and sell → realized profit", async () => {
  await saveTransaction(tx("buy", 150, 1, 150, "2026-01-01T00:00:00Z"));
  await saveTransaction(tx("sell", 1, 170, 170, "2026-01-02T00:00:00Z"));
  const pl = await calculatePL({ currentPrice: 180 });
  assertEq(pl.realizedPL, 20, "realized");
  assertEq(pl.unrealizedPL, 0, "unrealized");
  assertEq(pl.totalPL, 20, "total");
});

await test("Partial sell → mixed realized + unrealized", async () => {
  await saveTransaction(tx("buy", 300, 2, 150, "2026-01-01T00:00:00Z"));
  await saveTransaction(tx("sell", 1, 170, 170, "2026-01-02T00:00:00Z"));
  const pl = await calculatePL({ currentPrice: 180 });
  assertEq(pl.realizedPL, 20, "realized");
  assertEq(pl.unrealizedPL, 30, "unrealized");
  assertEq(pl.totalPL, 50, "total");
  assertEq(pl.solHoldings, 1, "holdings");
});

await test("FIFO cost basis matches oldest lot first", async () => {
  await saveTransaction(tx("buy", 100, 1, 100, "2026-01-01T00:00:00Z"));
  await saveTransaction(tx("buy", 200, 1, 200, "2026-01-02T00:00:00Z"));
  await saveTransaction(tx("sell", 1, 150, 150, "2026-01-03T00:00:00Z"));
  const pl = await calculatePL({ currentPrice: 250 });
  assertEq(pl.realizedPL, 50, "realized");
  assertEq(pl.unrealizedPL, 50, "unrealized");
  assertEq(pl.totalPL, 100, "total");
});

await test("Date range carries cost basis in from earlier buys", async () => {
  await saveTransaction(tx("buy", 150, 1, 150, "2026-01-01T00:00:00Z"));
  await saveTransaction(tx("sell", 1, 170, 170, "2026-06-15T00:00:00Z"));
  const pl = await calculatePL({ start: "2026-06-01", end: "2026-06-30", currentPrice: 180 });
  assertEq(pl.realizedPL, 20, "range realized");
  assertEq(pl.unrealizedPL, 0, "range unrealized");
  assertEq(pl.trades, 1, "only in-range swaps counted");
});

await test("Volume tracking", async () => {
  await saveTransaction(tx("buy", 100, 0.5, 200, "2026-01-01T00:00:00Z"));
  await saveTransaction(tx("buy", 150, 0.5, 300, "2026-01-02T00:00:00Z"));
  const pl = await calculatePL({ currentPrice: 250 });
  assertEq(pl.buyVolume, 250, "buy volume");
  assertEq(pl.buys, 2, "buy count");
});

await test("Dry-run swaps are excluded from P&L", async () => {
  await saveTransaction({ ...tx("buy", 150, 1, 150, "2026-01-01T00:00:00Z"), dryRun: true });
  await saveTransaction(tx("buy", 150, 1, 150, "2026-01-02T00:00:00Z"));
  const pl = await calculatePL({ currentPrice: 150 });
  assertEq(pl.buys, 1, "buy count");
  assertEq(pl.solHoldings, 1, "holdings");
});

await test("Today's P&L only counts today's swaps", async () => {
  await saveTransaction(tx("buy", 150, 1, 150, "2026-01-01T00:00:00Z"));
  await saveTransaction(tx("sell", 1, 200, 200, new Date().toISOString()));
  const pl = await getTodayPL(200);
  assertEq(pl.realizedPL, 50, "today realized");
  assertEq(pl.trades, 1, "today trades");
});

await test("History returns most recent first", async () => {
  await saveTransaction(tx("buy", 100, 1, 100, "2026-01-01T00:00:00Z"));
  await saveTransaction(tx("sell", 1, 120, 120, "2026-01-02T00:00:00Z"));
  const txs = await getTransactions({ limit: 10 });
  if (txs[0].type !== "sell") throw new Error(`expected newest first, got ${txs[0].type}`);
  assertEq(txs.length, 2, "count");
});

await test("History includes dry runs, P&L does not", async () => {
  await saveTransaction({ ...tx("buy", 100, 1, 100, "2026-01-01T00:00:00Z"), dryRun: true });
  assertEq((await getTransactions()).length, 1, "history count");
  assertEq((await getTransactions({ includeDryRun: false })).length, 0, "filtered history count");
  assertEq((await calculatePL({ currentPrice: 100 })).trades, 0, "pl trades");
});

await test("replayFifo asset option ignores other symbols", async () => {
  const txs = [
    { type: "buy", fromSym: "USDC", toSym: "JUPSOL", fromAmount: 120, toAmount: 1 },
    { type: "buy", fromSym: "USDC", toSym: "MSOL",   fromAmount: 500, toAmount: 4 },
  ];
  const scoped = replayFifo(txs, { asset: "JUPSOL" });
  assertEq(scoped.units, 1, "units");
  assertEq(scoped.costBasis, 120, "cost basis");
  assertEq(scoped.totalBuys, 1, "buy count");
});

await test("replayFifo without an asset stays symbol-agnostic", async () => {
  const txs = [
    { type: "buy", fromSym: "USDC", toSym: "JUPSOL", fromAmount: 120, toAmount: 1 },
    { type: "buy", fromSym: "USDC", toSym: "MSOL",   fromAmount: 500, toAmount: 4 },
  ];
  const all = replayFifo(txs);
  assertEq(all.units, 5, "units");
  assertEq(all.costBasis, 620, "cost basis");
  assertEq(all.totalBuys, 2, "buy count");
});

// ── Custody transfers ────────────────────────────────────────────────────────

const move = (units, over = {}) => ({
  type: "transfer_out", fromSym: "JUPSOL", toSym: "JUPSOL",
  fromAmount: units, toAmount: units, dryRun: false,
  intent: "custody", dest: "SafeWa11et", ...over,
});
const jupBuy = (usdc, units, over = {}) => ({
  type: "buy", fromSym: "USDC", toSym: "JUPSOL",
  fromAmount: usdc, toAmount: units, price: usdc / units, dryRun: false, ...over,
});

await test("replayFifo — a transfer consumes no lot and books no P&L", async () => {
  const base = [jupBuy(120, 1), jupBuy(140, 1)];
  const a = replayFifo(base, { asset: "JUPSOL" });
  const b = replayFifo([...base, move(1.5)], { asset: "JUPSOL" });

  assertEq(b.units, a.units, "units untouched");
  assertEq(b.costBasis, a.costBasis, "cost basis untouched");
  assertEq(b.realizedPl, a.realizedPl, "no P&L realized");
  assertEq(b.totalSells, a.totalSells, "not counted as a sell");
  assertEq(b.sellVolumeUsdc, a.sellVolumeUsdc, "no sell volume");
  assertEq(b.lots.length, a.lots.length, "lot book untouched");
  assertEq(b.movedUnits, 1.5, "movedUnits tracked");
  assertEq(b.transferCount, 1, "transferCount");
});

await test("replayFifo — transfers are asset-scoped", async () => {
  const txs = [jupBuy(120, 1), move(1, { fromSym: "MSOL", toSym: "MSOL" })];
  assertEq(replayFifo(txs, { asset: "JUPSOL" }).movedUnits, 0, "an MSOL move is not a JUPSOL move");
  assertEq(replayFifo(txs, { asset: "MSOL" }).movedUnits, 1, "counted under its own asset");
});

await test("replayFifo — transfer_in decrements movedUnits", async () => {
  const txs = [jupBuy(120, 2), move(1.5), move(0.5, { type: "transfer_in" })];
  assertEq(replayFifo(txs, { asset: "JUPSOL" }).movedUnits, 1, "1.5 out, 0.5 back");
});

// The keystone. run.js feeds plSummary().plPct into strategy.js's lossBoost(),
// so if a custody move changed any of these, putting coins somewhere safe
// would silently resize tomorrow's buy.
await test("A custody move changes NO P&L number", async () => {
  const base = [jupBuy(120, 1), jupBuy(140, 1)];
  const a = plSummary({ txs: base, asset: "JUPSOL", assetPrice: 150 });
  const b = plSummary({ txs: [...base, move(1.5)], asset: "JUPSOL", assetPrice: 150 });

  for (const k of ["unitsBought", "unitsSold", "botUnits", "usdIn", "usdOut",
                   "netDeployedUsd", "costBasisUsd", "currentValueUsd",
                   "realizedPlUsd", "unrealizedPlUsd", "plUsd", "plPct"]) {
    if (a[k] !== b[k]) throw new Error(`${k} changed: ${a[k]} → ${b[k]}`);
  }
  assertEq(b.fifo.lots.length, a.fifo.lots.length, "lot book identical");
});

await test("plSummary splits the position by location", async () => {
  const txs = [jupBuy(360, 3), move(1)];
  const r = plSummary({ txs, asset: "JUPSOL", assetPrice: 150 });
  assertEq(r.botUnits, 3, "botUnits — still owned");
  assertEq(r.movedUnits, 1, "movedUnits");
  assertEq(r.custodyUnits, 2, "custodyUnits — expected in the bot wallet");
  assertEq(r.movedValueUsd, 150, "movedValueUsd");
  assertEq(r.custodyValueUsd, 300, "custodyValueUsd");
});

await test("A full move leaves the position intact and custody at zero", async () => {
  const txs = [jupBuy(240, 2), move(2)];
  const r = plSummary({ txs, asset: "JUPSOL", assetPrice: 150 });
  assertEq(r.botUnits, 2, "botUnits unchanged");
  assertEq(r.custodyUnits, 0, "nothing left in the bot wallet");
  assertEq(r.costBasisUsd, 240, "cost basis unchanged");
  assertEq(r.realizedPlUsd, 0, "a move realizes nothing");
  assertEq(r.plUsd, 60, "unrealized gain still counted");
});

await test("A dry-run transfer moves nothing", async () => {
  const txs = [jupBuy(240, 2), move(2, { dryRun: true })];
  const r = plSummary({ txs, asset: "JUPSOL", assetPrice: 150 });
  assertEq(r.movedUnits, 0, "dry runs are excluded");
  assertEq(r.custodyUnits, 2, "still all in the bot wallet");
});

clearTransactions();

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll tests passed!");
