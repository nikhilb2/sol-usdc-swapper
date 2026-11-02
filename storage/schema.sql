-- schema.sql — idempotent. Safe to run against a fresh or existing database.

CREATE TABLE IF NOT EXISTS transactions (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  type        TEXT          NOT NULL CHECK (type IN ('buy', 'sell', 'transfer_out', 'transfer_in')),
  from_sym    TEXT          NOT NULL,
  to_sym      TEXT          NOT NULL,
  from_amount NUMERIC(38,12) NOT NULL,
  to_amount   NUMERIC(38,12) NOT NULL,
  price       NUMERIC(38,12),
  sig         TEXT,
  dry_run     BOOLEAN       NOT NULL DEFAULT false,
  intent      TEXT          NOT NULL DEFAULT 'manual',
  dest        TEXT                                    -- transfers only; NULL for swaps
);

-- Existing databases: CREATE TABLE IF NOT EXISTS skips the whole block above,
-- so widening the type CHECK and adding `dest` has to happen here too. Both
-- statements are idempotent. This MUST be applied before rolling out an image
-- that can write a transfer, or the CHECK rejects the insert after the coins
-- have already moved — money gone, ledger silent.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD  CONSTRAINT transactions_type_check
  CHECK (type IN ('buy', 'sell', 'transfer_out', 'transfer_in'));
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dest TEXT;

-- The reason to be on a database at all: a confirmed on-chain signature can be
-- logged exactly once, enforced by the engine rather than by hoping the process
-- doesn't crash between confirmation and append.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_sig_uniq
  ON transactions (sig)
  WHERE sig IS NOT NULL AND dry_run = false;

CREATE INDEX IF NOT EXISTS transactions_ts_idx ON transactions (ts);

-- Single-row strategy ledger. Held as JSONB so the state shape can evolve
-- without a migration, and so strategy.js stays a pure function of a plain
-- object exactly as it is with the file backend.
CREATE TABLE IF NOT EXISTS strategy_state (
  id         INT         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily closes for the report's counterfactual. PK on date gives dedupe for
-- free via ON CONFLICT DO NOTHING.
CREATE TABLE IF NOT EXISTS prices (
  date       DATE          PRIMARY KEY,
  close      NUMERIC(38,12) NOT NULL,
  source     TEXT,
  fetched_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Price alerts. Notification only: nothing reads this table to trade.
--
-- `armed` and `active` are separate on purpose. A one-shot alert that has
-- fired is inactive and kept, so the page can show what triggered. A repeating
-- alert that has fired stays active but disarmed until price retreats.
--
-- Rolling out the image that reads this table BEFORE migrating breaks the
-- dashboard's alerts card and crash-loops the watcher. Neither touches funds,
-- but run the migrate job first all the same.
CREATE TABLE IF NOT EXISTS price_alerts (
  id            BIGSERIAL      PRIMARY KEY,
  symbol        TEXT           NOT NULL,
  op            TEXT           NOT NULL CHECK (op IN ('above', 'below')),
  target        NUMERIC(38,12) NOT NULL CHECK (target > 0),
  repeat        BOOLEAN        NOT NULL DEFAULT false,
  note          TEXT,
  active        BOOLEAN        NOT NULL DEFAULT true,
  armed         BOOLEAN        NOT NULL DEFAULT true,
  fire_count    INT            NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
  last_fired_at TIMESTAMPTZ,
  -- Written by the watcher every tick, so the page can tell a quiet alert
  -- from a dead watcher.
  last_price    NUMERIC(38,12),
  checked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS price_alerts_active_idx ON price_alerts (active);
