// alerts-cli.js — Manage price alerts from the terminal.
//
//   npm run alerts                                    list
//   npm run alerts -- add SOL below 150               one-shot
//   npm run alerts -- add JUPSOL above 200 --repeat --note "take profit"
//   npm run alerts -- rm 3
//   npm run alerts -- test                            send a Telegram test message
//
// The dashboard can do the same; this exists so alerts never depend on the
// page being up. Firing is watch.js's job — this only edits the list.

import "dotenv/config";
import { ALERT_SYMBOLS, validateAlert, describeAlert } from "./alerts.js";
import { CONFIG } from "./config.js";
import { sendTelegram } from "./telegram.js";
import { selectAlerts, insertAlert, deleteAlert, describe as describeStorage, close } from "./storage/index.js";

const USAGE = `usage:
  node alerts-cli.js [list]
  node alerts-cli.js add <${ALERT_SYMBOLS.join("|")}> <above|below> <usd> [--repeat] [--note "text"]
  node alerts-cli.js rm <id>
  node alerts-cli.js test`;

function status(a) {
  if (!a.active) return `fired ${String(a.lastFiredAt ?? "").slice(0, 16).replace("T", " ")}`;
  if (!a.armed) return "fired, waiting to re-arm";
  return "armed";
}

async function list() {
  const alerts = await selectAlerts();
  console.log(`\n🔔 Price alerts — ${describeStorage()}\n`);
  if (!alerts.length) return console.log("   none. Add one with: node alerts-cli.js add SOL below 150\n");
  for (const a of alerts) {
    const now = a.lastPrice ? ` · now $${Number(a.lastPrice).toFixed(2)}` : "";
    console.log(`  #${String(a.id).padEnd(4)} ${describeAlert(a).padEnd(24)} ${a.repeat ? "repeat " : "once   "} ${status(a)}${now}${a.note ? ` · ${a.note}` : ""}`);
  }
  console.log();
}

async function main() {
  const [cmd = "list", ...rest] = process.argv.slice(2);

  if (cmd === "list") return list();

  if (cmd === "add") {
    const [symbol, op, target] = rest;
    const noteAt = rest.indexOf("--note");
    const v = validateAlert({
      symbol, op, target,
      repeat: rest.includes("--repeat"),
      note: noteAt >= 0 ? rest[noteAt + 1] : undefined,
    });
    if (!v.ok) throw new Error(`${v.error}\n\n${USAGE}`);
    const active = await selectAlerts({ activeOnly: true });
    if (active.length >= CONFIG.alerts.maxActive) throw new Error(`already ${active.length} active alerts (max ${CONFIG.alerts.maxActive})`);
    const a = await insertAlert(v.alert);
    console.log(`✅ #${a.id} ${describeAlert(a)} (${a.repeat ? "repeating" : "one-shot"})`);
    return;
  }

  if (cmd === "rm") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id) || id <= 0) throw new Error(USAGE);
    if (!(await deleteAlert(id))) throw new Error(`no alert #${id}`);
    console.log(`🗑  removed #${id}`);
    return;
  }

  if (cmd === "test") {
    await sendTelegram("🔔 Test from sol-usdc-swapper — price alerts will arrive in this chat.");
    console.log("✅ sent — check Telegram");
    return;
  }

  throw new Error(USAGE);
}

try {
  await main();
} catch (e) {
  console.error(`\n❌ ${e.message}\n`);
  process.exitCode = 1;
} finally {
  await close();
}
