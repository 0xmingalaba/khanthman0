"use client";

import type { Dictionary } from "@/src/i18n/dictionary";

export const THEME_STORAGE_KEY = "khanthman-theme";

/**
 * Phase 2A theme toggle — PLACED IN THE PRIMARY NAV (roadmap 2A.1) but
 * deliberately INERT for now.
 *
 * Why disabled: Light/Dark themes exist only at the token level in this
 * foundations PR (see globals.css, ".kh-theme-toggle"). No legacy surface is
 * re-skinned yet, so flipping `data-theme` would visibly change nothing.
 * Shipping an enabled control with no effect would be a dead control;
 * so this uses the approved feature-gated inert pattern from the Phase 2A
 * spec (§12 "Disabled"): `aria-disabled="true"`, NO activation handler at
 * all (pointer, Enter, Space — everything is inert), and a clear bilingual
 * explanation. Zero network calls (there is nothing to call).
 *
 * D-08 (persistence mechanism) and D-09 (sequencing) remain PARKED with the
 * owner. When page PRs complete theme coverage and D-08 is answered, this
 * component gains the toggle (localStorage + pre-paint `data-theme` stamp
 * sketched in app/layout.tsx implements the spec's non-binding placeholder).
 */
export function ThemeToggle({ t }: { t: Dictionary }) {
  return (
    <button
      type="button"
      className="kh-theme-toggle"
      aria-disabled="true"
      aria-label={t.theme.toggleSoon}
      title={t.theme.toggleSoon}
      data-testid="theme-toggle"
    >
      {/* Moon glyph — static; not an interactive control yet. */}
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <path
          d="M20.2 14.5A8.4 8.4 0 0 1 9.5 3.8a8.4 8.4 0 1 0 10.7 10.7Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
      <span className="kh-theme-toggle-badge">{t.theme.soon}</span>
    </button>
  );
}
