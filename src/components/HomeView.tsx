"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketSummary } from "@/src/lib/api-client";
import { api } from "@/src/lib/api-client";
import type { Dictionary } from "@/src/i18n/dictionary";
import type { Locale } from "@/src/lib/locale";
import { MarketCard } from "@/src/components/MarketCard";
import { SiteHeader } from "@/src/components/SiteHeader";
import { useApp } from "@/src/components/AppProvider";
import { formatDate, formatTimeLeft, number, probability } from "@/src/components/ui/format";

type Props = { locale: Locale; t: Dictionary; initialMarkets: MarketSummary[] | null };

const CATEGORIES = ["myanmar", "economy", "crypto", "world", "sports", "technology"] as const;

export function HomeView({ locale, t, initialMarkets }: Props) {
  const { user, wallet, signOut, ready } = useApp();
  // Server-rendered first paint: the initial catalogue arrives with the HTML, so
  // there is no empty flash before hydration. Later filtering refetches.
  const [markets, setMarkets] = useState<MarketSummary[] | null>(initialMarkets);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [sort, setSort] = useState<"closing" | "newest" | "activity">("closing");
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());

  // Watchlist is a device-local convenience only; it never affects balances.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("mingala-watchlist-v1");
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setWatchlist(new Set(parsed.filter((id): id is string => typeof id === "string")));
        }
      }
    } catch {
      /* ignore unreadable local data */
    }
  }, []);

  const toggleWatch = useCallback((id: string) => {
    setWatchlist((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem("mingala-watchlist-v1", JSON.stringify([...next]));
      } catch {
        /* storage may be unavailable; the in-memory state still works */
      }
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setError(false);
    try {
      const result = await api.markets({
        category: category === "all" ? undefined : category,
        q: query.trim() || undefined,
        sort,
      });
      setMarkets(result.markets);
    } catch {
      setError(true);
      setMarkets([]);
    }
  }, [category, query, sort]);

  const firstRender = useRef(true);
  useEffect(() => {
    if (!ready) return;
    // The server already supplied the default view; only refetch when the user
    // changes a filter or search term.
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const timer = setTimeout(() => void load(), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, ready, query]);

  const featured = useMemo(() => {
    if (!markets || markets.length === 0) return null;
    return markets[featuredIndex % markets.length];
  }, [markets, featuredIndex]);

  const categoryLabel = (id: string): string => {
    const market = markets?.find((item) => item.categoryId === id);
    if (market) return locale === "my" ? market.categoryNameMy : market.categoryNameEn;
    const fallback: Record<string, { en: string; my: string }> = {
      myanmar: { en: "Myanmar", my: "မြန်မာ" },
      economy: { en: "Economy", my: "စီးပွားရေး" },
      crypto: { en: "Crypto", my: "ခရစ်ပတို" },
      world: { en: "World", my: "ကမ္ဘာ" },
      sports: { en: "Sports", my: "အားကစား" },
      technology: { en: "Technology", my: "နည်းပညာ" },
    };
    return fallback[id]?.[locale] ?? id;
  };

  return (
    <main className="app-shell">
      <div className="virtual-ribbon" role="note">
        <span className="pulse-dot" aria-hidden="true" /> {t.notice.virtual}
      </div>

      <SiteHeader
        locale={locale}
        t={t}
        user={user}
        availablePya={wallet?.availablePya ?? null}
        onLogout={() => void signOut()}
        searchValue={query}
        onSearchChange={setQuery}
      />

      <section className="discovery-hero" aria-label={t.hero.featured}>
        <div className="featured-carousel">
          <div className="carousel-heading">
            <span className="eyebrow">
              <span className="eyebrow-line" /> {t.hero.featured}
            </span>
            {featured && (
              <span className="featured-count">
                {t.market.closes} · {formatDate(featured.closeAt, locale)}
              </span>
            )}
          </div>

          {featured ? (
            <div className="featured-spotlight">
              <div className="spotlight-top">
                <span className="market-category">{locale === "my" ? featured.categoryNameMy : featured.categoryNameEn}</span>
                <span className="spotlight-rank">{t.hero.spotlight}</span>
              </div>
              <Link className="spotlight-question" href={`/${locale}/market/${featured.slug}`}>
                {locale === "my" ? featured.questionMy : featured.questionEn}
              </Link>
              <div className="spotlight-probability">
                <strong>{probability(featured.impliedProbability, locale)}</strong>
                <span>{t.hero.yesProbability}</span>
                <span className="spotlight-change">{formatTimeLeft(featured.closeAt, locale)}</span>
              </div>
              <div className="spotlight-track" aria-hidden="true">
                <span style={{ width: `${featured.impliedProbability ?? 0}%` }} />
              </div>
              <div className="spotlight-bottom">
                <span>
                  {t.market.openInterest} · {number(featured.openInterestShares, locale)}
                </span>
                <Link className="spotlight-open" href={`/${locale}/market/${featured.slug}`}>
                  {t.hero.viewMarket} <span>→</span>
                </Link>
              </div>
            </div>
          ) : (
            <div className="featured-spotlight skeleton-block" aria-hidden="true" />
          )}

          {markets && markets.length > 1 && (
            <div className="carousel-controls">
              <span>
                {number((featuredIndex % markets.length) + 1, locale)} / {number(markets.length, locale)}
              </span>
              <div className="carousel-dots">
                {markets.slice(0, 8).map((market, index) => (
                  <button
                    key={market.id}
                    type="button"
                    className={featuredIndex % Math.min(markets.length, 8) === index ? "active" : ""}
                    aria-label={`${t.hero.featured} ${index + 1}`}
                    onClick={() => setFeaturedIndex(index)}
                  />
                ))}
              </div>
              <div className="carousel-arrows">
                <button
                  type="button"
                  aria-label={t.hero.previous}
                  onClick={() => setFeaturedIndex((index) => index - 1 + markets.length)}
                >
                  ‹
                </button>
                <button type="button" aria-label={t.hero.next} onClick={() => setFeaturedIndex((index) => index + 1)}>
                  ›
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className="hot-topics-panel" aria-label={t.hero.hotTopics}>
          <div className="hot-topics-title">
            <span className="hot-pulse" aria-hidden="true" />
            <strong>{t.hero.hotTopics}</strong>
          </div>
          <div className="hot-topic-list">
            {CATEGORIES.map((id, index) => (
              <button
                key={id}
                type="button"
                onClick={() => setCategory(id)}
                className={category === id ? "active" : ""}
              >
                <b>{number(index + 1, locale)}</b>
                <span>{categoryLabel(id)}</span>
                <span className="topic-arrow" aria-hidden="true">
                  →
                </span>
              </button>
            ))}
          </div>
        </aside>
      </section>

      <section className="workspace" id="markets" tabIndex={-1}>
        <div className="section-heading">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-line" /> {t.nav.markets}
            </div>
            <h2>
              {t.market.allMarkets}
              <span>.</span>
            </h2>
            <p>{t.market.priceFromBook}</p>
          </div>
          <div className="market-tools">
            <label className="sr-only" htmlFor="sort">
              {t.market.closes}
            </label>
            <select
              id="sort"
              className="sort-button"
              value={sort}
              onChange={(event) => setSort(event.target.value as typeof sort)}
            >
              <option value="closing">{t.market.closes}</option>
              <option value="newest">{t.market.status}</option>
              <option value="activity">{t.market.openInterest}</option>
            </select>
          </div>
        </div>

        <div className="category-row" role="group" aria-label={t.market.category}>
          <button
            type="button"
            className={category === "all" ? "category-chip selected" : "category-chip"}
            aria-pressed={category === "all"}
            onClick={() => setCategory("all")}
          >
            {t.categories.all}
          </button>
          {CATEGORIES.map((id) => (
            <button
              key={id}
              type="button"
              className={category === id ? "category-chip selected" : "category-chip"}
              aria-pressed={category === id}
              onClick={() => setCategory(id)}
            >
              {categoryLabel(id)}
            </button>
          ))}
        </div>

        {error ? (
          <div className="empty-state" role="alert">
            <strong>{t.errors.loadFailed}</strong>
            <p>{t.errors.loadFailedHint}</p>
            <button type="button" className="primary-cta" onClick={() => void load()}>
              {t.actions.retry}
            </button>
          </div>
        ) : markets === null ? (
          <div className="market-grid" aria-busy="true">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="market-card skeleton-block" aria-hidden="true" />
            ))}
          </div>
        ) : markets.length === 0 ? (
          <div className="empty-state">
            <strong>{t.market.noResults}</strong>
            <p>{t.market.noResultsHint}</p>
          </div>
        ) : (
          <>
            <div className="market-results-meta" role="status" aria-live="polite">
              <strong>{number(markets.length, locale)}</strong>
              <span>{t.market.results}</span>
            </div>
            <div className="market-grid">
              {markets.map((market) => (
                <MarketCard
                  key={market.id}
                  market={market}
                  locale={locale}
                  t={t}
                  watched={watchlist.has(market.id)}
                  onToggleWatch={toggleWatch}
                />
              ))}
            </div>
          </>
        )}
      </section>

      <footer className="footer">
        <div className="brand footer-brand">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span className="brand-word">
            {t.brand.name}
            <span>.</span>
            <small>{t.brand.suffix}</small>
          </span>
        </div>
        <p>{t.footer.tagline}</p>
        <p className="footer-disclaimer">{t.footer.disclaimer}</p>
        <div>
          <Link href={`/${locale}`}>{t.nav.explore}</Link>
          <Link href={`/${locale}/portfolio`}>{t.nav.portfolio}</Link>
          <span>{t.footer.rights}</span>
        </div>
      </footer>
    </main>
  );
}
