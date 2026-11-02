// auth.js — HTTP Basic credentials for the dashboard, from env vars.
//
// Basic auth is fine here because the server binds to loopback by default.
// If you ever expose it beyond localhost, put it behind TLS — Basic sends the
// password base64-encoded, which is encoding, not encryption.

import crypto from "crypto";

/** Constant-time string compare that does not leak length via early return. */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  // timingSafeEqual throws on length mismatch, so hash both to a fixed width
  // first. This keeps the comparison constant-time across differing lengths.
  const ah = crypto.createHash("sha256").update(ab).digest();
  const bh = crypto.createHash("sha256").update(bb).digest();
  return crypto.timingSafeEqual(ah, bh);
}

export function credentials() {
  return {
    user: process.env.DASHBOARD_USER || "",
    pass: process.env.DASHBOARD_PASSWORD || "",
  };
}

/**
 * Why the dashboard refuses to start rather than defaulting to something:
 * a monitoring page that silently comes up unauthenticated is worse than one
 * that doesn't come up at all.
 */
export function assertConfigured() {
  const { user, pass } = credentials();
  if (!user || !pass) {
    throw new Error(
      "DASHBOARD_USER and DASHBOARD_PASSWORD must both be set in .env.\n" +
      "   Generate a password with:  node -e \"console.log(require('crypto').randomBytes(18).toString('base64url'))\""
    );
  }
  if (pass.length < 12) {
    throw new Error(`DASHBOARD_PASSWORD is only ${pass.length} characters — use at least 12.`);
  }
}

/** @returns {boolean} true when the request carries valid Basic credentials. */
export function isAuthorized(authorizationHeader) {
  const { user, pass } = credentials();
  if (!user || !pass) return false;

  const header = String(authorizationHeader ?? "");
  if (!header.startsWith("Basic ")) return false;

  let decoded;
  try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); }
  catch { return false; }

  const idx = decoded.indexOf(":");
  if (idx < 0) return false;

  // Both comparisons always run — no short-circuit that would reveal whether
  // it was the username or the password that was wrong.
  const userOk = safeEqual(decoded.slice(0, idx), user);
  const passOk = safeEqual(decoded.slice(idx + 1), pass);
  return userOk && passOk;
}
