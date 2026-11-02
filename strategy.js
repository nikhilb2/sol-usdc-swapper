// strategy.js — Pure decision engine. No I/O, no clock, no network.
//
// `now` is always passed in and every function here is a pure transform of its
// arguments. That is what lets backtest.js and run.js execute the *same* code:
// if the decision logic ever forked between them, the backtest would be
// measuring something the bot doesn't actually do.
//
// The strategy itself is deliberately minimal — accrue a budget, spend it on a
// schedule, never spend money that isn't there. See config.js for why nothing
// cleverer survived backtesting.

/** UTC date key, "YYYY-MM-DD". */
export function utcDate(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/** Whole UTC days between two date keys. Negative clamps to 0. */
export function daysBetween(fromKey, toKey) {
  if (!fromKey) return 0;
  const ms = Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

export function cadenceDays(config) {
  return config.strategy.cadence === "weekly" ? 7 : 1;
}

/** Carry ceiling. Weekly cadence must be able to bank a full period. */
export function carryCap(config) {
  const { maxCarryUsd, dailyUsd } = config.strategy;
  return maxCarryUsd + cadenceDays(config) * dailyUsd;
}

/** Is `now` a scheduled buy day? */
export function isBuyDay(now, config) {
  if (config.strategy.cadence !== "weekly") return true;
  return new Date(now).getUTCDay() === config.strategy.weeklyDow;
}

/**
 * Accrue budget up to `now`. Pure — returns a new budget object.
 *
 * Keyed on lastAccrualDate so running twice in one day cannot accrue twice.
 */
export function accrue(budget, now, config) {
  const today = utcDate(now);
  if (budget.lastAccrualDate === today) return { ...budget };

  // First ever run accrues a single day, not a backfill from the epoch.
  const days = budget.lastAccrualDate ? daysBetween(budget.lastAccrualDate, today) : 1;
  const added = days * config.strategy.dailyUsd;

  return {
    ...budget,
    carryUsd:   Math.min(budget.carryUsd + added, carryCap(config)),
    accruedUsd: budget.accruedUsd + added,
    lastAccrualDate: today,
  };
}

/**
 * Dip boost: how much bigger the next buy should be, given total P&L percent.
 *
 * Pure, and deliberately unaware of where `plPct` came from — run.js measures
 * it from the real trade log, backtest.js from the simulated position, and both
 * feed the same function. `plPct` is a percentage (-2 means down 2%).
 *
 * Returns 1 (no change) whenever P&L is flat, positive, or unknowable — a
 * missing number must never silently size up a trade.
 */
export function lossBoost(plPct, config) {
  const { boostOnLoss, boostFactor, maxBoostMultiplier } = config.strategy;

  if (!boostOnLoss) return 1;
  if (!Number.isFinite(plPct) || plPct >= 0) return 1;

  const drawdown = Math.abs(plPct) / 100;
  return Math.min(1 + drawdown * boostFactor, maxBoostMultiplier);
}

const rail = (name, passed, detail) => ({ name, passed, detail });

/**
 * Decide what to do right now.
 *
 * @returns {{action: Object, rails: Array}} — action.type is "BUY" or "HOLD".
 *   Every rail is always evaluated and returned, even after one fails, so
 *   `--explain` shows the whole picture instead of stopping at the first no.
 */
export function decide({ state, balances, now, config, plPct = 0 }) {
  const today  = utcDate(now);
  // Normalise once, at the boundary. A caller that hands over a string, a NaN
  // from an empty trade log, or nothing at all gets flat P&L — never a boost,
  // and never a crash formatting the rail.
  const pl     = Number.isFinite(plPct) ? plPct : 0;
  const asset  = config.strategy.asset;
  const budget = accrue(state.budget, now, config);
  const rails  = [];

  const enabled   = config.strategy.enabled;
  const noPending = state.pendingIntent == null;
  const buyDay    = isBuyDay(now, config);
  const notToday  = state.lastBuyDate !== today;

  rails.push(rail("ENABLED", enabled, enabled ? "strategy enabled" : "STRATEGY_ENABLED=false"));
  rails.push(rail("NO_PENDING_INTENT", noPending,
    noPending ? "no unresolved swap" : `unresolved intent from ${state.pendingIntent?.createdAt}`));
  rails.push(rail("BUY_DAY", buyDay,
    config.strategy.cadence === "weekly"
      ? `weekly cadence, day ${new Date(now).getUTCDay()} vs target ${config.strategy.weeklyDow}`
      : "daily cadence"));
  rails.push(rail("NOT_BOUGHT_TODAY", notToday,
    notToday ? `last buy ${state.lastBuyDate ?? "never"}` : `already bought on ${today}`));

  // What we could spend: everything banked, scaled up if we're underwater, and
  // limited by what's actually in the wallet. The wallet is the hard
  // constraint — carry is only an intention, and the boost is only an appetite.
  const available = Math.max(0, balances.usdc);
  const boost     = lossBoost(pl, config);
  const want      = budget.carryUsd * boost;
  const spend     = Math.min(want, available);

  const funded = spend >= config.swap.minTradeSizeUsd;
  const hasUsdc = available >= config.swap.minTradeSizeUsd;

  rails.push(rail("USDC_AVAILABLE", hasUsdc,
    `$${available.toFixed(2)} USDC in wallet`));
  rails.push(rail("MIN_TRADE_SIZE", funded,
    `$${spend.toFixed(2)} vs $${config.swap.minTradeSizeUsd} minimum`));

  // Not a gate — it never blocks a trade — but it changes the size of one, so
  // --explain has to show it or the printed rails wouldn't explain the amount.
  rails.push(rail("DIP_BOOST", true,
    boost > 1
      ? `${boost.toFixed(2)}x — down ${Math.abs(pl).toFixed(2)}% ` +
        `($${round2(budget.carryUsd)} banked → $${round2(want)} target)`
      : `1.00x — ${config.strategy.boostOnLoss ? `P&L ${pl >= 0 ? "+" : ""}${pl.toFixed(2)}%` : "disabled"}`));

  const gasOk = balances.sol >= config.swap.minSolReserveLamports / 1e9;
  rails.push(rail("GAS_RESERVE", gasOk,
    `${balances.sol.toFixed(6)} SOL vs ${(config.swap.minSolReserveLamports / 1e9).toFixed(3)} reserve`));

  const go = enabled && noPending && buyDay && notToday && funded && gasOk;

  if (!go) {
    const blocked = rails.filter(r => !r.passed).map(r => r.name);
    return {
      action: {
        type: "HOLD",
        reason: blocked.length ? `blocked by ${blocked.join(", ")}` : "nothing to do",
        budget,
      },
      rails,
    };
  }

  return {
    action: {
      type: "BUY",
      fromSym: config.strategy.quote,
      toSym: asset,
      usd: round2(spend),
      intent: "dca",
      reason: boost > 1
        ? `scheduled ${config.strategy.cadence} buy — $${round2(spend)}, ` +
          `boosted ${boost.toFixed(2)}x on a ${Math.abs(pl).toFixed(2)}% drawdown`
        : `scheduled ${config.strategy.cadence} buy — $${round2(spend)} of banked budget`,
      budget,
      boost,
      plPct: pl,
    },
    rails,
  };
}

/**
 * Decide whether to take profit right now. Pure, like decide().
 *
 * Only ever consulted when decide() holds — run.js does at most one swap per
 * run and the DCA goes first, so a sale can never crowd out the scheduled buy.
 *
 * Sizes the sale off the WHOLE position (custody included, the same units P&L
 * is measured on) but can only sell what is in this wallet. If most of the
 * position has been swept to the safe wallet, the sale is clamped to what's
 * here, and the rail says so.
 *
 * @param {number} plPct          total P&L percent, from plSummary
 * @param {number} positionUnits  bot-attributed units, custody included
 * @param {number} assetPrice     USD per unit
 * @returns {{action: Object, rails: Array}} — action.type is "SELL" or "HOLD".
 */
export function decideSell({ state, balances, now, config, plPct = 0, positionUnits = 0, assetPrice = 0 }) {
  const today = utcDate(now);
  const tp    = config.strategy.takeProfit;
  const asset = config.strategy.asset;
  const pl    = Number.isFinite(plPct) ? plPct : 0;
  const rails = [];

  const enabled   = Boolean(tp?.enabled);
  const noPending = state.pendingIntent == null;
  const inProfit  = pl >= tp.thresholdPct;
  const sinceSell = state.lastSellDate ? daysBetween(state.lastSellDate, today) : Infinity;
  const cooled    = sinceSell >= tp.cooldownDays;

  rails.push(rail("TAKE_PROFIT", enabled, enabled ? "take-profit enabled" : "STRATEGY_TAKE_PROFIT is not true"));
  rails.push(rail("NO_PENDING_INTENT", noPending,
    noPending ? "no unresolved swap" : `unresolved intent from ${state.pendingIntent?.createdAt}`));
  rails.push(rail("PROFIT_TARGET", inProfit,
    `P&L ${pl >= 0 ? "+" : ""}${pl.toFixed(2)}% vs +${tp.thresholdPct}% target`));
  rails.push(rail("SELL_COOLDOWN", cooled,
    state.lastSellDate
      ? `last sale ${state.lastSellDate}, ${sinceSell}d ago vs ${tp.cooldownDays}d cooldown`
      : "never sold"));

  const inWallet = Math.max(0, balances.bySymbol?.[asset] ?? 0);
  const target   = Math.max(0, positionUnits) * tp.sellFraction;
  const units    = Math.min(target, inWallet);
  const usd      = units * assetPrice;

  rails.push(rail("ASSET_IN_WALLET", inWallet > 0,
    units < target
      ? `${inWallet.toFixed(6)} ${asset} here — clamped from ${target.toFixed(6)} (the rest is in custody)`
      : `${inWallet.toFixed(6)} ${asset} here, selling ${units.toFixed(6)}`));
  const funded = usd >= config.swap.minTradeSizeUsd;
  rails.push(rail("MIN_TRADE_SIZE", funded,
    `$${usd.toFixed(2)} vs $${config.swap.minTradeSizeUsd} minimum`));

  const gasOk = balances.sol >= config.swap.minSolReserveLamports / 1e9;
  rails.push(rail("GAS_RESERVE", gasOk,
    `${balances.sol.toFixed(6)} SOL vs ${(config.swap.minSolReserveLamports / 1e9).toFixed(3)} reserve`));

  const go = enabled && noPending && inProfit && cooled && funded && gasOk;

  if (!go) {
    const blocked = rails.filter(r => !r.passed).map(r => r.name);
    return { action: { type: "HOLD", reason: `no sale — blocked by ${blocked.join(", ")}` }, rails };
  }

  return {
    action: {
      type: "SELL",
      fromSym: asset,
      toSym: config.strategy.quote,
      units,
      amount: units,
      usd: round2(usd),
      intent: "take_profit",
      reason: `take profit — P&L +${pl.toFixed(2)}%, selling ${units.toFixed(6)} ${asset} (~$${round2(usd)})`,
      plPct: pl,
    },
    rails,
  };
}

/**
 * Fold an executed action back into state. Pure.
 *
 * `fill` carries what ACTUALLY happened (from executeSwap or the trade log),
 * never what was intended — a partial or re-priced fill must not desync the
 * ledger from the chain.
 */
export function applyAction(state, action, fill, { now }) {
  const today  = utcDate(now);
  const budget = action.budget ?? state.budget;

  // A sale touches no budget: the DCA neither banks its proceeds nor spends
  // less because of it. Only the cooldown anchor moves.
  if (action.type === "SELL") {
    return { ...state, lastSellDate: today, sellCount: (state.sellCount ?? 0) + 1 };
  }

  if (action.type !== "BUY") {
    return { ...state, budget, startDate: state.startDate ?? today };
  }

  const spent = fill?.usdSpent ?? action.usd;

  return {
    ...state,
    budget: {
      ...budget,
      carryUsd:  Math.max(0, round2(budget.carryUsd - spent)),
      spentUsd:  round2(budget.spentUsd + spent),
    },
    startDate:   state.startDate ?? today,
    lastBuyDate: today,
    buyCount:    state.buyCount + 1,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
