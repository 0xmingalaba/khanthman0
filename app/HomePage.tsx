"use client";

import { useEffect, useMemo, useState } from "react";

type Locale = "en" | "my";
type Category = "All" | "Myanmar" | "Economy" | "Crypto" | "World" | "Sports" | "Technology";
type Market = {
  id: number; category: Exclude<Category, "All">; question: string; questionMm: string;
  yes: number; volume: number; change: number; closes: string; symbol: string; tone: string;
  description: string; descriptionMm: string; resolution: string; resolutionMm: string;
};
type Position = { marketId: number; side: "YES" | "NO"; shares: number; averagePrice: number };
type Activity = { id: string; marketId: number; side: "YES" | "NO"; shares: number; price: number; cost: number; at: string };

const markets: Market[] = [
  { id: 1, category: "Economy", question: "Will USD/MMK trade below 4,000 by December 31?", questionMm: "ဒီဇင်ဘာ ၃၁ ရက်မတိုင်မီ USD/MMK ၄,၀၀၀ အောက် ရောက်မလား။", yes: 34, volume: 12840000, change: 4.2, closes: "Dec 31", symbol: "ကျပ်", tone: "mint", description: "A question about the USD/MMK exchange rate and the direction of Myanmar's currency market.", descriptionMm: "အမေရိကန်ဒေါ်လာနှင့် မြန်မာကျပ် ငွေလဲနှုန်းအကြောင်း မေးခွန်းဖြစ်သည်။", resolution: "A real market must name an authoritative reference-rate source, observation date and timezone.", resolutionMm: "တကယ့်ဈေးကွက်တွင် တရားဝင်ရည်ညွှန်းနှုန်းရင်းမြစ်၊ စောင့်ကြည့်မည့်ရက်နှင့် အချိန်ဇုန်ကို သတ်မှတ်ရမည်။" },
  { id: 2, category: "Myanmar", question: "Will Myanmar rice exports increase this quarter?", questionMm: "ယခုသုံးလပတ်တွင် မြန်မာ့ဆန်တင်ပို့မှု တိုးလာမလား။", yes: 67, volume: 8420000, change: 2.8, closes: "Dec 31", symbol: "🌾", tone: "gold", description: "A question about the change in Myanmar rice export volumes during the current quarter.", descriptionMm: "ယခုသုံးလပတ်အတွင်း မြန်မာ့ဆန်တင်ပို့မှုပမာဏ ပြောင်းလဲမှုကို မေးမြန်းထားသည်။", resolution: "A real market must define the official export dataset and comparison period.", resolutionMm: "တကယ့်ဈေးကွက်တွင် တရားဝင်ပို့ကုန်ဒေတာနှင့် နှိုင်းယှဉ်မည့်ကာလကို သတ်မှတ်ရမည်။" },
  { id: 3, category: "Crypto", question: "Will Bitcoin close above $110,000 this year?", questionMm: "ယခုနှစ်အတွင်း Bitcoin ဈေးနှုန်း ဒေါ်လာ ၁၁၀,၀၀၀ အထက် ပိတ်မလား။", yes: 58, volume: 32100000, change: -1.4, closes: "Dec 31", symbol: "₿", tone: "violet", description: "A market tracking the year-end closing price of Bitcoin.", descriptionMm: "နှစ်ကုန် Bitcoin ပိတ်ဈေးနှုန်းကို စောင့်ကြည့်သည့် မေးခွန်းဖြစ်သည်။", resolution: "A real market must specify the BTC/USD benchmark, source and UTC cutoff.", resolutionMm: "တကယ့်ဈေးကွက်တွင် BTC/USD ရည်ညွှန်းဈေး၊ ရင်းမြစ်နှင့် UTC ဖြတ်တောက်ချိန်ကို သတ်မှတ်ရမည်။" },
  { id: 4, category: "World", question: "Will the Fed cut interest rates at its next meeting?", questionMm: "နောက်လာမည့် အစည်းအဝေးတွင် Fed က အတိုးနှုန်း လျှော့ချမလား။", yes: 72, volume: 19600000, change: 1.1, closes: "Dec 10", symbol: "⌁", tone: "blue", description: "A market about the next announced Federal Reserve policy-rate decision.", descriptionMm: "အမေရိကန် Federal Reserve ၏ နောက်လာမည့် အတိုးနှုန်းဆုံးဖြတ်ချက်အကြောင်း ဖြစ်သည်။", resolution: "Resolve using the official Federal Reserve statement for the specified meeting.", resolutionMm: "သတ်မှတ်ထားသော အစည်းအဝေးအတွက် Federal Reserve ၏ တရားဝင်ကြေညာချက်ကို အသုံးပြုဆုံးဖြတ်ရမည်။" },
  { id: 5, category: "Sports", question: "Will Arsenal finish in the Premier League top two?", questionMm: "ပရီးမီးယားလိဂ်တွင် Arsenal က ထိပ်ဆုံးနှစ်သင်းအတွင်း ဝင်မလား။", yes: 41, volume: 6750000, change: -2.3, closes: "May 24", symbol: "⚽", tone: "coral", description: "A season-long question about the final Premier League table.", descriptionMm: "ပရီးမီးယားလိဂ်ရာသီအပြီး နောက်ဆုံးအဆင့်ရပ်တည်မှုအကြောင်း ဖြစ်သည်။", resolution: "Resolve using the official final Premier League standings.", resolutionMm: "ပရီးမီးယားလိဂ်၏ တရားဝင်နောက်ဆုံးအဆင့်ရပ်တည်မှုကို အသုံးပြုဆုံးဖြတ်ရမည်။" },
  { id: 6, category: "Myanmar", question: "Will Yangon record more than 10 days of heavy rain this month?", questionMm: "ယခုလ ရန်ကုန်တွင် မိုးသည်းထန်စွာ ရွာသည့်ရက် ၁၀ ရက်ကျော် ရှိမလား။", yes: 23, volume: 4120000, change: 0.7, closes: "Nov 30", symbol: "☂", tone: "blue", description: "A weather question based on daily rainfall observations in Yangon.", descriptionMm: "ရန်ကုန်မြို့၏ နေ့စဉ်မိုးရေချိန်တိုင်းတာချက်များအပေါ် အခြေခံသည့် မေးခွန်းဖြစ်သည်။", resolution: "A real market must define the weather station and measurable rainfall threshold.", resolutionMm: "တကယ့်ဈေးကွက်တွင် မိုးလေဝသစခန်းနှင့် မိုးရေချိန်သတ်မှတ်ချက်ကို တိတိကျကျ ဖော်ပြရမည်။" },
  { id: 7, category: "Technology", question: "Will a major AI model launch before year-end?", questionMm: "ယခုနှစ်မကုန်မီ အဆင့်မြင့် AI မော်ဒယ်သစ် ထွက်ရှိမလား။", yes: 61, volume: 9100000, change: 3.6, closes: "Dec 31", symbol: "✳", tone: "mint", description: "A market about a publicly announced release of a new frontier AI model.", descriptionMm: "AI မော်ဒယ်အသစ်တစ်ခုကို အများပြည်သူသို့ တရားဝင်မိတ်ဆက်မည်၊ မမိတ်ဆက်မည်ကို မေးမြန်းထားသည်။", resolution: "A real market must define qualifying capabilities and what counts as a public launch.", resolutionMm: "တကယ့်ဈေးကွက်တွင် သတ်မှတ်ချက်ပြည့်မီသော စွမ်းဆောင်ရည်နှင့် အများပြည်သူသို့ မိတ်ဆက်ခြင်း၏ အဓိပ္ပာယ်ကို သတ်မှတ်ရမည်။" },
  { id: 8, category: "Economy", question: "Will gold exceed $3,000 per ounce this year?", questionMm: "ယခုနှစ်အတွင်း ရွှေတစ်အောင်စ ဒေါ်လာ ၃,၀၀၀ ကျော်မလား။", yes: 48, volume: 15400000, change: -0.6, closes: "Dec 31", symbol: "Au", tone: "gold", description: "A market tracking the international spot gold price.", descriptionMm: "နိုင်ငံတကာ ရွှေဈေးနှုန်းကို စောင့်ကြည့်သည့် မေးခွန်းဖြစ်သည်။", resolution: "A real market must specify a gold benchmark, observation window and timezone.", resolutionMm: "တကယ့်ဈေးကွက်တွင် ရွှေဈေးရည်ညွှန်းချက်၊ စောင့်ကြည့်ကာလနှင့် အချိန်ဇုန်ကို သတ်မှတ်ရမည်။" }
];

const copy = {
  en: {
    ribbon: "SIMULATION MODE / LOCAL DEMO ONLY · NO REAL MONEY · ILLUSTRATIVE DATA", explore: "Explore", watchlist: "Watchlist", portfolio: "Portfolio", activity: "Activity", balance: "DEMO BALANCE",
    eyebrow: "A MARKETPLACE FOR WHAT'S NEXT", heroA: "Make your view", heroB: "count.", intro: "Explore questions shaping tomorrow. Compare probabilities, follow new information and test your conviction in a transparent virtual-credit simulation.",
    exploreMarkets: "Explore markets", how: "How it works", note: "Built for curious minds across Myanmar and beyond.", community: "COMMUNITY VIEW", signal: "illustrative YES signal", workspace: "YOUR WORKSPACE", learn: "Learn by testing ideas", caption: "Every forecast starts with a question.",
    sampleMarkets: "SAMPLE MARKETS", illustrative: "Illustrative questions", yourWatchlist: "YOUR WATCHLIST", saved: "Saved on this device", openPositions: "OPEN DEMO POSITIONS", localOnly: "Local simulation only", disconnected: "Not connected to a live exchange.",
    marketplace: "THE MARKETPLACE", questions: "Questions in play", watchlistDesc: "Keep an eye on the questions you care about.", portfolioDesc: "Track your virtual positions and simulated account value.", activityDesc: "A local record of your demo actions on this device.", exploreDesc: "Discover markets, compare outcomes and explore the crowd's view.",
    search: "Search markets...", trending: "Trending", volume: "Highest volume", highestYes: "Highest YES", closing: "Closing soon", all: "All", categories: {Myanmar:"Myanmar",Economy:"Economy",Crypto:"Crypto",World:"World",Sports:"Sports",Technology:"Technology"},
    noWatch: "Your watchlist is empty", noMatch: "No matching markets", saveWatch: "Save a market with the star icon to find it here.", trySearch: "Try another search or category.",
    snapshot: "MARKET SNAPSHOT", simulator: "Trade simulator", localDemo: "LOCAL DEMO", price: "Illustrative price", shares: "SHARES TO BUY", cost: "Estimated cost", payout: "Potential payout", profit: "Potential profit", payoutNote: "100 Pyas payout per winning share. Simplified demo calculation.",
    insufficient: "Insufficient demo balance", review: "Review demo order", disclaimer: "No real order book, account or server is connected. Prices and volumes are sample data.", readInfo: "Read market information",
    about: "ABOUT THIS QUESTION", resolution: "RESOLUTION EXAMPLE", ruleWarning: "Example only. Final rules and authoritative sources must be approved before a real market opens.",
    available: "AVAILABLE DEMO BALANCE", markValue: "POSITION MARK VALUE", equity: "SIMULATED EQUITY", positions: "OPEN POSITIONS", open: "Open positions", marked: "Marked using the sample probabilities shown in this demo.", reset: "Reset demo account", avg: "Avg. price", mark: "Mark", pnl: "Unrealized P/L", noPositions: "No demo positions yet", startPosition: "Choose a market and review a simulated order to create your first position.", stored: "Balances and positions are stored only in this browser on this device. They are not real funds or a server account.",
    recent: "Recent demo activity", history: "Your local simulated order history.", noActivity: "No activity yet", activityEmpty: "Your simulated orders will appear here.",
    simple: "SIMPLE BY DESIGN", think: "Think clearly.", see: "See possibilities.", step1: "Find a question", step1d: "Explore topics and follow the events that matter to you.", step2: "Form a view", step2d: "Compare YES and NO probabilities using sample prices.", step3: "Learn as it unfolds", step3d: "Track simulated positions and revisit your assumptions.",
    footer: "Independent thinking about the future.", reviewTitle: "Review your position", outcome: "Outcome", sharesLabel: "Shares", samplePrice: "Sample price", demoCost: "Demo cost", maxPayout: "Maximum payout if correct", beforeFees: "Potential profit before fees", modalWarning: "This action changes only your local demo balance and simulated portfolio. It does not place a real trade or contact a server.", confirm: "Confirm simulated position", back: "Go back", resetConfirm: "Reset local demo balance, positions, activity and watchlist?", resetDone: "Local demo account reset.", added: "Simulated position added. No server order was created.", remove: "Remove from watchlist", add: "Add to watchlist", close: "Closes", vol: "Vol.", marketRules: "Final rules and authoritative sources must be approved before a real market opens."
  },
  my: {
    ribbon: "သရုပ်ပြမုဒ် / စက်တွင်းသရုပ်ပြမှုသာ · တကယ့်ငွေကြေး မပါဝင် · နမူနာဒေတာ",
    explore: "ဈေးကွက်များ", watchlist: "စောင့်ကြည့်စာရင်း", portfolio: "အစုစု", activity: "လုပ်ဆောင်ချက်များ", balance: "သရုပ်ပြ လက်ကျန်ငွေ",
    eyebrow: "အနာဂတ်အတွက် ခန့်မှန်းချက်များ", heroA: "သင့်အမြင်ကို", heroB: "တန်ဖိုးရှိစေပါ။", intro: "မနက်ဖြန်ကို ပုံဖော်မည့် မေးခွန်းများကို လေ့လာပါ။ ဖြစ်နိုင်ခြေများကို နှိုင်းယှဉ်ပြီး သတင်းအသစ်များကို လိုက်လံစောင့်ကြည့်ကာ အတုငွေကြေးဖြင့် ပွင့်လင်းမြင်သာစွာ လေ့ကျင့်ခန့်မှန်းနိုင်ပါသည်။",
    exploreMarkets: "ဈေးကွက်များကို လေ့လာရန်", how: "အသုံးပြုပုံ", note: "မြန်မာနိုင်ငံနှင့် ကမ္ဘာတစ်ဝန်းရှိ စူးစမ်းလိုသူများအတွက်။", community: "အသိုင်းအဝိုင်း၏ ခန့်မှန်းချက်", signal: "နမူနာ မှန် ခန့်မှန်းချက်", workspace: "သင့်လုပ်ဆောင်ရန်နေရာ", learn: "ခန့်မှန်းခြင်းဖြင့် လေ့လာပါ", caption: "ခန့်မှန်းချက်တိုင်းသည် မေးခွန်းတစ်ခုမှ စတင်သည်။",
    sampleMarkets: "နမူနာဈေးကွက်များ", illustrative: "နမူနာမေးခွန်းများ", yourWatchlist: "သင့်စောင့်ကြည့်စာရင်း", saved: "ဤစက်တွင် သိမ်းဆည်းထားသည်", openPositions: "ဖွင့်ထားသော သရုပ်ပြအစုများ", localOnly: "စက်တွင်း သရုပ်ပြမှုသာ", disconnected: "တိုက်ရိုက်ဈေးကွက်နှင့် ချိတ်ဆက်ထားခြင်း မရှိပါ။",
    marketplace: "ဈေးကွက်", questions: "စိတ်ဝင်စားဖွယ် မေးခွန်းများ", watchlistDesc: "စိတ်ဝင်စားသော မေးခွန်းများကို စောင့်ကြည့်ပါ။", portfolioDesc: "သရုပ်ပြအစုများနှင့် လက်ကျန်တန်ဖိုးကို ကြည့်ရှုပါ။", activityDesc: "ဤစက်တွင် မှတ်တမ်းတင်ထားသော သရုပ်ပြလုပ်ဆောင်ချက်များ။", exploreDesc: "ဈေးကွက်များကို ရှာဖွေပြီး ရလဒ်များနှင့် အများ၏ခန့်မှန်းချက်ကို နှိုင်းယှဉ်ပါ။",
    search: "ဈေးကွက်များကို ရှာဖွေရန်...", trending: "ရေပန်းအစားဆုံး", volume: "ကုန်သွယ်မှုပမာဏ အများဆုံး", highestYes: "မှန် ဖြစ်နိုင်ခြေ အမြင့်ဆုံး", closing: "မကြာမီ ပိတ်မည့်ဈေးကွက်", all: "အားလုံး", categories: {Myanmar:"မြန်မာ",Economy:"စီးပွားရေး",Crypto:"ခရစ်ပ်တို",World:"ကမ္ဘာ့ရေးရာ",Sports:"အားကစား",Technology:"နည်းပညာ"},
    noWatch: "စောင့်ကြည့်စာရင်း မရှိသေးပါ", noMatch: "ကိုက်ညီသော ဈေးကွက် မတွေ့ပါ", saveWatch: "ကြယ်ပုံကို နှိပ်၍ ဈေးကွက်ကို သိမ်းဆည်းပါ။", trySearch: "အခြားစကားလုံး သို့မဟုတ် အမျိုးအစားဖြင့် ရှာဖွေပါ။",
    snapshot: "ဈေးကွက်အကျဉ်းချုပ်", simulator: "အရောင်းအဝယ် သရုပ်ပြစနစ်", localDemo: "စက်တွင်း သရုပ်ပြမှု", price: "နမူနာဈေးနှုန်း", shares: "ဝယ်ယူမည့် ရှယ်ယာအရေအတွက်", cost: "ခန့်မှန်းကုန်ကျငွေ", payout: "ရနိုင်သည့် ပေးချေငွေ", profit: "ဖြစ်နိုင်သည့် အမြတ်", payoutNote: "အနိုင်ရသော ရှယ်ယာတစ်ခုလျှင် ၁၀၀ ပြား ရရှိမည်။ ရိုးရှင်းသော သရုပ်ပြတွက်ချက်မှုသာ ဖြစ်သည်။",
    insufficient: "သရုပ်ပြလက်ကျန်ငွေ မလုံလောက်ပါ", review: "သရုပ်ပြအော်ဒါကို စစ်ဆေးရန်", disclaimer: "တကယ့်အော်ဒါစာရင်း၊ အကောင့် သို့မဟုတ် ဆာဗာနှင့် ချိတ်ဆက်ထားခြင်း မရှိပါ။ ဈေးနှုန်းနှင့် ပမာဏများသည် နမူနာဒေတာများသာ ဖြစ်သည်။", readInfo: "ဈေးကွက်အချက်အလက်ကို ဖတ်ရန်",
    about: "ဤမေးခွန်းအကြောင်း", resolution: "ရလဒ်ဆုံးဖြတ်ပုံ နမူနာ", ruleWarning: "နမူနာသာ ဖြစ်သည်။ တကယ့်ဈေးကွက် မဖွင့်မီ စည်းမျဉ်းများနှင့် တရားဝင်ရင်းမြစ်များကို အတည်ပြုရမည်။",
    available: "အသုံးပြုနိုင်သော သရုပ်ပြလက်ကျန်", markValue: "အစုများ၏ လက်ရှိတန်ဖိုး", equity: "သရုပ်ပြ စုစုပေါင်းတန်ဖိုး", positions: "ဖွင့်ထားသော အစုများ", open: "ဖွင့်ထားသော အစုများ", marked: "ဤသရုပ်ပြတွင် ပြသထားသော နမူနာဖြစ်နိုင်ခြေများဖြင့် တန်ဖိုးသတ်မှတ်ထားသည်။", reset: "သရုပ်ပြအကောင့်ကို ပြန်စရန်", avg: "ပျမ်းမျှဈေးနှုန်း", mark: "လက်ရှိဈေးနှုန်း", pnl: "မပိတ်သိမ်းရသေးသော အမြတ်/အရှုံး", noPositions: "သရုပ်ပြအစု မရှိသေးပါ", startPosition: "ဈေးကွက်တစ်ခုကို ရွေးချယ်ပြီး သရုပ်ပြအော်ဒါကို အတည်ပြုကာ ပထမဆုံးအစုကို ဖန်တီးပါ။", stored: "လက်ကျန်ငွေနှင့် အစုများကို ဤစက်၏ browser တွင်သာ သိမ်းဆည်းထားသည်။ တကယ့်ငွေကြေး သို့မဟုတ် ဆာဗာအကောင့် မဟုတ်ပါ။",
    recent: "နောက်ဆုံး သရုပ်ပြလုပ်ဆောင်ချက်များ", history: "သင့်စက်တွင်း သရုပ်ပြအော်ဒါမှတ်တမ်း။", noActivity: "လုပ်ဆောင်ချက် မရှိသေးပါ", activityEmpty: "သရုပ်ပြအော်ဒါများကို ဤနေရာတွင် ပြသပါမည်။",
    simple: "ရိုးရှင်းလွယ်ကူစွာ", think: "ရှင်းလင်းစွာ စဉ်းစားပါ။", see: "ဖြစ်နိုင်ခြေများကို မြင်ပါ။", step1: "မေးခွန်းတစ်ခု ရှာဖွေပါ", step1d: "စိတ်ဝင်စားသော အကြောင်းအရာများနှင့် ဖြစ်ရပ်များကို လေ့လာပါ။", step2: "သင့်အမြင်ကို ဖော်ထုတ်ပါ", step2d: "နမူနာဈေးနှုန်းများဖြင့် မှန်နှင့် မှား ဖြစ်နိုင်ခြေကို နှိုင်းယှဉ်ပါ။", step3: "ဖြစ်ပေါ်လာသည့်အတိုင်း လေ့လာပါ", step3d: "သရုပ်ပြအစုများကို စောင့်ကြည့်ပြီး သင့်ခန့်မှန်းချက်များကို ပြန်လည်သုံးသပ်ပါ။",
    footer: "အနာဂတ်အတွက် လွတ်လပ်စွာ တွေးခေါ်ခြင်း။", reviewTitle: "သင့်အစုကို စစ်ဆေးပါ", outcome: "ရလဒ်", sharesLabel: "ရှယ်ယာအရေအတွက်", samplePrice: "နမူနာဈေးနှုန်း", demoCost: "သရုပ်ပြကုန်ကျငွေ", maxPayout: "မှန်ကန်ပါက အများဆုံးရရှိမည့်ငွေ", beforeFees: "အခကြေးငွေမတိုင်မီ ဖြစ်နိုင်သည့်အမြတ်", modalWarning: "ဤလုပ်ဆောင်ချက်သည် သင့်စက်တွင်း သရုပ်ပြလက်ကျန်နှင့် အစုစုကိုသာ ပြောင်းလဲမည်ဖြစ်သည်။ တကယ့်အရောင်းအဝယ် မပြုလုပ်သလို ဆာဗာသို့လည်း ချိတ်ဆက်မည်မဟုတ်ပါ။", confirm: "သရုပ်ပြအစုကို အတည်ပြုရန်", back: "ပြန်သွားရန်", resetConfirm: "သရုပ်ပြလက်ကျန်ငွေ၊ အစုများ၊ လုပ်ဆောင်ချက်များနှင့် စောင့်ကြည့်စာရင်းကို ပြန်စမလား။", resetDone: "သရုပ်ပြအကောင့်ကို ပြန်လည်စတင်ပြီးပါပြီ။", added: "သရုပ်ပြအစုကို ထည့်သွင်းပြီးပါပြီ။ ဆာဗာအော်ဒါ မဖန်တီးခဲ့ပါ။", remove: "စောင့်ကြည့်စာရင်းမှ ဖယ်ရှားရန်", add: "စောင့်ကြည့်စာရင်းသို့ ထည့်ရန်", close: "ပိတ်မည့်ရက်", vol: "ပမာဏ", marketRules: "တကယ့်ဈေးကွက် မဖွင့်မီ စည်းမျဉ်းများနှင့် တရားဝင်ရင်းမြစ်များကို အတည်ပြုရမည်။"
  }
} as const;

const STORAGE_KEY = "mingala-demo-v3";
const MY_DIGITS: Record<string, string> = { "0":"၀", "1":"၁", "2":"၂", "3":"၃", "4":"၄", "5":"၅", "6":"၆", "7":"၇", "8":"၈", "9":"၉" };
const groupedInteger = (value: number) => Math.trunc(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const localizeDigits = (value: string, locale: Locale) => locale === "my" ? value.replace(/[0-9]/g, digit => MY_DIGITS[digit]) : value;
const fmt = (n: number, locale: Locale) => localizeDigits(groupedInteger(n), locale);
const money = (pyas: number, locale: Locale) => {
  const absolute = Math.abs(Math.trunc(pyas));
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, "0");
  const amount = (pyas < 0 ? "-" : "") + groupedInteger(whole) + "." + fraction;
  return locale === "my" ? localizeDigits(amount, locale) + " ကျပ်" : "₭ " + amount;
};
const activityDate = (iso: string, locale: Locale) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  // Myanmar time (UTC+06:30), formatted without locale-dependent Intl output.
  const myanmarTime = new Date(date.getTime() + 390 * 60 * 1000);
  const y = myanmarTime.getUTCFullYear();
  const m = String(myanmarTime.getUTCMonth() + 1).padStart(2, "0");
  const d = String(myanmarTime.getUTCDate()).padStart(2, "0");
  const h = String(myanmarTime.getUTCHours()).padStart(2, "0");
  const min = String(myanmarTime.getUTCMinutes()).padStart(2, "0");
  return localizeDigits(`${y}-${m}-${d} ${h}:${min}`, locale) + (locale === "my" ? " (မြန်မာစံတော်ချိန်)" : " MMT");
};
const categoryLabel = (c: Category, locale: Locale) => c === "All" ? copy[locale].all : copy[locale].categories[c];
const outcomeLabel = (side: "YES" | "NO", locale: Locale) => locale === "my" ? (side === "YES" ? "မှန်" : "မှား") : side;
const dateLabel = (date: string, locale: Locale) => locale === "my" ? ({ "Dec 31": "ဒီဇင်ဘာ ၃၁", "Dec 10": "ဒီဇင်ဘာ ၁၀", "May 24": "မေလ ၂၄", "Nov 30": "နိုဝင်ဘာ ၃၀" } as Record<string, string>)[date] ?? date : date;

export default function HomePage({ initialLocale }: { initialLocale?: Locale } = {}) {
  const [language, setLanguage] = useState<Locale>(initialLocale ?? "my");
  const [category, setCategory] = useState<Category>("All");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(1);
  const [side, setSide] = useState<"YES" | "NO">("YES");
  const [quantity, setQuantity] = useState("100");
  const [sort, setSort] = useState("trending");
  const [view, setView] = useState<"explore" | "watchlist" | "portfolio" | "activity">("explore");
  const [watchlist, setWatchlist] = useState<number[]>([2, 4]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [balance, setBalance] = useState(10000000);
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved: unknown = JSON.parse(raw);
        if (saved && typeof saved === "object") {
          const data = saved as Record<string, unknown>;
          if (Array.isArray(data.watchlist)) {
            setWatchlist(data.watchlist.filter((id): id is number => Number.isSafeInteger(id) && markets.some(m => m.id === id)));
          }
          if (Array.isArray(data.positions)) {
            setPositions(data.positions.filter((value): value is Position => {
              if (!value || typeof value !== "object") return false;
              const p = value as Record<string, unknown>;
              return Number.isSafeInteger(p.marketId) && markets.some(m => m.id === p.marketId) &&
                (p.side === "YES" || p.side === "NO") && Number.isSafeInteger(p.shares) &&
                Number(p.shares) > 0 && Number(p.shares) <= 1000000 &&
                Number.isSafeInteger(p.averagePrice) && Number(p.averagePrice) >= 1 && Number(p.averagePrice) <= 99;
            }));
          }
          if (Array.isArray(data.activity)) {
            setActivity(data.activity.filter((value): value is Activity => {
              if (!value || typeof value !== "object") return false;
              const a = value as Record<string, unknown>;
              return typeof a.id === "string" && Number.isSafeInteger(a.marketId) && markets.some(m => m.id === a.marketId) &&
                (a.side === "YES" || a.side === "NO") && Number.isSafeInteger(a.shares) && Number(a.shares) > 0 &&
                Number.isSafeInteger(a.price) && Number(a.price) >= 1 && Number(a.price) <= 99 &&
                Number.isSafeInteger(a.cost) && Number(a.cost) >= 0 && typeof a.at === "string";
            }).slice(0, 100));
          }
          if (Number.isSafeInteger(data.balance) && Number(data.balance) >= 0 && Number(data.balance) <= 1000000000) setBalance(Number(data.balance));
          if (!initialLocale && (data.language === "en" || data.language === "my")) setLanguage(data.language);
        }
      }
    } catch { /* Ignore invalid local demo data and keep safe defaults. */ }
    setHydrated(true);
  }, [initialLocale]);

  useEffect(() => {
    if (hydrated) { try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ watchlist, positions, activity, balance, language })); } catch { /* Storage may be unavailable or full; the current session remains usable. */ } }
  }, [hydrated, watchlist, positions, activity, balance, language]);

  useEffect(() => { document.documentElement.lang = language; }, [language]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.getElementById("market-search")?.focus();
      }
      if (e.key === "Escape") setConfirming(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const t = copy[language];
  const selected = markets.find(m => m.id === selectedId) ?? markets[0];
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = markets.filter(m =>
      (category === "All" || m.category === category) &&
      (view !== "watchlist" || watchlist.includes(m.id)) &&
      (!q || (m.question + " " + m.questionMm + " " + m.category).toLowerCase().includes(q))
    );
    if (sort === "volume") list.sort((a, b) => b.volume - a.volume);
    else if (sort === "probability") list.sort((a, b) => b.yes - a.yes);
    else if (sort === "closing") { const closeOrder: Record<string, number> = { "Nov 30": 20261130, "Dec 10": 20261210, "Dec 31": 20261231, "May 24": 20270524 }; list.sort((a, b) => (closeOrder[a.closes] ?? Number.MAX_SAFE_INTEGER) - (closeOrder[b.closes] ?? Number.MAX_SAFE_INTEGER)); }
    else list.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    return list;
  }, [category, query, sort, view, watchlist]);

  const price = side === "YES" ? selected.yes : 100 - selected.yes;
  const qty = Number(quantity);
  const valid = Number.isSafeInteger(qty) && qty > 0 && qty <= 1000000;
  const cost = valid ? qty * price : 0;
  const payout = valid ? qty * 100 : 0;
  const profit = payout - cost;
  const markValue = positions.reduce((sum, p) => {
    const m = markets.find(x => x.id === p.marketId);
    return sum + (m ? p.shares * (p.side === "YES" ? m.yes : 100 - m.yes) : 0);
  }, 0);

  const toggleWatch = (id: number) => setWatchlist(cur => cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
  const choose = (id: number) => { setSelectedId(id); setSide("YES"); setNotice(""); setView("explore"); };
  const placeDemo = () => {
    if (!valid || cost > balance) return;
    setPositions(cur => {
      const found = cur.find(p => p.marketId === selected.id && p.side === side);
      if (!found) return [...cur, { marketId: selected.id, side, shares: qty, averagePrice: price }];
      const total = found.shares + qty;
      const avg = Math.round((found.shares * found.averagePrice + qty * price) / total);
      return cur.map(p => p === found ? { ...p, shares: total, averagePrice: avg } : p);
    });
    setBalance(b => b - cost);
    setActivity(cur => [{ id: String(Date.now()), marketId: selected.id, side, shares: qty, price, cost, at: new Date().toISOString() }, ...cur].slice(0, 100));
    setNotice(t.added);
    setConfirming(false);
    setView("portfolio");
  };
  const reset = () => {
    if (!window.confirm(t.resetConfirm)) return;
    setBalance(10000000); setPositions([]); setActivity([]); setWatchlist([2, 4]); setNotice(t.resetDone);
  };

  return <main className="app-shell">
    <div className="demo-ribbon"><span className="pulse-dot" /> {t.ribbon}</div>
    <header className="topbar">
      <a className="brand" href="#" onClick={() => setView("explore")}><span className="brand-mark"><span /></span><span className="brand-word">mingala<span>.</span><small>PREDICTION MARKET</small></span></a>
      <nav className="main-nav" aria-label={language === "my" ? "ပင်မ လမ်းညွှန်" : "Main navigation"}>
        <button className={view === "explore" ? "nav-active" : ""} onClick={() => setView("explore")}>{t.explore}</button>
        <button className={view === "watchlist" ? "nav-active" : ""} onClick={() => setView("watchlist")}>{t.watchlist} <i className="nav-count">{watchlist.length}</i></button>
        <button className={view === "portfolio" ? "nav-active" : ""} onClick={() => setView("portfolio")}>{t.portfolio}</button>
        <button className={view === "activity" ? "nav-active" : ""} onClick={() => setView("activity")}>{t.activity}</button>
      </nav>
      <div className="top-actions">
        <button className="language-switch" onClick={() => window.location.assign(language === "en" ? "/my" : "/en")} aria-label={language === "my" ? "ဘာသာစကား ပြောင်းရန်" : "Change language"}>{language === "en" ? "EN / မြန်မာ" : "မြန်မာ / EN"}</button>
        <div className="balance-pill"><span>{t.balance}</span><strong>{money(balance, language)}</strong></div>
      </div>
    </header>

    <section className="market-intro">
      <div>
        <span className="market-intro-kicker">{language === "my" ? "အထူးရွေးချယ်ထားသော ဈေးကွက်များ" : "FEATURED MARKETS"}</span>
        <h1>{language === "my" ? "လူစိတ်ဝင်စားမှု မြင့်မားသော ခန့်မှန်းချက်များ" : "What will happen next?"}</h1>
        <p>{language === "my" ? "မြန်မာနိုင်ငံနှင့် ကမ္ဘာတစ်ဝန်းမှ စိတ်ဝင်စားဖွယ် မေးခွန်းများကို ရှာဖွေပါ။" : "Explore the questions people are watching. Compare outcomes and follow the latest probabilities."}</p>
      </div>
      <div className="market-intro-stats">
        <div><strong>{fmt(markets.length, language)}</strong><span>{language === "my" ? "နမူနာဈေးကွက်" : "Sample markets"}</span></div>
        <div><strong>{fmt(watchlist.length, language)}</strong><span>{language === "my" ? "စောင့်ကြည့်စာရင်း" : "Watchlist"}</span></div>
      </div>
    </section>

    <section className="featured-section" aria-label={language === "my" ? "အထူးဈေးကွက်များ" : "Featured markets"}>
      <div className="featured-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> {language === "my" ? "ယခု လူစိတ်ဝင်စားမှု အများဆုံး" : "IN THE SPOTLIGHT"}</span><h2>{language === "my" ? "အထူးဈေးကွက်များ" : "Featured markets"}</h2></div><span className="featured-count">{language === "my" ? "နမူနာဒေတာ" : "DEMO DATA"}</span></div>
      <div className="featured-grid">
        {[...markets].sort((a,b)=>b.volume-a.volume).slice(0,4).map((m,i)=><button type="button" key={m.id} className={"featured-card featured-tone-"+m.tone} onClick={()=>choose(m.id)}>
          <div className="featured-card-top"><span className="featured-symbol">{m.symbol}</span><span>{categoryLabel(m.category,language)}</span></div>
          <h3>{language === "my" ? m.questionMm : m.question}</h3>
          <div className="featured-probability"><strong>{fmt(m.yes,language)}%</strong><span>{language === "my" ? "မှန်နိုင်ခြေ" : "YES probability"}</span></div>
          <div className="featured-track"><span style={{width:m.yes+"%"}} /></div>
          <div className="featured-card-bottom"><span>{language === "my" ? "မှန်" : "Yes"} {m.yes}¢</span><span>{language === "my" ? "မှား" : "No"} {100-m.yes}¢</span><span>{t.vol} ₭{(m.volume/1000000).toFixed(1)}M</span></div>
        </button>)}
      </div>
    </section>

    <section className="hot-topics" aria-label={language === "my" ? "ရေပန်းစားသော အကြောင်းအရာများ" : "Hot topics"}>
      <div className="hot-topics-title"><span className="hot-pulse" /> <strong>{language === "my" ? "ရေပန်းစားသော အကြောင်းအရာများ" : "Hot topics"}</strong><span>{language === "my" ? "လေ့လာရန်" : "Explore topics"}</span></div>
      <div className="hot-topic-list">
        {(["Myanmar","Economy","Crypto","World","Sports","Technology"] as Exclude<Category,"All">[]).map((c,i)=><button type="button" key={c} onClick={()=>{setCategory(c);document.getElementById("markets")?.scrollIntoView({behavior:"smooth"});}}><b>{i+1}</b><span>{categoryLabel(c,language)}</span><small>{language === "my" ? "ဈေးကွက်များ" : "markets"}</small></button>)}
      </div>
    </section>

    <section className="workspace" id="markets">
      <div className="section-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> {t.marketplace}</div>
          <h2>{view === "watchlist" ? t.watchlist : view === "portfolio" ? t.portfolio : view === "activity" ? t.activity : (language === "my" ? "ဈေးကွက်အားလုံး" : "All markets")}<span>.</span></h2>
          <p>{view === "watchlist" ? t.watchlistDesc : view === "portfolio" ? t.portfolioDesc : view === "activity" ? t.activityDesc : t.exploreDesc}</p>
        </div>
        {(view === "explore" || view === "watchlist") && <div className="market-tools">
          <label className="search-box"><span>⌕</span><input id="market-search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t.search} aria-label={t.search} /><kbd>⌘ K</kbd></label>
          <select className="sort-button" value={sort} onChange={e => setSort(e.target.value)} aria-label={language === "my" ? "ဈေးကွက်စီရန်" : "Sort markets"}>
            <option value="trending">{t.trending}</option><option value="volume">{t.volume}</option><option value="probability">{t.highestYes}</option><option value="closing">{t.closing}</option>
          </select>
        </div>}
      </div>

      {(view === "explore" || view === "watchlist") && <>
        <div className="category-row" role="group" aria-label={language === "my" ? "ဈေးကွက်အမျိုးအစားများ" : "Market categories"}>
          {(["All", "Myanmar", "Economy", "Crypto", "World", "Sports", "Technology"] as Category[]).map(c => <button key={c} aria-pressed={category === c} className={category === c ? "category-chip selected" : "category-chip"} onClick={() => setCategory(c)}>{c === "All" ? "✳ " : ""}{categoryLabel(c, language)}</button>)}
        </div>
        <div className="market-layout">
          <div className="market-grid">
            {visible.map(m => <article key={m.id} className={selected.id === m.id ? "market-card chosen" : "market-card"}>
              <div className="market-card-top"><span className={"market-symbol " + m.tone}>{m.symbol}</span><span className="market-category">{categoryLabel(m.category, language)}</span><button className={watchlist.includes(m.id) ? "watch-button watching" : "watch-button"} onClick={() => toggleWatch(m.id)} aria-pressed={watchlist.includes(m.id)} aria-label={watchlist.includes(m.id) ? t.remove : t.add}>{watchlist.includes(m.id) ? "★" : "☆"}</button></div>
              <div className="market-card-main" role="button" tabIndex={0} onClick={() => choose(m.id)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(m.id); } }} aria-label={language === "my" ? m.questionMm : m.question}>
                <h3>{language === "my" ? m.questionMm : m.question}</h3>
                <div className="probability-line"><span>{outcomeLabel("YES", language)} <b>{m.yes} {language === "my" ? "ပြား" : "Pyas"}</b></span><span className={m.change >= 0 ? "positive" : "negative"}>{m.change >= 0 ? "↗" : "↘"} {Math.abs(m.change).toFixed(1)}%</span></div>
                <div className="probability-track"><span style={{ width: m.yes + "%" }} /></div>
              </div>
              <div className="market-outcomes"><span className="market-yes">{language === "my" ? "မှန်" : "Yes"} <b>{m.yes}¢</b></span><span className="market-no">{language === "my" ? "မှား" : "No"} <b>{100-m.yes}¢</b></span></div>
              <div className="market-card-footer"><span>◷ {t.close} {dateLabel(m.closes, language)}</span><span>{t.vol} ₭{(m.volume / 1000000).toFixed(1)}M</span></div>
            </article>)}
            {!visible.length && <div className="empty-state"><strong>{view === "watchlist" ? t.noWatch : t.noMatch}</strong><p>{view === "watchlist" ? t.saveWatch : t.trySearch}</p></div>}
          </div>

          <aside className="trade-panel">
            <div className="panel-heading"><div><span className="panel-kicker">{t.snapshot}</span><h3>{t.simulator}</h3></div><span className="demo-tag">{t.localDemo}</span></div>
            <div className="selected-market"><span className={"market-symbol small " + selected.tone}>{selected.symbol}</span><p>{language === "my" ? selected.questionMm : selected.question}</p></div>
            <div className="outcome-switch">
              <button className={side === "YES" ? "outcome-yes active" : "outcome-yes"} onClick={() => setSide("YES")}>{outcomeLabel("YES", language)} <b>{selected.yes} {language === "my" ? "ပြား" : "Pyas"}</b></button>
              <button className={side === "NO" ? "outcome-no active" : "outcome-no"} onClick={() => setSide("NO")}>{outcomeLabel("NO", language)} <b>{100 - selected.yes} {language === "my" ? "ပြား" : "Pyas"}</b></button>
            </div>
            <div className="price-context"><span>{t.price}</span><strong>{price} {language === "my" ? "ပြား" : "Pyas"}</strong></div>
            <label className="quantity-label" htmlFor="quantity">{t.shares}</label>
            <div className="quantity-input"><button onClick={() => setQuantity(String(Math.max(1, (Number(quantity) || 1) - 10)))} aria-label={language === "my" ? "အရေအတွက် လျှော့ရန်" : "Decrease quantity"}>−</button><input id="quantity" type="number" min="1" max="1000000" step="1" value={quantity} onChange={e => setQuantity(e.target.value)} /><button onClick={() => setQuantity(String(Math.min(1000000, (Number(quantity) || 0) + 10)))} aria-label={language === "my" ? "အရေအတွက် တိုးရန်" : "Increase quantity"}>+</button></div>
            <div className="quick-quantities">{[10, 50, 100, 500].map(n => <button key={n} className={qty === n ? "quick-selected" : ""} onClick={() => setQuantity(String(n))}>{fmt(n, language)}</button>)}</div>
            <div className="trade-summary">
              <div><span>{t.cost}</span><strong>{money(cost, language)}</strong></div>
              <div><span>{t.payout}</span><strong>{money(payout, language)}</strong></div>
              <div className="summary-profit"><span>{t.profit}</span><strong>{money(profit, language)}</strong></div>
              <small>{t.payoutNote}</small>
            </div>
            <button className="preview-button" disabled={!valid || cost > balance} onClick={() => setConfirming(true)}>{cost > balance ? t.insufficient : t.review} <span>→</span></button>
            <p className="panel-disclaimer">{t.disclaimer}</p>
            {notice && <div className="notice-message" role="status" aria-live="polite">{notice}</div>}
            <button className="market-rules-link" onClick={() => document.getElementById("market-rules")?.scrollIntoView({ behavior: "smooth" })}>{t.readInfo} ↓</button>
          </aside>
        </div>
        <section className="market-info" id="market-rules">
          <div><span className="panel-kicker">{t.about}</span><h3>{language === "my" ? selected.questionMm : selected.question}</h3><p>{language === "my" ? selected.descriptionMm : selected.description}</p></div>
          <div><span className="panel-kicker">{t.resolution}</span><p>{language === "my" ? selected.resolutionMm : selected.resolution}</p><span className="rules-warning">{t.ruleWarning}</span></div>
        </section>
      </>}

      {view === "portfolio" && <section className="portfolio-view">
        <div className="portfolio-summary">
          <div><span>{t.available}</span><strong>{money(balance, language)}</strong></div>
          <div><span>{t.markValue}</span><strong>{money(markValue, language)}</strong></div>
          <div><span>{t.equity}</span><strong>{money(balance + markValue, language)}</strong></div>
          <div><span>{t.positions}</span><strong>{fmt(positions.length, language)}</strong></div>
        </div>
        <div className="table-heading"><div><h3>{t.open}</h3><p>{t.marked}</p></div><button className="reset-button" onClick={reset}>{t.reset}</button></div>
        {positions.length ? <div className="position-list">{positions.map((p, i) => {
          const m = markets.find(x => x.id === p.marketId)!;
          const mark = p.side === "YES" ? m.yes : 100 - m.yes;
          return <div className="position-row" key={p.marketId + "-" + p.side + "-" + i}>
            <div className="position-market"><span className={"market-symbol small " + m.tone}>{m.symbol}</span><div><strong>{language === "my" ? m.questionMm : m.question}</strong><small>{outcomeLabel(p.side, language)} · {fmt(p.shares, language)} {t.sharesLabel}</small></div></div>
            <div><span>{t.avg}</span><strong>{p.averagePrice} {language === "my" ? "ပြား" : "Pyas"}</strong></div>
            <div><span>{t.mark}</span><strong>{mark} {language === "my" ? "ပြား" : "Pyas"}</strong></div>
            <div><span>{t.pnl}</span><strong className={mark >= p.averagePrice ? "positive" : "negative"}>{money((mark - p.averagePrice) * p.shares, language)}</strong></div>
            <button className="text-action" onClick={() => choose(m.id)}>{t.readInfo}</button>
          </div>;
        })}</div> : <div className="empty-state"><strong>{t.noPositions}</strong><p>{t.startPosition}</p><button className="primary-cta" onClick={() => setView("explore")}>{t.exploreMarkets} →</button></div>}
        <p className="panel-disclaimer">{t.stored}</p>
      </section>}

      {view === "activity" && <section className="activity-view">
        <div className="table-heading"><div><h3>{t.recent}</h3><p>{t.history}</p></div><button className="reset-button" onClick={reset}>{t.reset}</button></div>
        {activity.length ? <div className="activity-list">{activity.map(a => {
          const m = markets.find(x => x.id === a.marketId)!;
          return <div className="activity-row" key={a.id}><div><strong>{outcomeLabel(a.side, language)} · {fmt(a.shares, language)} {t.sharesLabel}</strong><small>{language === "my" ? m.questionMm : m.question}</small></div><div><span>{t.samplePrice}</span><strong>{a.price} {language === "my" ? "ပြား" : "Pyas"}</strong></div><div><span>{t.cost}</span><strong>{money(a.cost, language)}</strong></div><time>{activityDate(a.at, language)}</time></div>;
        })}</div> : <div className="empty-state"><strong>{t.noActivity}</strong><p>{t.activityEmpty}</p><button className="primary-cta" onClick={() => setView("explore")}>{t.exploreMarkets} →</button></div>}
      </section>}
    </section>

    <section className="how-section" id="how-it-works">
      <div><div className="eyebrow"><span className="eyebrow-line" /> {t.simple}</div><h2>{t.think}<br /><em>{t.see}</em></h2></div>
      <div className="how-steps">
        <div><span>01</span><strong>{t.step1}</strong><p>{t.step1d}</p></div>
        <div><span>02</span><strong>{t.step2}</strong><p>{t.step2d}</p></div>
        <div><span>03</span><strong>{t.step3}</strong><p>{t.step3d}</p></div>
      </div>
    </section>

    <footer className="footer">
      <a className="brand footer-brand" href="#" onClick={() => setView("explore")}><span className="brand-mark"><span /></span><span className="brand-word">mingala<span>.</span><small>PREDICTION MARKET</small></span></a>
      <p>{t.footer}</p>
      <div><button onClick={() => setView("explore")}>{t.explore}</button><button onClick={() => setView("watchlist")}>{t.watchlist}</button><span>© 2026 Mingala</span></div>
    </footer>

    {confirming && <div className="modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setConfirming(false); }}>
      <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <button className="modal-close" onClick={() => setConfirming(false)} aria-label={language === "my" ? "ပိတ်ရန်" : "Close"}>×</button>
        <span className="panel-kicker">{t.review}</span><h2 id="confirm-title">{t.reviewTitle} · {outcomeLabel(side, language)}</h2>
        <p>{language === "my" ? selected.questionMm : selected.question}</p>
        <div className="modal-breakdown">
          <div><span>{t.outcome}</span><strong>{outcomeLabel(side, language)}</strong></div>
          <div><span>{t.sharesLabel}</span><strong>{fmt(qty, language)}</strong></div>
          <div><span>{t.samplePrice}</span><strong>{price} {language === "my" ? "ပြား" : "Pyas"}</strong></div>
          <div><span>{t.demoCost}</span><strong>{money(cost, language)}</strong></div>
          <div><span>{t.maxPayout}</span><strong>{money(payout, language)}</strong></div>
          <div className="summary-profit"><span>{t.beforeFees}</span><strong>{money(profit, language)}</strong></div>
        </div>
        <div className="modal-warning">{t.modalWarning}</div>
        <button className="preview-button" onClick={placeDemo}>{t.confirm}</button><button className="cancel-button" onClick={() => setConfirming(false)}>{t.back}</button>
      </section>
    </div>}
  </main>;
}
