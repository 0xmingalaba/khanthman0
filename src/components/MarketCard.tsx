"use client";

import { memo } from "react";
import Link from "next/link";
import type { MarketSummary } from "@/src/lib/api-client";
import type { Locale } from "@/src/lib/locale";
import { formatDate, formatTimeLeft, number, price, probability } from "@/src/components/ui/format";
import type { Dictionary } from "@/src/i18n/dictionary";

type Props = {
  market: MarketSummary;
  locale: Locale;
  t: Dictionary;
  watched: boolean;
  onToggleWatch: (id: string) => void;
};

/**
 * A single market row.
 *
 * Memoised: the grid can hold hundreds of these, and toggling a watchlist star
 * must not re-render every sibling. All derived text is computed here from
 * server-supplied integers; nothing is invented client-side.
 */
function MarketCardBase({ market, locale, t, watched, onToggleWatch }: Props) {
  const question = locale === "my" ? market.questionMy : market.questionEn;
  const category = locale === "my" ? market.categoryNameMy : market.categoryNameEn;
  const yesPrice = market.yesBidPya;
  const noPrice = market.yesAskPya === null ? null : 100 - market.yesAskPya;

  return (
    <article className="market-card">
      <div className="market-card-top">
        <span className="market-category">{category}</span>
        <button
          type="button"
          className={watched ? "watch-toggle watched" : "watch-toggle"}
          onClick={() => onToggleWatch(market.id)}
          aria-pressed={watched}
          aria-label={watched ? t.actions.removeWatch : t.actions.addWatch}
        >
          <span aria-hidden="true">{watched ? "★" : "☆"}</span>
        </button>
      </div>

      <Link className="market-card-link" href={`/${locale}/market/${market.slug}`}>
        <h3>{question}</h3>

        <div className="probability-line">
          <span>
            {t.market.yes} <b>{price(yesPrice ?? 50, locale)}</b>
          </span>
          <span className="market-probability">{probability(market.impliedProbability, locale)}</span>
        </div>
        <div className="probability-track" aria-hidden="true">
          <span style={{ width: `${market.impliedProbability ?? 0}%` }} />
        </div>
      </Link>

      <div className="market-outcomes">
        <span className="market-yes">
          {t.market.yes} <b>{yesPrice === null ? "—" : price(yesPrice, locale)}</b>
        </span>
        <span className="market-no">
          {t.market.no} <b>{noPrice === null ? "—" : price(noPrice, locale)}</b>
        </span>
      </div>

      <div className="market-card-footer">
        <span>◷ {formatTimeLeft(market.closeAt, locale)}</span>
        <span>
          {t.market.openInterest} {number(market.openInterestShares, locale)}
        </span>
        <span className="market-close-date">{formatDate(market.closeAt, locale)}</span>
      </div>
    </article>
  );
}

export const MarketCard = memo(MarketCardBase);
