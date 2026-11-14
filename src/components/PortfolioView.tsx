"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, type OrderView, type Portfolio } from "@/src/lib/api-client";
import type { Dictionary } from "@/src/i18n/dictionary";
import type { Locale } from "@/src/lib/locale";
import { SiteHeader } from "@/src/components/SiteHeader";
import { useApp } from "@/src/components/AppProvider";
import { formatDate, money, number, price } from "@/src/components/ui/format";

type Props = { locale: Locale; t: Dictionary };

export function PortfolioView({ locale, t }: Props) {
  const { user, wallet, signOut, ready, refresh } = useApp();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const [portfolioResult, orderResult] = await Promise.all([api.portfolio(), api.orders()]);
      setPortfolio(portfolioResult);
      setOrders(orderResult.orders);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (!user) return;
    void load();
  }, [ready, user, load]);

  if (ready && !user) {
    return (
      <main className="app-shell">
        <SiteHeader
          locale={locale}
          t={t}
          user={null}
          availablePya={null}
          onLogout={() => void signOut()}
          showSearch={false}
        />
        <div className="empty-state">
          <strong>{t.trade.signInToTrade}</strong>
          <p>{t.trade.signInHint}</p>
          <Link className="primary-cta" href={`/${locale}/login`}>
            {t.nav.login} →
          </Link>
        </div>
      </main>
    );
  }

  const cash = portfolio?.cash;

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
        onLogout={async () => {
          await signOut();
          await refresh();
        }}
        showSearch={false}
      />

      <section className="workspace">
        <div className="section-heading">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-line" /> {t.portfolio.title}
            </div>
            <h2>
              {t.portfolio.title}
              <span>.</span>
            </h2>
            <p>{t.portfolio.subtitle}</p>
          </div>
        </div>

        {error && (
          <div className="empty-state" role="alert">
            <strong>{t.errors.loadFailed}</strong>
            <button type="button" className="primary-cta" onClick={() => void load()}>
              {t.actions.retry}
            </button>
          </div>
        )}

        <div className="portfolio-summary">
          <div>
            <span>{t.portfolio.available}</span>
            <strong>{cash ? money(cash.availablePya, locale) : "—"}</strong>
          </div>
          <div>
            <span>{t.portfolio.reserved}</span>
            <strong>{cash ? money(cash.reservedPya, locale) : "—"}</strong>
          </div>
          <div>
            <span>{t.portfolio.total}</span>
            <strong>{cash ? money(cash.totalPya, locale) : "—"}</strong>
          </div>
          <div>
            <span>{t.portfolio.positions}</span>
            <strong>{portfolio ? number(portfolio.positions.length, locale) : "—"}</strong>
          </div>
        </div>

        <p className="panel-disclaimer">{t.portfolio.virtualOnly}</p>

        <div className="table-heading">
          <div>
            <h3>{t.portfolio.positions}</h3>
            <p>{t.portfolio.notMarkedTitle}</p>
          </div>
        </div>

        {portfolio && portfolio.positions.length > 0 ? (
          <div className="position-list">
            {portfolio.positions.map((position) => (
              <div className="position-row" key={`${position.marketId}-${position.side}`}>
                <div className="position-market">
                  <div>
                    <Link href={`/${locale}/market/${position.slug}`}>
                      {locale === "my" ? position.questionMy : position.questionEn}
                    </Link>
                    <small>
                      {position.side === "YES" ? t.market.yes : t.market.no} ·{" "}
                      {number(position.sharesHeld, locale)} {t.portfolio.sharesHeld}
                    </small>
                  </div>
                </div>
                <div>
                  <span>{t.portfolio.costBasis}</span>
                  <strong>{money(position.costBasisPya, locale)}</strong>
                </div>
                <div>
                  <span>{t.portfolio.realised}</span>
                  <strong className={position.realisedPnlPya >= 0 ? "positive" : "negative"}>
                    {money(position.realisedPnlPya, locale)}
                  </strong>
                </div>
                <div>
                  <span>{t.market.closes}</span>
                  <strong>{formatDate(position.closeAt, locale, true)}</strong>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <strong>{t.portfolio.noPositions}</strong>
            <p>{t.portfolio.noPositionsHint}</p>
            <Link className="primary-cta" href={`/${locale}`}>
              {t.actions.viewAll} →
            </Link>
          </div>
        )}

        <p className="panel-disclaimer">{t.portfolio.notMarkedDetail}</p>

        <div className="table-heading">
          <div>
            <h3>{t.market.openOrders}</h3>
          </div>
        </div>
        {orders.length === 0 ? (
          <p className="panel-disclaimer">{t.market.noOpenOrders}</p>
        ) : (
          <ul className="open-order-list">
            {orders.map((order) => (
              <li key={order.id}>
                <span>
                  {order.action === "BUY" ? t.market.buy : t.market.sell}{" "}
                  {order.side === "YES" ? t.market.yes : t.market.no}
                </span>
                <strong>{price(order.pricePya, locale)}</strong>
                <span>
                  {t.market.remaining} {number(order.remainingQuantity, locale)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
