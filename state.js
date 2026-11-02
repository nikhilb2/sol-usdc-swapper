// state.js — Durable strategy ledger.
//
// Backed by Postgres when DATABASE_URL is set, an atomically-written JSON file
// otherwise. The state shape is identical either way, which is what keeps
// strategy.js a pure function of a plain object.

import path from "path";
import { CONFIG, strategyAsset } from "./config.js";
import {
  selectState, upsertState,
  acquireLock as backendAcquireLock,
  releaseLock as backendReleaseLock,
} from "./storage/index.js";

export const STATE_VERSION = 1;

// Path helpers are meaningful only for the file backend; kept for tests.
export function dataDir()   { return process.env.DATA_DIR || "./data"; }
export function statePath() { return path.join(dataDir(), "state.json"); }
export function lockPath()  { return path.join(dataDir(), "run.lock"); }

/** UTC date key, "YYYY-MM-DD". All idempotency keys use this. Pure. */
export function utcDate(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** Pure — exported for tests and the backtest. */
export function defaultState() {
  return {
    version: STATE_VERSION,
    updatedAt: null,
    asset: strategyAsset(),
    budget: {
      dailyUsd: CONFIG.strategy.dailyUsd,
      carryUsd: 0,            // unspent budget carried forward (capped)
      accruedUsd: 0,          // lifetime, for audit
      spentUsd: 0,            // lifetime USD actually deployed
      lastAccrualDate: null,  // UTC date of the last accrual tick
    },
    startDate: null,          // first run — anchors the counterfactual
    lastBuyDate: null,        // the idempotency key
    buyCount: 0,
    lastSellDate: null,       // anchors the take-profit cooldown
    sellCount: 0,
    pendingIntent: null,      // set BEFORE a swap, cleared after — see run.js
    lastRun: null,
  };
}

/**
 * Load state, merged onto defaults so a ledger written by an older version
 * still loads with newly-added fields present.
 *
 * A corrupt file backend is NOT silently replaced: trading from a reset ledger
 * would double-spend the budget and drop the pending-intent lock.
 */
export async function loadState() {
  const { state: raw, corrupt, backup } = await selectState();
  if (corrupt) return { state: defaultState(), fresh: false, corrupt: true, backup };
  if (!raw)    return { state: defaultState(), fresh: true, corrupt: false };

  const base  = defaultState();
  const state = { ...base, ...raw, budget: { ...base.budget, ...(raw.budget || {}) } };
  return { state, fresh: false, corrupt: false };
}

export async function saveState(state) {
  return upsertState({ ...state, updatedAt: new Date().toISOString() });
}

export async function acquireLock() { return backendAcquireLock(); }
export async function releaseLock() { return backendReleaseLock(); }
