// state.test.js — Ledger durability
// Run: node state.test.js

import fs from "fs";
import os from "os";
import path from "path";

const TEST_DIR = path.join(os.tmpdir(), "sol-usdc-swapper-state-test");
process.env.DATA_DIR = TEST_DIR;
process.env.STORAGE_BACKEND = "files";   // never let a stray DATABASE_URL hit a real DB
process.env.STRATEGY_ASSET = "JUPSOL";
fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

const { loadState, saveState, defaultState, statePath, acquireLock, releaseLock, lockPath, utcDate } =
  await import("./state.js");

let failures = 0;

async function test(name, fn) {
  try {
    fs.rmSync(statePath(), { force: true });
    await releaseLock();
    await fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    failures++;
    console.error(`❌ ${name}: ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`); }

await test("Missing file yields defaults and flags a fresh start", async () => {
  const { state, fresh, corrupt } = await loadState();
  assert(fresh, "fresh flag");
  assert(!corrupt, "not corrupt");
  assertEq(state.budget.carryUsd, 0, "carry");
  assertEq(state.asset, "JUPSOL", "asset");
});

await test("Save then load round-trips", async () => {
  const s = defaultState();
  s.budget.carryUsd = 24.5;
  s.lastBuyDate = "2026-08-26";
  s.buyCount = 7;
  await saveState(s);

  const { state, fresh } = await loadState();
  assert(!fresh, "not fresh");
  assertEq(state.budget.carryUsd, 24.5, "carry");
  assertEq(state.lastBuyDate, "2026-08-26", "date");
  assertEq(state.buyCount, 7, "count");
});

await test("Save leaves no temp file behind", async () => {
  await saveState(defaultState());
  const leftovers = fs.readdirSync(TEST_DIR).filter(f => f.includes(".tmp."));
  assertEq(leftovers.length, 0, `temp files: ${leftovers.join(",")}`);
});

await test("updatedAt is stamped on every write", async () => {
  await saveState(defaultState());
  assert((await loadState()).state.updatedAt, "updatedAt set");
});

await test("Corrupt state is preserved, not silently discarded", async () => {
  fs.writeFileSync(statePath(), "{ this is not json");
  const { state, corrupt, backup } = await loadState();
  assert(corrupt, "flagged corrupt");
  assert(fs.existsSync(backup), "backup written");
  assertEq(fs.readFileSync(backup, "utf8"), "{ this is not json", "backup content intact");
  assertEq(state.budget.carryUsd, 0, "defaults returned");
});

await test("A state file from an older version gains new fields on load", async () => {
  fs.writeFileSync(statePath(), JSON.stringify({ version: 1, lastBuyDate: "2026-01-01" }));
  const { state } = await loadState();
  assertEq(state.lastBuyDate, "2026-01-01", "old field kept");
  assertEq(state.budget.carryUsd, 0, "new nested field defaulted");
  assertEq(state.buyCount, 0, "new field defaulted");
});

await test("pendingIntent survives a save/load cycle intact", async () => {
  const s = defaultState();
  s.pendingIntent = {
    createdAt: "2026-08-26T09:00:00Z",
    action: { type: "BUY", usd: 12, fromSym: "USDC", toSym: "JUPSOL" },
    preBalances: { usdc: 100, asset: 1.5 },
  };
  await saveState(s);
  const back = (await loadState()).state.pendingIntent;
  assertEq(back.action.usd, 12, "usd");
  assertEq(back.preBalances.asset, 1.5, "pre-balance");
});

await test("DATA_DIR is re-read per call, not frozen at import", async () => {
  const alt = path.join(TEST_DIR, "alt");
  await saveState(defaultState());
  process.env.DATA_DIR = alt;
  assert(statePath().startsWith(alt), "path followed the env change");
  assert((await loadState()).fresh, "alt dir is empty");
  process.env.DATA_DIR = TEST_DIR;
process.env.STORAGE_BACKEND = "files";   // never let a stray DATABASE_URL hit a real DB
  assert(!(await loadState()).fresh, "original dir still has state");
});

await test("Lock is exclusive while held, and released after", async () => {
  await acquireLock();
  assert(fs.existsSync(lockPath()), "lock file exists");
  let threw = false;
  try { await acquireLock(); } catch { threw = true; }
  // Same pid is alive, so a second acquire must be refused.
  assert(threw, "second acquire refused");
  await releaseLock();
  assert(!fs.existsSync(lockPath()), "lock removed");
});

await test("A stale lock from a dead process is taken over", async () => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  // pid 999999 is not running.
  fs.writeFileSync(lockPath(), JSON.stringify({ pid: 999999, at: "2026-01-01T00:00:00Z" }));
  await acquireLock();
  assertEq(JSON.parse(fs.readFileSync(lockPath(), "utf8")).pid, process.pid, "took over");
  await releaseLock();
});

await test("utcDate is stable across timezones", async () => {
  assertEq(utcDate("2026-08-26T23:59:59Z"), "2026-08-26", "late UTC");
  assertEq(utcDate("2026-08-27T00:00:01Z"), "2026-08-27", "early UTC");
});

console.log(failures === 0 ? "\nAll state tests passed" : `\n${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
