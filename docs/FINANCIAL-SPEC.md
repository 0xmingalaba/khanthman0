# ADR-002 — Financial Specification (Virtual Credits, Integer Pyas)

Status: **Accepted for the operations implemented in this stage.**
Anything not described here is **not implemented** and must not be inferred from the UI.

> **Documentation corrected 2026-11-14 (correction phase).** Three statements in the
> original text did not match the code and have been fixed below: the ledger identity
> is enforced by `assertReconciled` (not `assertLedgerBalanced`), signup idempotency
> comes from the unique index on `users.email` (there is no `(user, kind)` constraint),
> and `system:clearing` does not exist in the schema. Section 10 records the numbering
> gap for ADR-001.

## 1. Units

| Concept | Rule |
| --- | --- |
| Money unit | Pya. `1 MMK = 100 Pyas` exactly. |
| Storage | `bigint` integers. No `numeric`, no `float`, no `double`. |
| Share price | Integer Pyas in `[1, 99]`. A YES price of `p` implies a NO price of `100 - p`. |
| Share quantity | Positive integer, `>= 1`. |
| Share payout | A winning share pays exactly **100 Pyas**; a losing share pays **0**. |
| Balance | `available + reserved = total`. Reserved cash is *not* spendable. |

Rationale: all prices and payouts are integers by construction, so no rounding policy is needed
anywhere in money arithmetic. Division only appears in display formatting and in average-price
reporting, where the result is explicitly a display value, not a stored one.

## 2. Accounts (ledger)

Every account has `(owner_type, owner_id, asset, kind)` and a signed balance.

| Account | Owner | Asset | Meaning |
| --- | --- | --- | --- |
| `cash:available` | user | `PYA` | Spendable virtual cash |
| `cash:reserved` | user | `PYA` | Cash locked behind open buy orders |
| `position:YES` / `position:NO` | user | `SHARE:<market>` | Shares owned |
| `escrow:shares` | market | `SHARE:<market>` | Shares reserved by open sell orders |
| `escrow:payout` | market | `PYA` | Collateral held to back outstanding shares |
| `system:equity` | system | `PYA` | Issuer of virtual credits (sign convention below) |
| `system:issued` | system | `SHARE:<market>:<YES\|NO>` | Issuer of share classes, used by test-only minting |

Sign convention: **positive = debit**. Assets held by users (cash, shares) are debit balances and
are positive. `system:equity` is a credit account and is negative once credits are issued, so the
sum of all PYA balances is always exactly **0**. This identity is asserted by `assertReconciled`
(`src/domain/ledger.ts`) and by an integration test, and is also checked at runtime by
`GET /api/health`.

> There is **no `system:clearing` account**, and there was never a `system:clearing` kind in the
> schema. Settlement moves Pyas directly from the buyer's `cash:reserved` to the seller's
> `cash:available`, so no clearing intermediary is needed while every trade is a transfer of
> existing shares. A clearing account becomes necessary only when complete-set minting is
> introduced. The earlier version of this document described it as if it existed.

## 3. Journals

A journal is immutable. Each entry has `(account, asset, delta)`. Rules enforced in code **and** by
database triggers:

1. Every journal has at least two entries.
2. For each asset, `sum(delta) = 0`.
3. No entry may be zero.
4. `ledger_entries` and `ledger_journals` reject `UPDATE` and `DELETE`.
5. Corrections are new compensating journals; history is never edited.

Every journal carries `kind`, optional `ref_type/ref_id`, an actor and a timestamp, so a balance can
always be explained by replaying journals.

## 4. Credit issuance

Platform signup grants **1,000,000 Pyas = 10,000 MMK** of virtual credit:

```
dr cash:available(user)  1,000,000
    cr system:equity            1,000,000
```

Issuance is idempotent per user, but **not** by a `(user, kind)` constraint — no such constraint
exists. The guarantee comes from the unique index on `users.email`: the account row, the
preferences row and the grant journal are written in one transaction, so a retried signup either
hits the existing email (409 `conflict`) or commits both the user and exactly one grant. There is
no code path that issues credits outside `registerUser`, and `kind = 'grant'` appears nowhere else.
This is virtual credit with no cash value. It is not a deposit.

## 5. Order placement (implemented)

### 5.1 Buy YES / Buy NO — limit order

A buy order at price `p` for `q` shares needs `p * q` Pyas of collateral, reserved up front:

```
dr cash:reserved(user)        p*q
    cr cash:available(user)          p*q
```

`cash:available` is decremented with a conditional update (`WHERE available >= amount`), so two
concurrent placements cannot spend the same Pyas. When the order is cancelled or fully filled, the
unspent part is released with the reverse journal and the same conditional discipline.

### 5.2 Sell YES / Sell NO — limit order

Selling requires owning the shares. Placing the order moves exactly `q` shares into escrow:

```
dr escrow:shares(market)   q
    cr position:<side>(user)      q
```

Ownership is verified with a locked read of the position row before the journal is written. A user
can never sell shares they do not own; there is no short path in the code.

### 5.3 Invariants at placement
- `1 <= price <= 99`, `1 <= quantity`, quantity is an integer.
- Market must be `open` and not past its close time.
- User must be authenticated; the actor in the journal is always the session user, never a payload field.
- Request carries an idempotency key; a replay returns the original result and writes nothing.

## 6. Cancellation (implemented)

Only the order owner may cancel, only while the order is `open`. The remaining unfilled reservation
(`price * remaining`) is released back:

```
cancel buy:   dr cash:available(user)  p*remaining
                  cr cash:reserved(user)        p*remaining
cancel sell:  dr position:<side>(user) remaining
                  cr escrow:shares(market)      remaining
```

Partial fills reduce `remaining` first, so cancellation releases exactly what is still reserved —
never the original amount.

## 7. Settlement of a fill (implemented as `settleTrade`)

A trade is `(buyer, seller, side, price, quantity)` where both parties are holders/sellers of the
same outcome. Cash moves from the buyer's reservation to the seller; shares move from escrow to the
buyer. No new shares are created — this stage only settles *transfer* trades of existing shares.

```
dr cash:reserved(buyer)      p*q
    cr cash:available(seller)       p*q
dr position:<side>(buyer)    q
    cr escrow:shares(market)       q
```

Both legs are written in the **same journal**, so the transfer is atomic: it is impossible to debit
the buyer without crediting the seller. The seller's cost basis is reduced and realised P/L recorded
as `(price - cost_basis) * q` in integer Pyas.

## 8. Deliberately NOT implemented

These are ambiguous or consequential, so they stay unimplemented and unsurfaced in the UI until the
owner approves a written specification:

- **Minting complete sets** (seller sells shares they do not hold, escrow matched from a YES/NO pair
  and collateral locked instead). Requires a collateral policy decision and a fee decision.
- **Merging complete sets** back into collateral.
- **Complementary cross-matching** between the YES book and the NO book.
- **Maker vs taker price** when two orders cross at different limits.
- **Fees**, **resolution payouts** to shareholders (100 or 0 per share), **void/refund** semantics,
  **order expiration**, **market cancellation refunds**.

The data model already carries `escrow:payout` so the resolution payout journal has a home once
those rules are approved. No UI element claims any of the above works.

## 9. Unknowns requiring owner decisions (not invented here)

1. Fee model: none, flat, or percentage — and who pays it.
2. Whether a creator can trade in their own market.
3. Void handling: refund at cost basis, at last price, or cancel-all-then-refund-reservations.
4. Minimum/maximum order size and per-market exposure limits.
5. Whether limit orders may rest beyond the market close time.

Each has a safe default in code (do nothing / reject), documented in code comments with
`PENDING OWNER DECISION`.

## 10. ADR numbering, and why ADR-001 is missing

This document is ADR-002 and `RESOLUTION-DESIGN.md` is ADR-003. **There is no ADR-001.**

That is a real gap, not an oversight in numbering: the decision it should have recorded — the
choice of stack (Next.js modular monolith + PostgreSQL, no separate matching service, no message
queue) and the reasoning for it — is currently only implied by the code and by the Stage 0 notes in
`docs/AUDIT.md`. An independent review flagged it, and it is recorded here rather than invented
retrospectively, because writing an ADR "after the fact" from the implementation would be a
fiction dressed as a decision record.

Until the owner supplies it, treat the following as the authoritative, if informal, architecture
baseline:

| Decision | Current state |
| --- | --- |
| Deployment shape | Single Next.js process; domain logic in `src/domain/*` called directly by route handlers |
| Database | PostgreSQL, one migration file, access through `src/db/executor.ts` |
| Test database | PGlite (WASM Postgres) for unit/CI, real PostgreSQL for concurrency tests |
| Money | Integer Pyas, `bigint`, branded TypeScript types |
| Auth | Server-side sessions, HttpOnly cookie, scrypt password hashing |

## 11. Corrections applied in the 2026-11-14 correction phase

Recorded here so the specification and the code stay reconciled:

| Area | Change |
| --- | --- |
| Idempotency fingerprint | 32-bit FNV-1a replaced with truncated SHA-256 (128 bits) and canonical JSON |
| Idempotency retention | 24-hour window, batched cleanup, in-flight claims excluded (`src/db/idempotency-retention.ts`) |
| Reservation reallocation | now takes the pool row lock, closing a latent race before matching ships |
| Ledger health | `GET /api/health` reports reconciliation state without exposing balances |
| Migrations | one transaction owner; migration files may no longer contain BEGIN/COMMIT |
