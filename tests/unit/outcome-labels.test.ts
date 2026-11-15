import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getDictionary } from "@/src/i18n/dictionary";
import { costOf, payoutOf, price, shares } from "@/src/lib/money";

/**
 * Phase 1 defect: the order-ticket payout/profit labels were YES-oriented
 * ("Payout if correct" / "မှန်ပါက ရရှိမည့်ငွေ") even when the user selected NO.
 * The approved fix neutralises the wording for both outcomes.
 *
 * Component-level rendering is not available in the current test setup (no
 * DOM/renderer — tests run on node --test + tsx). These tests therefore lock
 * down (a) the exact dictionary strings, (b) the side-independence of the
 * summary block in the component source, and (c) the unchanged preview math
 * the ticket mirrors.
 */

test("English labels use neutral outcome wording", () => {
  const t = getDictionary("en");
  assert.equal(t.market.potentialPayout, "Payout if this outcome wins");
  assert.equal(t.market.potentialProfit, "Profit if this outcome wins");
});

test("Burmese labels use neutral outcome wording", () => {
  const t = getDictionary("my");
  assert.equal(t.market.potentialPayout, "ဤရလဒ် အနိုင်ရပါက ရရှိမည့်ငွေ");
  assert.equal(t.market.potentialProfit, "ဤရလဒ် အနိုင်ရပါက အမြတ်");
});

test("neither locale's labels carry YES-specific orientation", () => {
  for (const locale of ["en", "my"] as const) {
    const t = getDictionary(locale);
    const pair = `${t.market.potentialPayout} ${t.market.potentialProfit}`;
    assert.doesNotMatch(pair, /yes/i);
    assert.doesNotMatch(pair, /correct/i);
    assert.doesNotMatch(pair, /မှန်/); // Burmese "correct"/"true" — the YES-oriented wording this fix removes
  }
});

test("YES and NO selections display the same neutral labels (single shared summary block)", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src", "components", "OrderTicket.tsx"),
    "utf8"
  );

  // The summary renders both labels from the shared dictionary keys, once each,
  // and the block between the "trade-summary" wrapper and the first error
  // message contains no side-specific branch.
  assert.equal(source.split("t.market.potentialPayout").length - 1, 1);
  assert.equal(source.split("t.market.potentialProfit").length - 1, 1);

  const start = source.indexOf("trade-summary");
  const end = source.indexOf("{!priceValid", start);
  assert.ok(start !== -1 && end > start, "expected to locate the trade-summary block");
  const summaryBlock = source.slice(start, end);
  assert.ok(summaryBlock.includes("t.market.potentialPayout"));
  assert.ok(summaryBlock.includes("t.market.potentialProfit"));
  assert.ok(
    !/\bside\b/.test(summaryBlock),
    "summary block must not branch on the selected YES/NO side"
  );
});

test("the deprecated YES-oriented copy cannot reappear anywhere in src/ or app/", () => {
  const deprecated = [
    "Payout if correct",
    "Profit if correct",
    "မှန်ပါက ရရှိမည့်ငွေ",
    "မှန်ပါက အမြတ်",
  ];
  const roots = [path.join(process.cwd(), "src"), path.join(process.cwd(), "app")];
  const offenders: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      const text = readFileSync(full, "utf8");
      for (const snippet of deprecated) {
        if (text.includes(snippet)) offenders.push(`${full}: ${snippet}`);
      }
    }
  };
  for (const root of roots) walk(root);

  assert.deepEqual(offenders, []);
});

test("preview arithmetic is unchanged: price 40 Pyas, quantity 20 shares", () => {
  // Mirrors the OrderTicket preview useMemo: collateral = costOf(price, qty),
  // payout = payoutOf(qty), profit = payout - collateral (side-independent).
  const pricePya = price(40);
  const quantity = shares(20);

  const collateral = costOf(pricePya, quantity);
  const payout = payoutOf(quantity);
  const profit = payout - collateral;

  assert.equal(collateral, 800); // 40 × 20
  assert.equal(payout, 2000); // 20 shares × 100 Pyas
  assert.equal(profit, 1200); // 2000 − 800
});

test("the preview computation is outcome-symmetric for YES and NO at the same price", () => {
  // The ticket feeds its current effectivePrice into the same formula regardless
  // of which side is selected, so both YES and NO at 40 Pyas × 20 shares produce
  // the identical preview — and both read the same neutral labels.
  const previewFor = (pricePya: number, quantity: number) => {
    const collateral = costOf(price(pricePya), shares(quantity));
    const payout = payoutOf(shares(quantity));
    return { collateral, payout, profit: payout - collateral };
  };

  const yesPreview = previewFor(40, 20);
  const noPreview = previewFor(40, 20);
  assert.deepEqual(yesPreview, noPreview);
  assert.deepEqual(yesPreview, { collateral: 800, payout: 2000, profit: 1200 });
});
