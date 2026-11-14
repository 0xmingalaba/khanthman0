# ADR-003 — Resolution, Payout and Dispute Design

Status: **Design only. Not implemented.** Nothing in the UI claims these features work.
This document exists so the payout journal is specified before it is coded, in line with
the rule that no financial behaviour is invented at the keyboard.

## 1. Current state

Implemented and tested: accounts, virtual credit grant, limit-order reservation, cancellation,
trade settlement of existing shares, portfolio reporting, market lifecycle *state machine*.
Not implemented: minting complete sets, matching, resolution payout, void/refund, disputes.

## 2. Why payout is not implemented yet

The ledger is ready for it: `escrow:payout` exists as a debit account holding collateral per
market. Paying winners is then a single balanced journal per market. But three inputs to that
journal are product decisions the owner has not made:

| # | Decision | Why it blocks payout |
| --- | --- | --- |
| D1 | **Fee model** — none, flat, or percentage; who pays | Changes the amount available to distribute, and must be journaled separately |
| D2 | **Void semantics** — refund at cost basis, at last traded price, or unwind every order | Three different journals with different user outcomes |
| D3 | **Escrow shortfall policy** — what happens if a market's `escrow:payout` cannot cover every outstanding share | Must never be "pay some users"; needs a defined priority, or a guarantee it cannot happen |

Until these are answered, the safest behaviour is the one implemented: markets can reach
`resolved` only with an outcome, and **no payout journal is written**, so no user balance can
be silently changed. A resolution without payout is visible and correctable; a wrong payout is not.

## 3. Proposed payout journal (pending D1 and D3)

For a resolved market with outcome `YES` and no fees, every holder of a YES share receives
100 Pyas per share from the market's payout escrow:

```
for each holder h with q YES shares:
    dr escrow:payout(market)   q * 100
        cr cash:available(h)          q * 100
```

Each holder's transfer is its own journal (`kind = 'resolution_payout'`, `ref_type = 'market'`),
written inside one transaction that also marks the market resolved. Properties:

- Winners of the losing outcome are simply never credited; their shares become worthless
  without any write, so history is untouched.
- The sum of all payouts equals the collateral originally locked, because every outstanding
  share was minted against exactly 100 Pyas of collateral. That equality is what D3 must
  guarantee; the payout code should *assert* it before writing anything, and abort the whole
  resolution if it does not hold.
- The ledger reconciliation invariant (every asset sums to zero) continues to hold because
  escrow is debited exactly as users are credited.

## 4. Dispute workflow (schema prepared, endpoints not built)

```
closed --(resolver)--> proposed --(anyone, with evidence)--> disputed
disputed --(moderator)--> proposed   (re-review, reason required)
disputed --(admin)--> resolved | voided
proposed --(resolver|admin)--> resolved
```

Guards already encoded in `src/domain/market-lifecycle.ts` and unit-tested:

- A market cannot skip review to open.
- A creator cannot resolve their own market (resolution requires resolver/admin).
- Voiding requires a reason and admin role.
- `resolved` and `voided` are terminal.
- Drafts and in-review markets are not publicly visible.

Evidence tables (`market_sources`, `market_evidence`, `disputes`, `dispute_evidence`) are listed
in the domain model; only `market_sources` exists so far because it is the one the UI renders.

## 5. Order of work once D1–D3 are approved

1. Add migration `0002_resolution.sql`: `market_resolutions`, `disputes`, `dispute_evidence`,
   `market_evidence`, plus a unique constraint limiting one active proposal per market.
2. Implement `src/domain/resolution.ts` with the assertion from §3 and payout journals.
3. Integration tests: payout equals collateral, no payout on void, double-resolution impossible,
   unauthorised resolution refused, reconciliation still zero.
4. Only then surface resolution controls in the admin UI.
