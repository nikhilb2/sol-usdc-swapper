// transfer-guard.js — The security guards for the one write route.
//
// Pure and side-effect-light on purpose, so the entire attack surface can be
// unit-tested without binding a port. server.js composes these; it does not
// reimplement them. Same split as strategy.js (decides) / run.js (executes).
//
// ── Why four independent CSRF layers ─────────────────────────────────────────
// HTTP Basic credentials are NOT cookies: they are not SameSite-protected, and
// a browser attaches them to a cross-site form POST at this origin. So an
// attacker's page can make the user's browser fire an authenticated request
// without ever knowing the password. Each layer below independently stops
// that; all four are ~30 lines total.
//
// The nonce is the one that closes the case completely: obtaining it requires
// READING an authenticated response, and a cross-origin attacker cannot read
// one (no CORS headers ⇒ the browser withholds the body).

import crypto from "crypto";
import { CONFIG } from "./config.js";

/** Constant-time string compare. Same construction as auth.js. */
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Layer 1 — the request must originate from this very page.
 * Browsers send Origin on cross-site form POSTs (carrying the ATTACKER's
 * origin), so a mismatch is decisive.
 */
export function checkOrigin(headers, allowedOrigin = CONFIG.dashboard.publicOrigin) {
  const origin = headers.origin;
  if (!origin) return { ok: false, code: "NO_ORIGIN", error: "missing Origin header" };

  let parsed;
  try { parsed = new URL(origin); }
  catch { return { ok: false, code: "BAD_ORIGIN", error: "malformed Origin header" }; }

  if (allowedOrigin) {
    if (origin !== allowedOrigin) {
      return { ok: false, code: "BAD_ORIGIN", error: "origin not allowed" };
    }
  } else if (!headers.host || parsed.host !== headers.host) {
    // No configured origin (loopback): fall back to Host agreement.
    return { ok: false, code: "BAD_ORIGIN", error: "origin does not match host" };
  }

  // Advisory but free when the browser sends it.
  const site = headers["sec-fetch-site"];
  if (site && site !== "same-origin") {
    return { ok: false, code: "CROSS_SITE", error: "cross-site request" };
  }
  return { ok: true };
}

/**
 * Layer 2 — JSON only. A cross-site HTML form can only produce
 * x-www-form-urlencoded, multipart/form-data or text/plain. None parse here.
 */
export function checkContentType(headers) {
  const raw = headers["content-type"] ?? "";
  const type = raw.split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    return { ok: false, code: "BAD_CONTENT_TYPE", error: "expected application/json" };
  }
  return { ok: true };
}

/**
 * Layer 3 — a header no form can set. A scripted cross-origin fetch that sets
 * it must preflight, and the preflight hits server.js's default 405 with no
 * Access-Control-Allow-* headers, so the browser never sends the real request.
 */
export function checkConfirmHeader(headers) {
  if (headers["x-swapper-confirm"] !== "1") {
    return { ok: false, code: "MISSING_CONFIRM", error: "missing confirmation header" };
  }
  return { ok: true };
}

/**
 * Read a JSON body with a hard cap.
 *
 * This is the process's first body parser, and it is the change that makes
 * remote code execution in the dashboard a live concern rather than a
 * theoretical one. Hence: reject on Content-Length before reading a byte,
 * destroy the socket on streamed overflow, and time out.
 */
export function readJsonBody(req, maxBytes = CONFIG.transfer.maxBodyBytes) {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxBytes) {
      return resolve({ ok: false, code: "BODY_TOO_LARGE", error: "request body too large" });
    }

    let size = 0;
    const chunks = [];
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    req.setTimeout?.(5000, () => {
      req.destroy();
      done({ ok: false, code: "BODY_TIMEOUT", error: "request body timed out" });
    });

    req.on("data", (c) => {
      size += c.length;
      // A liar in Content-Length is caught here regardless.
      if (size > maxBytes) {
        req.destroy();
        return done({ ok: false, code: "BODY_TOO_LARGE", error: "request body too large" });
      }
      chunks.push(c);
    });
    req.on("error", () => done({ ok: false, code: "BODY_ERROR", error: "could not read request body" }));
    req.on("end", () => {
      try { done({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
      catch { done({ ok: false, code: "BAD_JSON", error: "body is not valid JSON" }); }
    });
  });
}

// ── Nonces ───────────────────────────────────────────────────────────────────
// In-process and deliberately tiny. Losing them on restart is correct: a
// pending confirmation should not survive the server that issued it.

const nonces = new Map();
const MAX_NONCES = 32;

export function issueNonce(now = Date.now()) {
  for (const [k, exp] of nonces) if (exp <= now) nonces.delete(k);
  // Bound the map. Oldest-first, because Map preserves insertion order.
  while (nonces.size >= MAX_NONCES) nonces.delete(nonces.keys().next().value);

  const nonce = crypto.randomBytes(18).toString("base64url");
  nonces.set(nonce, now + CONFIG.transfer.nonceTtlMs);
  return nonce;
}

/** Single use: consuming a nonce deletes it, so a double-click cannot replay. */
export function consumeNonce(candidate, now = Date.now()) {
  if (typeof candidate !== "string" || !candidate) return false;

  // Compare against every live nonce in constant time rather than doing a Map
  // lookup on attacker-supplied input.
  let matched = null;
  for (const [k, exp] of nonces) {
    if (exp > now && safeEqual(k, candidate)) matched = k;
  }
  if (!matched) return false;
  nonces.delete(matched);
  return true;
}

/** Tests only. */
export function _resetNonces() { nonces.clear(); }

// ── Ledger-backed rate limits ────────────────────────────────────────────────

/**
 * Cooldown and daily cap, measured from the trade log rather than memory so
 * they survive a pod restart — a limit an attacker can reset by crashing the
 * process is not a limit.
 */
export function checkCooldown(txs, now = Date.now(), config = CONFIG) {
  const { cooldownMinutes, maxPerDay } = config.transfer;
  const moves = txs.filter(t => t.type === "transfer_out" && !t.dryRun);
  if (!moves.length) return { ok: true };

  const times = moves.map(t => new Date(t.timestamp).getTime()).sort((a, b) => a - b);
  const last  = times[times.length - 1];

  const sinceMs = now - last;
  if (sinceMs < cooldownMinutes * 60_000) {
    const retryAfter = Math.ceil((cooldownMinutes * 60_000 - sinceMs) / 1000);
    return { ok: false, code: "COOLDOWN", error: `another transfer is allowed in ${Math.ceil(retryAfter / 60)} min`, retryAfter };
  }

  const inLast24h = times.filter(t => now - t < 86_400_000).length;
  if (inLast24h >= maxPerDay) {
    return { ok: false, code: "DAILY_CAP", error: `daily transfer cap (${maxPerDay}) reached`, retryAfter: 3600 };
  }
  return { ok: true };
}

// ── Coarse per-process rate limit ────────────────────────────────────────────
// Bounds fee-burn from a password holder hammering the endpoint, independent
// of the ledger checks above (which only count SUCCESSFUL moves).

const WINDOW_MS = 10 * 60_000;
const WINDOW_MAX = 10;
let window = { start: 0, count: 0 };

export function checkRateLimit(now = Date.now()) {
  if (now - window.start > WINDOW_MS) window = { start: now, count: 0 };
  window.count++;
  if (window.count > WINDOW_MAX) {
    return { ok: false, code: "RATE_LIMITED", error: "too many attempts", retryAfter: Math.ceil((window.start + WINDOW_MS - now) / 1000) };
  }
  return { ok: true };
}

/** Tests only. */
export function _resetRateLimit() { window = { start: 0, count: 0 }; }

/**
 * An independent limiter with its own window, for a route that must not share
 * the transfer's budget — editing alerts should never use up the attempts a
 * transfer is allowed, nor the other way round.
 */
export function createRateLimit({ windowMs, max }) {
  let w = { start: 0, count: 0 };
  const check = (now = Date.now()) => {
    if (now - w.start > windowMs) w = { start: now, count: 0 };
    w.count++;
    if (w.count > max) {
      return { ok: false, code: "RATE_LIMITED", error: "too many attempts", retryAfter: Math.ceil((w.start + windowMs - now) / 1000) };
    }
    return { ok: true };
  };
  check.reset = () => { w = { start: 0, count: 0 }; };
  return check;
}
