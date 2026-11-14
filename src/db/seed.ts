/**
 * Development seed data.
 *
 * These markets are clearly development fixtures: their slugs are prefixed
 * `dev-`, they are only created by an explicit `db:seed` command, and the API
 * exposes real order-book state rather than fabricated prices. An empty book
 * reports "no price yet" instead of a made-up probability.
 *
 * Never run this against production data.
 */

import type { Database } from "./executor";
import { registerUser } from "@/src/domain/accounts";

type SeedMarket = {
  slug: string;
  categoryId: string;
  questionEn: string;
  questionMy: string;
  descriptionEn: string;
  descriptionMy: string;
  rulesEn: string;
  rulesMy: string;
  criteriaEn: string;
  criteriaMy: string;
  closeInDays: number;
  sources: { label: string; url: string }[];
};

const MARKETS: SeedMarket[] = [
  {
    slug: "dev-usd-mmk-below-4000",
    categoryId: "economy",
    questionEn: "Will USD/MMK trade below 4,000 on 31 December 2026?",
    questionMy: "၂၀၂၆ ဒီဇင်ဘာ ၃၁ ရက်တွင် USD/MMK သည် ၄,၀၀၀ အောက် ရောက်မည်လား။",
    descriptionEn:
      "A market on the official USD/MMK reference rate at the end of 2026. The question is about the published reference rate, not any parallel market rate.",
    descriptionMy:
      "၂၀၂၆ နှစ်ကုန်တွင် တရားဝင် USD/MMK ရည်ညွှန်းနှုန်းအပေါ် အခြေခံသည့် ဈေးကွက်ဖြစ်သည်။ အပြိုင်ဈေးကွက်နှုန်းများ မပါဝင်ပါ။",
    rulesEn:
      "YES resolves if the reference rate published for 31 December 2026 is strictly below 4,000 MMK per US dollar. Otherwise NO.",
    rulesMy:
      "၂၀၂၆ ဒီဇင်ဘာ ၃၁ ရက်အတွက် ထုတ်ပြန်သည့် ရည်ညွှန်းနှုန်းသည် တစ်ဒေါ်လာလျှင် ၄,၀၀၀ ကျပ်အောက် ရှိပါက မှန် ဖြစ်သည်။ မဟုတ်ပါက မှား။",
    criteriaEn: "Resolve from the official reference rate published by the Central Bank of Myanmar for the stated date.",
    criteriaMy: "သတ်မှတ်ရက်အတွက် မြန်မာနိုင်ငံတော်ဗဟိုဘဏ် ထုတ်ပြန်သည့် တရားဝင်ရည်ညွှန်းနှုန်းကို အသုံးပြုရမည်။",
    closeInDays: 47,
    sources: [{ label: "Central Bank of Myanmar", url: "https://www.cbm.gov.mm/" }],
  },
  {
    slug: "dev-yangon-heavy-rain-days",
    categoryId: "myanmar",
    questionEn: "Will Yangon record more than 10 heavy-rain days in December 2026?",
    questionMy: "၂၀၂၆ ဒီဇင်ဘာလတွင် ရန်ကုန်တွင် မိုးသည်းထန်သည့်ရက် ၁၀ ရက်ကျော် ရှိမည်လား။",
    descriptionEn:
      "Counts days in December 2026 at the Yangon meteorological station that record rainfall above the published heavy-rain threshold.",
    descriptionMy:
      "၂၀၂၆ ဒီဇင်ဘာလအတွင်း ရန်ကုန် မိုးလေဝသစခန်းတွင် ထုတ်ပြန်သည့် မိုးသည်းထန်သတ်မှတ်ချက်ထက် ကျော်လွန်သည့် ရက်များကို ရေတွက်သည်။",
    rulesEn:
      "YES resolves if the station reports 11 or more qualifying days in December 2026. A single station is used so the count is unambiguous.",
    rulesMy:
      "၂၀၂၆ ဒီဇင်ဘာလတွင် သတ်မှတ်ချက်ပြည့်မီသည့် ၁၁ ရက် သို့မဟုတ် ထို့ထက်ပို၍ ရှိပါက မှန် ဖြစ်သည်။ စခန်းတစ်ခုတည်းကို အသုံးပြုသည်။",
    criteriaEn: "Resolve from the Department of Meteorology and Hydrology daily observations for Yangon.",
    criteriaMy: "မိုးလေဝသနှင့် ဇလဗေဒညွှန်ကြားမှုဦးစီးဌာန၏ ရန်ကုန်နေ့စဉ်တိုင်းတာချက်များကို အသုံးပြုရမည်။",
    closeInDays: 16,
    sources: [{ label: "Department of Meteorology and Hydrology", url: "https://www.moezala.gov.mm/" }],
  },
  {
    slug: "dev-fed-rate-cut-next-meeting",
    categoryId: "world",
    questionEn: "Will the Federal Reserve cut its target range at the next FOMC meeting?",
    questionMy: "နောက်လာမည့် FOMC အစည်းအဝေးတွင် Federal Reserve က အတိုးနှုန်းကို လျှော့ချမည်လား။",
    descriptionEn:
      "A market on the published federal funds target range decision at the next scheduled FOMC meeting.",
    descriptionMy:
      "နောက်လာမည့် FOMC အစည်းအဝေးတွင် ထုတ်ပြန်မည့် federal funds အတိုးနှုန်းအပိုင်းအခြား ဆုံးဖြတ်ချက်အပေါ် အခြေခံသည်။",
    rulesEn:
      "YES resolves if the upper bound of the target range is lower after the meeting than before it. A hold or a hike resolves NO.",
    rulesMy:
      "အစည်းအဝေးအပြီးတွင် အတိုးနှုန်းအပိုင်းအခြား၏ အထက်ကန့်သတ်ချက် လျော့နည်းပါက မှန် ဖြစ်သည်။ မပြောင်းလဲခြင်း သို့မဟုတ် တိုးခြင်းသည် မှား။",
    criteriaEn: "Resolve from the official FOMC statement published by the Federal Reserve.",
    criteriaMy: "Federal Reserve ထုတ်ပြန်သည့် တရားဝင် FOMC ကြေညာချက်ကို အသုံးပြုရမည်။",
    closeInDays: 9,
    sources: [{ label: "Federal Reserve", url: "https://www.federalreserve.gov/" }],
  },
  {
    slug: "dev-ai-model-release-before-year-end",
    categoryId: "technology",
    questionEn: "Will a new frontier AI model be publicly released before 31 December 2026?",
    questionMy: "၂၀၂၆ ဒီဇင်ဘာ ၃၁ ရက်မတိုင်မီ အဆင့်မြင့် AI မော်ဒယ်သစ်တစ်ခု ထွက်ရှိမည်လား။",
    descriptionEn:
      "A market on whether a generally accessible frontier model from a major lab ships before the end of 2026.",
    descriptionMy:
      "အဓိကဓာတ်ခွဲခန်းတစ်ခုမှ အများပြည်သူအသုံးပြုနိုင်သည့် အဆင့်မြင့် AI မော်ဒယ်တစ်ခု ၂၀၂၆ မကုန်မီ ထွက်ရှိမည်လား။",
    rulesEn:
      "YES resolves if a model qualifying under the published criteria is generally available before 31 December 2026 23:59 UTC. Gated research previews do not count.",
    rulesMy:
      "ထုတ်ပြန်ထားသည့် သတ်မှတ်ချက်ပြည့်မီသော မော်ဒယ်တစ်ခုကို ၂၀၂၆ ဒီဇင်ဘာ ၃၁ ရက် ၂၃:၅၉ UTC မတိုင်မီ အများပြည်သူ အသုံးပြုနိုင်ပါက မှန် ဖြစ်သည်။ ကန့်သတ်ထားသော research preview များ မပါဝင်ပါ။",
    criteriaEn: "Resolve from the provider's own public release announcement.",
    criteriaMy: "ဝန်ဆောင်မှုပေးသူ၏ တရားဝင် ထုတ်ပြန်ကြေညာချက်ကို အသုံးပြုရမည်။",
    closeInDays: 47,
    sources: [{ label: "Provider announcements", url: "https://openai.com/news/" }],
  },
  {
    slug: "dev-premier-league-top-two",
    categoryId: "sports",
    questionEn: "Will Arsenal finish in the Premier League top two this season?",
    questionMy: "ဤရာသီ ပရီးမီးယားလိဂ်တွင် Arsenal သည် ထိပ်ဆုံးနှစ်သင်းအတွင်း ပါဝင်မည်လား။",
    descriptionEn: "A season-long market on the final Premier League table for the current season.",
    descriptionMy: "လက်ရှိရာသီ ပရီးမီးယားလိဂ် နောက်ဆုံးအဆင့်ရပ်တည်မှုအပေါ် ရာသီတစ်ခုလုံး ဈေးကွက်ဖြစ်သည်။",
    rulesEn: "YES resolves if Arsenal is placed first or second in the official final league table.",
    rulesMy: "တရားဝင် နောက်ဆုံးအဆင့်ဇယားတွင် Arsenal သည် ပထမ သို့မဟုတ် ဒုတိယ ရပ်တည်ပါက မှန် ဖြစ်သည်။",
    criteriaEn: "Resolve from the official final Premier League standings.",
    criteriaMy: "ပရီးမီးယားလိဂ်၏ တရားဝင် နောက်ဆုံးအဆင့်ရပ်တည်မှုကို အသုံးပြုရမည်။",
    closeInDays: 180,
    sources: [{ label: "Premier League", url: "https://www.premierleague.com/" }],
  },
];

export async function seedDevelopmentData(db: Database): Promise<{ markets: number; users: number }> {
  const existing = await db.query<{ c: number }>(
    "SELECT count(*)::int AS c FROM markets WHERE slug LIKE 'dev-%'"
  );

  if (existing.rows[0].c === 0) {
    for (const market of MARKETS) {
      const closeAt = new Date(Date.now() + market.closeInDays * 24 * 60 * 60 * 1000);
      const created = await db.query<{ id: string }>(
        `INSERT INTO markets
           (slug, category_id, question_en, question_my, description_en, description_my,
            rules_en, rules_my, resolution_criteria_en, resolution_criteria_my,
            status, opens_at, close_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open', now() - interval '1 day', $11)
         RETURNING id`,
        [
          market.slug,
          market.categoryId,
          market.questionEn,
          market.questionMy,
          market.descriptionEn,
          market.descriptionMy,
          market.rulesEn,
          market.rulesMy,
          market.criteriaEn,
          market.criteriaMy,
          closeAt,
        ]
      );
      for (const [index, source] of market.sources.entries()) {
        await db.query(
          "INSERT INTO market_sources (market_id, label, url, sort_order) VALUES ($1,$2,$3,$4)",
          [created.rows[0].id, source.label, source.url, index]
        );
      }
    }
  }

  // Development accounts only. Passwords are printed so a developer can sign in,
  // and they exist only when the seed command is run explicitly.
  let users = 0;
  const existingUsers = await db.query<{ c: number }>(
    "SELECT count(*)::int AS c FROM users WHERE email LIKE '%@dev.mingala.local'"
  );
  if (existingUsers.rows[0].c === 0) {
    for (const [handle, role] of [
      ["demo", "user"],
      ["maker", "user"],
      ["resolver", "resolver"],
      ["admin", "admin"],
    ] as const) {
      const created = await registerUser(db, {
        email: `${handle}@dev.mingala.local`,
        password: "mingala-dev-password-2026",
        displayName: `Dev ${handle}`,
        locale: "en",
      });
      if (role !== "user") {
        await db.query("UPDATE users SET role = $2 WHERE id = $1", [created.id, role]);
      }
      users += 1;
    }
  }

  const total = await db.query<{ c: number }>("SELECT count(*)::int AS c FROM markets WHERE slug LIKE 'dev-%'");
  return { markets: total.rows[0].c, users };
}
