import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { generateMetadata } from "@/app/[locale]/layout";
import { getDictionary } from "@/src/i18n/dictionary";
import type { Locale } from "@/src/lib/locale";

const APPROVED_BRAND = {
  en: {
    name: "Khant Hman",
    fullName: "Khant Hman Prediction Market",
    suffix: "PREDICTION MARKET",
  },
  my: {
    name: "ခန့်မှန်း",
    fullName: "ခန့်မှန်း ဈေးကွက်",
    suffix: "ခန့်မှန်း ဈေးကွက်",
  },
} as const satisfies Record<Locale, { name: string; fullName: string; suffix: string }>;

function stringEntries(value: unknown, path = "dictionary"): Array<[string, string]> {
  if (typeof value === "string") return [[path, value]];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      stringEntries(child, `${path}.${key}`)
    );
  }
  return [];
}

describe("approved product branding", () => {
  for (const locale of ["en", "my"] as const) {
    test(`${locale} exposes the exact compact, full and descriptor names`, () => {
      assert.deepEqual(getDictionary(locale).brand, APPROVED_BRAND[locale]);
    });

    test(`${locale} user-facing copy contains no old product name`, () => {
      for (const [path, copy] of stringEntries(getDictionary(locale))) {
        assert.doesNotMatch(copy, /mingala|nan\s*htauk/i, `old product name at ${path}`);
        assert.doesNotMatch(copy, /နံထောက်/, `old product name at ${path}`);
      }
    });

    test(`${locale} metadata uses the full name and preserves locale alternates`, async () => {
      const t = getDictionary(locale);
      assert.deepEqual(
        await generateMetadata({ params: Promise.resolve({ locale }) }),
        {
          title: APPROVED_BRAND[locale].fullName,
          description: t.meta.description,
          alternates: {
            canonical: `/${locale}`,
            languages: { my: "/my", en: "/en" },
          },
        }
      );
    });
  }

  test("unsupported locales do not receive branded metadata", async () => {
    assert.deepEqual(
      await generateMetadata({ params: Promise.resolve({ locale: "fr" }) }),
      {}
    );
  });

  test("root metadata declares the approved full and compact names", () => {
    // The root layout imports CSS, which the plain Node unit-test runner cannot
    // load. Assert its committed declaration here; the production build and HTTP
    // checks exercise the framework's actual metadata rendering separately.
    const source = readFileSync(resolve(process.cwd(), "app/layout.tsx"), "utf8");
    const declaration = /export const metadata: Metadata = \{([\s\S]*?)\n\};/.exec(source);
    assert.ok(declaration, "root metadata declaration must exist");
    assert.match(declaration[1], /title: "Khant Hman Prediction Market"/);
    assert.match(
      declaration[1],
      /description: "Explore questions about the future with Khant Hman Prediction Market\. Virtual credits only\."/
    );
    assert.match(declaration[1], /applicationName: "Khant Hman"/);
    assert.doesNotMatch(declaration[1], /mingala|nan\s*htauk/i);
    assert.doesNotMatch(declaration[1], /နံထောက်/);
  });
});
