// server.js — Read-only monitoring dashboard.
//
//   npm run dashboard        →  http://127.0.0.1:8787
//
// Deliberately read-only ABOUT TRADING: there is no endpoint that can buy or
// sell. The whole value of this system is its rails, and a "buy now" button on
// a web page is exactly the impulse those rails exist to stop. Use the CLI.
//
// There is exactly one write route that touches funds. It moves the
// accumulated asset to a single address pinned in config, and cannot be told
// where to send it — so the worst a stolen dashboard password buys is forcing
// the coins into the owner's own safe wallet, which is griefing, not theft.
//
// The only other write is the price-alert list (POST /api/alerts). It touches
// no funds and no strategy state; the worst a stolen password buys there is
// Telegram noise, bounded by maxActive and a rate limit. It sits behind the
// same Origin / content-type / custom-header / auth layers as the transfer.
// It needs no nonce: that layer exists to make an irreversible send
// unforgeable, and an alert is deleted with one click.
//
// That route also makes this the first version of this process to parse a
// request body, which is the change that turns RCE here from theoretical into
// something worth defending. The Content-Length pre-check, the 4KB cap, the
// JSON-only parse, the socket timeout and the strict route allow-list below
// are not decoration — they are the argument for signing in this process at
// all. See transfer-guard.js.
//
// Binds to loopback by default. DASHBOARD_HOST=0.0.0.0 exposes it to the
// network, which you should only do behind TLS and a reverse proxy.

import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { CONFIG, strategyAsset, mintFor, transferDestination } from "./config.js";
import { loadWallet, publicKeyStr } from "./wallet.js";
import { getBalances, getPriceUsd, getTokenBalance, getSpotPricesUsd } from "./query.js";
import { loadTransactions } from "./transactions.js";
import { loadState, saveState, acquireLock, releaseLock } from "./state.js";
import { loadCloses } from "./prices.js";
import { buildReport } from "./report.js";
import { decide } from "./strategy.js";
import {
  describe as describeStorage, close as closeStorage, backend as storageBackend,
  selectAlerts, insertAlert, deleteAlert,
} from "./storage/index.js";
import { ALERT_SYMBOLS, validateAlert, describeAlert } from "./alerts.js";
import { assertConfigured, isAuthorized, credentials } from "./auth.js";
import { executeTransfer } from "./transfer.js";
import {
  checkOrigin, checkContentType, checkConfirmHeader, readJsonBody,
  issueNonce, consumeNonce, checkCooldown, checkRateLimit, createRateLimit,
} from "./transfer-guard.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const HOST = process.env.DASHBOARD_HOST || "127.0.0.1";

// Jupiter prices cost 2 quote calls each. The browser polls, so cache them.
const PRICE_TTL_MS = 20_000;
let priceCache = { at: 0, asset: null, sol: null };

async function prices() {
  if (Date.now() - priceCache.at < PRICE_TTL_MS && priceCache.sol) return priceCache;
  const asset = strategyAsset();
  const [a, s] = await Promise.all([getPriceUsd(asset), getPriceUsd("SOL")]);
  priceCache = { at: Date.now(), asset: a, sol: s };
  return priceCache;
}

// Spot prices for the alert form's "now" hint: one Jupiter call for every
// symbol, cached for the same reason as above.
let spotCache = { at: 0, prices: {} };

async function spotPrices() {
  if (Date.now() - spotCache.at < PRICE_TTL_MS) return spotCache.prices;
  const prices = await getSpotPricesUsd(ALERT_SYMBOLS).catch(() => spotCache.prices);
  spotCache = { at: Date.now(), prices };
  return prices;
}

// ── Payload ──────────────────────────────────────────────────────────────────

/**
 * The wallet's public key. Reading it from the environment when available is
 * the only thing standing between this process and not needing PRIVATE_KEY at
 * all — the pubkey is public, and this was the sole reason the dashboard ever
 * loaded the key. Keeping the fallback means nothing breaks if it is unset.
 */
function walletPubkey() {
  return process.env.WALLET_PUBKEY || publicKeyStr(loadWallet());
}

async function buildStatus() {
  const asset  = strategyAsset();
  const pubkey = walletPubkey();

  const [{ asset: assetPrice, sol: solPrice }, balances, txs, loaded, closes] = await Promise.all([
    prices(),
    getBalances(pubkey),
    loadTransactions({ includeDryRun: false }),
    loadState(),
    loadCloses(),
  ]);

  const state  = loaded.state;
  const held   = balances.bySymbol[asset] ?? 0;

  // Does the safe wallet actually hold what the log says was moved there?
  // Needs no key, but it does need an RPC round-trip, and a hiccup there must
  // never take down the dashboard — hence null rather than a throw.
  let destUnits = null;
  if (CONFIG.transfer.destination) {
    destUnits = await getTokenBalance(CONFIG.transfer.destination, mintFor(asset)).catch(() => null);
  }

  // Attribution lives entirely in buildReport, so this page and `node report.js`
  // cannot disagree about which units are the bot's.
  const report = buildReport({ txs, state, asset, assetPrice, solPrice, held, closes, destUnits });

  // What the bot would decide right now, without touching anything. plPct is
  // passed so the DIP_BOOST rail shown here is the one run.js will actually
  // use — otherwise the page reports 1.00x while the bot buys 1.5x.
  const { action, rails } = decide({
    state, balances, now: new Date().toISOString(), config: CONFIG, plPct: report.plPct,
  });

  return {
    asset,
    // Truncated: the dashboard should identify the wallet, not publish it.
    wallet: `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`,
    storage: describeStorage(),
    dryRun: CONFIG.dryRun,
    cadence: CONFIG.strategy.cadence,
    dailyUsd: CONFIG.strategy.dailyUsd,
    prices: { asset: assetPrice, sol: solPrice, ratio: assetPrice / solPrice },
    balances: { usdc: balances.usdc, sol: balances.sol, asset: held },
    impliedUnits: report.botUnits,   // deprecated alias for report.botUnits
    budget: state.budget,
    counts: { buys: state.buyCount, startDate: state.startDate, lastBuyDate: state.lastBuyDate },
    report,
    transfer: {
      // Whether the button should render at all, and why not if it shouldn't.
      enabled: CONFIG.transfer.enabled && CONFIG.transfer.httpEnabled,
      destination: report.destination,
      // Full, not truncated: the confirm step exists so this can be READ and
      // checked before the click. It is behind auth and it is a public address.
      fullDestination: CONFIG.transfer.destination || null,
      movableUnits: held,
    },
    pending: state.pendingIntent,
    lastRun: state.lastRun,
    decision: { type: action.type, reason: action.reason, usd: action.usd ?? null },
    rails,
    now: new Date().toISOString(),
  };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(s);
}

function unauthorized(res) {
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="sol-usdc-swapper", charset="UTF-8"',
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end("Unauthorized\n");
}

// ── The one write route ──────────────────────────────────────────────────────

// Only one transfer may be in flight per process. Checked before the run lock,
// and it also sidesteps re-entering acquireLock() from two requests at once.
let transferInFlight = false;

/** Structured audit line for EVERY attempt, refusals included. */
function audit(req, fields, evt = "transfer") {
  console.log(JSON.stringify({
    evt,
    at: new Date().toISOString(),
    user: credentials().user,
    ip: req.socket.remoteAddress,
    xff: req.headers["x-forwarded-for"] ?? null,
    // Truncated: this is attacker-controlled text going into a log.
    ua: String(req.headers["user-agent"] ?? "").slice(0, 120),
    origin: req.headers.origin ?? null,
    ...fields,      // never the nonce, never the Authorization header
  }));
}

async function handleTransfer(req, res) {
  // Cheapest, header-only rejections first — no body read, no allocation, and
  // nothing touched for an anonymous caller.
  for (const check of [checkOrigin(req.headers), checkContentType(req.headers), checkConfirmHeader(req.headers)]) {
    if (!check.ok) {
      audit(req, { outcome: "refused", code: check.code });
      const status = check.code === "BAD_CONTENT_TYPE" ? 415
                   : check.code === "MISSING_CONFIRM" ? 400 : 403;
      return json(res, status, { ok: false, code: check.code, error: check.error });
    }
  }

  if (!isAuthorized(req.headers.authorization)) {
    audit(req, { outcome: "refused", code: "UNAUTHORIZED" });
    return unauthorized(res);
  }

  const rate = checkRateLimit();
  if (!rate.ok) {
    audit(req, { outcome: "refused", code: rate.code });
    return json(res, 429, { ok: false, code: rate.code, error: rate.error, retryAfter: rate.retryAfter });
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    audit(req, { outcome: "refused", code: parsed.code });
    return json(res, parsed.code === "BODY_TOO_LARGE" ? 413 : 400,
                { ok: false, code: parsed.code, error: parsed.error });
  }
  const body = parsed.body ?? {};

  // The CSRF defence that actually closes the case: this value can only be
  // obtained by READING an authenticated response, which a cross-origin
  // attacker cannot do. Single-use, so a double-click cannot replay it either.
  if (!consumeNonce(body.nonce)) {
    audit(req, { outcome: "refused", code: "BAD_NONCE" });
    return json(res, 403, { ok: false, code: "BAD_NONCE", error: "confirmation expired — reload and try again" });
  }

  if (transferInFlight) {
    audit(req, { outcome: "refused", code: "IN_FLIGHT" });
    return json(res, 409, { ok: false, code: "IN_FLIGHT", error: "a transfer is already in progress" });
  }
  transferInFlight = true;

  try {
    const asset  = strategyAsset();
    const pubkey = walletPubkey();
    const [balances, txs, loaded] = await Promise.all([
      getBalances(pubkey), loadTransactions({ includeDryRun: false }), loadState(),
    ]);
    const live = balances.bySymbol[asset] ?? 0;

    // Rails. Refusals still report them, so the page can say why.
    if (loaded.state.pendingIntent) {
      audit(req, { outcome: "refused", code: "PENDING_INTENT" });
      return json(res, 409, { ok: false, code: "PENDING_INTENT",
        error: "the bot has an unresolved intent and is halted — resolve it before moving funds" });
    }

    const cooldown = checkCooldown(txs);
    if (!cooldown.ok) {
      audit(req, { outcome: "refused", code: cooldown.code });
      return json(res, 429, { ok: false, code: cooldown.code, error: cooldown.error, retryAfter: cooldown.retryAfter });
    }

    // Echo check. Not a CSRF defence — a safety one. It catches a stale page
    // and, in particular, the CronJob having bought between the render and
    // the click.
    const expect = Number(body.expectUnits);
    if (!Number.isFinite(expect) || Math.abs(live - expect) > Math.max(1e-9, 1e-6 * live)) {
      audit(req, { outcome: "refused", code: "BALANCE_MISMATCH", live });
      return json(res, 409, { ok: false, code: "BALANCE_MISMATCH", liveUnits: live,
        error: `balance changed (now ${live.toFixed(6)} ${asset}) — confirm again` });
    }

    if (live <= 0) {
      audit(req, { outcome: "refused", code: "NOTHING_TO_MOVE" });
      return json(res, 409, { ok: false, code: "NOTHING_TO_MOVE", error: `${asset} balance is zero` });
    }

    // NOTE: the amount is never read from the body. The full balance moves.
    const price = await getPriceUsd(asset).catch(() => null);

    await acquireLock();
    try {
      // Same crash-safety contract as run.js: the intent is written before the
      // send, so a death mid-flight is recoverable. It also halts the daily
      // buy via strategy.js's NO_PENDING_INTENT rail until it is resolved.
      const now = new Date().toISOString();
      const dest = transferDestination().toBase58();
      await saveState({
        ...loaded.state,
        pendingIntent: {
          createdAt: now,
          action: { type: "TRANSFER", fromSym: asset, units: live, dest },
          preBalances: { usdc: balances.usdc, asset: live },
        },
      });

      const result = await executeTransfer({ intent: "custody", price });

      const after = await loadState();
      await saveState({ ...after.state, pendingIntent: null });

      audit(req, { outcome: "ok", units: result.units, dest: result.dest, sig: result.sig ?? null, dryRun: !!result.dryRun });
      return json(res, 200, {
        ok: true, sig: result.sig ?? null, units: result.units,
        dest: result.dest, dryRun: !!result.dryRun,
      });
    } finally {
      await releaseLock();
    }
  } catch (e) {
    // The real message goes to the logs; the browser gets nothing internal.
    console.error(`[dashboard] transfer failed: ${e.message}`);
    audit(req, { outcome: "error", code: "TRANSFER_FAILED", reason: e.message });
    return json(res, 500, { ok: false, code: "TRANSFER_FAILED",
      error: "transfer failed — see server logs. The pending intent is preserved; run `node run.js --resolve-intent` to settle it." });
  } finally {
    transferInFlight = false;
  }
}

// ── Price alerts ─────────────────────────────────────────────────────────────

// Its own window: alert edits never spend the transfer route's attempts.
const checkAlertRateLimit = createRateLimit({ windowMs: 10 * 60_000, max: 30 });

async function handleAlerts(req, res) {
  const refuse = (status, code, error) => {
    audit(req, { outcome: "refused", code }, "alerts");
    return json(res, status, { ok: false, code, error });
  };

  // Same header-only layers as the transfer, cheapest first.
  for (const check of [checkOrigin(req.headers), checkContentType(req.headers), checkConfirmHeader(req.headers)]) {
    if (!check.ok) {
      const status = check.code === "BAD_CONTENT_TYPE" ? 415 : check.code === "MISSING_CONFIRM" ? 400 : 403;
      return refuse(status, check.code, check.error);
    }
  }
  if (!isAuthorized(req.headers.authorization)) {
    audit(req, { outcome: "refused", code: "UNAUTHORIZED" }, "alerts");
    return unauthorized(res);
  }
  const rate = checkAlertRateLimit();
  if (!rate.ok) return refuse(429, rate.code, rate.error);

  const parsed = await readJsonBody(req, CONFIG.alerts.maxBodyBytes);
  if (!parsed.ok) return refuse(parsed.code === "BODY_TOO_LARGE" ? 413 : 400, parsed.code, parsed.error);
  const body = parsed.body ?? {};

  if (body.action === "create") {
    const v = validateAlert(body);
    if (!v.ok) return refuse(400, "INVALID", v.error);
    const active = await selectAlerts({ activeOnly: true });
    if (active.length >= CONFIG.alerts.maxActive) {
      return refuse(409, "TOO_MANY", `at most ${CONFIG.alerts.maxActive} active alerts`);
    }
    const alert = await insertAlert(v.alert);
    audit(req, { outcome: "ok", action: "create", id: alert.id, alert: describeAlert(alert) }, "alerts");
    return json(res, 200, { ok: true, alert });
  }

  if (body.action === "delete") {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return refuse(400, "INVALID", "id must be a positive integer");
    if (!(await deleteAlert(id))) return refuse(404, "NOT_FOUND", `no alert #${id}`);
    audit(req, { outcome: "ok", action: "delete", id }, "alerts");
    return json(res, 200, { ok: true });
  }

  return refuse(400, "INVALID", `action must be "create" or "delete"`);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // The one write route, as an explicit allow-list entry. The default 405
  // below is load-bearing: a cross-origin fetch carrying a custom header must
  // preflight, the OPTIONS gets a 405 with no Access-Control-Allow-*, and the
  // browser then refuses to send the real request. Do not invert this guard.
  if (req.method === "POST") {
    if (url.pathname === "/api/transfer" && CONFIG.transfer.enabled && CONFIG.transfer.httpEnabled) {
      try { return await handleTransfer(req, res); }
      catch (e) {
        console.error(`[dashboard] /api/transfer: ${e.message}`);
        return json(res, 500, { ok: false, code: "INTERNAL", error: "internal error — see server logs" });
      }
    }
    if (url.pathname === "/api/alerts") {
      try { return await handleAlerts(req, res); }
      catch (e) {
        console.error(`[dashboard] /api/alerts: ${e.message}`);
        return json(res, 500, { ok: false, code: "INTERNAL", error: "internal error — see server logs" });
      }
    }
    res.writeHead(405, { allow: "GET, HEAD" });
    return res.end("Method Not Allowed\n");
  }

  // Everything else is read-only and nothing here accepts a body.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    return res.end("Method Not Allowed\n");
  }

  // Liveness/readiness. Deliberately unauthenticated and deliberately dumb: it
  // proves this process is alive and nothing more. It must NOT touch Postgres
  // or Jupiter — a probe that depends on an external service turns a brief
  // outage into a restart storm, and takes the dashboard down exactly when you
  // want to look at it. It exposes no state.
  if (url.pathname === "/healthz") {
    return json(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
  }

  if (!isAuthorized(req.headers.authorization)) return unauthorized(res);

  try {
    if (url.pathname === "/api/status") {
      return json(res, 200, await buildStatus());
    }

    if (url.pathname === "/api/trades") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);
      const txs = await loadTransactions({ includeDryRun: true });
      return json(res, 200, txs.slice(-limit).reverse());
    }

    // Issued from its own route rather than folded into /api/status, so the
    // page's 20-second poll does not churn the nonce map and the TTL starts
    // when the user actually clicks.
    if (url.pathname === "/api/transfer/nonce") {
      if (!CONFIG.transfer.enabled || !CONFIG.transfer.httpEnabled) {
        return json(res, 404, { error: "not found" });
      }
      return json(res, 200, { nonce: issueNonce(), ttlMs: CONFIG.transfer.nonceTtlMs });
    }

    if (url.pathname === "/api/alerts") {
      const [alerts, prices] = await Promise.all([selectAlerts(), spotPrices()]);
      // The newest check across all alerts is the watcher's pulse. Null with
      // active alerts present means it has never run, or cannot reach storage.
      const checkedAt = alerts.map(a => a.checkedAt).filter(Boolean).sort().pop() ?? null;
      return json(res, 200, {
        alerts, symbols: ALERT_SYMBOLS, prices,
        watcher: { checkedAt, intervalSeconds: CONFIG.alerts.intervalSeconds },
      });
    }

    if (url.pathname === "/api/prices") {
      const days  = Math.min(Number(url.searchParams.get("days") || 180), 2000);
      const rows  = await loadCloses();
      return json(res, 200, rows.slice(-days));
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = fs.readFileSync(path.join(HERE, "public", "index.html"));
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // The page is entirely self-contained — no external anything.
        // connect-src 'self' already covers the button's same-origin POST.
        // form-action/base-uri/frame-ancestors are the additions that matter
        // once a write route exists: frame-ancestors is the clickjacking
        // defence, and it matters more because the ingress is public.
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; " +
          "form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      return res.end(html);
    }

    return json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(`[dashboard] ${url.pathname}: ${e.message}`);
    // Never leak internals (connection strings, paths) to the browser.
    return json(res, 500, { error: "internal error — see server logs" });
  }
});

try {
  assertConfigured();

  // A bad destination must fail the deploy, not the first click. Same
  // philosophy as assertConfigured: this is the check standing between a
  // typo and an unrecoverable transfer.
  if (CONFIG.transfer.enabled) {
    transferDestination();

    // The files backend's lock is a PID-checked file on a per-pod emptyDir,
    // so it cannot see the CronJob pod at all. Postgres's advisory lock can.
    if (storageBackend === "files" && HOST !== "127.0.0.1" && HOST !== "localhost" && CONFIG.transfer.httpEnabled) {
      throw new Error(
        "TRANSFER_HTTP_ENABLED with the files storage backend on a non-loopback host: " +
        "the run lock is per-pod and cannot protect against a concurrent CronJob run. " +
        "Use Postgres (set DATABASE_URL), or keep the button on loopback."
      );
    }
  }
} catch (e) {
  console.error(`\n❌ ${e.message}\n`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`\n📊 Dashboard  http://${HOST}:${PORT}`);
  console.log(`   storage: ${describeStorage()}`);
  console.log(`   no endpoint can trigger a swap`);
  console.log(`   price alerts: editable here, sent by \`npm run watch\``);
  if (CONFIG.transfer.enabled && CONFIG.transfer.httpEnabled) {
    const d = CONFIG.transfer.destination;
    console.log(`   ⚠️  transfer button ENABLED → ${d.slice(0, 4)}…${d.slice(-4)} (pinned; requests cannot change it)`);
  } else if (CONFIG.transfer.enabled) {
    console.log(`   transfers: CLI only (TRANSFER_HTTP_ENABLED is not true)`);
  }
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    console.log(`\n   ⚠️  Bound to ${HOST}, not loopback. Basic auth is base64, not encryption —`);
    console.log(`      put this behind TLS before exposing it.`);
  }
  console.log();
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(async () => { await closeStorage(); process.exit(0); });
  });
}
