# Khant Hman Prediction Market — Implementation Roadmap

Status legend: **Completed** · **Partially completed** · **Not started** · **Blocked**

Financial rules in this roadmap are fixed by the product brief and are not open to invention:
binary YES/NO, winning share pays **100 Pyas**, losing share pays **0**, prices are integer Pyas
in **[1, 99]**, quantities are positive integers, **1 MMK = 100 Pyas**, integer arithmetic only,
fully collateralised (no naked shorts), append-only double-entry ledger, virtual credits only.

## Stage 0 — Repository audit — Completed
`docs/AUDIT.md`. Clean branch from verified `chatgpt/m1-ui-overhaul` state, findings, risks,
prioritised plan.

## Stage 1 — Frontend quality — Partially completed
Done so far:
- Financial UI copy uses Pyas consistently (no cent glyph, no bogus `₭` symbol in amounts).
- Centralised, typed translations for every string rendered by the shell (no hardcoded UI copy).
- Server-set `<html lang>` per locale (correct for assistive tech on first paint).
- Locale-preserving navigation helper (`/en/...` ↔ `/my/...`) instead of hard page reloads.
- Accessibility: focus-visible rings on carousel/menu controls, dialog focus trap + focus restore,
  Escape handling, labelled live regions.

Remaining:
- Split `HomePage` into components; memoise market rows; virtualise when the catalogue exceeds ~100.
- Real market detail route `/en/market/[id]` fed by the API instead of an inline panel.
- Loading/error/empty states bound to real fetches; skeletons instead of layout shift.
- Bundle and paint budget checks in CI (`next build` route size budget).
- Burmese typography pass for long titles, and reduced-motion support for the starfield.

## Stage 2 — Backend foundation — Partially completed
Done so far:
- Dialect-neutral SQL executor with `pg` (production) and PGlite (tests/local) adapters.
- Versioned SQL migrations + idempotent runner (`schema_migrations`).
- Schema v1: users, sessions, user_preferences, market_categories, markets, market_rules,
  orders, trades, positions, ledger_accounts, ledger_journals, ledger_entries, account_balances,
  idempotency_keys, audit_logs.
- Integer-Pyas money module (parse/format/validate, MMK ↔ Pyas, Myanmar digits).
- scrypt password hashing with timing-safe verification and explicit cost parameters.
- Server-side sessions: opaque random token, only SHA-256 hash stored, rotating on login,
  revocable, expiry-enforced, secure cookie attributes.
- Zod request validation at the boundary; typed domain errors mapped to HTTP status.
- `requireUser` / `requireRole` RBAC helpers.

Remaining:
- Route handlers for register/login/logout/session and market reads, wired to the UI.
- Rate limiting for auth endpoints; audit-log writes on auth events.
- CSRF strategy for cookie-authenticated mutations (double-submit token).

## Stage 3 — Market engine — Partially completed
Done so far:
- Market lifecycle state machine (`draft → pending_review → open → closed → proposed →
  disputed → resolved/voided`) as a pure, tested transition table with actor permissions.
- Schema-level market, rules, category and resolution-source tables.

Remaining:
- Market creation + review workflow, admin endpoints, search (trigram/pg FTS), category feeds.
- Public read API and RSC pages replacing the sample array.

## Stage 4 — Financial engine — Partially completed
Done so far (documented in `docs/FINANCIAL-SPEC.md`, tested):
- Double-entry ledger: balanced-journal enforcement at write time **and** a DB-level check,
  append-only (no UPDATE/DELETE permitted), reconciliation query.
- User cash accounts, reserved cash, position accounts, market escrow, system equity.
- Order placement with collateral reservation for buys and share reservation for sells,
  inside one transaction, with row locks and conditional updates.
- Order cancellation releasing exactly the remaining reservation; partial fills supported.
- Idempotency keys so retried requests cannot duplicate financial effects.
- Position accounting with integer cost basis and realised P/L.

Not started (deliberately, pending a written matching specification):
- Price-time priority matching, mint/merge of complete sets, complementary YES/NO cross-matching,
  maker-price execution, order expiration, fee policy.

## Stage 5 — Resolution and disputes — Partially completed
- Lifecycle states and schema placeholders; typed resolution/dispute tables planned.
Remaining: proposals, evidence, disputes, reviewer decisions, finalisation with payout journals.

## Stage 6 — QA and security — Partially completed
- `node:test` suite covering money, ledger, reservations, concurrency, auth, schema constraints.
Remaining: E2E (Playwright), accessibility automation, load tests, dependency review cadence.

## Stage 7 — Launch preparation — Not started
Requires explicit owner approval: environment docs, migrations runbook, backup/restore rehearsal,
monitoring, incident response. No deployment is performed by this branch.
