import { notFound } from "next/navigation";
import { AuthView } from "@/src/components/AuthView";
import { getDictionary } from "@/src/i18n/dictionary";
import { isLocale } from "@/src/lib/locale";

export default async function SignupPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <AuthView locale={locale} t={getDictionary(locale)} mode="signup" />;
}
