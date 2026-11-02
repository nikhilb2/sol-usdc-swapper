// alerts.test.js — Price alert rules, Telegram delivery, the watcher loop
// Run: node alerts.test.js
//
// No network: prices and Telegram are injected fakes.

import fs from "fs";
import os from "os";
import path from "path";

const TEST_DIR = path.join(os.tmpdir(), "sol-usdc-swapper-alerts-test");
process.env.DATA_DIR = TEST_DIR;
process.env.STORAGE_BACKEND = "files";   // never let a stray DATABASE_URL hit a real DB
fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

const { validateAlert, evaluate, formatAlertMessage, ALERT_SYMBOLS } = await import("./alerts.js");
const { sendTelegram } = await import("./telegram.js");
const { CONFIG } = await import("./config.js");
const storage = await import("./storage/index.js");
const { tick, runTick, _resetHealth } = await import("./watch.js");
const { createRateLimit } = await import("./transfer-guard.js");

let failures = 0;

async function test(name, fn) {
  try {
    fs.rmSync(path.join(TEST_DIR, "alerts.json"), { force: true });
    _resetHealth();
    await fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    failures++;
    console.error(`❌ ${name}: ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`); }

const NOW = "2026-10-16T12:00:00.000Z";
const later = (min) => new Date(Date.parse(NOW) + min * 60_000).toISOString();
const alert = (over = {}) => ({
  id: 1, symbol: "SOL", op: "below", target: 150, repeat: false, note: null,
  active: true, armed: true, fireCount: 0, lastFiredAt: null, ...over,
});

// ── Validation ───────────────────────────────────────────────────────────────

await test("A well-formed alert validates, symbol and op normalised", async () => {
  const v = validateAlert({ symbol: "sol", op: "BELOW", target: "149.5", repeat: true, note: " dip " });
  assert(v.ok, v.error);
  assertEq(v.alert.symbol, "SOL", "symbol");
  assertEq(v.alert.op, "below", "op");
  assertEq(v.alert.target, 149.5, "target parsed");
  assertEq(v.alert.repeat, true, "repeat");
  assertEq(v.alert.note, "dip", "note trimmed");
});

await test("USDC is not alertable — it is the unit prices are in", async () => {
  assert(!ALERT_SYMBOLS.includes("USDC"), "not offered");
  assert(!validateAlert({ symbol: "USDC", op: "above", target: 1 }).ok, "rejected");
});

await test("Bad targets are refused rather than coerced", async () => {
  for (const target of ["", " ", "abc", "1e3", -5, 0, NaN, Infinity, 1e9, null, "12,5"]) {
    assert(!validateAlert({ symbol: "SOL", op: "above", target }).ok, `accepted ${JSON.stringify(target)}`);
  }
});

await test("Unknown op, unknown symbol and non-boolean repeat are refused", async () => {
  assert(!validateAlert({ symbol: "SOL", op: "crosses", target: 1 }).ok, "op");
  assert(!validateAlert({ symbol: "DOGE", op: "above", target: 1 }).ok, "symbol");
  assert(!validateAlert({ symbol: "SOL", op: "above", target: 1, repeat: "yes" }).ok, "repeat");
  assert(!validateAlert(null).ok, "null body");
});

await test("Notes lose control characters and are capped", async () => {
  const v = validateAlert({ symbol: "SOL", op: "above", target: 1, note: "a\nb\u0000c" + "x".repeat(500) });
  assert(v.ok, v.error);
  assert(!/[\n\u0000]/.test(v.alert.note), "control chars stripped");
  assertEq(v.alert.note.length, 120, "capped");
});

await test("State fields in the input are ignored", async () => {
  const v = validateAlert({ symbol: "SOL", op: "above", target: 1, active: false, fireCount: 99, id: 7 });
  assertEq(Object.keys(v.alert).sort().join(","), "note,op,repeat,symbol,target", "only the five inputs");
});

// ── Evaluation ───────────────────────────────────────────────────────────────

await test("below fires at and under the target, not above it", async () => {
  assertEq(evaluate(alert(), 150.01, NOW).fire, false, "above target");
  assertEq(evaluate(alert(), 150, NOW).fire, true, "exactly at target");
  assertEq(evaluate(alert(), 140, NOW).fire, true, "under target");
});

await test("above fires at and over the target", async () => {
  const a = alert({ op: "above", target: 200 });
  assertEq(evaluate(a, 199.99, NOW).fire, false, "under");
  assertEq(evaluate(a, 200, NOW).fire, true, "at");
});

await test("A one-shot alert goes inactive when it fires", async () => {
  const { fire, patch } = evaluate(alert(), 140, NOW);
  assert(fire, "fired");
  assertEq(patch.active, false, "inactive");
  assertEq(patch.fireCount, 1, "counted");
  assertEq(patch.lastFiredAt, NOW, "stamped");
});

await test("A repeating alert disarms, and re-arms only past the band", async () => {
  const a = alert({ repeat: true });
  const first = evaluate(a, 140, NOW);
  assert(first.fire && first.patch.active === true && first.patch.armed === false, "fired, still active, disarmed");

  const fired = { ...a, ...first.patch };
  // rearmPct 1 → must climb to 151.50 before it can fire again.
  assertEq(evaluate(fired, 140, later(120)).fire, false, "no re-fire while disarmed");
  assertEq(evaluate(fired, 151, later(120)).patch, null, "inside the band: stays disarmed");
  assertEq(evaluate(fired, 151.5, later(120)).patch?.armed, true, "past the band: re-armed");
});

await test("A re-armed repeating alert still respects the cooldown", async () => {
  const a = alert({ repeat: true, lastFiredAt: NOW, fireCount: 1 });
  assertEq(evaluate(a, 140, later(CONFIG.alerts.repeatCooldownMinutes - 1)).fire, false, "inside cooldown");
  assertEq(evaluate(a, 140, later(CONFIG.alerts.repeatCooldownMinutes)).fire, true, "after cooldown");
});

await test("Inactive alerts and garbage prices do nothing", async () => {
  assertEq(evaluate(alert({ active: false }), 1, NOW).fire, false, "inactive");
  for (const p of [NaN, 0, -1, Infinity, undefined]) {
    const r = evaluate(alert(), p, NOW);
    assert(!r.fire && r.patch === null, `price ${p}`);
  }
});

await test("The message names the alert, the price and the note", async () => {
  const msg = formatAlertMessage(alert({ note: "buy the dip" }), 148.123, { origin: "https://sol.example.com" });
  assert(msg.includes("SOL below $150.00"), msg);
  assert(msg.includes("$148.12"), "price");
  assert(msg.includes("buy the dip"), "note");
  assert(msg.includes("One-shot"), "mode");
  assert(msg.includes("https://sol.example.com"), "link");
});

// ── Telegram ─────────────────────────────────────────────────────────────────

const cfg = { botToken: "123:SECRET-TOKEN", chatId: "42" };
const reply = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });

await test("sendMessage is called with the expected request", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return reply(200, { ok: true, result: { message_id: 9 } })(); };
  const r = await sendTelegram("hello", { cfg, fetchImpl });
  assertEq(r.messageId, 9, "message id");
  assertEq(seen.url, "https://api.telegram.org/bot123:SECRET-TOKEN/sendMessage", "url");
  assertEq(seen.init.method, "POST", "method");
  const body = JSON.parse(seen.init.body);
  assertEq(body.chat_id, "42", "chat id");
  assertEq(body.text, "hello", "text");
  assertEq(body.parse_mode, undefined, "plain text");
});

await test("A Telegram refusal throws with its description", async () => {
  let err;
  try { await sendTelegram("x", { cfg, fetchImpl: reply(400, { ok: false, description: "chat not found" }) }); }
  catch (e) { err = e; }
  assert(err && /chat not found/.test(err.message), err?.message);
});

await test("The bot token never appears in an error", async () => {
  const fetchImpl = async (url) => { throw new Error(`request to ${url} failed, reason: ECONNRESET`); };
  let err;
  try { await sendTelegram("x", { cfg, fetchImpl }); } catch (e) { err = e; }
  assert(err, "threw");
  assert(!err.message.includes("SECRET-TOKEN"), `leaked: ${err.message}`);
  assert(err.message.includes("<token>"), "scrubbed marker");
});

await test("Unconfigured Telegram refuses to send", async () => {
  let threw = false;
  try { await sendTelegram("x", { cfg: { botToken: "", chatId: "1" }, fetchImpl: reply(200, { ok: true }) }); }
  catch { threw = true; }
  assert(threw, "threw");
});

// ── Storage (files backend) ──────────────────────────────────────────────────

await test("Alerts round-trip, newest first, inactive last", async () => {
  const a = await storage.insertAlert({ symbol: "SOL", op: "below", target: 150, repeat: false, note: null });
  const b = await storage.insertAlert({ symbol: "JUPSOL", op: "above", target: 200, repeat: true, note: "tp" });
  assertEq(b.id, a.id + 1, "ids increase");
  await storage.updateAlert(a.id, { active: false, lastFiredAt: NOW });
  const rows = await storage.selectAlerts();
  assertEq(rows[0].id, b.id, "active first");
  assertEq(rows[1].active, false, "fired one last");
  assertEq((await storage.selectAlerts({ activeOnly: true })).length, 1, "activeOnly");
});

await test("updateAlert ignores fields it does not own", async () => {
  const a = await storage.insertAlert({ symbol: "SOL", op: "below", target: 150, repeat: false, note: null });
  await storage.updateAlert(a.id, { target: 1, symbol: "MSOL", armed: false });
  const [row] = await storage.selectAlerts();
  assertEq(row.target, 150, "target untouched");
  assertEq(row.symbol, "SOL", "symbol untouched");
  assertEq(row.armed, false, "armed applied");
});

await test("Deleting a missing alert reports false", async () => {
  assertEq(await storage.deleteAlert(999), false, "nothing deleted");
  assertEq(await storage.updateAlert(999, { armed: false }), false, "nothing updated");
});

await test("A corrupt alerts file throws instead of reading as empty", async () => {
  fs.writeFileSync(path.join(TEST_DIR, "alerts.json"), "{ nope");
  let threw = false;
  try { await storage.insertAlert({ symbol: "SOL", op: "below", target: 1, repeat: false, note: null }); }
  catch { threw = true; }
  assert(threw, "refused to overwrite");
  assertEq(fs.readFileSync(path.join(TEST_DIR, "alerts.json"), "utf8"), "{ nope", "file intact");
});

// ── The watcher loop ─────────────────────────────────────────────────────────

const sink = () => { const sent = []; const send = async (t) => { sent.push(t); }; return { sent, send }; };

await test("A tick fires a met alert once, then never again", async () => {
  await storage.insertAlert({ symbol: "SOL", op: "below", target: 150, repeat: false, note: null });
  await storage.insertAlert({ symbol: "SOL", op: "below", target: 100, repeat: false, note: null });
  const { sent, send } = sink();
  const getPrices = async () => ({ SOL: 140 });

  const r = await tick({ now: NOW, send, getPrices });
  assertEq(r.fired, 1, "only the met alert");
  assertEq(sent.length, 1, "one message");

  await tick({ now: later(1), send, getPrices });
  assertEq(sent.length, 1, "one-shot does not repeat");

  const rows = await storage.selectAlerts();
  const fired = rows.find(a => a.target === 150);
  assertEq(fired.active, false, "persisted inactive");
  assertEq(rows.find(a => a.target === 100).lastPrice, 140, "price stamped on the active one");
});

await test("A failed send leaves the alert armed, and the next tick delivers it", async () => {
  await storage.insertAlert({ symbol: "SOL", op: "below", target: 150, repeat: false, note: null });
  const getPrices = async () => ({ SOL: 140 });

  const r = await tick({ now: NOW, getPrices, send: async () => { throw new Error("telegram down"); } });
  assertEq(r.failed, 1, "counted as failed");
  assertEq((await storage.selectAlerts())[0].active, true, "still active");

  const { sent, send } = sink();
  await tick({ now: later(1), send, getPrices });
  assertEq(sent.length, 1, "delivered late, not lost");
});

await test("A symbol with no price is skipped, the rest still fire", async () => {
  await storage.insertAlert({ symbol: "MSOL", op: "below", target: 1000, repeat: false, note: null });
  await storage.insertAlert({ symbol: "SOL", op: "below", target: 1000, repeat: false, note: null });
  const { sent, send } = sink();
  await tick({ now: NOW, send, getPrices: async () => ({ SOL: 140 }) });
  assertEq(sent.length, 1, "SOL fired");
  assert((await storage.selectAlerts()).some(a => a.symbol === "MSOL" && a.active), "MSOL untouched");
});

await test("Repeated failures warn once on Telegram, and recovery says so", async () => {
  await storage.insertAlert({ symbol: "SOL", op: "below", target: 1, repeat: false, note: null });
  const { sent, send } = sink();
  const broken = async () => { throw new Error("jupiter 503"); };

  for (let i = 0; i < CONFIG.alerts.feedDownAfterTicks - 1; i++) await runTick({ send, getPrices: broken });
  assertEq(sent.length, 0, "quiet below the threshold");
  await runTick({ send, getPrices: broken });
  assertEq(sent.length, 1, "warned at the threshold");
  assert(/blind/.test(sent[0]) && /jupiter 503/.test(sent[0]), sent[0]);
  await runTick({ send, getPrices: broken });
  assertEq(sent.length, 1, "warned only once");

  await runTick({ send, getPrices: async () => ({ SOL: 140 }) });
  assertEq(sent.length, 2, "recovery announced");
  assert(/working again/.test(sent[1]), sent[1]);
});

await test("No active alerts means no price call at all", async () => {
  let called = false;
  await tick({ now: NOW, send: async () => {}, getPrices: async () => { called = true; return {}; } });
  assertEq(called, false, "Jupiter not hit for nothing");
});

// ── Rate limit ───────────────────────────────────────────────────────────────

await test("createRateLimit windows are independent of each other", async () => {
  const a = createRateLimit({ windowMs: 60_000, max: 2 });
  const b = createRateLimit({ windowMs: 60_000, max: 2 });
  assert(a(1000).ok && a(1001).ok, "first two pass");
  assertEq(a(1002).ok, false, "third refused");
  assert(b(1003).ok, "other limiter unaffected");
  assert(a(62_000).ok, "new window");
});

await storage.close();
console.log(failures === 0 ? "\nAll alert tests passed" : `\n${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
