import test from "node:test";
import assert from "node:assert/strict";
import { isLocale, localePath, otherLocaleOf, stripLocale } from "@/src/lib/locale";
import { getDictionary } from "@/src/i18n/dictionary";

test("locale paths replace rather than stack the prefix", () => {
  assert.equal(localePath("/", "en"), "/en");
  assert.equal(localePath("/my", "en"), "/en");
  assert.equal(localePath("/my/market/abc", "en"), "/en/market/abc");
  assert.equal(localePath("/en/portfolio", "my"), "/my/portfolio");
  assert.equal(localePath("market/abc", "my"), "/my/market/abc");
});

test("stripping the locale yields a locale-independent path", () => {
  assert.equal(stripLocale("/en/market/abc"), "/market/abc");
  assert.equal(stripLocale("/my"), "/");
  assert.equal(stripLocale("/en/portfolio"), "/portfolio");
});

test("only supported locales are accepted", () => {
  assert.equal(isLocale("en"), true);
  assert.equal(isLocale("my"), true);
  assert.equal(isLocale("fr"), false);
  assert.equal(isLocale(""), false);
  assert.equal(isLocale(undefined), false);
  assert.equal(isLocale(2), false);
});

test("switching locale is symmetric", () => {
  assert.equal(otherLocaleOf("en"), "my");
  assert.equal(otherLocaleOf("my"), "en");
});

/**
 * Structural parity: a missing Burmese string is a common regression that a
 * TypeScript type cannot catch at runtime for newly added keys in either file.
 */
test("both dictionaries expose the same keys with non-empty strings", () => {
  const en = getDictionary("en");
  const my = getDictionary("my");

  const walk = (a: unknown, b: unknown, path: string): void => {
    assert.equal(typeof a, typeof b, `type mismatch at ${path}`);
    if (typeof a === "string") {
      assert.ok((b as string).trim().length > 0, `empty translation at ${path}`);
      return;
    }
    if (a && typeof a === "object") {
      const aKeys = Object.keys(a as Record<string, unknown>).sort();
      const bKeys = Object.keys(b as Record<string, unknown>).sort();
      assert.deepEqual(aKeys, bKeys, `key mismatch at ${path}`);
      for (const key of aKeys) {
        walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
      }
    }
  };

  walk(en, my, "dictionary");
});

test("Burmese copy is actually Burmese, not a copy of English", () => {
  assert.notEqual(getDictionary("my").nav.login, getDictionary("en").nav.login);
  // At least one Myanmar Unicode code point must appear in the Burmese strings.
  assert.match(getDictionary("my").nav.login, /[\u1000-\u109F]/);
});

test("the virtual-credit disclosure exists in both languages", () => {
  for (const locale of ["en", "my"] as const) {
    const t = getDictionary(locale);
    assert.ok(t.notice.virtual.length > 10);
    assert.ok(t.notice.virtualDetail.length > 20);
    assert.ok(t.portfolio.virtualOnly.length > 20);
  }
});
