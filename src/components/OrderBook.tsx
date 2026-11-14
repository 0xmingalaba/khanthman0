"use client";

import type { DepthLevel } from "@/src/lib/api-client";
import type { Locale } from "@/src/lib/locale";
import type { Dictionary } from "@/src/i18n/dictionary";
import { shares as formatShares } from "@/src/components/ui/format";

type Props = {
  locale: Locale;
  t: Dictionary;
  side: "YES" | "NO";
  bids: DepthLevel[];
  asks: DepthLevel[];
};

/**
 * Resting-order depth for one outcome.
 *
 * Depth is real: it is aggregated from open orders only. Bar widths are scaled to
 * the largest visible level so a thin book does not look deep.
 */
export function OrderBook({ locale, t, side, bids, asks }: Props) {
  const max = Math.max(
    1,
    ...bids.map((level) => level.quantity),
    ...asks.map((level) => level.quantity)
  );

  const rows = (levels: DepthLevel[], kind: "bid" | "ask") =>
    levels.slice(0, 8).map((level) => (
      <li key={`${kind}-${level.pricePya}`} className={kind === "bid" ? "depth-row bid" : "depth-row ask"}>
        <span className="depth-bar" style={{ width: `${Math.round((level.quantity / max) * 100)}%` }} aria-hidden="true" />
        <span className="depth-price">{level.pricePya}</span>
        <span className="depth-quantity">{formatShares(level.quantity, locale)}</span>
      </li>
    ));

  return (
    <div className="order-book">
      <div className="book-column">
        <h5>{t.market.bids}</h5>
        {bids.length === 0 ? <p className="panel-disclaimer">{t.market.depthEmpty}</p> : <ul>{rows(bids, "bid")}</ul>}
      </div>
      <div className="book-column">
        <h5>{t.market.asks}</h5>
        {asks.length === 0 ? <p className="panel-disclaimer">{t.market.depthEmpty}</p> : <ul>{rows(asks, "ask")}</ul>}
      </div>
      <p className="book-side-label">{side === "YES" ? t.market.yes : t.market.no}</p>
    </div>
  );
}
