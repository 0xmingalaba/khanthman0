# Nan Htauk Prediction Market

A Myanmar-focused prediction market, built as a Next.js + TypeScript modular monolith on
PostgreSQL. **Virtual credits only** — no real money, no deposits, no withdrawals.

## Status

| Stage | State |
| --- | --- |
| Repository audit | Completed — `docs/AUDIT.md` |
| Frontend (discovery, market detail, portfolio, auth) | Completed for the current scope |
| Backend foundation (DB, migrations, auth, API) | Completed |
| Market engine (lifecycle, reads) | Partially — creation/review/admin not built |
| Financial engine | Partially — see below |
| Resolution, disputes, payout | **Not started, by design** — `docs/RESOLUTION-DESIGN.md` |
| Launch preparation | Not started — `docs/PRODUCTION-READINESS.md` |

### What works end to end

- Registration, login, logout, server-side sessions with hashed tokens.
- Market discovery with real order-book-derived prices, search, categories, sorting.
- Market detail with description, rules, resolution criteria, cited sources, both order books.
- **Fully collateralised limit orders**: buy orders reserve `price × quantity` Pyas, sell orders
  escrow owned shares, cancellation releases exactly the remaining reservation.
- Settlement of a trade between two resting orders, atomically, with cost basis and realised P/L.
- Portfolio with ledger-derived balances and positions.
- Burmese and English UI throughout, integer-Pya formatting, Myanmar time.

### What deliberately does not work yet

- **Order matching.** Orders rest in the book; nothing crosses them automatically. The matching
  policy (maker vs taker price, complementary YES/NO cross-matching) is not yet specified by the
  product owner, so it is not guessed.
- **Minting and merging complete sets.** Not implemented; requires a collateral and fee decision.
- **Resolution payout and disputes.** The lifecycle state machine and schema groundwork exist, and
  the payout journal is specified in ADR-003, but no payout is written. A resolved market
  therefore does not yet pay holders.
- **Unrealised P/L.** Requires an approved mark-price rule; the UI says so rather than estimating.

The UI never presents any of the above as working.

## Requirements

- Node.js 22+
- PostgreSQL 15+ for production, **or** PGlite (embedded, WASM) for local development

## Local development

```bash
npm install

# Option A: embedded database (no external service)
MINGALA_DB=pglite npm run db:seed
MINGALA_DB=pglite npm run dev

# Option B: real PostgreSQL
cp .env.example .env.local     # then set DATABASE_URL
npm run db:migrate
npm run db:seed                # development fixtures only
npm run dev
```

Open http://localhost:3000 (redirects to `/my`).

Seed accounts exist only when `db:seed` is run explicitly:
`demo@dev.mingala.local`, `maker@dev.mingala.local`, `resolver@dev.mingala.local`,
`admin@dev.mingala.local`, all with password `mingala-dev-password-2026`.

## Validation

```bash
npm run typecheck          # strict TypeScript, no suppressions
npm test                   # unit: money, formatting, lifecycle, auth primitives, schemas
npm run test:integration   # real Postgres transactions via PGlite
npm run build              # production build
```

Integration tests run against PGlite, which is PostgreSQL compiled to WASM, using the same
migrations and the same domain code as production. They therefore exercise real constraint
triggers, deferred journal-balance checks and row locking, not mocks.

## Architecture

```
app/                 routing, server components, API route handlers (thin)
src/lib/             money (integer Pyas), errors, schemas, locale, api client
src/db/              executor interface, pg + pglite adapters, migrations, seed
src/domain/          ledger, trading, reservations, lifecycle, markets, accounts
src/auth/            scrypt passwords, hashed sessions, RBAC
src/components/      UI components
src/i18n/            typed bilingual dictionary
tests/               unit + integration (node:test)
docs/                audit, roadmap, financial spec, ADRs, readiness
```

Key decisions:

1. **Integer Pyas everywhere.** Money never touches a float. Prices are 1–99 Pyas; a winning
   share pays 100 Pyas; 1 MMK = 100 Pyas.
2. **Append-only double-entry ledger.** Journals and entries reject UPDATE/DELETE/TRUNCATE by
   trigger, every journal must balance per asset (enforced by a deferred constraint trigger), and
   balances are written *only* by an entry trigger, so a balance can never disagree with the
   entries that produced it.
3. **The ledger owns shares too**, not just cash. Share ownership is an account, so "no naked
   short selling" is a balance constraint rather than a code convention.
4. **Reservations are ledger facts.** Collateral locks, share escrow and their release are all
   journals, so cancellation and partial fills are auditable rather than a mutable column.
5. **One driver interface, two adapters.** Production uses `pg`; tests and local development use
   PGlite. Same SQL, same transactional semantics.
6. **Explicit authorisation.** Route protection is requested per route, never inferred from the
   HTTP method, and the acting user always comes from the session, never from the request body.

## Documentation

- `docs/AUDIT.md` — what existed, what was wrong, prioritised risks
- `docs/FINANCIAL-SPEC.md` — the accounting rules actually implemented, and those deliberately not
- `docs/RESOLUTION-DESIGN.md` — payout and dispute design, with the decisions that block it
- `docs/PRODUCTION-READINESS.md` — configuration, gaps, backup and incident response
- `docs/ROADMAP.md` — staged plan with honest status

## Licence and honesty note

Nan Htauk is a simulation using virtual credits. It is not a licensed exchange, it does not handle
real money, and the balances it shows have no cash value.
