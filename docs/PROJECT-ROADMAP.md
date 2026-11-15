# Khant Hman Prediction Market — Product Roadmap

> **Product:** Khant Hman Prediction Market (ခန့်မှန်း ဈေးကွက်)  
> **Short name:** Khant Hman  
> **Roadmap owner:** Product owner  
> **Last updated:** 2026-11-15  
> **Purpose:** Living roadmap and progress checklist. Tick a box only after the work is implemented and verified. Update this file as decisions change.

## How to use this roadmap

- `[ ]` Not completed.
- `[x]` Completed and verified.
- `[~]` In progress / partially completed (GitHub Markdown renders this as an unchecked item; explain progress in the status note).
- **Blocked** means work must not proceed until the stated dependency or approval is satisfied.
- A feature being discussed or planned does not mean it has been implemented.
- Keep this roadmap current through small commits. Do not mark a task complete based only on an agent's report; inspect the result and verify it.

## 1. Product vision and decisions

Build a Myanmar-focused prediction-market web application where users can browse event markets, trade YES/NO shares, manage positions and follow market outcomes. The intended experience takes inspiration from the usability of Polymarket, while Khant Hman must have its own product identity, rules and implementation.

| Area | Current decision |
|---|---|
| English product name | Khant Hman Prediction Market |
| Myanmar product name | ခန့်မှန်း ဈေးကွက် |
| Short name | Khant Hman |
| Platform currency | **MMK only — မြန်မာကျပ် (ကျပ်)** |
| Share pricing | Expressed in whole MMK per share; no separate subunit |
| Primary product | Web application |
| Additional distribution channels | PWA and Telegram |
| Native Android/iOS apps | Not in the initial plan |
| Current MVP account funds | Virtual credits only |
| Real-money payments | Not enabled; separate approval gate |

### Product principles

- Make the core web application reliable before expanding scope.
- Keep the user experience clear in both English and Burmese.
- Use one shared backend and one set of business rules for web, PWA and Telegram.
- Keep trading, balances, settlement and permissions server-authoritative.
- Never represent demo/sample market data as live market activity.
- Do not enable real-money deposits, withdrawals or payouts without legal, security, operational and explicit product-owner approval.

## 2. Roadmap at a glance

| Phase | Goal | Current status |
|---|---|---|
| 0 | Product identity and project foundation | PR #8 merged into `main`; local Windows verification pending |
| 1 | Get the existing webapp working locally | **Current priority** |
| 2 | Complete the prediction-market MVP | Not yet accepted as complete |
| 3 | Administration and operations | Planned |
| 4 | PWA and Telegram distribution | Planned |
| 5 | MMK payment operations | Blocked pending reviews and approval |
| 6 | Production readiness and controlled launch | Planned |
| 7 | Post-launch improvement and growth | Future |

---

## Phase 0 — Product identity and project foundation

**Goal:** Establish the product identity, repository and engineering baseline.

- [x] Confirm the product name: Khant Hman Prediction Market.
- [x] Confirm MMK (ကျပ်) as the sole currency throughout the platform.
- [x] Confirm there is no separate share denomination or fractional currency unit; YES/NO share prices are expressed in whole MMK.
- [x] Choose web app, PWA and Telegram as the intended channels; no native app for the initial plan.
- [x] Complete independent review of repository-wide rebrand PR #8. (Findings resolved at the final head `1226911`; CI green; squash-merged as `5c6f103` on 2026-11-15.)
- [x] Resolve all outstanding review findings and confirm CI against the final PR head. (All review threads on PR #8 resolved; both CI runs at the final head completed successfully.)
- [x] PR #8 merged into `main` (`5c6f103`, 2026-11-15).
- [ ] Confirm the local Windows 11 development setup on the merged `main`.

**Current repository context (2026-11-15):** PR #8, `chore: complete Khant Hman repository-wide rebrand`, was squash-merged into `main` as `5c6f103` on 2026-11-15 (final head `1226911`; CI green; all review threads resolved). PR #9 carries this roadmap as a documentation-only change rebased onto the merged `main`. Do not merge or deploy without explicit product-owner approval.

## Phase 1 — Working local web application

**Goal:** Run the existing application on the product owner's Windows 11 machine and verify the current functionality before adding more features.

### 1.1 Development environment

- [ ] Pull the approved repository version into the local Windows 11 worktree.
- [ ] Install dependencies successfully.
- [ ] Confirm environment files load consistently for Next.js and database CLI commands.
- [ ] Confirm the PGlite local database opens the intended existing data directory.
- [ ] Confirm migrations and development seed run safely.
- [ ] Start the app with the documented Windows-compatible command.
- [ ] Confirm the app is reachable in the local browser.
- [ ] Confirm no unexpected empty/new database is opened when legacy data exists.

### 1.2 UI and functional smoke test

- [ ] Home page loads without a critical error.
- [ ] Header, footer and primary navigation work.
- [ ] English and Burmese locale switching works and preserves the current route where expected.
- [ ] Responsive layout is usable at desktop and mobile viewport sizes.
- [ ] Registration and sign-in screens render and behave as currently implemented.
- [ ] Market listing and category/search controls work as currently implemented.
- [ ] Market detail view works as currently implemented.
- [ ] YES/NO trade or order-review interaction works as currently implemented.
- [ ] Portfolio, positions and balance views work as currently implemented (balances, positions and open orders only — there is no account activity or transaction history view yet; that is tracked in Phase 2).
- [ ] Refresh, browser back/forward and direct route loading work.
- [ ] Loading, empty and error states are understandable.
- [ ] No critical browser-console or server-terminal errors remain.

### 1.3 Defect handling

For each defect, record: reproduction steps, expected result, actual result, root cause, fix and verification.

- [ ] Record all discovered defects in GitHub Issues or the agreed project tracker.
- [ ] Fix P0 blockers (startup failure, data loss/corruption, critical security defects).
- [ ] Fix P1 blockers (essential user journey cannot complete).
- [ ] Retest fixes and close only verified issues.

**Phase 1 exit criteria:** The app starts reliably on the local Windows 11 environment; essential existing user flows work; no unresolved P0/P1 issues remain. This phase does not imply production readiness.

## Phase 2 — Prediction-market MVP

**Goal:** Deliver a complete, coherent virtual-credit prediction-market experience.

### 2.1 Accounts and authentication

Previously discussed registration choices: phone-number registration and email registration. The final launch choice is still open.

- [ ] Decide whether launch supports email, phone number or both.
- [ ] Complete registration and verification flow.
- [ ] Complete sign-in and sign-out.
- [ ] Complete session persistence, expiry and revocation.
- [ ] Add account recovery.
- [ ] Verify the existing authentication rate limiting and abuse protection: a per-client limit in the shared `route()` wrapper plus per-account/per-address ceilings (`loginAccount` for login, `registerAccount` for registration) with hashed identity keys; confirm the limits actually engage. Keep a shared-store limiter as the multi-instance production follow-up — the current limiter is deliberately process-local (see the security note below).
- [ ] Define and implement an account-level lockout / throttling policy with safe recovery on top of the existing per-account ceilings (lockout after sustained failure, safe recovery, no account-enumeration leaks).
- [ ] Verify the existing CSRF defense for cookie-authenticated state-changing requests: the shared `route()` wrapper enforces a same-origin Origin/Referer check for mutations (SameSite=Lax is the first line); confirm cross-origin mutations are rejected and that no mutation endpoint bypasses the wrapper.
- [ ] Verify sensitive authentication events are recorded in the audit log — registration (`auth.register`), login (`auth.login`) and logout (`auth.logout`) are currently recorded; complete any gaps for other sensitive events.

Security requirements: password hashing, secure cookies/sessions, server-side authorization, input validation and protection against account enumeration and brute-force attempts. Before multi-instance production, replace or supplement process-local rate limiting with a shared store and verify trusted-proxy configuration.

### 2.2 Market discovery and market pages

- [x] Market catalog is database-backed: the home page renders `initialMarkets` loaded via `listMarkets` (`app/[locale]/page.tsx`), and `HomeView` refreshes it through the markets API (`src/lib/api-client.ts` → `/api/markets` → `app/api/markets/route.ts` → `listMarkets`).
- [ ] Verify the existing database-backed market catalog on the local Windows environment: the shown markets are live database content (never sample or demo data presented as live), category/search controls and the refresh path behave as implemented, and loading, empty and error states are understandable.
- [ ] Verify the existing market discovery flow on the local Windows environment: category filter chips and search (client `HomeView` → `/api/markets?category=&q=` → `listMarkets` applies both filters), and the dedicated market detail route (`app/[locale]/market/[slug]/page.tsx` with `MarketView` rendering the question, description and resolution criteria).
- [ ] Decide and specify any genuinely missing discovery behavior separately — for example dedicated per-category feed routes (not present; category filtering exists) — rather than re-implementing what exists.
- [ ] Show market question, description and precise resolution criteria.
- [ ] Show YES/NO prices and relevant market status.
- [ ] Show close time, outcome status and resolution information.
- [ ] Add clear loading, empty and error states.
- [ ] Clearly label any remaining demo data.

Potential initial categories (not yet finalized): Myanmar affairs, politics/government, economy/business, sports, technology and world events.

### 2.3 Trading experience

The intended UX is similar in familiarity to Polymarket: select YES or NO, enter an amount/quantity, review the order and see the resulting position.

**Current status (2026-11-15):** the repository already implements the core trading paths — order placement with collateral/share reservation, cancellation with reservation release, settlement, reservation accounting and idempotent replay — in `src/domain/trading.ts`, `src/domain/reservations.ts` and `src/lib/money.ts`. The existing tests exercise these paths in legacy Pya-based units. None of this has been verified under MMK-only rules, and per `docs/ROADMAP.md` Stage 4 the price-time matching engine is deliberately not started. The required work is to audit, adapt and verify the existing functionality — not to re-implement it from the checklist below.

- [ ] Finalize and approve a written matching/pricing specification using whole-MMK share prices (for example, YES at 30 ကျပ် and NO at 70 ကျပ်); explicitly define payout, price bounds, rounding and minimum order size.
- [ ] Audit the existing trading paths and their financial-unit assumptions: order placement (`placeOrder`), cancellation and reservation release (`cancelOrder`), settlement (`settleTrade`), reservations (`src/domain/reservations.ts`), idempotent replay (idempotency keys) and position accounting. Record what exists, what is partial and what is genuinely missing; check this against `docs/FINANCIAL-SPEC.md` and Stage 4 of `docs/ROADMAP.md`.
- [ ] Audit and migrate the existing Pya-based implementation, stored values, seed balances, APIs, formatters and tests to MMK-only accounting without losing or misrepresenting existing records.
- [ ] Adapt the existing order placement, cancellation, reservation and settlement paths to the approved MMK-only rules (whole-MMK share prices, winning-share payout, price bounds, rounding and minimum order size). Do not re-implement working paths from scratch.
- [ ] Verify after the MMK migration (not before): order placement and its reservations, cancellation and reservation release including partial fills, position settlement, idempotent replay of retried requests, and balance/position consistency with the ledger. Do not mark this complete until the tests actually run and pass under MMK units; the existing suite certifies Pya-based behavior only.
- [ ] Decide the trading mechanism (order book, automated market maker or another design); do not assume this is settled.
- [ ] Identify and schedule any genuinely missing trading functionality separately rather than assuming the existing paths are missing — for example the matching engine (price-time priority, complementary YES/NO cross-matching, complete-set mint/merge), order expiry, fee policy, and the order status/trade history read experience (`listOpenOrders` exists; the depth of history UI has not been assessed).
- [ ] Test simultaneous orders and balance/position race conditions under MMK rules.
- [ ] Explain fees, execution price and order outcomes clearly to users.

### 2.4 Portfolio and account activity

- [ ] Show available and reserved balance separately.
- [ ] Show open positions by market and outcome.
- [ ] Show share quantity and average cost.
- [ ] Show current value where a reliable market price exists.
- [ ] Show realized and unrealized P/L with clear definitions.
- [ ] Show completed trades and account activity (activity/history view not yet implemented — PortfolioView currently shows balances, positions and open orders).
- [ ] Keep balances consistent with the ledger.

### 2.5 Market lifecycle, resolution and disputes

- [ ] Implement market creation and review permissions.
- [ ] Define who may propose an outcome.
- [ ] Define acceptable resolution sources/evidence.
- [ ] Implement outcome proposal and review.
- [ ] Implement dispute submission and handling.
- [ ] Implement authorized final resolution.
- [ ] Verify settlement of winning/losing positions through ledger journals under the approved MMK rules (existing `settleTrade` path in `src/domain/trading.ts` — do not re-implement); complete any genuine gaps.
- [ ] Define and implement void/cancellation rules.
- [ ] Make resolution history and evidence visible to users where appropriate.

## Phase 3 — Administration and operations

**Goal:** Give authorized staff safe tools to operate the platform.

- [ ] Admin dashboard and operational overview.
- [ ] User lookup and account status management.
- [ ] Market creation, editing, review, publishing and closing.
- [ ] Market outcome proposal and resolution review.
- [ ] Dispute and evidence management.
- [ ] Trading and suspicious-activity monitoring.
- [ ] Transaction and ledger inspection.
- [ ] Audit-log viewer.
- [ ] Role-based access control and least-privilege permissions.
- [ ] Admin action confirmation and reason capture.
- [ ] Separation of market, resolution, support and finance responsibilities.

Proposed roles (to be finalized): Super Admin, Market Manager, Resolver, Finance Operator and Support Operator. A staff role must not receive broad financial authority merely for convenience.

## Phase 4 — PWA and Telegram

**Goal:** Make Khant Hman accessible through the selected channels without creating separate trading systems.

### PWA

- [ ] Responsive mobile-first experience.
- [ ] Web app manifest and installability.
- [ ] App icons and launch experience.
- [ ] Offline behavior defined safely (never imply offline trades have executed).
- [ ] Push notifications, if approved and supported.
- [ ] Test install/update behavior on supported browsers.

### Telegram

- [ ] Decide Telegram Bot vs Mini App feature scope.
- [ ] Implement secure account linking/authentication.
- [ ] Market discovery and market notifications.
- [ ] Mini App interface if approved.
- [ ] Reuse the same server-side authorization, trading engine and ledger.
- [ ] Test Telegram identity/session security and account recovery.

## Phase 5 — MMK deposits and withdrawals

**Status: BLOCKED.** This phase is not authorized for implementation or activation merely because the workflows have been discussed.

The product owner discussed a manual MMK workflow, potentially using payment methods such as KPay or WavePay. These are examples under consideration, not confirmed provider integrations or approvals.

### 5.1 Manual deposit flow discussed

1. User selects a deposit amount in MMK.
2. Platform displays one currently valid deposit account/payment method.
3. User sends the MMK transfer.
4. User submits a payment reference or evidence.
5. Authorized Finance Operator independently verifies receipt.
6. Operator approves or rejects the request with a reason.
7. Only an approved, verified deposit is credited through the ledger.

- [ ] Obtain Myanmar legal/regulatory advice and confirm whether the proposed business model and payment flow are permitted.
- [ ] Confirm provider/bank terms and obtain required permissions.
- [ ] Define deposit limits, verification standards and fraud controls.
- [ ] Define payment-account rotation/availability and reconciliation procedures.
- [ ] Implement pending/approved/rejected states and operator audit trails.
- [ ] Prevent duplicate credits and screenshot-only verification.
- [ ] Test reconciliation and exception handling.

### 5.2 Manual withdrawal flow discussed

1. User submits a withdrawal amount and destination/account details.
2. System validates and reserves the available balance.
3. Authorized operator reviews the request.
4. Operator sends the MMK transfer through the approved channel.
5. Operator independently verifies the transfer result.
6. Request is completed or rejected, with ledger entries and audit history.

- [ ] Obtain legal, regulatory and payment-provider approval.
- [ ] Define user identity checks and destination ownership checks.
- [ ] Define limits, review thresholds and fraud controls.
- [ ] Define approval and separation-of-duties policy.
- [ ] Implement safe reservation, rejection and release behavior.
- [ ] Implement operator evidence, reconciliation and audit history.
- [ ] Test duplicate requests, failed transfers, reversals and disputes.

**Hard gate:** Real-money deposits, withdrawals and payouts remain disabled until legal, security, operational and product-owner approvals are documented. The current MVP remains virtual-credit only.

## Phase 6 — Production readiness and controlled launch

- [ ] Complete legal/regulatory review for the final product model.
- [ ] Select and review production hosting and database arrangements.
- [ ] Configure production PostgreSQL, secrets and environment separation.
- [ ] Configure domain, HTTPS and secure headers.
- [ ] Complete database migration and rollback runbook.
- [ ] Rehearse backup and restore.
- [ ] Set up monitoring, alerting and error reporting.
- [ ] Complete security review and penetration testing appropriate to the risk.
- [ ] Complete load and concurrency testing.
- [ ] Define incident response and access revocation procedures.
- [ ] Prepare customer support and user-facing policies.
- [ ] Run a controlled beta with explicit eligibility and limits.
- [ ] Product owner approves public launch.
- [ ] Deploy only after explicit product-owner approval.

## Phase 7 — Post-launch improvement

Prioritize using user feedback, reliability data and operational needs.

- [ ] Watchlists and favorites.
- [ ] Market and price alerts.
- [ ] Improved charts and market history.
- [ ] Better market discovery and recommendations.
- [ ] Market discussion/community features, if appropriate.
- [ ] Additional categories and language improvements.
- [ ] Performance and accessibility improvements.
- [ ] Analytics for product quality and market health.

---

## 3. Engineering and financial rules

These are project guardrails. Changes require an explicit written specification and review.

- **Server-authoritative:** The server validates and executes all trades, balance changes and settlements.
- **Currency:** MMK (ကျပ်) is the sole currency and accounting unit throughout Khant Hman. Do not introduce Pya, cents or another subunit.
- **Share prices:** YES/NO share prices and all order/trade amounts are expressed in whole MMK. A 30 ကျပ် YES price and 70 ကျပ် NO price are illustrative only; the complete pricing, payout, bounds, rounding and minimum-order rules require an approved specification.
- **Integer arithmetic:** Use integer MMK amounts only; never use unsafe floating-point financial calculations or fractional-MMK values.
- **Existing implementation migration:** The current code and financial specification still use legacy Pya-based units and conversion assumptions. This conflicts with the confirmed product decision and must be audited and migrated to MMK-only units. Do not silently reinterpret existing ledger balances, seed credits, payout constants or historical records. Prepare a documented, tested migration and reconciliation plan before changing financial code or data.
- **Virtual credits:** The MVP remains virtual-credit only, but those credits are denominated in MMK (ကျပ်) for the product experience. They are not cash, deposits or a promise of redemption.
- **Collateral:** Fully collateralised positions; no naked shorts.
- **Double-entry ledger:** Every financial movement is represented by balanced journal entries.
- **Append-only accounting:** Do not silently edit or delete posted ledger history.
- **Transactions and concurrency:** Protect balances, reservations, orders and settlement against races and partial writes.
- **Idempotency:** Retried requests must not duplicate financial effects.
- **Auditability:** Sensitive user, staff and financial actions must be traceable.
- **Testing:** Verify behavior, failure paths and concurrency—not only successful compilation.

Technical implementation detail and stage-by-stage engineering status remain in [`docs/ROADMAP.md`](./ROADMAP.md). Financial rules and accounting detail should remain aligned with [`docs/FINANCIAL-SPEC.md`](./FINANCIAL-SPEC.md).

## 4. Definition of done

A roadmap checkbox may be checked only when:

1. The change is implemented in the repository.
2. Relevant automated tests pass.
3. The affected user flow has been manually or end-to-end verified where appropriate.
4. Documentation is updated where needed.
5. No unresolved critical regression remains.
6. The product owner has approved decisions that require owner approval.

## 5. Decision log — open product questions

These topics were discussed but are not finalized. Record the decision here when agreed.

- [ ] Registration at launch: email, phone number or both?
- [ ] Complete trading mechanism and matching/pricing rules in whole MMK, including winning-share payout, price bounds, rounding and minimum order size?
- [ ] Market categories for initial launch?
- [ ] Market creation, review and resolution authority?
- [ ] Resolution evidence standards and dispute window?
- [ ] Telegram Bot vs Mini App scope?
- [ ] MMK payment methods and operating partners (subject to legal/provider approval)?
- [ ] Deposit/withdrawal limits and identity-verification requirements?
- [ ] Public beta eligibility and launch criteria?

## 6. Change history

| Date | Change |
|---|---|
| 2026-11-15 | Created product-level roadmap from product-owner discussions; added phase checklists, current Phase 1 priority, PWA/Telegram direction, manual MMK payment concepts and explicit real-money approval gates. |
| 2026-11-15 | Incorporated independent review findings: added auth/CSRF/distributed-rate-limit hardening items and flagged the legacy Pya-based implementation for an explicit currency decision; no financial code or ledger behavior changed. |
| 2026-11-15 | Product owner confirmed MMK (ကျပ်) as the sole currency across the platform. Removed Pya as a share denomination/subunit from the product specification; added whole-MMK pricing and a required legacy-unit migration/reconciliation task. No financial code or data changed. |
| 2026-11-15 | Rebased onto post-PR-#8 `main` (`5c6f103`). Reframed the market-catalog task as verification of the existing database-backed implementation (`listMarkets` via `app/[locale]/page.tsx` and `/api/markets`), and the trading tasks as audit/adapt/verify of the existing implementation in `src/domain/trading.ts`; recorded that MMK-unit verification has not happened. Recorded PR #8's merge. No financial code or data changed. |
| 2026-11-15 | Follow-up Codex review: reframed market discovery (categories, search, detail route), authentication rate limiting/CSRF and audit-log items as verification of existing implementations; moved the account-activity smoke check out of Phase 1 (no such view exists) to Phase 2. No code changed. |
