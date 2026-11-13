# Mingala Prediction Market

An independently designed Myanmar-focused prediction-market interface.

## Current milestone: M1 UI foundation

This first implementation is a frontend-only experience using clearly labelled illustrative data. It does **not** connect to accounts, a database, an order book, a ledger, or real trading.

### Included
- Responsive market discovery page
- Category filtering and market search
- English / Burmese display toggle for sample market questions
- Watchlist interactions
- YES / NO trade preview with integer arithmetic
- Self-hosted Noto Sans Myanmar font files through the npm package
- Original Mingala visual identity

### Requirements
- Node.js 22+
- npm 10+

### Run locally

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

### Important

All market statistics, prices, liquidity, and volumes are mock demonstration values. The preview button does not submit orders or move virtual credits. Do not use this UI as evidence of a functioning exchange.

## Planned architecture

Next.js + TypeScript modular monolith with PostgreSQL as the authoritative datastore. Financial amounts will use integer Pyas (1 MMK = 100 Pyas), never floating-point accounting. Backend trading and ledger functionality will be implemented in later milestones after the relevant owner decisions are confirmed.
