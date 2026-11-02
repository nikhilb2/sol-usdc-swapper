// storage/files.js — JSONL + JSON file backend.
//
// The default when DATABASE_URL is unset. Keeps the project runnable with no
// services, which is what the test suite uses.

import fs from "fs";
import path from "path";

const dataDir    = () => process.env.DATA_DIR || "./data";
const txPath     = () => path.join(dataDir(), "transactions.jsonl");
const statePath  = () => path.join(dataDir(), "state.json");
const pricesPath = () => path.join(dataDir(), "prices.jsonl");
const lockPath   = () => path.join(dataDir(), "run.lock");
const alertsPath = () => path.join(dataDir(), "alerts.json");

export const backend = "files";
export function describe() { return `files (${dataDir()})`; }
export async function migrate() { fs.mkdirSync(dataDir(), { recursive: true }); }
export async function close() {}

// ── Transactions ─────────────────────────────────────────────────────────────

export async function insertTransaction(record) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.appendFileSync(txPath(), JSON.stringify(record) + "\n");
  return record;
}

export async function selectTransactions({ includeDryRun = false } = {}) {
  let raw;
  try { raw = fs.readFileSync(txPath(), "utf8"); } catch { return []; }
  const txs = raw.split("\n").filter(Boolean).flatMap(l => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
  return includeDryRun ? txs : txs.filter(t => !t.dryRun);
}

export async function deleteTransactions() {
  try { fs.unlinkSync(txPath()); } catch {}
}

// ── Strategy state ───────────────────────────────────────────────────────────

export async function selectState() {
  let raw;
  try { raw = fs.readFileSync(statePath(), "utf8"); }
  catch { return { state: null, corrupt: false }; }

  try { return { state: JSON.parse(raw), corrupt: false }; }
  catch {
    const backup = `${statePath()}.corrupt.${Date.now()}`;
    try { fs.renameSync(statePath(), backup); } catch {}
    return { state: null, corrupt: true, backup };
  }
}

/**
 * Atomic write. Both fsyncs matter: the file fsync makes the bytes durable and
 * the directory fsync makes the rename durable. Skipping the second is the
 * classic bug — the rename can be lost on power failure even when the contents
 * were flushed.
 */
function writeJsonAtomic(target, value) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${target}.tmp.${process.pid}`;
  const fd  = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, target);

  const dfd = fs.openSync(dir, "r");
  try { fs.fsyncSync(dfd); } catch { /* not supported on all filesystems */ }
  finally { fs.closeSync(dfd); }
}

export async function upsertState(state) {
  writeJsonAtomic(statePath(), state);
  return state;
}

// ── Prices ───────────────────────────────────────────────────────────────────

export async function selectCloses() {
  let raw;
  try { raw = fs.readFileSync(pricesPath(), "utf8"); } catch { return []; }
  const byDate = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.date && Number.isFinite(r.close)) byDate.set(r.date, r);
    } catch { /* skip a malformed line rather than losing the file */ }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function insertCloses(rows) {
  if (!rows.length) return 0;
  fs.mkdirSync(dataDir(), { recursive: true });
  const known = new Set((await selectCloses()).map(r => r.date));
  const fresh = rows.filter(r => !known.has(r.date));
  if (!fresh.length) return 0;
  fs.appendFileSync(pricesPath(), fresh.map(r => JSON.stringify(r)).join("\n") + "\n");
  return fresh.length;
}

// ── Price alerts ─────────────────────────────────────────────────────────────
//
// One JSON file, rewritten whole. Two processes (dashboard and watcher) each
// read-modify-write it, so a create landing in the same millisecond as a tick
// can be lost. Acceptable for a local dev backend; production is Postgres,
// where each write is its own row-level statement.

// Only a missing file means "no alerts". An unreadable one throws: reading it
// as empty would let the next write silently replace every alert.
function readAlertsFile() {
  let raw;
  try { raw = fs.readFileSync(alertsPath(), "utf8"); }
  catch (e) { if (e.code === "ENOENT") return { nextId: 1, alerts: [] }; throw e; }
  const f = JSON.parse(raw);
  return { nextId: f.nextId ?? 1, alerts: Array.isArray(f.alerts) ? f.alerts : [] };
}

const ALERT_FIELDS = ["active", "armed", "fireCount", "lastFiredAt"];

export async function selectAlerts({ activeOnly = false } = {}) {
  const { alerts } = readAlertsFile();
  return alerts
    .filter(a => !activeOnly || a.active)
    .sort((a, b) => (b.active - a.active) || b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
}

export async function insertAlert(a) {
  const f = readAlertsFile();
  const row = {
    id: f.nextId, symbol: a.symbol, op: a.op, target: a.target, repeat: a.repeat, note: a.note,
    active: true, armed: true, fireCount: 0, createdAt: new Date().toISOString(),
    lastFiredAt: null, lastPrice: null, checkedAt: null,
  };
  writeJsonAtomic(alertsPath(), { nextId: f.nextId + 1, alerts: [...f.alerts, row] });
  return row;
}

export async function updateAlert(id, patch) {
  const f = readAlertsFile();
  const row = f.alerts.find(a => a.id === id);
  if (!row) return false;
  for (const k of ALERT_FIELDS) if (k in patch) row[k] = patch[k];
  writeJsonAtomic(alertsPath(), f);
  return true;
}

export async function deleteAlert(id) {
  const f = readAlertsFile();
  const alerts = f.alerts.filter(a => a.id !== id);
  if (alerts.length === f.alerts.length) return false;
  writeJsonAtomic(alertsPath(), { ...f, alerts });
  return true;
}

export async function markAlertsChecked(pricesBySym, at) {
  const f = readAlertsFile();
  let touched = false;
  for (const a of f.alerts) {
    if (a.active && pricesBySym[a.symbol] !== undefined) {
      a.lastPrice = pricesBySym[a.symbol];
      a.checkedAt = at;
      touched = true;
    }
  }
  if (touched) writeJsonAtomic(alertsPath(), f);
}

// ── Run lock ─────────────────────────────────────────────────────────────────

export async function acquireLock() {
  fs.mkdirSync(dataDir(), { recursive: true });
  const p = lockPath();
  try {
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    if (holder?.pid && isAlive(holder.pid)) {
      throw new Error(`Another run is in progress (pid ${holder.pid}, started ${holder.at}). If that is wrong, delete ${p}`);
    }
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return true;
  }
}

export async function releaseLock() {
  try { fs.unlinkSync(lockPath()); } catch {}
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
