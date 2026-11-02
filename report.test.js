// report.test.js — Attribution and P&L
// Run: node report.test.js
//
// buildReport is pure, so none of this touches the network or storage — but
// importing it pulls in storage/index.js, so the backend is pinned first.

import fs from "fs";
import os from "os";
import path from "path";

const TEST_DIR = path.join(os.tmpdir(), "sol-usdc-swapper-report-test");
process.env.DATA_DIR = TEST_DIR;
process.env.STORAGE_BACKEND = "files";   // never let a stray DATABASE_URL hit a real DB
process.env.STRATEGY_ASSET = "JUPSOL";
fs.mkdirSync(TEST_DIR, { recursive: true });

const { buildReport } = await import("./report.js");
const { defaultState } = await import("./state.js");

const ASSET  = "JUPSOL";
const APRICE = 120;   // USD per JUPSOL
const SPRICE = 100;   // USD per SOL   → ratio 1.2

function st(over = {}) {
  const s = defaultState();
  return { ...s, ...over, budget: { ...s.budget, ...(over.budget || {}) } };
}

const buy = (usdc, units, date, over = {}) => ({
  type: "buy", fromSym: "USDC", toSym: ASSET,
  fromAmount: usdc, toAmount: units, price: usdc / units,
  timestamp: `${date}T00:00:00Z`, dryRun: false, intent: "dca", ...over,
});

const moved = (units, date, over = {}) => ({
  type: "transfer_out", fromSym: ASSET, toSym: ASSET,
  fromAmount: units, toAmount: units, price: APRICE,
  timestamp: `${date}T00:00:00Z`, dryRun: false, intent: "custody",
  dest: "6C49kcijBHQNHFPieMn4BRjT3owZQ6wCckbCHbYnpzf1", ...over,
});

const sell = (units, usdc, date, over = {}) => ({
  type: "sell", fromSym: ASSET, toSym: "USDC",
  fromAmount: units, toAmount: usdc, price: usdc / units,
  timestamp: `${date}T00:00:00Z`, dryRun: false, intent: "manual", ...over,
});

const CLOSES = [
  { date: "2026-01-01", close: 100 },
  { date: "2026-01-02", close: 125 },
];

/** Defaults chosen so a clean wallet reconciles exactly. */
function rep(over = {}) {
  const txs = over.txs ?? [];
  // Explicit per type: a transfer row has toSym === fromSym, so a net
  // "in minus out" calculation would silently cancel it to zero.
  const held = over.held ?? txs
    .filter(t => !t.dryRun)
    .reduce((s, t) => {
      if (t.type === "buy")           return s + (t.toSym   === ASSET ? t.toAmount   : 0);
      if (t.type === "sell")          return s - (t.fromSym === ASSET ? t.fromAmount : 0);
      if (t.type === "transfer_out")  return s - (t.fromSym === ASSET ? t.fromAmount : 0);
      if (t.type === "transfer_in")   return s + (t.fromSym === ASSET ? t.fromAmount : 0);
      return s;
    }, 0);
  return buildReport({
    txs,
    state: over.state ?? st(),
    asset: ASSET,
    assetPrice: over.assetPrice ?? APRICE,
    solPrice: SPRICE,
    held,
    closes: over.closes ?? CLOSES,
    openingUnits: over.openingUnits ?? 0,
    destUnits: over.destUnits ?? null,
  });
}

let failures = 0;

function test(name, fn) {
  try { fn(); console.log(`✅ ${name}`); }
  catch (e) { failures++; console.error(`❌ ${name}: ${e.message}`); }
}

function assertEq(a, b, msg) {
  if (Math.abs(a - b) > 1e-6) throw new Error(`${msg}: expected ${b}, got ${a}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── Attribution ──────────────────────────────────────────────────────────────

test("Clean wallet — bot units are the whole position", () => {
  const r = rep({ txs: [buy(120, 1, "2026-01-01"), buy(120, 1, "2026-01-02")] });
  assertEq(r.botUnits, 2, "botUnits");
  assertEq(r.walletUnits, 2, "walletUnits");
  assertEq(r.externalUnits, 0, "externalUnits");
  assertEq(r.unexplainedUnits, 0, "unexplainedUnits");
  assert(r.reconciled, "should reconcile");
});

test("Undeclared bag is excluded from the position and the benchmark", () => {
  const txs = [buy(120, 1, "2026-01-01")];
  const r = rep({ txs, held: 7 });          // 6 units the bot never bought
  assertEq(r.botUnits, 1, "botUnits ignores the bag");
  assertEq(r.walletUnits, 7, "walletUnits");
  assertEq(r.externalUnits, 6, "externalUnits");
  assertEq(r.unexplainedUnits, 6, "unexplained");
  assert(!r.reconciled, "must NOT reconcile — banner should fire");
  // The whole point: the bag must not inflate what the benchmark compares.
  assertEq(r.botSolEquiv, 1 * 1.2, "botSolEquiv excludes the bag");
  assertEq(r.totalSolEquiv, 1 * 1.2, "totalSolEquiv excludes the bag");
});

test("Declared opening balance reconciles the same bag", () => {
  const txs = [buy(120, 1, "2026-01-01")];
  const r = rep({ txs, held: 7, openingUnits: 6 });
  assertEq(r.botUnits, 1, "botUnits unchanged");
  assertEq(r.externalUnits, 6, "externalUnits unchanged");
  assertEq(r.unexplainedUnits, 0, "unexplained goes to zero");
  assert(r.reconciled, "should reconcile once declared");
  assertEq(r.currentValueUsd, 120, "P&L still ignores the declared bag");
  assertEq(r.netDeployedUsd, 120, "deployed still ignores the declared bag");
});

test("Undeclared transfer out — still fails reconciliation", () => {
  const txs = [buy(120, 1, "2026-01-01"), buy(120, 1, "2026-01-02")];
  const r = rep({ txs, held: 0.5 });
  assertEq(r.botUnits, 2, "botUnits from the log");
  assertEq(r.externalUnits, -1.5, "externalUnits is negative");
  assertEq(r.unexplainedUnits, -1.5, "unexplained is negative");
  assert(!r.reconciled, "must not reconcile");
  assert(Number.isFinite(r.plPct), "plPct finite");
});

test("Dust drift still reconciles", () => {
  const txs = [buy(120, 1, "2026-01-01")];
  const r = rep({ txs, held: 1 + 1e-9 });
  assert(r.reconciled, "1e-9 of drift is rounding, not activity");
});

// ── Custody ──────────────────────────────────────────────────────────────────

test("Declared move reconciles and leaves the position intact", () => {
  const txs = [buy(120, 1, "2026-01-01"), buy(120, 1, "2026-01-02"), moved(1.5, "2026-01-03")];
  const r = rep({ txs, held: 0.5 });
  assertEq(r.botUnits, 2, "botUnits — still owned, just elsewhere");
  assertEq(r.movedUnits, 1.5, "movedUnits");
  assertEq(r.custodyUnits, 0.5, "custodyUnits");
  assertEq(r.expectedUnits, 0.5, "expected in this wallet");
  assertEq(r.unexplainedUnits, 0, "nothing unexplained");
  assert(r.reconciled, "should reconcile once declared");
  assertEq(r.currentValueUsd, 240, "P&L still values every unit");
  assertEq(r.plUsd, 0, "no gain at cost");
  assertEq(r.botSolEquiv, 2 * 1.2, "SOL-equivalent covers the whole position");
});

test("A full move leaves an empty wallet reconciled and every number identical", () => {
  const base = [buy(120, 1, "2026-01-01"), buy(120, 1, "2026-01-02")];
  const before = rep({ txs: base });
  const after  = rep({ txs: [...base, moved(2, "2026-01-03")], held: 0 });

  assert(after.reconciled, "an emptied wallet must reconcile at exactly zero");
  assertEq(after.custodyUnits, 0, "nothing left here");
  assertEq(after.movedUnits, 2, "all of it moved");

  // The whole thesis: a custody change is not a performance event.
  for (const k of ["botUnits", "netDeployedUsd", "costBasisUsd", "avgCostUsd",
                   "currentValueUsd", "plUsd", "plPct", "plSol", "plSolPct",
                   "botSolEquiv", "totalSolEquiv", "deployedSolAtCost"]) {
    if (before[k] !== after[k]) throw new Error(`${k} changed: ${before[k]} → ${after[k]}`);
  }
  assertEq(after.flat.sameCapital.deltaSol, before.flat.sameCapital.deltaSol, "benchmark unchanged");
});

test("A declared move does not excuse an undeclared one", () => {
  const txs = [buy(120, 1, "2026-01-01"), buy(120, 1, "2026-01-02"), moved(1, "2026-01-03")];
  const r = rep({ txs, held: 0.4 });   // 1 declared, 0.6 quietly gone
  assertEq(r.unexplainedUnits, -0.6, "the undeclared part still shows");
  assert(!r.reconciled, "must not reconcile");
});

test("Opening balance and a move compose", () => {
  const txs = [buy(120, 1, "2026-01-01"), moved(1, "2026-01-02")];
  const r = rep({ txs, held: 6, openingUnits: 6 });
  assertEq(r.custodyUnits, 0, "the bot's own unit left");
  assertEq(r.expectedUnits, 6, "only the declared bag should remain");
  assertEq(r.unexplainedUnits, 0, "reconciles");
  assert(r.reconciled, "both declarations apply together");
});

test("Destination shortfall is reported, surplus is not", () => {
  const txs = [buy(120, 1, "2026-01-01"), buy(120, 1, "2026-01-02"), moved(1.5, "2026-01-03")];

  const short = rep({ txs, held: 0.5, destUnits: 0 });
  assertEq(short.destShortfall, 1.5, "the safe wallet is short");
  assert(!short.destReconciled, "must flag a shortfall");
  assert(short.reconciled, "the bot wallet still reconciles on its own");

  const surplus = rep({ txs, held: 0.5, destUnits: 9 });
  assertEq(surplus.destShortfall, 0, "a safe wallet may hold more from elsewhere");
  assert(surplus.destReconciled, "a surplus is not a problem");

  const unchecked = rep({ txs, held: 0.5 });
  assert(unchecked.destUnits === null, "null when not checked");
  assert(unchecked.destShortfall === null, "no verdict without data");
  assert(unchecked.destReconciled === null, "no verdict without data");
});

test("A dry-run move is not a move", () => {
  const txs = [buy(120, 1, "2026-01-01"), moved(1, "2026-01-02", { dryRun: true })];
  const r = rep({ txs, held: 1 });
  assertEq(r.movedUnits, 0, "dry runs excluded");
  assert(r.reconciled, "wallet still holds it");
});

test("Another asset's trades never touch this asset's numbers", () => {
  const txs = [
    buy(120, 1, "2026-01-01"),
    { ...buy(500, 4, "2026-01-02"), toSym: "MSOL" },
  ];
  const r = rep({ txs, held: 1 });
  assertEq(r.botUnits, 1, "botUnits");
  assertEq(r.usdIn, 120, "usdIn excludes the MSOL buy");
  assertEq(r.buyCount, 1, "buyCount");
  assertEq(r.costBasisUsd, 120, "FIFO book is asset-scoped");
});

test("Dry runs are excluded from every number", () => {
  const txs = [buy(999, 9, "2026-01-01", { dryRun: true }), buy(120, 1, "2026-01-02")];
  const r = rep({ txs, held: 1 });
  assertEq(r.botUnits, 1, "botUnits");
  assertEq(r.netDeployedUsd, 120, "netDeployedUsd");
  assertEq(r.buyCount, 1, "buyCount");
});

// ── P&L ──────────────────────────────────────────────────────────────────────

test("Profit and loss percentage on deployed capital", () => {
  // $200 in for 2 units; now worth $120 each = $240.
  const r = rep({ txs: [buy(200, 2, "2026-01-01")] });
  assertEq(r.netDeployedUsd, 200, "deployed");
  assertEq(r.costBasisUsd, 200, "cost basis");
  assertEq(r.currentValueUsd, 240, "current value");
  assertEq(r.plUsd, 40, "P&L");
  assertEq(r.plPct, 20, "P&L %");
  assertEq(r.avgCostUsd, 100, "avg cost");
});

test("A loss reports negative", () => {
  const r = rep({ txs: [buy(200, 1, "2026-01-01")] });
  assertEq(r.currentValueUsd, 120, "current value");
  assertEq(r.plUsd, -80, "P&L");
  assertEq(r.plPct, -40, "P&L %");
});

test("Sells split realized from unrealized, FIFO", () => {
  // Buy 2 @ $100 basis, sell 1 for $170 → realized +$70, 1 unit left @ $100.
  const r = rep({ txs: [buy(200, 2, "2026-01-01"), sell(1, 170, "2026-01-02")] });
  assertEq(r.botUnits, 1, "botUnits net of the sell");
  assertEq(r.usdIn, 200, "usdIn");
  assertEq(r.usdOut, 170, "usdOut");
  assertEq(r.netDeployedUsd, 30, "net deployed");
  assertEq(r.costBasisUsd, 100, "remaining FIFO basis");
  assertEq(r.avgCostUsd, 100, "avg cost is of units still held");
  assertEq(r.realizedPlUsd, 70, "realized");
  assertEq(r.unrealizedPlUsd, 20, "unrealized");
  assertEq(r.plUsd, 90, "total P&L");
  assertEq(r.flat.sameCapital.spent, 30, "benchmark gets capital net of sells");
});

test("Banked cash is reported but never inside current value", () => {
  const r = rep({ txs: [buy(120, 1, "2026-01-01")], state: st({ budget: { carryUsd: 24 } }) });
  assertEq(r.carryUsd, 24, "carry reported");
  assertEq(r.currentValueUsd, 120, "current value excludes carry");
  assertEq(r.plPct, 0, "P&L % undiluted by carry");
  // It IS counted in the SOL benchmark, which cash-hoarding could otherwise game.
  assertEq(r.carrySolEquiv, 0.24, "carry in SOL");
  assertEq(r.totalSolEquiv, 1.2 + 0.24, "benchmark total includes carry");
});

test("SOL-denominated P&L uses the close on each trade's own date", () => {
  // $100 on the day SOL closed at 100 → 1 SOL; $125 at 125 → 1 SOL. 2 SOL total.
  const r = rep({ txs: [buy(100, 1, "2026-01-01"), buy(125, 1, "2026-01-02")] });
  assertEq(r.deployedSolAtCost, 2, "SOL the same dollars would have bought");
  assertEq(r.botSolEquiv, 2.4, "SOL-equivalent held");
  assertEq(r.plSol, 0.4, "SOL gained vs bare SOL");
  assertEq(r.plSolPct, 20, "SOL P&L %");
});

test("Missing price history degrades to null, not NaN", () => {
  const r = rep({ txs: [buy(120, 1, "2026-01-01")], closes: [] });
  assert(r.deployedSolAtCost === null, "deployedSolAtCost null");
  assert(r.plSol === null, "plSol null");
  assert(r.flat === null, "no benchmark without closes");
});

test("Empty log produces no NaN or Infinity", () => {
  const r = rep({ txs: [] });
  for (const k of ["botUnits", "plUsd", "plPct", "avgCostUsd", "currentValueUsd",
                   "netDeployedUsd", "totalSolEquiv", "unexplainedUnits"]) {
    assert(Number.isFinite(r[k]), `${k} should be finite, got ${r[k]}`);
  }
  assertEq(r.plPct, 0, "plPct");
  assert(r.reconciled, "an empty wallet reconciles");
});

test("Benchmark deltas are computed once, in the report", () => {
  const r = rep({ txs: [buy(100, 1, "2026-01-01"), buy(125, 1, "2026-01-02")] });
  const b = r.flat.sameCapital;
  assertEq(b.deltaSol, r.totalSolEquiv - b.sol, "deltaSol");
  assertEq(b.deltaPct, (b.deltaSol / b.sol) * 100, "deltaPct");
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll tests passed!");
