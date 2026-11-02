// telegram.js — Send a message through a Telegram bot.
//
// One POST to sendMessage, plain text, 10-second timeout.
//
// The bot token is part of the URL, so it is one careless `${e}` away from a
// log line. Every error leaving this file has it scrubbed.

import { CONFIG } from "./config.js";

export function telegramConfigured(cfg = CONFIG.telegram) {
  return Boolean(cfg.botToken && cfg.chatId);
}

function scrub(message, token) {
  return token ? String(message).split(token).join("<token>") : String(message);
}

/**
 * @param {string} text
 * @param {Object} [opts]
 * @param {Object} [opts.cfg]       — { botToken, chatId }; defaults to config
 * @param {Function} [opts.fetchImpl] — injectable for tests
 * @returns {Promise<{messageId:number}>}
 */
export async function sendTelegram(text, { cfg = CONFIG.telegram, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (!telegramConfigured(cfg)) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) {
      // Telegram's own description ("chat not found", "Too Many Requests: retry
      // after 7") is the useful part, and never contains the token.
      throw new Error(`Telegram ${res.status}: ${body?.description ?? "no description"}`);
    }
    return { messageId: body.result?.message_id ?? null };
  } catch (e) {
    const reason = e.name === "AbortError" ? `timed out after ${timeoutMs}ms` : e.message;
    throw new Error(scrub(`Telegram send failed: ${reason}`, cfg.botToken));
  } finally {
    clearTimeout(timer);
  }
}
