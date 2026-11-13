# Mingala Prediction Market

An independently designed, Myanmar-focused prediction-market frontend.

## Current milestone: M1 UI overhaul (frontend simulation)

This milestone is a browser-only product prototype. It is **not** a live exchange and has no server-side users, market feed, order book, matching engine, database, ledger, or real-money functionality.

### Included
- Responsive Mingala market discovery experience
- English / Burmese market-question toggle
- Search across English and Burmese question text and category
- Category filtering and sorting by sample volume, YES probability, and displayed close label
- Device-local watchlist
- YES / NO simulated position calculator and order-review confirmation
- Local demo balance, simulated positions, and activity history
- Portfolio mark-to-sample-price and simplified P/L display
- Market description and example resolution guidance
- Keyboard shortcut Ctrl/Cmd + K to focus search
- Local browser storage for demo state
- Self-hosted Noto Sans Myanmar font package

### Important limitations
- Market names, prices, probability changes, volumes, close labels and all other market values are illustrative sample data.
- The sort called “Trending” is currently a volume-based sample ordering, not a live trend calculation.
- The “Closing soon” option sorts the sample close labels as text and is not a date-aware production sort.
- The demo simulator records local positions only. It does not send orders, match trades, reserve collateral, or post ledger entries.
- Local storage is editable by the user and is not secure account storage.
- There is no real account, login, registration, leaderboard, or cross-device synchronization.
- Resolution text is guidance for future market rules, not approved resolution criteria.

Do not use this prototype to represent real market activity, account balances, trading, or exchange liquidity.

## Requirements and local development

- Node.js 22+
- npm 10+

```bash
npm install
npm run dev
```

Open http://localhost:3000.

### Validation

```bash
npm run typecheck
npm run build
```

## Planned architecture

Next.js + TypeScript modular monolith with PostgreSQL as the authoritative datastore. Financial amounts will use integer Pyas (1 MMK = 100 Pyas), never floating-point accounting. The production matching engine, double-entry ledger, authentication, market lifecycle, audit trail and security controls will be implemented and tested in later milestones.
