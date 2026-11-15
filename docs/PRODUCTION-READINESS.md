# Khant Hman Prediction Market — Production Readiness Checklist

Status as of this branch. Nothing here has been deployed, and deployment requires explicit
owner approval.

## 1. Before any deployment

| Item | Status | Notes |
| --- | --- | --- |
| Reproducible installs | **Done** | `package-lock.json` committed, CI uses `npm ci` |
| Strict TypeScript, no suppressions | **Done** | `tsc --noEmit` clean; no `@ts-ignore` in `src/` |
| Production build green | **Done** | `next build` passes with all routes |
| Automated tests | **Done** | 33 unit + 59 integration, run in CI |
| Dependency audit | **Done** | `npm audit --omit=dev --audit-level=high` in CI |
| Secrets out of the repository | **Done** | `.env*` ignored, `.env.example` documented |
| Not-yet-approved financial features hidden | **Done** | No mint/merge/payout/dispute UI exists |

## 2. Configuration the owner must supply

1. `DATABASE_URL` for a managed PostgreSQL 15+ instance, with TLS.
2. Run migrations: `npm run db:migrate` (idempotent, checksum-guarded).
3. Remove `KHANTHMAN_DB=pglite` from any deployed environment. PGlite is development-only;
   `getDatabase()` throws if neither setting is present, so a misconfiguration fails loudly
   instead of silently using an ephemeral database.
4. Set `NODE_ENV=production` so session cookies are issued with `Secure`.

## 3. Known gaps that block a public launch

| # | Gap | Risk | Mitigation plan |
| --- | --- | --- | --- |
| G1 | Rate limiting is in-process only | Brute force across instances | Move to shared store (Postgres table or Redis) before scaling past one instance. **Partially mitigated:** auth endpoints now also limit per *account*, which IP rotation cannot reset (see `docs/DEPLOYMENT.md`). |
| G2 | No email verification or password reset | Account recovery impossible | Needs transactional email provider; out of scope until approved |
| G3 | No matching engine | Orders rest but never cross | Requires the matching specification and the D1–D3 decisions in `RESOLUTION-DESIGN.md` |
| G4 | No resolution payout | Winning shares do not pay | Specified but intentionally not implemented; see ADR-003 |
| G5 | Unrealised P/L not shown | Users cannot see mark-to-market | Needs an approved mark-price rule |
| G6 | No CSP header yet | XSS defence is layered but not maximal | Add a nonce-based CSP once all asset sources are known |
| G7 | No backups rehearsed | Data loss risk | Documented below; must be rehearsed on a staging database |

### Gaps closed in the 2026-11-14 correction phase

| Was | Now |
| --- | --- |
| Rate limiting trusted the client-controlled leftmost `X-Forwarded-For`, so a forged header reset the bucket per request | Explicit immediate-peer allowlist (`TRUSTED_PROXY_CIDRS`) plus right-anchored hop count; forwarded headers are ignored from untrusted peers. A per-account auth limit remains. Regression tests cover rotating forged headers. See `docs/DEPLOYMENT.md`. |
| `migrate()` nested a transaction around a file that already contained `BEGIN`/`COMMIT`; a failed migration left committed DDL behind (reproduced on PostgreSQL 16.2) | One transaction owner. The runner owns it, refuses files containing transaction control, and writes the version row inside the same transaction. Covered by `tests/integration/migrations.test.ts`. |
| "Concurrency" was only tested on PGlite, which serialises all transactions — no row lock was ever contended | Real-PostgreSQL suite over multiple connections (`npm run test:postgres`), including a mutation check: removing `FOR UPDATE` makes it fail. False-green guard: `npm run test:postgres:gate` fails unless a real server is reachable and the whole suite passes; `npm run verify:postgres-gate` self-checks the gate. CI runs the raw suite directly. |
| Idempotency fingerprint was 32-bit FNV (collision-prone) and keys were never pruned | Truncated SHA-256 over canonical JSON; 24-hour retention with batched cleanup that never removes in-flight claims. |
| Reservation reallocation read the shared cash pool without a lock | Now takes the pool row lock, before matching is introduced. |
| No runtime ledger check; `reconcile()` claimed an "admin health check" that did not exist | `GET /api/health` reports reconciliation state and leaks no balances. |

Still open and deliberately untouched: ADR-001 (see ADR-002 §10), the matching engine, resolution
payout, fees and disputes.

## 4. Backup and recovery

- Use the managed provider's automated daily snapshots plus point-in-time recovery.
- The ledger is append-only by trigger, so recovery to any point in time is internally
  consistent: balances are derived from entries, not stored independently.
- Weekly restore rehearsal: restore the latest snapshot into a scratch database, then run
  `assertReconciled` across all assets. A restore that does not reconcile is a failed restore.
- Run `npm run db:reconcile` (wraps `reconcile()` in `src/domain/ledger.ts`) against the restored
  database, or call `GET /api/health`, which reports reconciliation without exposing balances.

## 5. Monitoring to add before launch

- Error rate and latency on `/api/*` (per route).
- Database connection pool saturation.
- Failed login and rate-limit counters (abuse signal).
- A scheduled job run of `reconcile()`; any non-zero asset total is a page-worthy incident.

## 6. Incident response (financial)

1. Do not delete or edit ledger rows — the schema forbids it, and it would destroy the audit trail.
2. Stop writes: put the affected markets into `closed` (no new orders), which is reversible.
3. Identify affected journals by `ref_type`/`ref_id` and `created_at`.
4. Correct with a new `correction` journal written by an admin action, with a memo.
5. Verify with `assertReconciled` and an account statement before resuming trading.
