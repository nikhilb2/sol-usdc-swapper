# SOL accumulation strategy — full description

A self-contained explanation of what this bot does and why, written so someone
with no access to the codebase can evaluate or critique it.

---

## 1. Objective

**Accumulate SOL-denominated units over a multi-year horizon using a small,
fixed stream of new dollars (~$13/day, ~$4,750/yr).**

The scoreboard is *SOL*, not USD. The question the system tries to answer is
not "did I make money" (that is mostly just SOL's price) but "did this rule end
up holding more SOL than the obvious alternative — buying bare SOL with the
same dollars on a flat schedule?"

Everything below follows from taking that question seriously, including the
decision to make the trading rule as close to trivial as possible.

---

## 2. Why the strategy is deliberately boring

The original design was an adaptive DCA (buy more when statistically cheap,
skip when expensive) plus a sell-high / rebuy-lower swing sleeve. Both were
backtested on 1,000 daily SOL closes (2023-12 → 2026-08 — covering the 2024
bull run, the 2025 drawdown, and the 2026 recovery), then re-tested
independently across 8 other assets over the same window.

| Idea tested | Result |
|---|---|
| z-score DCA tiers (buy more below mean, less above) | t = 0.15 across 9 assets — indistinguishable from noise |
| Sell-high / rebuy-lower swing sleeve | t ≈ −2.5, won only 3 of 18 asset/config pairs — a real effect, and *negative* |
| Block bootstrap, 500 resamples | every variant p > 0.13; family-wise p = 0.22 for the best of 9 |

Two conclusions were load-bearing for the final design:

1. **Fixed-dollar buying is already price-aware.** $13 at a $100 price buys
   twice the SOL that $13 at $200 does. Layering a z-score on top of that
   mostly just idles cash, and idle cash in an uptrend is SOL you didn't buy.
2. **Trade count is inversely correlated with SOL kept.** In the swing grid,
   29 round trips → −4.8%; 17 round trips → +1.6%, monotonically in between.
   Overtrading losing money was the single most reliable effect in the dataset.

Any apparent winner turned out to be a cash-holding rule being rewarded because
SOL's final price happened to sit ~25% below its period mean — i.e. short beta
dressed up as skill.

**Conclusion: there is no timing edge available at this size.** What does
reliably add SOL is staking yield, so the strategy spends its complexity budget
on custody, correctness, and honest measurement instead of on the entry rule.

---

## 3. What actually adds SOL: holding a liquid staking token

Instead of holding bare SOL, the bot buys and holds a **liquid staking token
(LST)** — a token that appreciates against SOL as staking rewards accrue.

Realized trailing-12-month SOL-denominated yield, measured 2026-08-28:

| LST | realized 12mo | note |
|---|---|---|
| **jupSOL** | **6.30%** | current default |
| mSOL | 6.19% | |
| jitoSOL | 5.80% | deepest liquidity, tightest NAV tracking |
| bnSOL | 5.31% | |

The sharper framing: SOL's supply inflates ~3.68%/yr and essentially all of
that issuance goes to stakers. An unstaked holder therefore *loses supply share
every year*. The real choice is not "+6% or 0%" — it is "+6% or −3.7% relative
to the network".

Purchases go **USDC → LST directly** (not USDC → SOL → LST): one swap instead
of two, so cheaper in fees and cleaner for tax accounting.

---

## 4. The trading rule

### 4.1 Budget accrual

- A budget accrues **$13/day** (`STRATEGY_DAILY_USD`), keyed on the UTC date so
  running the bot twice in one day cannot accrue twice.
- Unspent budget **carries forward** up to a cap (`STRATEGY_MAX_CARRY_USD`,
  default $36; the effective ceiling is `maxCarry + cadence_days × daily`).
- The carry cap is kept tight on purpose: idle cash is an unintentional
  short-beta bet, and in the audit this one parameter silently controlled most
  of the outcome variance.
- Cadence is **daily** by default. Weekly tested marginally better and creates
  7× fewer taxable events; it's a config flip, not a different code path.

### 4.2 The rails (every gate that can stop a buy)

Each run evaluates all of these and prints them, even after one fails, so the
`--explain` output shows the whole picture rather than stopping at the first no:

| Rail | Blocks the buy when |
|---|---|
| `ENABLED` | the strategy is switched off |
| `NO_PENDING_INTENT` | a previous swap is unresolved (crash recovery pending) |
| `BUY_DAY` | weekly cadence and today isn't the target weekday |
| `NOT_BOUGHT_TODAY` | a buy already happened on this UTC date (idempotency) |
| `USDC_AVAILABLE` | wallet USDC is below the $5 minimum trade size |
| `MIN_TRADE_SIZE` | the computed spend is below $5 (dust trades get eaten by fees) |
| `GAS_RESERVE` | wallet SOL is below 0.05 SOL, the fee reserve |
| `DIP_BOOST` | *never blocks* — it only sizes the trade (shown for transparency) |

Spend is computed as:

```
want      = carryUsd × boost
spend     = min(want, wallet USDC balance)
```

**The wallet balance is the hard constraint; banked carry is only an
intention.** The bot can never spend money it doesn't have.

There is deliberately **no `--force` flag**. Every rail exists to stop a trade
that shouldn't happen, and an override is exactly what you'd reach for at the
moment your judgement is worst. Behaviour changes go through visible config.

### 4.3 The dip boost — the only non-flat rule

When **total P&L** (realized + unrealized, as a percentage of net USD deployed)
is negative, the next buy is multiplied by:

```
multiplier = min(1 + (drawdown_fraction × BOOST_FACTOR), MAX_BOOST)
```

At the defaults (factor 10, cap 1.5×):

| Total P&L | Buy size |
|---|---|
| 0% or better | 1.00× |
| −2% | 1.20× |
| −5% | 1.50× (cap reached) |
| −10% | 1.50× (capped) |
| −50% | 1.50× (capped) |

**The cap is the entire point.** Without it, a 50% drawdown would ask for a 6×
buy at exactly the moment the wallet can least afford it — a martingale sized
by the crash itself. At 1.5× the boost is fully in effect by a 5% drawdown and
never grows past it, so a bad enough decline cannot escalate the position.

Two honest caveats, stated in the code and the docs:

1. **This is averaging down, not a timing edge.** The backtest found no timing
   edge and this rule does not create one. It is not a claim that drawdowns
   predict returns. What it does is put more dollars in at lower prices, which
   lowers average cost per unit and *raises total exposure*. That cuts both
   ways, and it is a concentrated bet on this asset, not evidence of skill.
2. **It spends money the budget never accrued.** Carry floors at zero, so a
   boosted buy draws on dollars the daily rate never banked. Lifetime `spent`
   drifts above lifetime `accrued`, and that gap is precisely where "the same
   capital, spread evenly" stops describing what's happening. If the wallet is
   only funded at the flat daily rate, the boost is silently clamped to
   whatever USDC is there and does nothing.

The boost is scored separately in the backtest, **per dollar deployed**, never
against the flat baseline in absolute SOL — because it deploys more capital, so
of course it ends with more SOL. That comparison would measure the size of the
cheque, not the quality of the rule. The question a dip-buying rule must answer
is whether *each dollar* bought more SOL than the same dollar spread evenly.

---

## 5. Measurement — the part the effort actually went into

### 5.1 Two benchmarks, because one number hides a failure mode

- **Same capital (primary)** — take the exact dollars actually deployed and
  spread them evenly across the same window. Isolates the *decision* from how
  much got funded, and cannot be gamed by under-deploying.
- **Same schedule** — $13 every single day regardless. This is where days
  missed to an empty wallet or a sleeping machine show up as a real cost.

Banked-but-unspent cash is valued at the final price and **counted in the
benchmark** — omitting it is exactly how a cash-hoarding rule fakes a good
result. It is deliberately **excluded from P&L**, because P&L asks "did the
position I bought go up?" and cash is not a position.

The benchmark window ends at the last real buy, not today, so the counterfactual
doesn't get free days the bot never had a chance to trade.

### 5.2 The backtest runs the production code

`backtest.js` imports `decide()` and `applyAction()` from the live strategy
module rather than reimplementing them. If the two ever forked, the backtest
would be measuring code the bot doesn't run — the most common way a backtest
lies. With the boost off, the backtest must reproduce flat DCA *exactly*; that
equality is the harness's own correctness check and prints as a pass/fail line.

### 5.3 Attribution: the log defines the position, the wallet defines the reconciliation

The wallet is a real address and may hold units the bot never bought (a
pre-existing bag, a manual swap, an inbound transfer). Units the bot didn't buy
have **no cost basis it can know**, so they never enter P&L or the benchmark.

```
wallet holds     18.481203 JUPSOL   ← the chain
bot-attributed   12.481203          ← the trade log; every figure uses this
opening balance   6.000000          ← human-declared
unexplained       0.000000          ✅ reconciled
```

Mixing them is not a rounding error: an undeclared bag measured against capital
the bot really deployed reads as free profit, and a transfer out reads as a
catastrophic loss. Anything unexplained past a 2% tolerance raises a banner.

P&L itself is **USD FIFO** over the swap log.

---

## 6. Custody: moving the position to a safer wallet

The bot's signing key lives in an internet-facing pod. Past a certain position
size you want the coins elsewhere, so there's a sweep to a pinned safe wallet.

The design constraint that matters: **the destination is pinned in config and
can never be supplied by a request.** The worst an attacker with the dashboard
password can do is force the coins into the owner's own safe wallet and burn a
few cents of fees — griefing, not theft. A cooldown and a daily cap bound even
that. There is no `TRANSFER_ASSET` setting, because one that could be set to
USDC would turn a custody button into a way to move working capital.

**A move is a custody change, not a sale.** The units are still yours, so they
keep their cost basis and stay in the position. Every P&L and benchmark figure
is bit-identical before and after a move; only the reconciler changes, because
it stops expecting those units in this wallet.

This is not cosmetic: the dip boost is sized from P&L, so if moving coins to
cold storage reset the P&L, *putting your money somewhere safe would silently
change how much the bot buys tomorrow*. It doesn't, and a test asserts it.

---

## 7. Operational safety properties

| Property | Mechanism |
|---|---|
| Can't double-buy | idempotent on the UTC date in persisted state |
| Can't run twice concurrently | run lock (Postgres advisory lock, or file lock with stale takeover) |
| Survives a crash mid-swap | intent written *before* the swap, reconciled against the trade log next run |
| Can't spend money it doesn't have | wallet balance is the hard cap |
| Can't strand itself without gas | refuses to trade below the 0.05 SOL reserve |
| Never guesses | an ambiguous crash **halts and asks** rather than inventing a ledger entry |
| Confirmed signature logged once | partial unique index on the signature (Postgres backend) |

Swap execution goes through Jupiter with 0.5% slippage tolerance and an abort
above 1.0% quoted price impact. The dashboard is read-only with respect to
trading — **there is no endpoint that can trigger a swap**, because a "buy now"
button is precisely the impulse the rails exist to stop.

---

## 8. Current parameters

| Parameter | Default | Meaning |
|---|---|---|
| asset | `JUPSOL` | what gets accumulated |
| quote | `USDC` | funding currency |
| daily budget | `$13` | accrual rate |
| cadence | `daily` | or `weekly` (Mondays) |
| max carry | `$36` | unspent budget ceiling |
| boost on loss | `on` | dip boost enabled |
| boost factor | `10` | multiplier on the drawdown fraction |
| max boost | `1.5×` | hard ceiling on the multiplier |
| take-profit | `off` | sell when P&L reaches the threshold |
| take-profit threshold / size / cooldown | `+10%` / `10%` / `30d` | |
| min trade size | `$5` | dust floor |
| slippage tolerance | `50 bps` | |
| max price impact | `1.0%` | abort threshold |
| SOL gas reserve | `0.05 SOL` | never spent |

---

## 9. Known limitations and open questions

Stated plainly, since these are the things worth arguing about:

- **Single-asset concentration.** This is an unhedged, leveraged-by-conviction
  bet on Solana. No diversification rule exists, by choice.
- **LST-specific risk.** jupSOL adds validator/pool/smart-contract risk and NAV
  depeg risk on top of SOL price risk, in exchange for ~6.3%/yr. jitoSOL has
  deeper liquidity and tighter NAV tracking at ~0.5%/yr less yield — a defensible
  alternative trade-off.
- **The exit rule is optional and off by default.** A take-profit
  (`STRATEGY_TAKE_PROFIT`) sells 10% of the position when total P&L reaches
  +10%, then not again for 30 days; proceeds stay as USDC and never
  redeploy. Unlike the rejected swing sleeve it never buys back, so it is a
  slow de-risking into cash, not a round trip. On 1,000 days (2024-01 →
  2026-10) it beat DCA by +8.6% in SOL terms, and beat the same sales on
  random days (p ≈ 0.04) — but SOL ended ~26% below its period mean, which
  is the path where holding cash wins. Across rolling 365-day windows it won
  17 of 22, worst −16%. Run `node backtest-takeprofit.js` before enabling.
- **The dip boost is the one unfalsified rule.** It survived on reasoning
  ("more dollars at lower prices") rather than on evidence, and it is the piece
  most likely to be wrong. Its cap is what makes being wrong survivable.
- **The boost's backtest number is an upper bound.** The simulation assumes an
  always-funded wallet; a real wallet funded at exactly $13/day would have most
  boosts clamped away by the `USDC_AVAILABLE` rail.
- **~1,000 days of history is one market cycle**, on one asset, and the strategy
  parameters were chosen after looking at it. The p-values above argue *against*
  the rejected rules, which is the direction that survives that critique — but
  they are not independent validation of the surviving one.
