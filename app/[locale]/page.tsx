import { notFound } from "next/navigation";
import HomePage from "../page";

export default async function LocalizedHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (locale !== "en" && locale !== "my") notFound();
  return <HomePage initialLocale={locale} />;
}
