// storage/postgres.js — Postgres backend, active when DATABASE_URL is set.
//
// What the database buys us over the file backend:
//   - a UNIQUE index on the signature, so a confirmed trade can be logged
//     exactly once, enforced by the engine rather than by hoping the process
//     survives between confirmation and append
//   - pg_advisory_lock for the run lock: session-scoped and released
//     automatically when the connection drops, so there is no stale-lock
//     heuristic to get wrong
//   - real transactions instead of temp-file-plus-rename-plus-two-fsyncs

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

// NUMERIC comes back as a string by default to protect precision. Our amounts
// are ≤ 9 decimal places and well inside float64's exact-integer range, and the
// file backend already round-trips them through JSON numbers, so parse to
// Number and keep the two backends behaviourally identical.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, v => (v === null ? null : parseFloat(v)));

// Advisory lock key. Arbitrary but fixed — two int32s form one lock identity.
// Exported so tests assert against the real key rather than a copy that can drift.
export const LOCK_KEY = [0x5013, 0x5741];

let pool = null;
let lockClient = null;

function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 10_000,
    });
    // A pool error with no listener crashes the process.
    pool.on("error", e => console.error(`postgres pool error: ${e.message}`));
  }
  return pool;
}

const q = (text, params) => getPool().query(text, params);

export const backend = "postgres";

export function describe() {
  try {
    const u = new URL(process.env.DATABASE_URL);
    return `postgres (${u.host}/${u.pathname.slice(1)})`;
  } catch { return "postgres"; }
}

/** Apply schema.sql. Idempotent — safe against an existing database. */
export async function migrate() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  await q(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
}

export async function close() {
  if (lockClient) { try { lockClient.release(); } catch {} lockClient = null; }
  if (pool) { await pool.end(); pool = null; }
}

// ── Transactions ─────────────────────────────────────────────────────────────

const toRecord = r => ({
  timestamp:  r.ts instanceof Date ? r.ts.toISOString() : r.ts,
  type:       r.type,
  fromSym:    r.from_sym,
  toSym:      r.to_sym,
  fromAmount: r.from_amount,
  toAmount:   r.to_amount,
  price:      r.price,
  sig:        r.sig,
  dryRun:     r.dry_run,
  intent:     r.intent,
  dest:       r.dest ?? null,
});

export async function insertTransaction(record) {
  const { rows } = await q(
    `INSERT INTO transactions (ts, type, from_sym, to_sym, from_amount, to_amount, price, sig, dry_run, intent, dest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     -- A re-run that re-submits an already-confirmed signature must not
     -- produce a second row. Returns nothing when the row already exists.
     -- Type-agnostic, so a custody transfer inherits the same exactly-once
     -- guarantee a swap gets — which is what makes its retry path safe.
     ON CONFLICT (sig) WHERE sig IS NOT NULL AND dry_run = false DO NOTHING
     RETURNING *`,
    [record.timestamp, record.type, record.fromSym, record.toSym,
     record.fromAmount, record.toAmount, record.price, record.sig,
     record.dryRun, record.intent, record.dest ?? null]
  );
  return rows.length ? toRecord(rows[0]) : record;
}

export async function selectTransactions({ includeDryRun = false } = {}) {
  const { rows } = await q(
    includeDryRun
      ? `SELECT * FROM transactions ORDER BY ts ASC, id ASC`
      : `SELECT * FROM transactions WHERE dry_run = false ORDER BY ts ASC, id ASC`
  );
  return rows.map(toRecord);
}

export async function deleteTransactions() {
  await q(`TRUNCATE transactions RESTART IDENTITY`);
}

// ── Strategy state ───────────────────────────────────────────────────────────

export async function selectState() {
  const { rows } = await q(`SELECT state FROM strategy_state WHERE id = 1`);
  return { state: rows.length ? rows[0].state : null, corrupt: false };
}

export async function upsertState(state) {
  await q(
    `INSERT INTO strategy_state (id, state, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [JSON.stringify(state)]
  );
  return state;
}

// ── Prices ───────────────────────────────────────────────────────────────────

export async function selectCloses() {
  const { rows } = await q(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, close, source FROM prices ORDER BY date ASC`
  );
  return rows;
}

export async function insertCloses(rows) {
  if (!rows.length) return 0;
  const { rowCount } = await q(
    `INSERT INTO prices (date, close, source)
     SELECT * FROM unnest($1::date[], $2::numeric[], $3::text[])
     ON CONFLICT (date) DO NOTHING`,
    [rows.map(r => r.date), rows.map(r => r.close), rows.map(r => r.source ?? null)]
  );
  return rowCount;
}

// ── Price alerts ─────────────────────────────────────────────────────────────

const iso = v => (v instanceof Date ? v.toISOString() : v ?? null);

const toAlert = r => ({
  id:          Number(r.id),
  symbol:      r.symbol,
  op:          r.op,
  target:      r.target,
  repeat:      r.repeat,
  note:        r.note,
  active:      r.active,
  armed:       r.armed,
  fireCount:   r.fire_count,
  createdAt:   iso(r.created_at),
  lastFiredAt: iso(r.last_fired_at),
  lastPrice:   r.last_price,
  checkedAt:   iso(r.checked_at),
});

// The only fields updateAlert may touch. A fixed map, so a patch key can never
// become SQL.
const ALERT_COLUMNS = { active: "active", armed: "armed", fireCount: "fire_count", lastFiredAt: "last_fired_at" };

export async function selectAlerts({ activeOnly = false } = {}) {
  const { rows } = await q(
    `SELECT * FROM price_alerts ${activeOnly ? "WHERE active" : ""}
     ORDER BY active DESC, created_at DESC, id DESC`
  );
  return rows.map(toAlert);
}

export async function insertAlert(a) {
  const { rows } = await q(
    `INSERT INTO price_alerts (symbol, op, target, repeat, note) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [a.symbol, a.op, a.target, a.repeat, a.note]
  );
  return toAlert(rows[0]);
}

/** @returns {Promise<boolean>} false when the alert no longer exists */
export async function updateAlert(id, patch) {
  const keys = Object.keys(patch).filter(k => ALERT_COLUMNS[k]);
  if (!keys.length) return true;
  const sets = keys.map((k, i) => `${ALERT_COLUMNS[k]} = $${i + 2}`).join(", ");
  const { rowCount } = await q(`UPDATE price_alerts SET ${sets} WHERE id = $1`, [id, ...keys.map(k => patch[k])]);
  return rowCount > 0;
}

/** @returns {Promise<boolean>} false when there was nothing to delete */
export async function deleteAlert(id) {
  const { rowCount } = await q(`DELETE FROM price_alerts WHERE id = $1`, [id]);
  return rowCount > 0;
}

/** Stamp every active alert on a symbol with the price the watcher just saw. */
export async function markAlertsChecked(pricesBySym, at) {
  const syms = Object.keys(pricesBySym);
  if (!syms.length) return;
  await q(
    `UPDATE price_alerts a SET last_price = p.price, checked_at = $3
     FROM unnest($1::text[], $2::numeric[]) AS p(symbol, price)
     WHERE a.symbol = p.symbol AND a.active`,
    [syms, syms.map(s => pricesBySym[s]), at]
  );
}

// ── Run lock ─────────────────────────────────────────────────────────────────

/**
 * Session-scoped advisory lock. Held on a dedicated connection so it survives
 * for the life of the process and is released by the server the moment that
 * connection goes away — including if we are SIGKILLed. No stale lock is
 * possible, which is the whole reason to prefer this over a lockfile.
 */
export async function acquireLock() {
  // Guard re-entry. Without this a second caller in the same process
  // overwrites lockClient, fails the advisory lock, nulls the global, and
  // makes the FIRST caller's releaseLock() a no-op — leaking a pooled
  // connection and wedging the lock until the TCP session dies. Harmless
  // while only run.js took the lock; the dashboard's transfer route made
  // two callers in one process possible.
  if (lockClient) throw new Error("This process already holds the run lock.");
  lockClient = await getPool().connect();
  const { rows } = await lockClient.query(`SELECT pg_try_advisory_lock($1, $2) AS got`, LOCK_KEY);
  if (!rows[0].got) {
    lockClient.release();
    lockClient = null;
    throw new Error("Another run holds the Postgres advisory lock. Wait for it to finish.");
  }
  return true;
}

export async function releaseLock() {
  if (!lockClient) return;
  try { await lockClient.query(`SELECT pg_advisory_unlock($1, $2)`, LOCK_KEY); } catch {}
  try { lockClient.release(); } catch {}
  lockClient = null;
}
