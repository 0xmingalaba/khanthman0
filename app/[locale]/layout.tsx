import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppProvider } from "@/src/components/AppProvider";
import { getDictionary } from "@/src/i18n/dictionary";
import { isLocale, type Locale } from "@/src/lib/locale";

/**
 * Locale layout.
 *
 * `lang` is rendered on the server so assistive technology gets the correct
 * language on first paint, instead of after a client-side correction.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = getDictionary(locale);
  return {
    title: t.brand.fullName,
    description: t.meta.description,
    alternates: {
      canonical: `/${locale}`,
      languages: { my: "/my", en: "/en" },
    },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <div lang={locale as Locale} data-locale={locale}>
      <AppProvider>{children}</AppProvider>
    </div>
  );
}
