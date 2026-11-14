-- Mingala schema v1
--
-- Conventions
--   * All money is integer Pyas in BIGINT. Never NUMERIC/FLOAT for money.
--   * 1 MMK = 100 Pyas. A winning share pays 100 Pyas.
--   * Timestamps are UTC (timestamptz). Display conversion happens in the UI.
--   * The ledger is the single source of truth for balances, including shares.
--     `positions` stores cost basis / realised P&L for reporting only.
--   * Append-only tables reject UPDATE, DELETE and TRUNCATE via triggers.
--   * account_balances is written *only* by an entry trigger, so a balance can
--     never disagree with the sum of its ledger entries.
--
-- TRANSACTION OWNERSHIP
--   This file contains NO BEGIN/COMMIT. The migration runner (src/db/migrate.ts)
--   owns exactly one transaction per file and records the version inside it, so a
--   failure rolls back both the DDL and the schema_migrations row. Do not add
--   transaction control here: a COMMIT inside a runner-managed transaction ends
--   the outer transaction early and silently destroys atomicity.
-- ---------------------------------------------------------------------------
-- Users and sessions
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  password_algo   TEXT NOT NULL DEFAULT 'scrypt-v1',
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user', 'creator', 'resolver', 'moderator', 'admin')),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'closed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT users_email_shape CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT users_display_name_len CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 60)
);

CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    BYTEA NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  user_agent    TEXT,
  CONSTRAINT sessions_token_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE user_preferences (
  user_id     UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  locale      TEXT NOT NULL DEFAULT 'my' CHECK (locale IN ('my', 'en')),
  timezone    TEXT NOT NULL DEFAULT 'Asia/Yangon',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Markets
-- ---------------------------------------------------------------------------

CREATE TABLE market_categories (
  id          TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,30}$'),
  name_en     TEXT NOT NULL,
  name_my     TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE markets (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                    TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,120}$'),
  category_id             TEXT NOT NULL REFERENCES market_categories (id),
  question_en             TEXT NOT NULL CHECK (char_length(question_en) BETWEEN 8 AND 240),
  question_my             TEXT NOT NULL CHECK (char_length(question_my) BETWEEN 8 AND 240),
  description_en          TEXT NOT NULL,
  description_my          TEXT NOT NULL,
  rules_en                TEXT NOT NULL,
  rules_my                TEXT NOT NULL,
  resolution_criteria_en  TEXT NOT NULL,
  resolution_criteria_my  TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'pending_review', 'open', 'closed',
                                            'proposed', 'disputed', 'resolved', 'voided')),
  outcome                 TEXT CHECK (outcome IN ('YES', 'NO')),
  creator_id              UUID REFERENCES users (id),
  resolver_id             UUID REFERENCES users (id),
  opens_at                TIMESTAMPTZ,
  close_at                TIMESTAMPTZ NOT NULL,
  resolved_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  version                 INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT markets_close_after_open CHECK (opens_at IS NULL OR close_at > opens_at),
  CONSTRAINT markets_outcome_requires_resolved
    CHECK (outcome IS NULL OR status = 'resolved')
);

CREATE INDEX markets_status_close_idx ON markets (status, close_at);
CREATE INDEX markets_category_idx ON markets (category_id, status);

CREATE TABLE market_sources (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id   UUID NOT NULL REFERENCES markets (id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  url         TEXT NOT NULL CHECK (url ~ '^https://'),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX market_sources_market_idx ON market_sources (market_id, sort_order);

-- ---------------------------------------------------------------------------
-- Ledger accounts
-- ---------------------------------------------------------------------------

CREATE TABLE ledger_accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type  TEXT NOT NULL CHECK (owner_type IN ('user', 'market', 'system')),
  owner_id    UUID,
  -- 'PYA' for money, or 'SHARE:<market uuid>:<YES|NO>' for a share class.
  asset       TEXT NOT NULL
              CHECK (asset = 'PYA' OR asset ~ '^SHARE:[0-9a-f-]{36}:(YES|NO)$'),
  kind        TEXT NOT NULL CHECK (kind IN (
                'cash_available', 'cash_reserved',
                'shares_available', 'shares_reserved',
                'escrow_shares', 'escrow_payout', 'system_equity', 'system_issued')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_owner_present
    CHECK ((owner_type = 'system' AND owner_id IS NULL)
        OR (owner_type <> 'system' AND owner_id IS NOT NULL)),
  CONSTRAINT ledger_accounts_asset_matches_kind
    CHECK ((kind IN ('cash_available', 'cash_reserved', 'escrow_payout', 'system_equity')
            AND asset = 'PYA')
        OR (kind IN ('shares_available', 'shares_reserved', 'escrow_shares', 'system_issued')
            AND asset LIKE 'SHARE:%')),
  -- Ownership model: users hold cash and their own shares; the market holds
  -- escrowed shares and payout collateral; the system holds only equity.
  CONSTRAINT ledger_accounts_kind_matches_owner
    CHECK ((kind IN ('escrow_shares', 'escrow_payout') AND owner_type = 'market')
        OR (kind IN ('system_equity', 'system_issued') AND owner_type = 'system')
        OR (kind IN ('cash_available', 'cash_reserved', 'shares_available', 'shares_reserved')
            AND owner_type = 'user'))
);

CREATE UNIQUE INDEX ledger_accounts_identity_key
  ON ledger_accounts (
    owner_type,
    COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid),
    asset,
    kind
  );

-- ---------------------------------------------------------------------------
-- Ledger journals and entries (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE ledger_journals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL CHECK (kind IN (
                'grant', 'order_reserve', 'order_release',
                'trade_settlement', 'resolution_payout', 'void_refund', 'correction')),
  actor_id    UUID REFERENCES users (id),
  ref_type    TEXT,
  ref_id      UUID,
  memo        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_journals_created_idx ON ledger_journals (created_at DESC);
CREATE INDEX ledger_journals_ref_idx ON ledger_journals (ref_type, ref_id);

CREATE TABLE ledger_entries (
  id          BIGSERIAL PRIMARY KEY,
  journal_id  UUID NOT NULL REFERENCES ledger_journals (id),
  account_id  UUID NOT NULL REFERENCES ledger_accounts (id),
  delta       BIGINT NOT NULL CHECK (delta <> 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_journal_idx ON ledger_entries (journal_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id);

-- Materialised balances. Only the trigger below may write this table.
CREATE TABLE account_balances (
  account_id  UUID PRIMARY KEY REFERENCES ledger_accounts (id),
  kind        TEXT NOT NULL,
  asset       TEXT NOT NULL,
  balance     BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Sign model (positive = debit):
  --   user cash / user shares / market share escrow / market payout escrow are
  --   all debit balances and can never go negative. The platform cannot spend,
  --   lend or escrow what it does not hold.
  --   `system_equity` (issued Pyas) and `system_issued` (issued shares) are the
  --   credit side of the same assets and are therefore never positive.
  CONSTRAINT account_balances_non_negative
    CHECK (kind IN ('system_equity', 'system_issued') OR balance >= 0),
  CONSTRAINT account_balances_equity_not_positive
    CHECK (kind <> 'system_equity' OR balance <= 0),
  CONSTRAINT account_balances_issued_shares_not_positive
    CHECK (kind <> 'system_issued' OR balance <= 0)
);

-- A journal must balance per asset. Enforced at COMMIT time so a multi-entry
-- journal can be inserted statement by statement.
CREATE FUNCTION mingala_assert_journal_balanced() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  unbalanced BIGINT;
BEGIN
  SELECT count(*) INTO unbalanced
  FROM (
    SELECT a.asset
    FROM ledger_entries e
    JOIN ledger_accounts a ON a.id = e.account_id
    WHERE e.journal_id = NEW.journal_id
    GROUP BY a.asset
    HAVING sum(e.delta) <> 0
  ) per_asset;

  IF unbalanced > 0 THEN
    RAISE EXCEPTION 'ledger journal % is not balanced per asset', NEW.journal_id;
  END IF;

  IF (SELECT count(*) FROM ledger_entries WHERE journal_id = NEW.journal_id) < 2 THEN
    RAISE EXCEPTION 'ledger journal % must have at least two entries', NEW.journal_id;
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_journal_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mingala_assert_journal_balanced();

CREATE FUNCTION mingala_apply_entry_to_balance() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE account_balances
     SET balance = balance + NEW.delta,
         updated_at = now()
   WHERE account_id = NEW.account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no balance row for ledger account %', NEW.account_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entries_apply_balance
  AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION mingala_apply_entry_to_balance();

CREATE FUNCTION mingala_forbid_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only and rejects %', TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION mingala_forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION mingala_forbid_mutation();

CREATE TRIGGER ledger_journals_append_only
  BEFORE UPDATE OR DELETE ON ledger_journals
  FOR EACH ROW EXECUTE FUNCTION mingala_forbid_mutation();
CREATE TRIGGER ledger_journals_no_truncate
  BEFORE TRUNCATE ON ledger_journals
  FOR EACH STATEMENT EXECUTE FUNCTION mingala_forbid_mutation();

CREATE TRIGGER account_balances_no_delete
  BEFORE DELETE ON account_balances
  FOR EACH ROW EXECUTE FUNCTION mingala_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Orders, trades, positions
-- ---------------------------------------------------------------------------

CREATE TABLE orders (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id          UUID NOT NULL REFERENCES markets (id),
  user_id            UUID NOT NULL REFERENCES users (id),
  side               TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
  action             TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),
  price_pya          INTEGER NOT NULL CHECK (price_pya BETWEEN 1 AND 99),
  quantity           BIGINT NOT NULL CHECK (quantity >= 1),
  remaining_quantity BIGINT NOT NULL CHECK (remaining_quantity >= 0),
  -- For BUY orders: Pyas still reserved. For SELL orders: shares still reserved.
  reserved_units     BIGINT NOT NULL CHECK (reserved_units >= 0),
  status             TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'filled', 'cancelled', 'expired')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at          TIMESTAMPTZ,
  CONSTRAINT orders_remaining_within_quantity CHECK (remaining_quantity <= quantity),
  CONSTRAINT orders_filled_has_no_remainder
    CHECK (status <> 'filled' OR remaining_quantity = 0),
  -- A reservation can never exceed what the remaining size requires. It may be
  -- lower only because a fill released price improvement (buy limit above the
  -- execution price), so the ledger stays the authority and the order mirrors it.
  CONSTRAINT orders_reservation_within_limit
    CHECK ((action = 'BUY' AND reserved_units <= remaining_quantity * price_pya)
        OR (action = 'SELL' AND reserved_units = remaining_quantity)),
  CONSTRAINT orders_reserved_non_negative CHECK (reserved_units >= 0),
  CONSTRAINT orders_closed_flag
    CHECK ((status = 'open' AND closed_at IS NULL) OR (status <> 'open' AND closed_at IS NOT NULL))
);

CREATE INDEX orders_book_idx ON orders (market_id, side, action, status, price_pya);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);
CREATE INDEX orders_open_idx ON orders (market_id, status) WHERE status = 'open';

CREATE TABLE trades (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id      UUID NOT NULL REFERENCES markets (id),
  side           TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
  price_pya      INTEGER NOT NULL CHECK (price_pya BETWEEN 1 AND 99),
  quantity       BIGINT NOT NULL CHECK (quantity >= 1),
  buy_order_id   UUID NOT NULL REFERENCES orders (id),
  sell_order_id  UUID NOT NULL REFERENCES orders (id),
  buyer_id       UUID NOT NULL REFERENCES users (id),
  seller_id      UUID NOT NULL REFERENCES users (id),
  journal_id     UUID NOT NULL REFERENCES ledger_journals (id),
  executed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trades_distinct_parties CHECK (buyer_id <> seller_id)
);

CREATE INDEX trades_market_idx ON trades (market_id, executed_at DESC);
CREATE INDEX trades_journal_idx ON trades (journal_id);

-- Cost basis and realised P&L only. Balances live in the ledger.
CREATE TABLE positions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users (id),
  market_id          UUID NOT NULL REFERENCES markets (id),
  side               TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
  cost_basis_pya     BIGINT NOT NULL DEFAULT 0 CHECK (cost_basis_pya >= 0),
  realised_pnl_pya   BIGINT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT positions_unique UNIQUE (user_id, market_id, side)
);

-- ---------------------------------------------------------------------------
-- Idempotency and audit
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key           TEXT NOT NULL CHECK (char_length(key) BETWEEN 8 AND 100),
  endpoint      TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  response_json JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

CREATE TABLE audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  actor_id     UUID REFERENCES users (id),
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_hash      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id);

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION mingala_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Seed reference data
-- ---------------------------------------------------------------------------

INSERT INTO market_categories (id, name_en, name_my, sort_order) VALUES
  ('myanmar',    'Myanmar',    'မြန်မာ',        1),
  ('economy',    'Economy',    'စီးပွားရေး',    2),
  ('crypto',     'Crypto',     'ခရစ်ပတို',      3),
  ('world',      'World',      'ကမ္ဘာ',         4),
  ('sports',     'Sports',     'အားကစား',       5),
  ('technology', 'Technology', 'နည်းပညာ',       6);
