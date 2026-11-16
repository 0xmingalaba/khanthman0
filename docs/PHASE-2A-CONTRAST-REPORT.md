# Phase 2A — Design-Token Contrast Verification Report

> **Scope:** design-token foundations PR (branch `arena/fa29be6a-phase2a-foundations`).
> Implements the required verification method of `docs/PHASE-2A-DESIGN-SPEC.md` §8.9, **step 1** (computed WCAG 2.x relative-luminance ratios for every token pair, both themes).
> Spec evidence status: token values remain **PROPOSED** (spec §8.2) until in-browser spot checks are attached for each page PR.
>
> **Method:** `node scripts/contrast-check.mjs` — parses `:root` (light) and `:root[data-theme="dark"]` (dark) blocks in `app/globals.css`, strips comments, computes WCAG 2.x relative luminance with the standard piecewise sRGB transfer, and prints the table below. The same pairs are asserted in CI by `tests/unit/contrast.test.ts`.
>
> **Date:** 2026-11-16 · **Tooling:** Node v22.22.3, custom script (no new dependencies) · **Themes:** Light, Dark

## Results (all computed; none are in-browser measurements)

| Pair | Light | Dark | Required | Result |
|---|---|---|---|---|
| --text on --bg (#101a19/#ffffff ↔ #e9edeb/#0e1514) | 17.74 | 15.65 | ≥4.5 | PASS |
| --muted on --bg (#5c6f6b/#ffffff ↔ #93a49f/#0e1514) | 5.33 | 7.09 | ≥4.5 | PASS |
| --line-strong (UI boundary) on --bg (#7d8b83/#ffffff ↔ #67766f/#0e1514) | 3.56 | 3.87 | ≥3 | PASS |
| --line (decorative) on --bg (#e3e7e3/#ffffff ↔ #25322f/#0e1514) | 1.25 | 1.39 | ≥0 | PASS |
| --down on --bg (#b3261e/#ffffff ↔ #ff8a80/#0e1514) | 6.54 | 8.10 | ≥4.5 | PASS |
| --up on --bg (#0e7767/#ffffff ↔ #3dd598/#0e1514) | 5.45 | 9.83 | ≥4.5 | PASS |
| --text on --surface (#101a19/#ffffff ↔ #e9edeb/#131c1b) | 17.74 | 14.70 | ≥4.5 | PASS |
| --muted on --surface (#5c6f6b/#ffffff ↔ #93a49f/#131c1b) | 5.33 | 6.66 | ≥4.5 | PASS |
| --line-strong (UI boundary) on --surface (#7d8b83/#ffffff ↔ #67766f/#131c1b) | 3.56 | 3.64 | ≥3 | PASS |
| --line (decorative) on --surface (#e3e7e3/#ffffff ↔ #25322f/#131c1b) | 1.25 | 1.30 | ≥0 | PASS |
| --down on --surface (#b3261e/#ffffff ↔ #ff8a80/#131c1b) | 6.54 | 7.60 | ≥4.5 | PASS |
| --up on --surface (#0e7767/#ffffff ↔ #3dd598/#131c1b) | 5.45 | 9.23 | ≥4.5 | PASS |
| --text on --surface-2 (#101a19/#f6f7f6 ↔ #e9edeb/#182220) | 16.52 | 13.80 | ≥4.5 | PASS |
| --muted on --surface-2 (#5c6f6b/#f6f7f6 ↔ #93a49f/#182220) | 4.96 | 6.25 | ≥4.5 | PASS |
| --line-strong (UI boundary) on --surface-2 (#7d8b83/#f6f7f6 ↔ #67766f/#182220) | 3.32 | 3.41 | ≥3 | PASS |
| --line (decorative) on --surface-2 (#e3e7e3/#f6f7f6 ↔ #25322f/#182220) | 1.16 | 1.22 | ≥0 | PASS |
| --down on --surface-2 (#b3261e/#f6f7f6 ↔ #ff8a80/#182220) | 6.09 | 7.14 | ≥4.5 | PASS |
| --up on --surface-2 (#0e7767/#f6f7f6 ↔ #3dd598/#182220) | 5.07 | 8.67 | ≥4.5 | PASS |
| --text on --surface-3 (#101a19/#eceeeb ↔ #e9edeb/#1f2a27) | 15.20 | 12.53 | ≥4.5 | PASS |
| --muted on --surface-3 (#5c6f6b/#eceeeb ↔ #93a49f/#1f2a27) | 4.57 | 5.68 | ≥4.5 | PASS |
| --line-strong (UI boundary) on --surface-3 (#7d8b83/#eceeeb ↔ #67766f/#1f2a27) | 3.05 | 3.10 | ≥3 | PASS |
| --line (decorative) on --surface-3 (#e3e7e3/#eceeeb ↔ #25322f/#1f2a27) | 1.07 | 1.11 | ≥0 | PASS |
| --down on --surface-3 (#b3261e/#eceeeb ↔ #ff8a80/#1f2a27) | 5.60 | 6.48 | ≥4.5 | PASS |
| --up on --surface-3 (#0e7767/#eceeeb ↔ #3dd598/#1f2a27) | 4.67 | 7.87 | ≥4.5 | PASS |
| --on-accent on --accent (#ffffff/#0e7767 ↔ #05231a/#3dd598) | 5.45 | 8.85 | ≥4.5 | PASS |
| --accent on --bg (#0e7767/#ffffff ↔ #3dd598/#0e1514) | 5.45 | 9.83 | ≥4.5 | PASS |
| --accent-hover on --bg (#095c51/#ffffff ↔ #57d3a1/#0e1514) | 7.89 | 9.89 | ≥4.5 | PASS |
| --accent on --accent-soft (#0e7767/#e9f3ee ↔ #3dd598/#16302a) | 4.81 | 7.49 | ≥4.5 | PASS |
| --accent-hover on --accent-soft (#095c51/#e9f3ee ↔ #57d3a1/#16302a) | 6.96 | 7.54 | ≥4.5 | PASS |
| --muted on --surface-3 (disabled) (#5c6f6b/#eceeeb ↔ #93a49f/#1f2a27) | 4.57 | 5.68 | ≥4.5 | PASS |
| --input text on --input-surface (#101a19/#ffffff ↔ #e9edeb/#182220) | 17.74 | 13.80 | ≥4.5 | PASS |
| --down on --danger-surface (#b3261e/#fdecea ↔ #ff8a80/#2a1714) | 5.72 | 7.47 | ≥4.5 | PASS |
| --warning-ink on --warning-surface (#6b4e12/#f6ecd4 ↔ #e0c073/#2a2413) | 6.56 | 8.79 | ≥4.5 | PASS |
| --focus-ring on --bg (#0e7767/#ffffff ↔ #3dd598/#0e1514) | 5.45 | 9.83 | ≥3 | PASS |
| --focus-ring on --surface (#0e7767/#ffffff ↔ #3dd598/#131c1b) | 5.45 | 9.23 | ≥3 | PASS |

Failures: 0

## Pass/fail summary

- Meaningful pairs (body text, muted text, UI/boundary pairs, focus ring): **PASS in both themes** (minimums: 4.5:1 text, 3:1 non-text/UI per WCAG 2.2 AA).
- Decorative `--line` pairs are intentionally below 3:1 (≈1.07–1.39) and are exempt **only** as decorative separators that are never the sole boundary cue (spec §8.2/§8.4). They carry no text or control boundary meaning.
- Disabled control pair (`--muted` on `--surface-3`): **4.57 (light) / 5.68 (dark)** — passes 4.5:1; the spec's prohibition on fixed low-opacity disabled labels remains in force (spec §8.6).
- Meaningful boundaries (`--line-strong`) clear 3:1 against every canvas/surface in both themes (min 3.05 light on `--surface-3`, 3.10 dark on `--surface-3`).
- Failures: **0**.

## Not yet verified (explicitly open)

1. **In-browser measurement** of rendered pairs (Chrome DevTools or axe) in both themes, **including hover, focus, active, disabled and error states** (spec §8.9 steps 2–3) — required for each page PR before merge; cannot be produced in a headless CI sandbox without a browser.
2. **Burmese string width/overflow** at these sizes (spec §11 L-06) — manual review.
3. Legacy surfaces are not yet tokenized; no legacy pair is covered by this report.
4. Hover/focus variants beyond token-level pairs (e.g., actual rendered button hover fills after alpha/opacity, if any are introduced later) must be re-measured when introduced.
5. Ratios are computed from the sRGB hex values exactly as written in `app/globals.css`; any token edit requires re-running `node scripts/contrast-check.mjs` and updating `tests/unit/contrast.test.ts` expectations.

## How to reproduce

```bash
node scripts/contrast-check.mjs
npm test          # includes tests/unit/contrast.test.ts
```
