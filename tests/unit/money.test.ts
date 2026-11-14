import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_AMOUNT_PYA,
  MoneyError,
  complementPrice,
  costOf,
  displayAveragePrice,
  formatPya,
  formatPyaPrice,
  localizeDigits,
  mmkToPya,
  payoutOf,
  price,
  pyaToMmkString,
  pya,
  shares,
} from "@/src/lib/money";

test("pya rejects non-integers, negatives and oversized values", () => {
  assert.equal(pya(100), 100);
  assert.throws(() => pya(1.5), MoneyError);
  assert.throws(() => pya(-1), MoneyError);
  assert.throws(() => pya(Number.NaN), MoneyError);
  assert.throws(() => pya(MAX_AMOUNT_PYA + 1), MoneyError);
  assert.throws(() => pya(Number.MAX_SAFE_INTEGER + 2), MoneyError);
});

test("share quantities must be positive integers", () => {
  assert.equal(shares(1), 1);
  assert.throws(() => shares(0), MoneyError);
  assert.throws(() => shares(-5), MoneyError);
  assert.throws(() => shares(2.5), MoneyError);
});

test("price ticks are constrained to 1..99 inclusive", () => {
  assert.equal(price(1), 1);
  assert.equal(price(99), 99);
  assert.throws(() => price(0), MoneyError);
  assert.throws(() => price(100), MoneyError);
  assert.throws(() => price(50.5), MoneyError);
});

test("complementary YES/NO prices always sum to 100", () => {
  for (const p of [1, 2, 25, 50, 73, 98, 99]) {
    assert.equal((p as number) + complementPrice(price(p)), 100);
  }
  assert.throws(() => complementPrice(0), MoneyError);
  assert.throws(() => complementPrice(100), MoneyError);
});

test("MMK to Pya conversion is exact, including two decimals", () => {
  assert.equal(mmkToPya("1"), 100);
  assert.equal(mmkToPya("1.5"), 150);
  assert.equal(mmkToPya("1.55"), 155);
  assert.equal(mmkToPya("0.01"), 1);
  assert.equal(mmkToPya("10000"), 1_000_000);
  assert.equal(mmkToPya(1234.56), 123456);
  assert.throws(() => mmkToPya("1.555"), MoneyError);
  assert.throws(() => mmkToPya("-5"), MoneyError);
  assert.throws(() => mmkToPya("abc"), MoneyError);
  assert.throws(() => mmkToPya("1e9"), MoneyError);
});

test("Pya to MMK string is exact and never uses float division", () => {
  assert.equal(pyaToMmkString(pya(0)), "0.00");
  assert.equal(pyaToMmkString(pya(1)), "0.01");
  assert.equal(pyaToMmkString(pya(99)), "0.99");
  assert.equal(pyaToMmkString(pya(100)), "1.00");
  assert.equal(pyaToMmkString(pya(1_234_567)), "12345.67");
  assert.equal(pyaToMmkString(-250), "-2.50");
});

test("cost and payout use integer arithmetic", () => {
  assert.equal(costOf(price(34), shares(100)), 3400);
  assert.equal(costOf(price(99), shares(1_000_000)), 99_000_000);
  assert.equal(payoutOf(shares(100)), 10_000);
  assert.throws(() => costOf(99, 10 ** 13), MoneyError);
});

test("average price is display-only and safe on garbage input", () => {
  assert.equal(displayAveragePrice(3400, 100), 34);
  assert.equal(displayAveragePrice(0, 100), 0);
  assert.equal(displayAveragePrice(100, 0), 0);
  assert.throws(() => displayAveragePrice(-1, 10), MoneyError);
});

test("formatting is locale-aware and uses no cent glyph", () => {
  assert.equal(formatPya(pya(1_234_567), "en"), "K 12,345.67");
  assert.equal(formatPya(pya(1_234_567), "my"), "၁၂,၃၄၅.၆၇ ကျပ်");
  assert.equal(formatPyaPrice(34, "en"), "34 Pyas");
  assert.equal(formatPyaPrice(34, "my"), "၃၄ ပြား");
  assert.equal(localizeDigits("2026", "my"), "၂၀၂၆");
  assert.equal(localizeDigits("2026", "en"), "2026");
  for (const locale of ["en", "my"] as const) {
    assert.ok(!formatPya(pya(500), locale).includes("¢"));
  }
});

test("no money helper ever returns a non-integer", () => {
  const results = [
    mmkToPya("0.03"),
    mmkToPya("99999.99"),
    costOf(price(37), shares(7)),
    payoutOf(shares(13)),
    complementPrice(price(64)),
  ];
  for (const value of results) {
    assert.ok(Number.isInteger(value), `${value} should be an integer`);
  }
});
