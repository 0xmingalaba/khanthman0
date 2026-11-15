# Mingala — Repository Audit (Stage 0)

> **Historical document.** The product was renamed to **Khant Hman Prediction Market**
> during the repository-wide rebrand (see `chore/khant-hman-full-rebrand`). Every
> "Mingala" reference below is a pre-rebrand historical record kept for accuracy;
> backward-compatibility identifiers (env vars, PGlite path, the `mingala_session`
> cookie, migration SQL) are documented in `.env.example` and `src/db/config.ts`.

Date: 2026-11-14
Auditor: Arena engineering agent
Base audited: `chatgpt/m1-ui-overhaul` @ `e296c9d` ("Improve scrolling and reduce visual rendering cost")

## 1. Git and workspace state

| Item | Finding |
| --- | --- |
| Default branch | `main` @ `e2d80a1` — contains only a two-line README ("Initial commit"). |
| Active development branch | `chatgpt/m1-ui-overhaul` @ `e296c9d`, 53 commits ahead of `main`. |
| Open PR | #1 "Draft: Refine Mingala marketplace UI and demo UX" — DRAFT, source `chatgpt/m1-ui-overhaul`. |
| Working tree at audit start | Clean (`git status --porcelain` empty). No stashes. |
| Other refs | `chatgpt/m1-ui-foundation` @ `52ebc2d` (older UI iteration). |
| Session branch | `arena/9a41e7b8-mingala-prediction-market`, fast-forwarded to `e296c9d` so all work starts from the verified UI state. |

The requested branch name `arena/mingala-platform-build` cannot be created in this environment: the Arena session is bound to a single branch (`arena/9a41e7b8-mingala-prediction-market`) and creating/pushing other branches would detach the work from the session. The session branch was therefore branched from the same verified base commit, which satisfies the intent (a clean, isolated branch from `chatgpt/m1-ui-overhaul`). `chatgpt/m1-ui-overhaul` and `main` are untouched.

## 2. What actually exists

A **browser-only prototype**: 6 source files, ~1,270 lines.

```
app/layout.tsx          root layout, Myanmar font, metadata
app/page.tsx            "/" -> redirect("/my")
app/[locale]/page.tsx   validates locale in {my,en}, renders HomePage
app/HomePage.tsx        413 lines, "use client" — the entire product
app/globals.css         814 lines, hand-written dark "space glass" design system
.github/workflows/ci.yml typecheck + build + HTTP smoke tests
next.config.ts, tsconfig.json, package.json
```

Dependencies: Next 15.5, React 19.1, TypeScript 5.9, `@fontsource/noto-sans-myanmar`. No database, no ORM, no test runner, no auth, no API routes, no server components beyond the locale shell.

### Working, and worth preserving
- Locale routing `/my`, `/en`, and `/` → `/my` (307), all verified by CI smoke tests.
- Self-hosted Burmese font, Burmese/English copy object, Burmese digit localisation, explicit Myanmar-time (UTC+06:30) formatting that deliberately avoids locale-dependent `Intl` output.
- Honest labelling: a permanent "SIMULATION MODE / LOCAL DEMO ONLY · NO REAL MONEY · ILLUSTRATIVE DATA" ribbon, and README limitations that do not overclaim.
- Discovery layout: spotlight carousel + hot-topics sidebar, category chips, sort control, market cards, trade preview modal, watchlist, portfolio and activity views.
- Defensive `localStorage` hydration: every persisted field is type-guarded before use; failures are swallowed and fall back to safe defaults.
- CI enforces `npm audit --omit=dev --audit-level=high`, strict typecheck, production build and route smoke tests.

### Not real (prototype-only, must not be mistaken for product)
- All market data is a hardcoded 8-element `markets` array. No feed, no freshness, no provenance.
- "Trading" is local state arithmetic: `setBalance(b => b - cost)` and a `Math.round`-based average price. No order, no trade, no position object, no ledger, no reservation, no server.
- Portfolio "P/L" is mark-to-sample-price fiction.
- Login/Sign up buttons are informational toasts.
- `Math.abs(b.change)`-based "Trending" sort; text-sorted "Closing soon".
- Prices shown inconsistently as `{yes}¢`, `{yes} Pyas`, `{yes} ပြား` in different components — cent glyph `¢` is wrong for Pyas.

### Defects and risks found
1. **No server-side anything.** Every user-visible claim about balances is client state, editably by the user. This is acceptable for a labelled demo and unacceptable for any authenticated release.
2. **Locale switch does full page navigation** (`window.location.assign`) and is only available inside the hamburger menu; no locale-aware link helper, so locale is lost when moving between future routes.
3. **Global `<html lang="my">`** is corrected on the client via `document.documentElement.lang`, so the first paint for `/en` is mislabelled for assistive tech.
4. **Single 413-line client component** holds all state; every keystroke in the quantity input re-renders carousel, grid, portfolio and modal subtrees. No memoised card component, no virtualisation (acceptable at 8 markets, not at 800).
5. **`useMemo` dependency list includes `watchlist` array identity** but the visible list memo also depends on sort/query correctly; however `visible` mutates the source array in place via `list.sort(...)` on a filtered copy — currently safe because `filter` returns a new array, but it is a latent trap.
6. **`!` non-null assertions** (`markets.find(...)!`) on persisted position/activity market IDs. Hydration filters these today, but one future data change becomes a runtime crash.
7. **Accessibility gaps**: carousel dots have no visible focus treatment, dropdown has `role="menu"` without roving focus or focus trap, the confirm dialog does not trap focus or restore it, and `aria-live` regions are used for things that also need `role="alert"` semantics on error.
8. **No tests at all.** CI proves "it builds and returns 200", nothing about behaviour.
9. **No database, migrations, secrets handling, rate limiting, CSRF strategy or error boundary** exists, so Stage 2 starts from zero on the backend.
10. **`npm install` (not `npm ci`)** in CI, and no lockfile committed — builds are not reproducible.

### Dependency and configuration findings
- `overrides.postcss: ^8.5.23` is a security pin; keep it.
- No lockfile in git (`package-lock.json` absent) — must be committed for reproducible installs.
- No `.env.example`, no `server-only` guard, no `zod`/validation, so Stage 2 introduces the first validated input boundary.

## 3. Architecture assessment

The existing stack (Next.js App Router + TypeScript strict + hand-authored CSS) is appropriate for a modular monolith and is **kept**. No rewrite is justified. What is missing is everything below the presentation layer.

Target layering to build (v1):

```
app/                    routing, RSC pages, route handlers   (thin)
  api/                  JSON endpoints, Zod-validated, auth-guarded
src/lib/                money (integer Pyas), errors, clock, validation
src/db/                 dialect-neutral executor, pg + pglite adapters, migrations
src/domain/             ledger, orders, positions, markets, resolution  (pure + transactional)
src/auth/               scrypt passwords, sessions, RBAC
tests/                  unit + integration + security (node:test)
docs/                   audit, roadmap, ADRs, financial specification
```

Key decision: the database executor is an interface with two adapters. Production uses `pg` (real PostgreSQL); tests and local demos use PGlite (PostgreSQL compiled to WASM, same SQL semantics, real transactions). This lets the financial invariants be proven by executable tests in any environment, which is the difference between "ledger code exists" and "ledger behaviour is verified".

## 4. Prioritised risks

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | Financial math in floating point / client trust | Critical | Integer-Pyas money module; server-only computation; invariant tests |
| R2 | No double-entry ledger → unreconcilable balances | Critical | Append-only journals + per-journal balance enforcement + reconciliation test |
| R3 | Double-spend under concurrent requests | Critical | Row locks, conditional balance updates, idempotency keys, concurrency tests |
| R4 | No auth boundary / RBAC | Critical | scrypt, hashed server-side sessions, `requireUser`, role checks, tests |
| R5 | Demo UI mistaken for live exchange | High | Persistent demo label until API data is real; no fake wiring |
| R6 | No reproducible installs | Medium | Commit lockfile; `npm ci` in CI |
| R7 | Accessibility and locale correctness | Medium | Focus management, server-set `lang`, locale-preserving links |
| R8 | Render cost of monolithic client page | Medium | Split components, memoise rows, defer heavy decorative CSS |

## 5. Roadmap

See `docs/ROADMAP.md` for the staged plan and current status.

## 6. Stage 0 verdict

The repository is **healthy and safe to build on**: clean tree, green build path, no uncommitted third-party work. The UI shell is a reasonable foundation. The product itself (markets, accounts, ledger, matching, resolution) does not exist yet, so no working backend behaviour will be rewritten — everything below the UI is additive.
