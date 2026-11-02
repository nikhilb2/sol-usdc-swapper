// config.js — SOL / LST <-> USDC swap + accumulation configuration

import { PublicKey } from "@solana/web3.js";
import "dotenv/config";

export const CONFIG = {
  // ── Token addresses ──────────────────────────────────────────────────────
  tokens: {
    SOL:     "So11111111111111111111111111111111111111112",  // Wrapped SOL
    USDC:    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",

    // Liquid staking tokens. These accrue staking rewards by appreciating
    // against SOL, so holding one is how the stack grows in SOL terms.
    // Realized 12-month SOL-denominated yield, measured 2026-08-28:
    //   jupSOL 6.30% | mSOL 6.19% | jitoSOL 5.80% | bnSOL 5.31%
    JUPSOL:  "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
    JITOSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    MSOL:    "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  },

  // ── Token decimals ───────────────────────────────────────────────────────
  decimals: {
    SOL:     9,
    USDC:    6,
    JUPSOL:  9,
    JITOSOL: 9,
    MSOL:    9,
  },

  // ── Swap safety limits ───────────────────────────────────────────────────
  swap: {
    // Slippage tolerance in basis points (50 = 0.5%)
    slippageBps: 50,

    // Abort the swap if Jupiter reports a price impact above this %
    maxPriceImpactPct: 1.0,

    // Never spend SOL below this reserve — it pays for transaction fees.
    // A "SOL -> USDC max" swap sells everything above this floor.
    // A wallet holding only an LST cannot transact; this must stay funded.
    minSolReserveLamports: 50_000_000,  // 0.05 SOL

    // Minimum swap size in USD-equivalent (avoids dust trades eaten by fees).
    // Enforced in strategy.js — a $2 residual buy is not worth the priority fee.
    minTradeSizeUsd: 5,

    // Send retries on transient RPC failures
    sendAttempts: 3,
  },

  // ── Accumulation strategy ────────────────────────────────────────────────
  //
  // Deliberately boring. Backtested against 1000 days of SOL daily closes
  // (2023-12 -> 2026-08) plus 8 other assets over the same window:
  //
  //   - z-score DCA tiers:  t = 0.15 across 9 assets. Noise.
  //   - sell-high/rebuy-low: t ~ -2.5, won 3 of 18 asset/config pairs.
  //     The only statistically real effect found, and it is NEGATIVE.
  //   - block-bootstrap (500 resamples): every variant p > 0.13,
  //     family-wise p = 0.22 for the best of 9.
  //
  // There is no timing edge here at this size. The reliable source of "more
  // SOL" is staking yield (~5-6%/yr) and not being diluted by the ~3.68%
  // inflation that unstaked holders eat. So: buy on a schedule, hold an LST,
  // and measure honestly against the do-nothing baseline.
  strategy: {
    enabled: process.env.STRATEGY_ENABLED !== "false",

    // What we accumulate. Must be a key in `tokens` above.
    asset: process.env.STRATEGY_ASSET || "JUPSOL",

    // Funding currency. Buying USDC -> LST directly (rather than
    // USDC -> SOL -> LST) is both cheaper and cleaner for tax accounting.
    quote: "USDC",

    // Budget: accrues every day, spent on each buy.
    dailyUsd: Number(process.env.STRATEGY_DAILY_USD ?? 13),

    // How often to actually buy. "daily" preserves the habit; "weekly"
    // tested marginally better and makes 7x fewer taxable events.
    cadence: process.env.STRATEGY_CADENCE || "daily",   // "daily" | "weekly"
    weeklyDow: 1,                                        // Monday, when weekly

    // Unspent budget carries forward up to this, then buys regardless.
    // Keep tight: idle cash is an unintentional short-beta bet, and the
    // audit showed this parameter silently controls most of the variance.
    maxCarryUsd: Number(process.env.STRATEGY_MAX_CARRY_USD ?? 36),

    // ── Dip boost ──────────────────────────────────────────────────────────
    // When total P&L is negative, buy bigger. The multiplier is
    //   1 + (drawdown fraction * boostFactor)
    // so at the default 10x, being down 2% buys 1.20x the usual size.
    //
    // Read this for what it is: averaging down. It is NOT a timing edge — the
    // backtest above found none, and this rule does not create one. What it
    // does is spend more capital at lower prices, which lowers the average
    // cost of the units it buys and raises total exposure. It also spends
    // money the daily budget never accrued (carry floors at 0), so lifetime
    // `spentUsd` will exceed `accruedUsd`; the report shows the gap.
    boostOnLoss: process.env.STRATEGY_BOOST_ON_LOSS !== "false",

    // Multiplier applied to the drawdown fraction. 10 = "10x the percentage".
    boostFactor: Number(process.env.STRATEGY_BOOST_FACTOR ?? 10),

    // Hard ceiling on the multiplier. Without it a 50% drawdown asks for a 6x
    // buy at exactly the moment the wallet can least afford it — a martingale
    // sized by the crash itself. At 1.5 the boost tops out at a 5% drawdown,
    // so the rule leans into a dip without ever letting one dictate the size.
    maxBoostMultiplier: Number(process.env.STRATEGY_MAX_BOOST ?? 1.5),

    // ── Take-profit ────────────────────────────────────────────────────────
    // When total P&L reaches +thresholdPct, sell sellFraction of the position
    // to USDC — then not again for cooldownDays. The DCA is untouched: the
    // proceeds sit as USDC and the budget never redeploys them.
    //
    // The cooldown is not optional polish. P&L is measured against capital
    // NET of sells, so a profitable sale pushes the percentage UP; without a
    // cooldown the rule would fire again the next day, and the next, until
    // the position was gone. backtest-takeprofit.js sweeps the cooldown.
    //
    // Read this for what it is too: ending with cash is a bet that SOL falls.
    // It wins on a path where price peaked mid-window and loses on one that
    // keeps rising. Default OFF — a sell path nobody opted into is not one
    // that should ship enabled.
    takeProfit: {
      enabled:      process.env.STRATEGY_TAKE_PROFIT === "true",
      thresholdPct: Number(process.env.STRATEGY_TAKE_PROFIT_PCT ?? 10),
      sellFraction: Number(process.env.STRATEGY_TAKE_PROFIT_FRACTION ?? 0.10),
      cooldownDays: Number(process.env.STRATEGY_TAKE_PROFIT_COOLDOWN_DAYS ?? 30),
    },

    // Units of the strategy asset that were in the wallet BEFORE the bot
    // started, or otherwise acquired outside it. This is a human declaration:
    // the bot cannot know it, because it never saw the trade.
    //
    // Declaring it only changes how the reconciliation line is LABELLED —
    // "declared opening balance" instead of "unexplained". It never enters
    // P&L, because units the bot didn't buy have no cost basis it can know.
    openingUnits: Number(process.env.STRATEGY_OPENING_UNITS ?? 0),
  },

  // ── Price history (for the report's do-nothing counterfactual) ───────────
  prices: {
    // Coinbase is primary: keyless, ~10 req/s, no monthly credit cap.
    // Returns [time, low, high, open, close, volume] sorted DESCENDING,
    // and the newest row is the in-progress UTC day (must be dropped).
    coinbaseUrl: "https://api.exchange.coinbase.com/products/SOL-USD/candles",
    // CoinGecko fallback only — the keyless tier rate-limits hard (429 on
    // the second call during testing) and its last array element is a live
    // spot snapshot rather than a daily close.
    coingeckoUrl: "https://api.coingecko.com/api/v3/coins/solana/market_chart",
    coingeckoApiKey: process.env.COINGECKO_API_KEY,
    bootstrapDays: 200,
  },

  // ── Jupiter API ───────────────────────────────────────────────────────────
  jupiter: {
    quoteUrl: "https://api.jup.ag/swap/v1/quote",
    swapUrl:  "https://api.jup.ag/swap/v1/swap",
    // Same host as the quotes. lite-api.jup.ag served this too, but returned
    // Cloudflare 525s on 2026-10-16 while this host stayed up.
    priceUrl: "https://api.jup.ag/price/v3",
    apiKey:   process.env.JUPITER_API_KEY,
  },

  // ── RPC ───────────────────────────────────────────────────────────────────
  rpcUrl: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",

  // ── Custody transfer ─────────────────────────────────────────────────────
  //
  // Sweeping the accumulated LST to a wallet whose key is NOT sitting in an
  // internet-facing pod. The destination is pinned HERE and can never be
  // supplied by a request: that single constraint is what makes the dashboard
  // button defensible. An attacker holding the dashboard password can, at
  // worst, force the coins into the owner's own safe wallet and burn a few
  // cents of fees — griefing, not theft.
  //
  // There is deliberately no TRANSFER_ASSET key. The asset is always
  // strategyAsset(); a key that could be set to USDC would turn a custody
  // button into a way to move the bot's working capital.
  transfer: {
    // Default OFF. A write path that ships enabled is a write path nobody
    // consciously opted into.
    enabled:     process.env.TRANSFER_ENABLED === "true",
    // Gates only the HTTP button. The CLI works whenever `enabled`.
    httpEnabled: process.env.TRANSFER_HTTP_ENABLED === "true",

    // The ONLY address funds can go to. Validated by transferDestination().
    destination: process.env.TRANSFER_DESTINATION || "",

    // Rate limits. Enforced against the LEDGER, not memory, so they survive a
    // pod restart. These bound the fee-burn if the password ever leaks.
    cooldownMinutes: Number(process.env.TRANSFER_COOLDOWN_MINUTES ?? 60),
    maxPerDay:       Number(process.env.TRANSFER_MAX_PER_DAY ?? 2),

    priorityFeeMicroLamports: Number(process.env.TRANSFER_PRIORITY_FEE ?? 20_000),
    computeUnitLimit: 80_000,

    // HTTP hardening. The nonce is the CSRF defence that actually matters:
    // it can only be obtained by successfully READING an authenticated
    // endpoint, which a blind cross-origin attacker cannot do.
    nonceTtlMs:   120_000,
    maxBodyBytes: 4096,
  },

  // ── Price alerts ─────────────────────────────────────────────────────────
  //
  // Notification only. Nothing here can trade: an alert firing sends a
  // Telegram message and changes no strategy state. The watcher (watch.js) is
  // a separate process that holds no wallet key at all.
  alerts: {
    // How often the watcher checks. One Jupiter price call per tick covers
    // every symbol, so a minute is cheap.
    intervalSeconds: Number(process.env.ALERTS_INTERVAL_SECONDS ?? 60),

    // A repeating alert re-arms only once price retreats this far back past
    // the target. Without the band, a price chopping around $150.00 would
    // fire "SOL below $150" on every other tick.
    rearmPct: Number(process.env.ALERTS_REARM_PCT ?? 1),

    // And never more often than this, however far price swings.
    repeatCooldownMinutes: Number(process.env.ALERTS_REPEAT_COOLDOWN_MINUTES ?? 60),

    // Consecutive failed price checks before the watcher says so on Telegram.
    // A watcher that silently cannot see prices is an alert that never fires.
    feedDownAfterTicks: 10,

    // Bounds both storage and the Telegram spam a leaked password could buy.
    maxActive: 50,
    maxBodyBytes: 1024,
  },

  // In the cluster these come from the `sol-swapper-telegram` Secret, mounted
  // as-is, so there is one copy of the token to rotate.
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId:   process.env.TELEGRAM_CHAT_ID || "",
  },

  dashboard: {
    // Exact origin the browser will send, e.g. https://sol.example.com.
    // Empty = derive from the Host header, which is fine on loopback.
    publicOrigin: process.env.DASHBOARD_PUBLIC_ORIGIN || "",
  },

  // ── Dry run: quote and log the swap but don't submit the transaction ─────
  dryRun: process.env.DRY_RUN === "true",
};

export function decimalsFor(sym) {
  const d = CONFIG.decimals[sym];
  if (d === undefined) {
    throw new Error(`Unknown token: ${sym}. Supported: ${Object.keys(CONFIG.tokens).join(", ")}`);
  }
  return d;
}

export function mintFor(sym) {
  const mint = CONFIG.tokens[sym];
  if (!mint) {
    throw new Error(`Unknown token: ${sym}. Supported: ${Object.keys(CONFIG.tokens).join(", ")}`);
  }
  return mint;
}

/** The token the strategy accumulates, validated. */
export function strategyAsset() {
  const sym = CONFIG.strategy.asset;
  mintFor(sym);  // throws if unknown
  return sym;
}

/** True for the liquid staking tokens — i.e. everything that isn't SOL or USDC. */
export function isLst(sym) {
  return sym !== "SOL" && sym !== "USDC" && Boolean(CONFIG.tokens[sym]);
}

/**
 * Validate and return the pinned transfer destination.
 *
 * This is the highest-stakes function in the codebase: a destination that is
 * not a plain wallet derives an associated token account that NO key can ever
 * sign for, and the funds are gone permanently — no attacker required.
 *
 * Deliberately pure (no network, no wallet import) so config.js still loads
 * without PRIVATE_KEY. transfer.js adds the checks only the network can make:
 * that the account, if it exists at all, is owned by the System Program.
 *
 * @returns {PublicKey}
 */
export function transferDestination() {
  const s = CONFIG.transfer.destination;
  if (!s) {
    throw new Error("TRANSFER_DESTINATION is not set — transfers are enabled but have no destination.");
  }

  let pk;
  try { pk = new PublicKey(s); }
  catch { throw new Error(`TRANSFER_DESTINATION is not a valid Solana address: ${s}`); }

  // PublicKey tolerates some non-canonical base58; round-tripping does not.
  if (pk.toBase58() !== s) {
    throw new Error(`TRANSFER_DESTINATION is not canonical base58: ${s}`);
  }

  // A wallet address is an ed25519 public key. A PDA is off the curve and has
  // no private key, so an ATA derived from one is unspendable forever.
  if (!PublicKey.isOnCurve(pk.toBytes())) {
    throw new Error(`TRANSFER_DESTINATION ${s} is off the ed25519 curve (a PDA or derived account), not a wallet. Refusing.`);
  }

  // Note this check is NOT redundant with the curve check: mint addresses are
  // ordinary ed25519 keys and pass it. jupSOL's own vanity mint is on-curve.
  if (Object.values(CONFIG.tokens).includes(s)) {
    throw new Error(`TRANSFER_DESTINATION ${s} is a token mint, not a wallet.`);
  }

  return pk;
}
