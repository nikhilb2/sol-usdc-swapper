// watch.js — The price alert watcher.
//
//   npm run watch            check every ALERTS_INTERVAL_SECONDS, forever
//   node watch.js --once     one check, then exit
//
// A long-running process of its own (k8s/07-alerts.yaml), not part of the
// dashboard: the internet-facing pod never holds the Telegram token, and this
// pod never holds the wallet key. It reads alerts and prices, and writes only
// alert state. It cannot trade.
//
// Delivery is at-least-once. The alert's state is saved only after Telegram
// accepts the message, so an outage means a late alert, never a lost one; a
// crash between the send and the save means the same alert twice.

import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";

import { CONFIG } from "./config.js";
import { getSpotPricesUsd } from "./query.js";
import { evaluate, describeAlert, formatAlertMessage } from "./alerts.js";
import { sendTelegram, telegramConfigured } from "./telegram.js";
import {
  selectAlerts, updateAlert, markAlertsChecked,
  describe as describeStorage, close as closeStorage,
} from "./storage/index.js";

// The liveness probe reads this file's mtime: a wedged loop stops touching it
// and the kubelet restarts the pod.
export const HEARTBEAT = process.env.WATCH_HEARTBEAT || path.join(os.tmpdir(), "sol-swapper-watch.heartbeat");

const log = (fields) => console.log(JSON.stringify({ evt: "alerts", at: new Date().toISOString(), ...fields }));

/**
 * One pass over every active alert. Throws if it cannot see prices or reach
 * storage; runTick() below turns a run of those into a Telegram warning.
 *
 * @returns {Promise<{checked:number, fired:number, failed:number}>}
 */
export async function tick({ now = new Date().toISOString(), send = sendTelegram, getPrices = getSpotPricesUsd } = {}) {
  const alerts = await selectAlerts({ activeOnly: true });
  if (!alerts.length) return { checked: 0, fired: 0, failed: 0 };

  const prices = await getPrices([...new Set(alerts.map(a => a.symbol))]);
  await markAlertsChecked(prices, now);

  let fired = 0, failed = 0;
  // Sequential: Telegram allows about one message a second per chat, and a
  // handful of alerts firing together is the only time this loop is busy.
  for (const alert of alerts) {
    const price = prices[alert.symbol];
    if (price === undefined) continue;

    const { fire, patch } = evaluate(alert, price, now);
    if (fire) {
      try {
        await send(formatAlertMessage(alert, price));
      } catch (e) {
        failed++;
        log({ outcome: "send_error", id: alert.id, alert: describeAlert(alert), reason: e.message });
        continue;    // state untouched, so the next tick tries again
      }
      fired++;
      log({ outcome: "fired", id: alert.id, alert: describeAlert(alert), price });
    }
    if (patch) {
      const exists = await updateAlert(alert.id, patch);
      if (!fire && exists) log({ outcome: "rearmed", id: alert.id, alert: describeAlert(alert), price });
    }
  }
  return { checked: alerts.length, fired, failed };
}

// In memory on purpose: after a restart the count starts again, which at worst
// delays the warning by one threshold.
const health = { failures: 0, warned: false };

/**
 * tick(), plus the one thing a silent watcher must not do: fail quietly. A
 * watcher that cannot see prices, or cannot read its alerts, is a set of
 * alerts that will never fire — so after feedDownAfterTicks failures in a row
 * it says so, once, and again when it recovers.
 */
export async function runTick({ send = sendTelegram, ...opts } = {}) {
  try {
    const r = await tick({ send, ...opts });
    if (health.warned) {
      await send("✅ Price alerts are working again.")
        .then(() => { health.warned = false; })
        .catch(e => log({ outcome: "send_error", reason: e.message }));
    }
    health.failures = 0;
    return r;
  } catch (e) {
    health.failures++;
    log({ outcome: "tick_error", failures: health.failures, reason: e.message });
    if (health.failures >= CONFIG.alerts.feedDownAfterTicks && !health.warned) {
      await send(`⚠️ Price alerts are blind: ${health.failures} checks in a row failed.\nLast error: ${e.message}`)
        .then(() => { health.warned = true; })
        .catch(err => log({ outcome: "send_error", reason: err.message }));
    }
    return null;
  }
}

/** Tests only. */
export function _resetHealth() { health.failures = 0; health.warned = false; }

function heartbeat() {
  try { fs.writeFileSync(HEARTBEAT, new Date().toISOString()); } catch { /* probe will notice */ }
}

async function main() {
  if (!telegramConfigured()) {
    // Fail the deploy, not silently swallow every alert.
    console.error("\n❌ TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set.\n");
    process.exit(1);
  }

  const once = process.argv.includes("--once");
  const every = Math.max(10, CONFIG.alerts.intervalSeconds) * 1000;
  log({ outcome: "start", storage: describeStorage(), intervalSeconds: every / 1000, once });

  let stopping = false;
  let timer = null;
  const stop = async () => {
    stopping = true;
    clearTimeout(timer);
    await closeStorage();
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, stop);

  // setTimeout after each pass rather than setInterval, so a slow pass (a
  // Telegram timeout) can never overlap the next one.
  const loop = async () => {
    // Quiet unless something happens: fired, re-armed and errors log
    // themselves, so a healthy minute writes nothing.
    await runTick();
    // Even after a failed tick: the probe asks whether the LOOP is alive, and
    // restarting the pod would not bring back Jupiter or Postgres.
    heartbeat();
    if (once) return stop();
    if (!stopping) timer = setTimeout(loop, every);
  };
  await loop();
}

if (process.argv[1]?.endsWith("watch.js")) main();
