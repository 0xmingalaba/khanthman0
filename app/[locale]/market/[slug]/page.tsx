import { notFound } from "next/navigation";
import { MarketView } from "@/src/components/MarketView";
import { getDictionary } from "@/src/i18n/dictionary";
import { isLocale } from "@/src/lib/locale";
import { getMarketBySlug } from "@/src/domain/markets";
import { getDatabase } from "@/src/db";

export const dynamic = "force-dynamic";

/**
 * Market detail page.
 *
 * Rendered on the server from the database, so the first paint contains real
 * content (good for both latency and crawlability), with the client component
 * taking over for trading.
 */
export default async function MarketPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();

  let initialMarket = null;
  try {
    const db = await getDatabase();
    initialMarket = await getMarketBySlug(db, slug);
  } catch {
    // A database outage must not 500 the whole page; the client shows a retry.
    initialMarket = null;
  }

  return (
    <MarketView locale={locale} t={getDictionary(locale)} slug={slug} initialMarket={initialMarket} />
  );
}
