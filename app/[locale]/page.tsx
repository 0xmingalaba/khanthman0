import { notFound } from "next/navigation";
import { HomeView } from "@/src/components/HomeView";
import { getDictionary } from "@/src/i18n/dictionary";
import { isLocale } from "@/src/lib/locale";
import { listMarkets } from "@/src/domain/markets";
import { getDatabase } from "@/src/db";

export const dynamic = "force-dynamic";

export default async function LocalizedHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  // Render the catalogue on the server so the first paint contains real markets.
  // A database failure degrades to the client retry state rather than a 500.
  let initialMarkets = null;
  try {
    const db = await getDatabase();
    initialMarkets = await listMarkets(db, { limit: 60 });
  } catch {
    initialMarkets = null;
  }

  return <HomeView locale={locale} t={getDictionary(locale)} initialMarkets={initialMarkets} />;
}
