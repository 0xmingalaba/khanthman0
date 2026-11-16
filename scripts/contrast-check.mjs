#!/usr/bin/env node
/**
 * Phase 2A — design-token contrast verification (spec §8.9, method step 1).
 *
 * Parses the semantic token blocks in app/globals.css (`:root` = light,
 * `:root[data-theme="dark"]` = dark), computes WCAG 2.x relative-luminance
 * ratios for every meaningful token pair in both themes, and prints a
 * markdown table. Exits non-zero if any pair that must clear a threshold
 * does not. Stdlib only; no dependencies.
 *
 * NOTE: computed ratios, not in-browser measurements (spec §8.9 step 2/3 —
 * see docs/PHASE-2A-CONTRAST-REPORT.md).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cssRaw = readFileSync(join(root, "app", "globals.css"), "utf8");
// Strip comments before parsing so `;` inside comments cannot break declarations.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");

function tokenBlock(selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g");
  const blocks = [...css.matchAll(re)];
  if (blocks.length === 0) throw new Error(`token block not found: ${selector}`);
  const tokens = {};
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

const luminance = (hex) => {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? [...c].map((ch) => ch + ch).join("") : c.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** [description, foreground token, background token, minimum ratio, required?] */
const SURFACES = ["--bg", "--surface", "--surface-2", "--surface-3"];
const pairs = [];
for (const s of SURFACES) {
  pairs.push([`--text on ${s}`, "--text", s, 4.5]);
  pairs.push([`--muted on ${s}`, "--muted", s, 4.5]);
  pairs.push([`--line-strong (UI boundary) on ${s}`, "--line-strong", s, 3]);
  pairs.push([`--line (decorative) on ${s}`, "--line", s, 0]);
  pairs.push([`--down on ${s}`, "--down", s, 4.5]);
  pairs.push([`--up on ${s}`, "--up", s, 4.5]);
}
pairs.push(["--on-accent on --accent", "--on-accent", "--accent", 4.5]);
pairs.push(["--accent on --bg", "--accent", "--bg", 4.5]);
pairs.push(["--accent-hover on --bg", "--accent-hover", "--bg", 4.5]);
pairs.push(["--accent on --accent-soft", "--accent", "--accent-soft", 4.5]);
pairs.push(["--accent-hover on --accent-soft", "--accent-hover", "--accent-soft", 4.5]);
pairs.push(["--muted on --surface-3 (disabled)", "--muted", "--surface-3", 4.5]);
pairs.push(["--input text on --input-surface", "--text", "--input-surface", 4.5]);
pairs.push(["--down on --danger-surface", "--down", "--danger-surface", 4.5]);
pairs.push(["--warning-ink on --warning-surface", "--warning-ink", "--warning-surface", 4.5]);
pairs.push(["--focus-ring on --bg", "--focus-ring", "--bg", 3]);
pairs.push(["--focus-ring on --surface", "--focus-ring", "--surface", 3]);

const fmt = (n) => n.toFixed(2);
let failures = 0;
const lines = [];
lines.push("| Pair | Light | Dark | Required | Result |");
lines.push("|---|---|---|---|---|");
for (const [label, fg, bg, min] of pairs) {
  if (!light[fg] || !light[bg] || !dark[fg] || !dark[bg]) {
    lines.push(`| ${label} | MISSING TOKEN | MISSING | ≥${min} | **FAIL** |`);
    failures += 1;
    continue;
  }
  const l = ratio(light[fg], light[bg]);
  const d = ratio(dark[fg], dark[bg]);
  const ok = l >= min && d >= min;
  if (!ok) failures += 1;
  lines.push(`| ${label} (${light[fg]}/${light[bg]} ↔ ${dark[fg]}/${dark[bg]}) | ${fmt(l)} | ${fmt(d)} | ≥${min} | ${ok ? "PASS" : "**FAIL**"} |`);
}
console.log(lines.join("\n"));
console.log(`\nFailures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
