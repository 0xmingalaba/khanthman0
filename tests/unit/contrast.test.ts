import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * WCAG 2.x token contrast guard (Phase 2A, spec §8.9 step 1).
 *
 * Parses the semantic token blocks in app/globals.css and asserts every
 * meaningful token pair clears its threshold in BOTH themes. Failing here means
 * a token regressed — fix the token, never the threshold.
 *
 * In-browser verification (both themes, all interactive states) remains a
 * separate manual gate for each page PR — see docs/PHASE-2A-CONTRAST-REPORT.md.
 */

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cssRaw = readFileSync(join(root, "app", "globals.css"), "utf8");
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, ""); // strip comments

function tokenBlock(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blocks = [...css.matchAll(new RegExp(escaped + "\\s*\\{([^}]*)\\}", "g"))];
  assert.ok(blocks.length > 0, `token block not found: ${selector}`);
  const tokens: Record<string, string> = {};
  for (const match of blocks) {
    for (const decl of match[1].split(";")) {
      const m = decl.match(/^\s*(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*$/);
      if (m) tokens[m[1]] = m[2].toLowerCase();
    }
  }
  return tokens;
}

const light = tokenBlock(":root");
const dark = tokenBlock(':root[data-theme="dark"]');

const luminance = (hex: string): number => {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? [...c].map((ch) => ch + ch).join("") : c.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const SURFACES = ["--bg", "--surface", "--surface-2", "--surface-3"] as const;

const cases: Array<[string, string, string, number]> = [];
for (const s of SURFACES) {
  cases.push([`--text on ${s}`, "--text", s, 4.5]);
  cases.push([`--muted on ${s}`, "--muted", s, 4.5]);
  cases.push([`--line-strong on ${s}`, "--line-strong", s, 3]);
  cases.push([`--down on ${s}`, "--down", s, 4.5]);
  cases.push([`--up on ${s}`, "--up", s, 4.5]);
}
cases.push(["--on-accent on --accent", "--on-accent", "--accent", 4.5]);
cases.push(["--accent on --bg", "--accent", "--bg", 4.5]);
cases.push(["--accent-hover on --bg", "--accent-hover", "--bg", 4.5]);
cases.push(["--accent on --accent-soft", "--accent", "--accent-soft", 4.5]);
cases.push(["--accent-hover on --accent-soft", "--accent-hover", "--accent-soft", 4.5]);
cases.push(["--muted on --surface-3 (disabled)", "--muted", "--surface-3", 4.5]);
cases.push(["--input text on --input-surface", "--text", "--input-surface", 4.5]);
cases.push(["--down on --danger-surface", "--down", "--danger-surface", 4.5]);
cases.push(["--warning-ink on --warning-surface", "--warning-ink", "--warning-surface", 4.5]);
cases.push(["--focus-ring on --bg", "--focus-ring", "--bg", 3]);
cases.push(["--focus-ring on --surface", "--focus-ring", "--surface", 3]);

for (const [label, fg, bg, min] of cases) {
  test(`${label} — both themes ≥ ${min}:1`, () => {
    assert.ok(light[fg], `light missing ${fg}`);
    assert.ok(light[bg], `light missing ${bg}`);
    assert.ok(dark[fg], `dark missing ${fg}`);
    assert.ok(dark[bg], `dark missing ${bg}`);
    const l = ratio(light[fg], light[bg]);
    const d = ratio(dark[fg], dark[bg]);
    assert.ok(l >= min, `light ${label}: ${l.toFixed(2)} < ${min}`);
    assert.ok(d >= min, `dark ${label}: ${d.toFixed(2)} < ${min}`);
  });
}
