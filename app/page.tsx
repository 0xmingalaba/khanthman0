"use client";

import { useMemo, useState } from "react";

type Category = "All" | "Myanmar" | "Economy" | "Crypto" | "World" | "Sports";
type Market = {
  id: number;
  category: Exclude<Category, "All">;
  question: string;
  questionMm: string;
  yes: number;
  volume: number;
  change: number;
  closes: string;
  symbol: string;
  tone: string;
};

const markets: Market[] = [
  { id: 1, category: "Economy", question: "Will USD/MMK trade below 4,000 by December 31?", questionMm: "ဒီဇင်ဘာ ၃၁ ရက်မတိုင်မီ USD/MMK ၄,၀၀၀ အောက် ရောက်မလား။", yes: 34, volume: 12840000, change: 4.2, closes: "Dec 31", symbol: "₮", tone: "mint" },
  { id: 2, category: "Myanmar", question: "Will Myanmar rice exports increase this quarter?", questionMm: "ယခုသုံးလပတ်တွင် မြန်မာ့ဆန်တင်ပို့မှု တိုးလာမလား။", yes: 67, volume: 8420000, change: 2.8, closes: "Dec 31", symbol: "🌾", tone: "gold" },
  { id: 3, category: "Crypto", question: "Will Bitcoin close above $110,000 this year?", questionMm: "ယခုနှစ်အတွင်း Bitcoin ဈေးနှုန်း ဒေါ်လာ ၁၁၀,၀၀၀ အထက် ပိတ်မလား။", yes: 58, volume: 32100000, change: -1.4, closes: "Dec 31", symbol: "₿", tone: "violet" },
  { id: 4, category: "World", question: "Will the Fed cut interest rates at its next meeting?", questionMm: "နောက်လာမည့် အစည်းအဝေးတွင် Fed က အတိုးနှုန်း လျှော့ချမလား။", yes: 72, volume: 19600000, change: 1.1, closes: "Dec 10", symbol: "⌁", tone: "blue" },
  { id: 5, category: "Sports", question: "Will Arsenal finish in the Premier League top two?", questionMm: "ပရီးမီးယားလိဂ်တွင် Arsenal က ထိပ်ဆုံးနှစ်သင်းအတွင်း ဝင်မလား။", yes: 41, volume: 6750000, change: -2.3, closes: "May 24", symbol: "⚽", tone: "coral" },
  { id: 6, category: "Myanmar", question: "Will Yangon record more than 10 days of heavy rain this month?", questionMm: "ယခုလ ရန်ကုန်တွင် မိုးသည်းထန်စွာ ရွာသည့်ရက် ၁၀ ရက်ကျော် ရှိမလား။", yes: 23, volume: 4120000, change: 0.7, closes: "Nov 30", symbol: "☂", tone: "blue" }
];

const categories: Category[] = ["All", "Myanmar", "Economy", "Crypto", "World", "Sports"];
const fmt = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);

export default function HomePage() {
  const [category, setCategory] = useState<Category>("All");
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState<"en" | "my">("en");
  const [selected, setSelected] = useState<Market>(markets[0]);
  const [side, setSide] = useState<"YES" | "NO">("YES");
  const [quantity, setQuantity] = useState("100");
  const [watchlist, setWatchlist] = useState<number[]>([2, 4]);
  const [notice, setNotice] = useState("");

  const visibleMarkets = useMemo(() => markets.filter((market) => {
    const matchesCategory = category === "All" || market.category === category;
    const text = language === "my" ? market.questionMm : market.question;
    return matchesCategory && text.toLowerCase().includes(query.toLowerCase());
  }), [category, language, query]);

  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  const price = side === "YES" ? selected.yes : 100 - selected.yes;
  const cost = Math.round(qty * price);
  const potential = qty * 100;
  const profit = potential - cost;

  const toggleWatch = (id: number) => setWatchlist((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return (
    <main className="app-shell">
      <div className="demo-ribbon"><span className="pulse-dot" /> DEMO ENVIRONMENT <span className="ribbon-divider">/</span> VIRTUAL CREDITS ONLY · NO REAL-MONEY TRADING</div>
      <header className="topbar">
        <a className="brand" href="#" aria-label="Mingala home">
          <span className="brand-mark"><span /></span>
          <span className="brand-word">mingala<span>.</span><small>PREDICTION MARKET</small></span>
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          <a className="nav-active" href="#markets">Explore</a>
          <a href="#how-it-works">How it works</a>
          <a href="#leaderboard">Leaderboard</a>
        </nav>
        <div className="top-actions">
          <button className="language-switch" onClick={() => setLanguage(language === "en" ? "my" : "en")} aria-label="Switch language">{language === "en" ? "EN" : "မြန်မာ"} <span>⌄</span></button>
          <button className="login-button" onClick={() => setNotice("Account access will be connected in a later milestone.")}>Log in</button>
          <button className="signup-button" onClick={() => setNotice("Account registration will be connected in a later milestone.")}>Get started <span>↗</span></button>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> THE FUTURE IS A QUESTION</div>
          <h1>What will<br /><em>happen next?</em></h1>
          <p>Explore what people think about the future.<br />Discover probabilities. Follow the questions that matter.</p>
          <div className="hero-actions"><a className="primary-cta" href="#markets">Explore markets <span>↘</span></a><a className="text-cta" href="#how-it-works">How Mingala works <span>→</span></a></div>
          <div className="hero-note"><span className="tiny-shield">◇</span> Built for curious minds across Myanmar and beyond.</div>
        </div>
        <div className="hero-art" aria-label="Abstract probability illustration">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" />
          <div className="hero-sun"><span>?</span></div>
          <div className="floating-card card-one"><span className="float-label">MARKET SENTIMENT</span><strong>68<span>%</span></strong><small>YES probability</small><div className="mini-bars"><i /><i /><i /><i /><i /><i /><i /></div></div>
          <div className="floating-card card-two"><span className="float-label">COMMUNITY SIGNAL</span><div className="signal-row"><b>↑</b><strong>+12.4%</strong></div><small>over the last 7 days</small></div>
          <div className="art-caption">A better way to think about tomorrow.</div>
        </div>
      </section>

      <section className="stats-strip" aria-label="Platform overview">
        <div><span className="stat-label">MARKETS TRACKED</span><strong>24</strong><small>Questions worth watching</small></div>
        <div><span className="stat-label">COMMUNITY MEMBERS</span><strong>1,280</strong><small>Curious minds, one place</small></div>
        <div><span className="stat-label">VIRTUAL CREDITS IN PLAY</span><strong>₭ 84.2M</strong><small>Demo figures only</small></div>
        <div className="stats-aside"><span className="live-indicator" /> A growing view of what comes next.</div>
      </section>

      <section className="markets-section" id="markets">
        <div className="section-heading">
          <div><div className="eyebrow"><span className="eyebrow-line" /> THE MARKETPLACE</div><h2>Questions in play<span>.</span></h2><p>Explore active questions and see where the crowd stands.</p></div>
          <div className="market-tools"><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search markets..." aria-label="Search markets" /><kbd>⌘ K</kbd></label><button className="sort-button" onClick={() => setNotice("Market sorting will be added with live market data.")}>Trending <span>⌄</span></button></div>
        </div>
        <div className="category-row" role="tablist" aria-label="Market categories">{categories.map((item) => <button key={item} role="tab" aria-selected={category === item} className={category === item ? "category-chip selected" : "category-chip"} onClick={() => setCategory(item)}>{item === "All" ? "✳ " : ""}{item}</button>)}</div>
        <div className="market-layout">
          <div className="market-grid">
            {visibleMarkets.map((market) => <article key={market.id} className={selected.id === market.id ? "market-card chosen" : "market-card"}>
              <div className="market-card-top"><span className={`market-symbol ${market.tone}`}>{market.symbol}</span><span className="market-category">{market.category}</span><button className={watchlist.includes(market.id) ? "watch-button watching" : "watch-button"} onClick={() => toggleWatch(market.id)} aria-label={watchlist.includes(market.id) ? "Remove from watchlist" : "Add to watchlist"}>{watchlist.includes(market.id) ? "★" : "☆"}</button></div>
              <button className="market-card-main" onClick={() => { setSelected(market); setNotice(""); }}><h3>{language === "my" ? market.questionMm : market.question}</h3><div className="probability-line"><span>YES <b>{market.yes}¢</b></span><span className={market.change >= 0 ? "positive" : "negative"}>{market.change >= 0 ? "↗" : "↘"} {Math.abs(market.change).toFixed(1)}%</span></div><div className="probability-track"><span style={{ width: `${market.yes}%` }} /></div></button>
              <div className="market-card-footer"><span>◷ Closes {market.closes}</span><span>Vol. ₭{(market.volume / 1000000).toFixed(1)}M</span></div>
            </article>)}
            {visibleMarkets.length === 0 && <div className="empty-state"><span>⌕</span><strong>No matching markets</strong><p>Try another search or category.</p></div>}
          </div>

          <aside className="trade-panel">
            <div className="panel-heading"><div><span className="panel-kicker">QUICK VIEW</span><h3>Trade preview</h3></div><span className="demo-tag">DEMO</span></div>
            <div className="selected-market"><span className={`market-symbol small ${selected.tone}`}>{selected.symbol}</span><p>{language === "my" ? selected.questionMm : selected.question}</p></div>
            <div className="outcome-switch"><button className={side === "YES" ? "outcome-yes active" : "outcome-yes"} onClick={() => setSide("YES")}>YES <b>{selected.yes}¢</b></button><button className={side === "NO" ? "outcome-no active" : "outcome-no"} onClick={() => setSide("NO")}>NO <b>{100 - selected.yes}¢</b></button></div>
            <div className="order-book-mini"><div className="book-head"><span>INDICATIVE PRICE</span><span>DEMO LIQUIDITY</span></div><div className="book-row"><span>Best bid</span><b>{Math.max(1, price - 2)}¢</b><span className="book-amount">12,400 shares</span></div><div className="book-row"><span>Best ask</span><b>{Math.min(99, price + 2)}¢</b><span className="book-amount">8,250 shares</span></div></div>
            <label className="quantity-label" htmlFor="quantity">SHARES TO BUY</label><div className="quantity-input"><input id="quantity" type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} /><span>SHARES</span></div>
            <div className="trade-summary"><div><span>Estimated cost</span><strong>₭ {fmt(cost)}</strong></div><div><span>Potential payout</span><strong>₭ {fmt(potential)}</strong></div><div className="summary-profit"><span>Potential profit</span><strong>₭ {fmt(profit)}</strong></div></div>
            <button className="preview-button" disabled={qty < 1 || qty > 1000000} onClick={() => setNotice("Demo only — no order was submitted and no credits were moved.")}>Preview {side} order <span>→</span></button>
            <p className="panel-disclaimer">Illustrative preview only. No account, order book or balance is connected yet.</p>
            {notice && <div className="notice-message" role="status">{notice}</div>}
          </aside>
        </div>
      </section>

      <section className="how-section" id="how-it-works"><div><div className="eyebrow"><span className="eyebrow-line" /> SIMPLE BY DESIGN</div><h2>Think clearly.<br /><em>See possibilities.</em></h2></div><div className="how-steps"><div><span>01</span><strong>Find a question</strong><p>Explore topics and follow the events that matter to you.</p></div><div><span>02</span><strong>Form a view</strong><p>Read the market signal and consider both outcomes.</p></div><div><span>03</span><strong>Learn as it unfolds</strong><p>Track how expectations change as new information arrives.</p></div></div></section>
      <footer className="footer"><a className="brand footer-brand" href="#"><span className="brand-mark"><span /></span><span className="brand-word">mingala<span>.</span><small>PREDICTION MARKET</small></span></a><p>Independent thinking about the future.</p><div><a href="#markets">Explore</a><a href="#how-it-works">How it works</a><span>© 2026 Mingala</span></div></footer>
    </main>
  );
}
