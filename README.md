# sol-usdc-swapper

A Jupiter-based swapper for SOL / liquid-staking-tokens ↔ USDC, plus a
scheduled accumulation strategy that buys on a timer and measures itself
honestly against doing nothing.

## Why the strategy is boring

The original plan was an adaptive DCA (buy more when cheap, skip when
expensive) plus a sell-high / rebuy-lower swing sleeve. Both were backtested
against 1000 daily SOL closes (2023-12 → 2026-08, covering the 2024 bull, the
2025 drawdown, and the 2026 run) and then re-tested independently across 8
other assets over the same window. Neither survived:

| Idea | Result |
|---|---|
| z-score DCA tiers | t = 0.15 across 9 assets — indistinguishable from noise |
| Sell-high / rebuy-lower sleeve | t ≈ −2.5, won 3 of 18 asset/config pairs |
| Block bootstrap, 500 resamples | every variant p > 0.13; family-wise p = 0.22 for the best of 9 |

Two things worth internalising:

1. **Fixed-dollar buying is already price-aware.** $13 at $100 buys twice the
   SOL that $13 at $200 does. Layering a z-score on top mostly just idles cash,
   and idle cash in an uptrend is SOL you didn't buy.
2. **Trade count is inversely correlated with SOL kept.** In the swing grid,
   29 round trips → −4.8%; 17 → +1.6%, monotonically. Overtrading really does
   lose money, and it was the most reliable effect in the whole dataset.

Any apparent winner was a cash-holding rule being paid for SOL's final price
sitting 25% below its period mean — short beta dressed up as skill.

**What does reliably add SOL is staking.** A liquid staking token appreciates
against SOL as rewards accrue. Verified 12-month realized yield (2026-08-28):

| LST | realized 12mo | note |
|---|---|---|
| jupSOL | **6.30%** | default |
| mSOL | 6.19% | |
| jitoSOL | 5.80% | deepest liquidity, tightest NAV tracking |
| bnSOL | 5.31% | |

The sharper framing: SOL inflates ~3.68%/yr, so an unstaked holder loses supply
share every year. The choice isn't "+6% or 0%".

So this bot buys a fixed amount on a fixed schedule, holds an LST, and spends
its real effort on the scoreboard.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env — set PRIVATE_KEY and RPC_URL at minimum
```

## The accumulation bot

```bash
node run.js --explain        # read-only: today's decision + every rail. Start here.
node run.js --dry-run        # quote and log, never submits
node run.js                  # execute
node report.js               # the scoreboard
node backtest.js             # replay the strategy over price history
```

`--explain` writes no state and sends no transaction. Run it first, and run it
any time you want to know what the bot is thinking.

### Dip boost

The one rule that isn't a flat schedule. When total P&L — realized plus
unrealized, as a percentage of net USD deployed — is negative, the next buy is
multiplied by `1 + (drawdown fraction × STRATEGY_BOOST_FACTOR)`, capped at
`STRATEGY_MAX_BOOST`. At the defaults (factor 10, cap 1.5x):

| Total P&L | Buy is |
|---|---|
| 0% or better | 1.00x — unchanged |
| −2% | 1.20x |
| −5% | 1.50x — cap reached |
| −10% | 1.50x — capped |
| −50% | 1.50x — capped |

The cap is the point. Without it a 50% drawdown asks for a 6x buy at exactly
the moment the wallet can least afford it, which is a martingale sized by the
crash itself. At 1.5x the boost is fully in effect by a 5% drawdown and never
grows past it, so a bad enough decline cannot escalate the position on its own.

Two things to be honest about, given everything above:

1. **This is averaging down, not a timing edge.** The backtest found no timing
   edge and this rule does not create one — it is not a claim that drawdowns
   predict anything. What it actually does is put more dollars in at lower
   prices, which lowers the average cost of the units bought and *raises* total
   exposure. That cuts both ways, and it is a bet on this asset specifically,
   not evidence of skill.
2. **It spends money the budget never accrued.** `carryUsd` floors at 0, so a
   boosted buy can only come out of dollars the daily rate never banked:
   lifetime `spentUsd` will drift above `accruedUsd`, and that gap is the point
   at which "the same capital, spread evenly" stops describing what you are
   doing. The wallet's USDC balance is the real limit — keep it funded above
   the plain `STRATEGY_DAILY_USD` rate, or a boosted buy is simply clamped to
   whatever is in there and the boost quietly does nothing.

`STRATEGY_BOOST_ON_LOSS=false` turns it off entirely. Either way `--explain`
prints the current multiplier as the `DIP_BOOST` rail — the one rail that never
blocks a trade, only sizes one.

### Safety properties

| Property | How |
|---|---|
| Can't double-buy | Idempotent on the UTC date in `state.json` |
| Can't run twice at once | `run.lock`, with stale-lock takeover if the holder died |
| Survives a crash mid-swap | Intent written *before* the swap, reconciled against the trade log on the next run |
| Can't spend money it doesn't have | Wallet balance is the hard cap; banked budget is only an intention |
| Can't strand itself without gas | Refuses to trade below the SOL reserve |
| Never guesses | An ambiguous crash halts and asks, rather than inventing a ledger entry |

There is deliberately **no `--force`**. Every rail exists to stop a trade that
shouldn't happen, and an override is what you'd reach for at the exact moment
your judgement is worst. To change behaviour, edit config visibly.

### Recovering from a halt

If a run dies between the on-chain confirmation and the log append, the next
run detects it. If it can't resolve it safely it stops and tells you what to
check. After confirming on Solscan:

```bash
node run.js --resolve-intent executed --sig <signature>
node run.js --resolve-intent none          # if the swap never landed
```

## Manual swaps

```bash
node query.js                        # balances + price
node query.js --quote SOL USDC 1.5   # quote only
node swap.js USDC JUPSOL 12          # buy $12 of jupSOL
node swap.js SOL USDC max --yes      # sell all SOL above the gas reserve
DRY_RUN=true node swap.js USDC JUPSOL 12
```

## P&L and the scoreboard

`pl.js` is USD FIFO P&L. `report.js` is the one that matters: it denominates
everything in **SOL** and compares against buying bare SOL instead.

It reports two benchmarks, because one number would hide a failure mode:

- **Same capital** (primary) — the same dollars you actually deployed, spread
  evenly. Isolates the decision from how much got funded, and can't be gamed by
  under-deploying.
- **Same schedule** — $13 every single day regardless. This is where days
  missed to an empty wallet or a sleeping laptop show up.

Banked-but-unspent cash is valued and counted **in the benchmark**. Omitting it
is how a cash-hoarding strategy fakes a good result.

It is deliberately *excluded* from the P&L. The two questions differ: P&L asks
"did the position I bought go up?", and cash is not a position — counting it
would flatter the number for simply not trading. The benchmark asks "did the
rule beat doing nothing?", which hoarding cash genuinely can game.

### Attribution — the wallet is not the position

The wallet is a real address and may hold units the bot never bought: a
pre-existing bag, a manual swap, a transfer in. The rule is **the log defines
the position, the wallet defines the reconciliation.**

```
wallet holds     18.481203 JUPSOL   ← the chain
bot-attributed   12.481203          ← the trade log; every figure uses this
opening balance   6.000000          ← declared, STRATEGY_OPENING_UNITS
unexplained       0.000000          ✅ reconciled
```

Units the bot did not buy have no cost basis it can know, so they never enter
the P&L or the benchmark. Mixing them in is not a rounding error: an
undeclared bag measured against capital the bot really deployed reads as free
profit, and a transfer out reads as a catastrophic loss.

`STRATEGY_OPENING_UNITS` only changes the *label* — declared instead of
unexplained. The arithmetic is identical either way. Anything still
unexplained past a 2% tolerance raises a banner on the dashboard and a warning
in the scorecard.

## Moving the position to a safer wallet

The bot's wallet holds the key that signs its trades, and that key sits in an
internet-facing pod. Past a certain size you want the position somewhere else.

```bash
npm run transfer                 # sweep the whole balance (prompts)
node transfer.js --dry-run --yes # rehearse it
```

There is also a button on the dashboard, off by default
(`TRANSFER_HTTP_ENABLED`). Either way the destination comes from
`TRANSFER_DESTINATION` and **nothing in the request can change it** — see
[Why the button is safe](#why-the-button-is-safe).

### A move is a custody change, not a sale

This is the part that matters for the numbers. The units are still yours, so
they stay in the position and keep their cost basis:

```
Custody
  in bot wallet         0.412300 JUPSOL   (= 0.4978 SOL)
  moved to safe wallet  3.117400 JUPSOL   (= 3.7643 SOL)  ← still yours; P&L tracks it
  destination           Dwjr…6sD6
  safe wallet holds     3.117400          ✅ covers the moved amount
```

`botUnits`, `costBasisUsd`, `plUsd`, `plPct`, `plSol` and every benchmark are
**bit-identical before and after a move.** What changes is one thing: the
reconciler stops expecting those units in this wallet
(`expectedUnits = custodyUnits + openingUnits`).

Treating a move as a disposal would be actively harmful, not just untidy.
`run.js` sizes the dip boost from `plSummary().plPct` — so if moving coins to
cold storage reset the P&L, putting your money somewhere safe would silently
change how much the bot buys tomorrow. It doesn't, and `pl.test.js` asserts it.

An **undeclared** shortfall still fails reconciliation, which is the whole
point of keeping the check. If you moved coins by hand, declare it:

```bash
node transfer.js --record-only --units 1.5 --sig <signature>
```

That retires the "unexplained" line honestly. The only previous option was to
invent a `sell`, which would book profit that never happened.

The dashboard also reads the destination's balance (a keyless RPC call) and
flags a **shortfall** — not a mismatch, since your safe wallet may hold the
same asset from elsewhere.

### Why the button is safe

The destination is pinned in config and can never be supplied by a request.
That single constraint is what makes a write route on a public dashboard
defensible: **an attacker holding the dashboard password cannot steal — the
worst they can do is force the coins into your own safe wallet** and burn a few
cents in fees. The cooldown and daily cap bound even that.

What the pinning does *not* protect against, and what the layered checks are
for:

- **A bad destination is unrecoverable, with no attacker involved.** A token
  account or PDA derives an associated token account that no key can ever sign
  for. `config.js` checks canonical base58, the ed25519 curve and the mint
  list; `transfer.js` additionally asks the chain whether the System Program
  owns it. Being on-curve is *not* sufficient on its own — mint addresses are
  ordinary ed25519 keys and pass that check, jupSOL's own vanity mint included.
  The server refuses to boot on a bad value.
- **CSRF.** Basic-auth credentials are not cookies and are not SameSite
  protected, so a browser attaches them to a cross-site form POST. Four
  independent layers close it: an `Origin`/`Host` match, JSON-only
  content-type, a custom header (whose CORS preflight dies on the default 405),
  and a single-use nonce that can only be obtained by *reading* an
  authenticated response — which a cross-origin attacker cannot do.
- **This is the process's first body parser**, which is what makes RCE in the
  dashboard worth defending against at all. Hence the `Content-Length`
  pre-check, the 4KB cap, the socket timeout and the strict route allow-list.

The transfer also writes a `pendingIntent` before it sends, exactly as the
daily buy does, so a crash mid-flight is recoverable and the bot halts rather
than trading against a ledger it is not sure about.

## Dashboard

```bash
npm run dashboard      # http://127.0.0.1:8787
```

A monitoring page — read-only about trading; there is no buy or sell button.
It shows the bot-attributed position in SOL-equivalent,
profit/loss in dollars and percent, USD deployed, the benchmark against buying
bare SOL, every rail with its current value, a price chart, and the trade log.
It also shows what the bot *would* decide right now, without touching anything.

**There is no endpoint that can trigger a swap.** The value of this system is
its rails, and a "buy now" button is precisely the impulse they exist to stop.
Trades come from `node run.js`.

Auth is HTTP Basic from `DASHBOARD_USER` / `DASHBOARD_PASSWORD`. The server
refuses to start if either is unset or the password is under 12 characters.
Credentials are compared in constant time, and both halves are always checked
so a failure never reveals which one was wrong.

It binds to `127.0.0.1` by default. Basic auth is base64, not encryption — only
set `DASHBOARD_HOST=0.0.0.0` behind TLS and a reverse proxy.

The page is entirely self-contained: no CDN, no build step, no external
requests, enforced by a `Content-Security-Policy` header. The wallet address is
truncated and no secret is ever included in a response.

Every figure covers the bot-attributed position only, so other activity on the
address cannot distort it. If units remain that neither the trade log nor a
declared opening balance explains, the page says so and names the likely
causes — a transfer, a swap made outside the bot, or a different key in `.env`.

## Price alerts

```bash
npm run alerts -- add SOL below 150                       # one-shot
npm run alerts -- add JUPSOL above 200 --repeat --note "take profit"
npm run alerts                                            # list
npm run alerts -- rm 3
npm run alerts -- test                                    # send a test message
npm run watch                                             # the watcher
```

Or use the **Price alerts** card on the dashboard. Alerts go to Telegram.

An alert is a **level, not a crossing**. "SOL below $150" fires on the first
check where SOL is at or under $150, even when that is the first check after
you create it. The dashboard warns you before you add one that would fire
straight away.

- **One-shot** (the default) fires once and turns off. It stays in the list,
  greyed out, so you can see what triggered.
- **Repeat** fires, then waits. It re-arms only after price moves back
  `ALERTS_REARM_PCT` (1%) past the target, and it never fires more than once
  per `ALERTS_REPEAT_COOLDOWN_MINUTES` (60). Without that band, a price
  chopping around $150.00 would send a message every minute.

The watcher (`watch.js`) is its own process and holds no wallet key. Alerts
cannot trade. Once a minute it prices every symbol with a single Jupiter
call. That is a reference price: right for "tell me when", wrong for sizing a
trade, so swaps still use quotes.

Delivery is **at-least-once**. An alert's state is saved only after Telegram
accepts the message, so a Telegram outage delays an alert and never drops it.
If ten checks in a row fail (Jupiter or Postgres down), the watcher says so on
Telegram and says so again when it recovers, because a watcher that cannot
see prices fails silently otherwise. The dashboard card also shows when the
watcher last checked, and turns amber if that is more than three intervals ago.

`POST /api/alerts` is the dashboard's second write route. It touches no funds
and no strategy state. It sits behind the same Origin, JSON-only,
custom-header and auth layers as the transfer, has its own rate limit, and is
capped at 50 active alerts. It skips the transfer's nonce: that layer guards
an irreversible send, and an unwanted alert is undone with one click.

## Storage

Two interchangeable backends behind one async interface
([storage/index.js](storage/index.js)):

| | when | used for |
|---|---|---|
| **Postgres** | `DATABASE_URL` is set | production |
| **Files** (JSONL + JSON) | it isn't | tests, offline, no services |

```bash
npm run db:up       # docker compose up -d
npm run migrate     # apply storage/schema.sql (idempotent)
npm run db:psql     # psql shell into the container
npm run db:down     # stop (data survives; add -v to delete it)
```

Every run prints which backend it touched, so the two can never be confused.

Postgres earns its place on three specific guarantees the file backend cannot
make:

- **A confirmed signature can be logged exactly once** — a partial unique index
  on `sig`, so a crash-retry that re-submits an already-confirmed trade cannot
  produce a second row. The file backend can only hope the process survives
  between on-chain confirmation and the append.
- **`pg_advisory_lock` for the run lock** — session-scoped and released by the
  server the moment the connection drops, even on SIGKILL. No stale-lock
  heuristic to get wrong.
- **Real transactions** instead of temp-file + rename + two fsyncs.

State is stored as a single JSONB row, so its shape can evolve without a
migration and `strategy.js` stays a pure function of a plain object.

Credentials live in `.env` (gitignored) and are interpolated into
`docker-compose.yml`, which is committed and contains no secrets.

> **Percent-encode the password in `DATABASE_URL`.** A literal `#` both
> truncates the URL at the fragment and is treated as a comment by dotenv.

## Kubernetes

The dashboard
is a Deployment behind a Traefik ingress with a cert-manager certificate; the
daily buy is a CronJob, which is the natural shape for a process that runs once
and exits. The price alert watcher is a second, single-replica Deployment. See
[k8s/README.md](k8s/README.md).

```bash
docker buildx build --platform linux/amd64 \
  -t registry.example.com/sol-swapper:latest --push .
./k8s/make-secret.sh
kubectl apply -k k8s-local/   # your values; see k8s/README.md
```

## Scheduling (macOS)

Use **launchd**, not cron — cron silently skips runs when the Mac is asleep,
launchd fires on wake. See `launchd/` for a ready plist. Schedule after
~00:30 UTC so the previous day's close exists.

## Environment variables

| Variable | Description |
|---|---|
| `PRIVATE_KEY` | Solana private key (base58 OR JSON `[1,2,3,...]` array) |
| `RPC_URL` | Helius or other Solana RPC endpoint |
| `JUPITER_API_KEY` | Optional — higher Jupiter rate limits |
| `DATABASE_URL` | Postgres connection string. Unset → file backend. **Percent-encode the password.** |
| `STORAGE_BACKEND` | Force `files` or `postgres`, overriding the above |
| `POSTGRES_USER` / `_PASSWORD` / `_DB` / `_PORT` | Consumed by `docker-compose.yml` |
| `DATA_DIR` | Where the file backend writes (default `./data`) |
| `DRY_RUN` | `true` to quote and log without submitting |
| `STRATEGY_ENABLED` | `false` makes `run.js` a no-op |
| `STRATEGY_ASSET` | `JUPSOL` (default), `JITOSOL`, `MSOL`, or `SOL` |
| `STRATEGY_DAILY_USD` | Daily budget, default `13` |
| `STRATEGY_CADENCE` | `daily` (default) or `weekly` |
| `STRATEGY_MAX_CARRY_USD` | Max unspent budget carried forward, default `36` |
| `STRATEGY_BOOST_ON_LOSS` | Dip boost. On by default; `false` disables it |
| `STRATEGY_BOOST_FACTOR` | Multiplier applied to the drawdown fraction, default `10` |
| `STRATEGY_MAX_BOOST` | Ceiling on the dip-boost multiplier, default `1.5` |
| `STRATEGY_OPENING_UNITS` | Units of the asset held before the bot started. Labels them instead of reporting them as unexplained; never counted in P&L |
| `COINGECKO_API_KEY` | Optional price-history fallback key |
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | Dashboard Basic auth. Required to start it; password ≥ 12 chars |
| `DASHBOARD_PORT` / `DASHBOARD_HOST` | Default `8787` / `127.0.0.1` |
| `DASHBOARD_PUBLIC_ORIGIN` | Exact origin for the transfer route's CSRF check, e.g. `https://sol.example.com`. Empty falls back to `Host` (fine on loopback) |
| `WALLET_PUBKEY` | Optional. Lets the dashboard show the wallet without loading `PRIVATE_KEY` |
| `TRANSFER_DESTINATION` | The **only** address a transfer can go to. Must be a plain wallet — validated at boot and against the chain before every send |
| `TRANSFER_ENABLED` | `true` to allow `node transfer.js`. Default `false` |
| `TRANSFER_HTTP_ENABLED` | `true` to expose the dashboard button. Default `false`; the route does not exist otherwise |
| `TRANSFER_COOLDOWN_MINUTES` | Minimum gap between transfers, default `60`. Measured from the trade log |
| `TRANSFER_MAX_PER_DAY` | Transfers per 24 h, default `2` |
| `TRANSFER_PRIORITY_FEE` | Priority fee in micro-lamports, default `20000` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Where price alerts go. In the cluster, from the `sol-swapper-telegram` Secret. The watcher will not start without both |
| `ALERTS_INTERVAL_SECONDS` | How often the watcher checks, default `60` |
| `ALERTS_REARM_PCT` | How far price must move back before a repeating alert re-arms, default `1` |
| `ALERTS_REPEAT_COOLDOWN_MINUTES` | Minimum gap between firings of one repeating alert, default `60` |

## Files

| File | Purpose |
|---|---|
| [config.js](config.js) | Mints, decimals, swap limits, strategy config |
| [wallet.js](wallet.js) | Load a keypair from `PRIVATE_KEY` |
| [query.js](query.js) | Balances, Jupiter quotes, per-token USD price, LST/SOL ratio |
| [swap.js](swap.js) | Execute a swap: quote → sign → send → confirm → log |
| [storage/index.js](storage/index.js) | Backend selection: Postgres or files |
| [storage/postgres.js](storage/postgres.js) | Postgres backend, advisory lock, sig uniqueness |
| [storage/files.js](storage/files.js) | JSONL/JSON backend, atomic writes |
| [storage/schema.sql](storage/schema.sql) | Idempotent schema |
| [transactions.js](transactions.js) | Append-only trade log |
| [state.js](state.js) | Durable strategy ledger, run lock |
| [strategy.js](strategy.js) | **Pure** decision engine — no I/O, no clock |
| [prices.js](prices.js) | Daily close history (Coinbase primary, CoinGecko fallback) |
| [run.js](run.js) | The daily orchestrator / cron entrypoint |
| [report.js](report.js) | SOL-denominated scoreboard |
| [backtest.js](backtest.js) | Replays the real strategy over history |
| [pl.js](pl.js) | FIFO USD P&L |
| [transfer.js](transfer.js) | Sweep the asset to the pinned safe wallet |
| [transfer-guard.js](transfer-guard.js) | **Pure** HTTP guards for the one write route |
| [server.js](server.js) | Dashboard HTTP server (read-only except the transfer and the alert list) |
| [alerts.js](alerts.js) | **Pure** price-alert rules: validate, evaluate, format |
| [watch.js](watch.js) | The alert watcher: prices → rules → Telegram |
| [telegram.js](telegram.js) | Telegram `sendMessage`, token scrubbed from errors |
| [alerts-cli.js](alerts-cli.js) | Add, list, remove and test alerts from a terminal |
| [auth.js](auth.js) | Constant-time Basic-auth checks |
| [public/index.html](public/index.html) | The dashboard page, self-contained |
| [Dockerfile](Dockerfile) | One image, three entrypoints |
| [k8s/](k8s/) | Manifests, secret script, deployment notes |

`strategy.js` performs no I/O and takes `now` as an argument. That's what lets
`backtest.js` run the *same* code the bot runs — if they forked, the backtest
would be measuring something that never ships.

## Caveats

- Backtests measure one asset on one historical path. The measured differences
  were inside the noise band, which argues *for* the simple design, not against.
- LSTs carry smart-contract and governance risk (the Jito and Jup pools are
  upgradeable). jupSOL and jitoSOL have never meaningfully depegged; mSOL has
  traded 1.7–2.1% below NAV in stress.
- SIMD-0550 (merged, not yet activated) would roughly halve Solana staking
  yields over ~3 years.
- Every swap is a taxable event in most jurisdictions. Buying USDC → LST
  directly (what this bot does) avoids the extra disposal that USDC → SOL → LST
  would incur.
- None of this is financial advice.
