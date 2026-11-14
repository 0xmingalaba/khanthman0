import { notFound } from "next/navigation";
import { PortfolioView } from "@/src/components/PortfolioView";
import { getDictionary } from "@/src/i18n/dictionary";
import { isLocale } from "@/src/lib/locale";

export const dynamic = "force-dynamic";

export default async function PortfolioPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <PortfolioView locale={locale} t={getDictionary(locale)} />;
}
