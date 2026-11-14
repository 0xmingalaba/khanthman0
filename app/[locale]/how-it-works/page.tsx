import { notFound } from "next/navigation";
import Link from "next/link";
import { getDictionary } from "@/src/i18n/dictionary";
import { isLocale } from "@/src/lib/locale";

export default async function HowItWorksPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);

  const steps =
    locale === "my"
      ? [
          ["မေးခွန်းတစ်ခု ရှာပါ", "မြန်မာနှင့် ကမ္ဘာ့ ဖြစ်ရပ်များအပေါ် မေးခွန်းများကို လေ့လာပါ။"],
          ["သင့်အမြင်ကို ယူပါ", "မှန် သို့မဟုတ် မှား ရှယ်ယာများကို သရုပ်ပြခရက်ဒစ်ဖြင့် ဝယ်ယူပါ။"],
          ["ရလဒ်ကို စောင့်ကြည့်ပါ", "ဈေးကွက်ပိတ်ပြီး စည်းမျဉ်းများအတိုင်း ဆုံးဖြတ်သောအခါ မှန်သောရှယ်ယာတစ်ခုလျှင် ၁၀၀ ပြား ရရှိသည်။"],
        ]
      : [
          ["Find a question", "Browse markets about events in Myanmar and around the world."],
          ["Take a position", "Buy YES or NO shares with virtual credits. Collateral is reserved up front."],
          ["Follow the outcome", "When a market closes and resolves under its published rules, each winning share pays 100 Pyas."],
        ];

  return (
    <main className="app-shell">
      <div className="virtual-ribbon" role="note">
        <span className="pulse-dot" aria-hidden="true" /> {t.notice.virtual}
      </div>
      <section className="workspace">
        <div className="section-heading">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-line" /> {t.nav.howItWorks}
            </div>
            <h2>
              {t.hero.title}
              <span>.</span>
            </h2>
            <p>{t.hero.intro}</p>
          </div>
        </div>

        <div className="how-steps">
          {steps.map(([title, detail], index) => (
            <div key={title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{title}</strong>
              <p>{detail}</p>
            </div>
          ))}
        </div>

        <p className="panel-disclaimer">{t.notice.virtualDetail}</p>
        <p className="panel-disclaimer">{t.portfolio.notMarkedDetail}</p>

        <Link className="primary-cta" href={`/${locale}`}>
          {t.actions.viewAll} →
        </Link>
      </section>
    </main>
  );
}
