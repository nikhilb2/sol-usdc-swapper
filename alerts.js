// alerts.js — Price alert rules. Pure: no I/O, no clock.
//
// Same split as strategy.js (decides) / run.js (executes): this file says
// whether an alert fires and what its stored state becomes; watch.js fetches
// prices, sends the Telegram message and persists the result.
//
// An alert is a level, not a crossing: "SOL below $150" fires on the first
// check where SOL is at or under $150, including the very first check after
// it is created. The dashboard warns when that is about to happen.
//
//   one-shot (default)  fires once, then goes inactive
//   repeat              fires, disarms, and re-arms only after price retreats
//                       rearmPct back past the target AND the cooldown has run

import { CONFIG } from "./config.js";

/** Everything priced in USD. USDC is the unit, so it is not alertable. */
export const ALERT_SYMBOLS = Object.keys(CONFIG.tokens).filter(s => s !== "USDC");
export const ALERT_OPS = ["above", "below"];

const MAX_NOTE = 120;
const MAX_TARGET = 1e7;

/**
 * Validate untrusted input (an HTTP body or CLI args) into a new alert.
 * Never trusts a field it was not asked for: state fields are always fresh.
 *
 * @returns {{ok:true, alert:Object} | {ok:false, error:string}}
 */
export function validateAlert(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "expected an object" };

  const symbol = String(input.symbol ?? "").toUpperCase();
  if (!ALERT_SYMBOLS.includes(symbol)) {
    return { ok: false, error: `symbol must be one of ${ALERT_SYMBOLS.join(", ")}` };
  }

  const op = String(input.op ?? "").toLowerCase();
  if (!ALERT_OPS.includes(op)) return { ok: false, error: `op must be "above" or "below"` };

  // Number("") is 0 and Number(" 5 ") is 5; neither should slip through as a
  // typo-turned-target, so require an actual number or a clean numeric string.
  const raw = input.target;
  const target = typeof raw === "number" ? raw
    : typeof raw === "string" && /^\s*\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(target) || target <= 0 || target >= MAX_TARGET) {
    return { ok: false, error: "target must be a positive USD price" };
  }

  if (input.repeat !== undefined && typeof input.repeat !== "boolean") {
    return { ok: false, error: "repeat must be true or false" };
  }

  // Strip control characters: this text goes straight into a Telegram message
  // and a log line.
  const note = String(input.note ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_NOTE);

  return {
    ok: true,
    alert: { symbol, op, target, repeat: input.repeat === true, note: note || null },
  };
}

/** Is the alert's condition true at this price? */
export function isMet(alert, price) {
  return alert.op === "above" ? price >= alert.target : price <= alert.target;
}

/** Has price retreated far enough back past the target to re-arm? */
export function hasRetreated(alert, price, rearmPct) {
  const band = alert.target * (rearmPct / 100);
  return alert.op === "above" ? price <= alert.target - band : price >= alert.target + band;
}

/**
 * Decide what one price observation does to one alert.
 *
 * The patch is applied only AFTER the message is delivered (see watch.js), so
 * a Telegram outage means a late alert, never a lost one.
 *
 * @param {Object} alert
 * @param {number} price
 * @param {string} now — ISO timestamp
 * @returns {{fire:boolean, patch:Object|null}}
 */
export function evaluate(alert, price, now, config = CONFIG) {
  if (!alert.active || !Number.isFinite(price) || price <= 0) return { fire: false, patch: null };

  if (!alert.armed) {
    // Active but disarmed: a repeating alert that has fired and is waiting
    // for price to move back before it can fire again.
    return hasRetreated(alert, price, config.alerts.rearmPct)
      ? { fire: false, patch: { armed: true } }
      : { fire: false, patch: null };
  }

  if (!isMet(alert, price)) return { fire: false, patch: null };

  if (alert.repeat && alert.lastFiredAt) {
    const since = Date.parse(now) - Date.parse(alert.lastFiredAt);
    if (since < config.alerts.repeatCooldownMinutes * 60_000) return { fire: false, patch: null };
  }

  return {
    fire: true,
    patch: {
      armed: false,
      active: alert.repeat,          // a one-shot is done
      lastFiredAt: now,
      fireCount: (alert.fireCount ?? 0) + 1,
    },
  };
}

const money = v => v >= 1 ? v.toFixed(2) : v.toPrecision(4);

/** One-line human description, shared by the CLI, the page and the message. */
export function describeAlert(alert) {
  return `${alert.symbol} ${alert.op} $${money(alert.target)}`;
}

/** Plain text — no parse_mode, so nothing in a note can break the markup. */
export function formatAlertMessage(alert, price, { origin = CONFIG.dashboard.publicOrigin } = {}) {
  const arrow = alert.op === "above" ? "📈" : "📉";
  const lines = [
    `${arrow} ${describeAlert(alert)}`,
    `${alert.symbol} is now $${money(price)}`,
  ];
  if (alert.note) lines.push(`Note: ${alert.note}`);
  lines.push(alert.repeat
    ? `Repeating — re-arms once ${alert.symbol} moves back ${CONFIG.alerts.rearmPct}% past the target.`
    : "One-shot — this alert is now off.");
  if (origin) lines.push(origin);
  return lines.join("\n");
}
