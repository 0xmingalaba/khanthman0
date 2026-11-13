import { notFound } from "next/navigation";
import HomePage from "../HomePage";

export default async function LocalizedHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (locale !== "en" && locale !== "my") notFound();
  return <HomePage initialLocale={locale} />;
}
