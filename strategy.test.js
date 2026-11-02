// strategy.test.js — Decision engine rails
// Run: node strategy.test.js

import fs from "fs";
import os from "os";
import path from "path";

const TEST_DIR = path.join(os.tmpdir(), "sol-usdc-swapper-strategy-test");
process.env.DATA_DIR = TEST_DIR;
process.env.STRATEGY_ASSET = "JUPSOL";
process.env.STRATEGY_DAILY_USD = "12";   // pinned: these rails test the engine, not the budget
// config.js loads .env, so clear these before importing it — the shipped-default
// test must assert what config.js ships, not what this machine happens to set.
delete process.env.STRATEGY_BOOST_ON_LOSS;
delete process.env.STRATEGY_BOOST_FACTOR;
delete process.env.STRATEGY_MAX_BOOST;
delete process.env.STRATEGY_TAKE_PROFIT;
delete process.env.STRATEGY_TAKE_PROFIT_PCT;
delete process.env.STRATEGY_TAKE_PROFIT_FRACTION;
delete process.env.STRATEGY_TAKE_PROFIT_COOLDOWN_DAYS;
fs.mkdirSync(TEST_DIR, { recursive: true });

const { decide, decideSell, accrue, applyAction, carryCap, isBuyDay, daysBetween, lossBoost } = await import("./strategy.js");
const { defaultState } = await import("./state.js");
const { CONFIG } = await import("./config.js");

// A deep-ish clone so tests can tweak config without leaking into each other.
function cfg(over = {}) {
  return {
    ...CONFIG,
    swap:     { ...CONFIG.swap, ...(over.swap || {}) },
    strategy: { ...CONFIG.strategy, ...(over.strategy || {}) },
  };
}

function st(over = {}) {
  const s = defaultState();
  return { ...s, ...over, budget: { ...s.budget, ...(over.budget || {}) } };
}

const bal = (usdc, sol = 0.1) => ({ usdc, sol, bySymbol: { USDC: usdc, SOL: sol } });

// A Wednesday, so weekly (Monday) cadence is off by default.
const WED = "2026-08-26T09:00:00Z";
const MON = "2026-08-24T09:00:00Z";

let failures = 0;

function test(name, fn) {
  try { fn(); console.log(`✅ ${name}`); }
  catch (e) { failures++; console.error(`❌ ${name}: ${e.message}`); }
}

function assertEq(a, b, msg) {
  if (typeof a === "number" && typeof b === "number") {
    if (Math.abs(a - b) > 0.001) throw new Error(`${msg}: expected ${b}, got ${a}`);
  } else if (a !== b) {
    throw new Error(`${msg}: expected ${b}, got ${a}`);
  }
}

const railOf = (rails, name) => rails.find(r => r.name === name);

// ── Accrual ──────────────────────────────────────────────────────────────────

test("First accrual banks exactly one day, not a backfill from epoch", () => {
  const b = accrue(st().budget, WED, cfg());
  assertEq(b.carryUsd, 12, "carry");
  assertEq(b.accruedUsd, 12, "accrued");
  assertEq(b.lastAccrualDate, "2026-08-26", "date");
});

test("Accrual is idempotent within a UTC day", () => {
  const c = cfg();
  const once  = accrue(st().budget, WED, c);
  const twice = accrue(once, "2026-08-26T23:59:00Z", c);
  assertEq(twice.carryUsd, 12, "carry unchanged");
  assertEq(twice.accruedUsd, 12, "accrued unchanged");
});

test("A missed run backfills the gap", () => {
  const b = accrue(st({ budget: { carryUsd: 0, lastAccrualDate: "2026-08-23" } }).budget, WED, cfg());
  assertEq(b.carryUsd, 36, "3 days of $12");
});

test("Carry is capped so an offline month cannot dump a lump sum", () => {
  const c = cfg();
  const b = accrue(st({ budget: { carryUsd: 0, lastAccrualDate: "2026-01-01" } }).budget, WED, c);
  assertEq(b.carryUsd, carryCap(c), "clamped to cap");
  assertEq(carryCap(c), 48, "daily cap = 36 + 1*12");
});

test("Weekly cadence raises the carry cap to hold a full period", () => {
  assertEq(carryCap(cfg({ strategy: { cadence: "weekly" } })), 120, "36 + 7*12");
});

test("daysBetween never returns negative", () => {
  assertEq(daysBetween("2026-08-26", "2026-08-20"), 0, "clamped");
});

// ── The buy path ─────────────────────────────────────────────────────────────

test("Funded first run buys the banked budget", () => {
  const { action } = decide({ state: st(), balances: bal(100), now: WED, config: cfg() });
  assertEq(action.type, "BUY", "type");
  assertEq(action.usd, 12, "usd");
  assertEq(action.toSym, "JUPSOL", "buys the strategy asset");
  assertEq(action.fromSym, "USDC", "funded from USDC directly");
  assertEq(action.intent, "dca", "tagged for the report");
});

test("Buys the accumulated carry after missed days, not just one day", () => {
  const s = st({ budget: { carryUsd: 0, lastAccrualDate: "2026-08-23" } });
  const { action } = decide({ state: s, balances: bal(100), now: WED, config: cfg() });
  assertEq(action.usd, 36, "3 days banked");
});

// ── Rails ────────────────────────────────────────────────────────────────────

test("Idempotency: a second run the same UTC day does not buy again", () => {
  const s = st({ lastBuyDate: "2026-08-26" });
  const { action, rails } = decide({ state: s, balances: bal(100), now: WED, config: cfg() });
  assertEq(action.type, "HOLD", "type");
  assertEq(railOf(rails, "NOT_BOUGHT_TODAY").passed, false, "rail");
});

test("A pending intent halts everything", () => {
  const s = st({ pendingIntent: { createdAt: "2026-08-26T08:00:00Z" } });
  const { action, rails } = decide({ state: s, balances: bal(100), now: WED, config: cfg() });
  assertEq(action.type, "HOLD", "type");
  assertEq(railOf(rails, "NO_PENDING_INTENT").passed, false, "rail");
});

test("Never spends USDC the wallet does not hold", () => {
  const { action } = decide({ state: st(), balances: bal(7), now: WED, config: cfg() });
  assertEq(action.type, "BUY", "still buys");
  assertEq(action.usd, 7, "clamped to wallet balance");
});

test("Underfunded below the dust floor holds and keeps the budget banked", () => {
  const { action, rails } = decide({ state: st(), balances: bal(3), now: WED, config: cfg() });
  assertEq(action.type, "HOLD", "type");
  assertEq(railOf(rails, "MIN_TRADE_SIZE").passed, false, "rail");
  assertEq(action.budget.carryUsd, 12, "budget preserved, not forfeited");
});

test("Refuses to trade without gas — an all-LST wallet cannot transact", () => {
  const { action, rails } = decide({ state: st(), balances: bal(100, 0.001), now: WED, config: cfg() });
  assertEq(action.type, "HOLD", "type");
  assertEq(railOf(rails, "GAS_RESERVE").passed, false, "rail");
});

test("STRATEGY_ENABLED=false disables buying", () => {
  const { action } = decide({ state: st(), balances: bal(100), now: WED, config: cfg({ strategy: { enabled: false } }) });
  assertEq(action.type, "HOLD", "type");
});

test("Weekly cadence holds off-day and buys on the target day", () => {
  const c = cfg({ strategy: { cadence: "weekly" } });
  assertEq(isBuyDay(WED, c), false, "Wednesday is not a buy day");
  assertEq(isBuyDay(MON, c), true, "Monday is");
  assertEq(decide({ state: st(), balances: bal(200), now: WED, config: c }).action.type, "HOLD", "wed");
  assertEq(decide({ state: st(), balances: bal(200), now: MON, config: c }).action.type, "BUY", "mon");
});

test("Every rail is reported even after one fails", () => {
  const open = decide({ state: st(), balances: bal(100), now: WED, config: cfg() }).rails;
  const shut = decide({ state: st({ pendingIntent: { createdAt: "x" } }), balances: bal(0, 0), now: WED, config: cfg() }).rails;
  assertEq(shut.length, open.length, "same rail count regardless of outcome");
  if (shut.filter(r => !r.passed).length < 3) throw new Error("expected several failing rails to be surfaced");
});

// ── Purity ───────────────────────────────────────────────────────────────────

test("decide is pure — it does not mutate the state it is given", () => {
  const s = st();
  Object.freeze(s); Object.freeze(s.budget);
  decide({ state: s, balances: bal(100), now: WED, config: cfg() });
  assertEq(s.budget.carryUsd, 0, "input untouched");
  assertEq(s.lastBuyDate, null, "input untouched");
});

test("decide is deterministic for identical inputs", () => {
  const args = { state: st(), balances: bal(100), now: WED, config: cfg() };
  assertEq(JSON.stringify(decide(args).action), JSON.stringify(decide(args).action), "stable");
});

// ── Reducer ──────────────────────────────────────────────────────────────────

test("applyAction records the buy and draws down the carry", () => {
  const { action } = decide({ state: st(), balances: bal(100), now: WED, config: cfg() });
  const next = applyAction(st(), action, { usdSpent: 12 }, { now: WED });
  assertEq(next.lastBuyDate, "2026-08-26", "date key set");
  assertEq(next.buyCount, 1, "count");
  assertEq(next.budget.carryUsd, 0, "carry drawn down");
  assertEq(next.budget.spentUsd, 12, "lifetime spend");
  assertEq(next.startDate, "2026-08-26", "counterfactual anchor set");
});

test("applyAction uses the ACTUAL fill, not the intended amount", () => {
  const { action } = decide({ state: st(), balances: bal(100), now: WED, config: cfg() });
  const next = applyAction(st(), action, { usdSpent: 9.5 }, { now: WED });
  assertEq(next.budget.spentUsd, 9.5, "actual spend recorded");
  assertEq(next.budget.carryUsd, 2.5, "unspent remainder stays banked");
});

test("A HOLD still advances accrual so budget is never silently lost", () => {
  const { action } = decide({ state: st(), balances: bal(0), now: WED, config: cfg() });
  const next = applyAction(st(), action, null, { now: WED });
  assertEq(next.budget.carryUsd, 12, "accrued despite holding");
  assertEq(next.lastBuyDate, null, "but no buy recorded");
});

test("Round trip: buy then same-day rerun is a no-op", () => {
  const c = cfg();
  const first = decide({ state: st(), balances: bal(100), now: WED, config: c });
  const after = applyAction(st(), first.action, { usdSpent: 12 }, { now: WED });
  const second = decide({ state: after, balances: bal(88), now: WED, config: c });
  assertEq(second.action.type, "HOLD", "no double buy");
});

// ── Dip boost ────────────────────────────────────────────────────────────────

// Defaults are pinned here rather than read from CONFIG so a later change to
// the shipped factor or cap fails these tests loudly instead of silently
// redefining what they assert.
const boostCfg = (over = {}) =>
  cfg({ strategy: { boostOnLoss: true, boostFactor: 10, maxBoostMultiplier: 1.5, ...over } });

test("The user's case: down 2% at 10x buys 1.20x", () => {
  assertEq(lossBoost(-2, boostCfg()), 1.2, "multiplier");
});

test("Boost scales linearly with the drawdown", () => {
  // Cap lifted: this asserts the formula, not the clamp.
  const c = boostCfg({ maxBoostMultiplier: 99 });
  assertEq(lossBoost(-1,  c), 1.1, "-1%");
  assertEq(lossBoost(-5,  c), 1.5, "-5%");
  assertEq(lossBoost(-10, c), 2.0, "-10%");
});

test("Profit and break-even never change the size", () => {
  assertEq(lossBoost(0,    boostCfg()), 1, "flat");
  assertEq(lossBoost(5,    boostCfg()), 1, "up 5%");
  assertEq(lossBoost(1000, boostCfg()), 1, "up a lot");
});

test("The cap holds — a crash cannot size the trade", () => {
  assertEq(lossBoost(-5,  boostCfg()), 1.5, "-5% is exactly the cap");
  assertEq(lossBoost(-20, boostCfg()), 1.5, "-20% still capped");
  assertEq(lossBoost(-50, boostCfg()), 1.5, "-50% still capped");
  assertEq(lossBoost(-99, boostCfg()), 1.5, "-99% still capped");
});

test("The shipped default cap is 1.5x, reached at a 5% drawdown", () => {
  // Guards the config default itself, not a value this file invented.
  assertEq(CONFIG.strategy.maxBoostMultiplier, 1.5, "shipped cap");
  assertEq(CONFIG.strategy.boostFactor, 10, "shipped factor");
  assertEq(lossBoost(-4, CONFIG), 1.4, "-4% is still under the cap");
  assertEq(lossBoost(-5, CONFIG), 1.5, "-5% reaches it");
  assertEq(lossBoost(-80, CONFIG), 1.5, "a crash gets no more than -5% does");
});

test("An unknowable P&L never sizes up a trade", () => {
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, "-5"]) {
    assertEq(lossBoost(bad, boostCfg()), 1, `plPct=${String(bad)}`);
  }
});

test("boostOnLoss=false disables the rule entirely", () => {
  assertEq(lossBoost(-50, boostCfg({ boostOnLoss: false })), 1, "disabled");
});

test("Boost multiplies the banked budget, not just one day of it", () => {
  // Two days banked at $12/day = $24, down 5% → capped 1.5x → $36.
  const state = st({ budget: { carryUsd: 12, lastAccrualDate: "2026-08-25" } });
  const { action } = decide({ state, balances: bal(500), now: WED, config: boostCfg(), plPct: -5 });
  assertEq(action.usd, 36, "boosted spend");
});

test("Boosted buy spends past the accrued budget — carry floors at 0", () => {
  const c = boostCfg();
  const { action } = decide({ state: st(), balances: bal(500), now: WED, config: c, plPct: -2 });
  assertEq(action.usd, 14.4, "12 * 1.20");

  const next = applyAction(st(), action, { usdSpent: action.usd }, { now: WED });
  assertEq(next.budget.carryUsd, 0, "carry cannot go negative");
  assertEq(next.budget.spentUsd, 14.4, "lifetime spend records the overspend");
  // The overspend is visible precisely because accrual does not follow it.
  assertEq(next.budget.accruedUsd, 12, "accrual is untouched by the boost");
});

test("The wallet still caps the boost — appetite is not funding", () => {
  // Wants 12 * 1.5 = $18, wallet holds $15.
  const { action } = decide({ state: st(), balances: bal(15), now: WED, config: boostCfg(), plPct: -20 });
  assertEq(action.usd, 15, "clamped to available USDC");
});

test("Boost never revives a trade the rails killed", () => {
  const blocked = decide({
    state: st({ lastBuyDate: "2026-08-26" }), balances: bal(500), now: WED,
    config: boostCfg(), plPct: -20,
  });
  assertEq(blocked.action.type, "HOLD", "already bought today");
});

test("Boost cannot lift a dust trade over the minimum on its own", () => {
  // $1 banked, capped 1.5x → $1.50, still under the $5 floor.
  const state = st({ budget: { carryUsd: 1, lastAccrualDate: "2026-08-26" } });
  const { action, rails } = decide({ state, balances: bal(500), now: WED, config: boostCfg(), plPct: -20 });
  assertEq(action.type, "HOLD", "still dust");
  assertEq(railOf(rails, "MIN_TRADE_SIZE").passed, false, "min trade rail blocks");
});

test("The DIP_BOOST rail explains the size without ever blocking", () => {
  const boosted = decide({ state: st(), balances: bal(500), now: WED, config: boostCfg(), plPct: -2 });
  const railB = railOf(boosted.rails, "DIP_BOOST");
  assertEq(railB.passed, true, "never a gate");
  assertEq(railB.detail.includes("1.20x"), true, `detail shows multiplier: ${railB.detail}`);

  // Present and passing even when it does nothing, so --explain always accounts
  // for the amount rather than going quiet on the flat path.
  const flat = decide({ state: st(), balances: bal(500), now: WED, config: boostCfg(), plPct: 3 });
  assertEq(railOf(flat.rails, "DIP_BOOST").passed, true, "still passes when idle");
  assertEq(flat.action.usd, 12, "unboosted size");
});

test("decide survives a junk plPct instead of crashing the rail formatter", () => {
  for (const bad of [NaN, undefined, null, "-5", Infinity]) {
    const { action, rails } = decide({
      state: st(), balances: bal(500), now: WED, config: boostCfg(), plPct: bad,
    });
    assertEq(action.usd, 12, `unboosted for plPct=${String(bad)}`);
    assertEq(action.plPct, 0, `normalised to 0 for plPct=${String(bad)}`);
    assertEq(railOf(rails, "DIP_BOOST").detail.includes("1.00x"), true, "rail still renders");
  }
});

test("Omitting plPct is treated as flat, not as a loss", () => {
  const { action } = decide({ state: st(), balances: bal(500), now: WED, config: boostCfg() });
  assertEq(action.usd, 12, "default is unboosted");
  assertEq(action.boost, 1, "explicit 1x on the action");
});

test("The action carries the boost and the P&L that produced it", () => {
  const { action } = decide({ state: st(), balances: bal(500), now: WED, config: boostCfg(), plPct: -2 });
  assertEq(action.boost, 1.2, "boost on action");
  assertEq(action.plPct, -2, "plPct on action");
  assertEq(action.reason.includes("boosted 1.20x"), true, `reason explains: ${action.reason}`);
});


// ── Take-profit ──────────────────────────────────────────────────────────────

const tpCfg = (over = {}) => cfg({ strategy: { takeProfit: { ...CONFIG.strategy.takeProfit, enabled: true, ...over } } });
// A wallet holding the whole 5-unit position, priced at $130 — a $65 sale at 10%.
const tpBal = (units = 5, sol = 0.1) => ({ usdc: 0, sol, bySymbol: { USDC: 0, SOL: sol, JUPSOL: units } });
const sellArgs = (over = {}) => ({
  state: st(), balances: tpBal(), now: WED, config: tpCfg(), plPct: 12, positionUnits: 5, assetPrice: 130, ...over,
});

test("Take-profit ships OFF — a sell path nobody opted into", () => {
  assertEq(CONFIG.strategy.takeProfit.enabled, false, "default");
  assertEq(decideSell(sellArgs({ config: cfg() })).action.type, "HOLD", "off holds even deep in profit");
});

test("The shipped defaults are +10%, 10%, 30 days", () => {
  const { thresholdPct, sellFraction, cooldownDays } = CONFIG.strategy.takeProfit;
  assertEq(thresholdPct, 10, "threshold");
  assertEq(sellFraction, 0.10, "fraction");
  assertEq(cooldownDays, 30, "cooldown");
});

test("At +10% it sells 10% of the position", () => {
  const { action } = decideSell(sellArgs({ plPct: 10 }));
  assertEq(action.type, "SELL", "sells at exactly the threshold");
  assertEq(action.units, 0.5, "10% of 5 units");
  assertEq(action.fromSym, "JUPSOL", "sells the asset");
  assertEq(action.toSym, "USDC", "for the quote");
  assertEq(action.usd, 65, "priced");
});

test("Below the threshold it holds", () => {
  const { action, rails } = decideSell(sellArgs({ plPct: 9.99 }));
  assertEq(action.type, "HOLD", "no sale");
  assertEq(railOf(rails, "PROFIT_TARGET").passed, false, "rail names why");
});

test("The cooldown blocks a second sale inside the window", () => {
  const state = st({ lastSellDate: "2026-07-28" });   // 29 days before WED
  const { action, rails } = decideSell(sellArgs({ state }));
  assertEq(action.type, "HOLD", "29 days is not 30");
  assertEq(railOf(rails, "SELL_COOLDOWN").passed, false, "cooldown rail");
});

test("The cooldown releases on day 30", () => {
  const state = st({ lastSellDate: "2026-07-27" });   // 30 days before WED
  assertEq(decideSell(sellArgs({ state })).action.type, "SELL", "sells again");
});

test("A same-day rerun after a sale does not sell again", () => {
  const { action } = decideSell(sellArgs());
  const after = applyAction(st(), action, null, { now: WED });
  assertEq(decideSell(sellArgs({ state: after, plPct: 15 })).action.type, "HOLD", "cooldown from today");
});

test("Sizes off the whole position but sells only what is in this wallet", () => {
  // 5 units owned, 4.7 swept to custody: 10% is 0.5, only 0.3 is here.
  const { action, rails } = decideSell(sellArgs({ balances: tpBal(0.3) }));
  assertEq(action.type, "SELL", "still sells");
  assertEq(action.units, 0.3, "clamped to the wallet");
  assertEq(railOf(rails, "ASSET_IN_WALLET").detail.includes("clamped"), true, "rail says it was clamped");
});

test("A dust sale is refused", () => {
  const { action, rails } = decideSell(sellArgs({ balances: tpBal(0.03) }));   // $3.90
  assertEq(action.type, "HOLD", "under $5");
  assertEq(railOf(rails, "MIN_TRADE_SIZE").passed, false, "min size rail");
});

test("A sale is refused without gas, or with an intent pending", () => {
  assertEq(decideSell(sellArgs({ balances: tpBal(5, 0.01) })).action.type, "HOLD", "gas");
  assertEq(decideSell(sellArgs({ state: st({ pendingIntent: { createdAt: WED } }) })).action.type, "HOLD", "pending");
});

test("A junk plPct never triggers a sale", () => {
  for (const p of [NaN, Infinity, undefined, "12"]) {
    assertEq(decideSell(sellArgs({ plPct: p })).action.type, "HOLD", `plPct=${String(p)}`);
  }
});

test("A sale leaves the DCA budget untouched and starts the cooldown", () => {
  const before = st({ budget: { carryUsd: 13, spentUsd: 100, accruedUsd: 113, lastAccrualDate: "2026-08-26" }, buyCount: 7, lastBuyDate: "2026-08-26" });
  const { action } = decideSell(sellArgs({ state: before }));
  const after = applyAction(before, action, null, { now: WED });
  assertEq(JSON.stringify(after.budget), JSON.stringify(before.budget), "budget unchanged");
  assertEq(after.buyCount, 7, "not a buy");
  assertEq(after.lastBuyDate, "2026-08-26", "buy idempotency key untouched");
  assertEq(after.lastSellDate, "2026-08-26", "cooldown anchor");
  assertEq(after.sellCount, 1, "counted");
});

test("decideSell is pure", () => {
  const args = sellArgs({ state: st({ lastSellDate: "2026-01-01" }) });
  const frozen = JSON.stringify(args);
  decideSell(args);
  assertEq(JSON.stringify(args), frozen, "inputs unchanged");
});

console.log(failures === 0 ? "\nAll strategy tests passed" : `\n${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
