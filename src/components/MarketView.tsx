"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ApiRequestError,
  api,
  newIdempotencyKey,
  type MarketDetail,
  type OrderView,
} from "@/src/lib/api-client";
import type { Dictionary } from "@/src/i18n/dictionary";
import type { Locale } from "@/src/lib/locale";
import { SiteHeader } from "@/src/components/SiteHeader";
import { OrderTicket } from "@/src/components/OrderTicket";
import { OrderBook } from "@/src/components/OrderBook";
import { useApp } from "@/src/components/AppProvider";
import { formatDateTime, formatTimeLeft, number, probability } from "@/src/components/ui/format";

type Props = { locale: Locale; t: Dictionary; slug: string; initialMarket: MarketDetail | null };

export function MarketView({ locale, t, slug, initialMarket }: Props) {
  const { user, wallet, signOut, ready, setWallet } = useApp();
  const [market, setMarket] = useState<MarketDetail | null>(initialMarket);
  const [loadError, setLoadError] = useState(false);
  const [openOrders, setOpenOrders] = useState<OrderView[]>([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const loadMarket = useCallback(async () => {
    try {
      const result = await api.market(slug);
      setMarket(result.market);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [slug]);

  const loadOrders = useCallback(async () => {
    if (!user) {
      setOpenOrders([]);
      return;
    }
    try {
      const result = await api.orders();
      setOpenOrders(result.orders.filter((order) => order.marketId === market?.id));
    } catch {
      /* the ticket still works; the list simply stays as-is */
    }
  }, [user, market?.id]);

  useEffect(() => {
    if (!ready) return;
    void loadMarket();
    void loadOrders();
  }, [ready, loadMarket, loadOrders]);

  const submit = useCallback(
    async (input: { side: "YES" | "NO"; action: "BUY" | "SELL"; pricePya: number; quantity: number }) => {
      if (!market) return;
      setPending(true);
      setMessage(null);
      try {
        const result = await api.placeOrder({
          marketId: market.id,
          ...input,
          idempotencyKey: newIdempotencyKey(),
        });
        setWallet({
          availablePya: result.cash.available,
          reservedPya: result.cash.reserved,
          totalPya: result.cash.total,
        });
        setMessage({ kind: "success", text: t.trade.placed });
        await Promise.all([loadMarket(), loadOrders()]);
      } catch (error) {
        setMessage({
          kind: "error",
          text:
            error instanceof ApiRequestError && error.api.code === "insufficient_shares"
              ? t.trade.insufficientShares
              : error instanceof ApiRequestError && error.api.code === "insufficient_funds"
                ? t.trade.insufficientFunds
                : t.auth.errorGeneric,
        });
      } finally {
        setPending(false);
      }
    },
    [market, t, setWallet, loadMarket, loadOrders]
  );

  const cancel = useCallback(
    async (orderId: string) => {
      setPending(true);
      setMessage(null);
      try {
        const result = await api.cancelOrder({ orderId, idempotencyKey: newIdempotencyKey() });
        setWallet({
          availablePya: result.cash.available,
          reservedPya: result.cash.reserved,
          totalPya: result.cash.total,
        });
        setMessage({ kind: "success", text: t.trade.cancelled });
        await Promise.all([loadMarket(), loadOrders()]);
      } catch {
        setMessage({ kind: "error", text: t.auth.errorGeneric });
      } finally {
        setPending(false);
      }
    },
    [t, setWallet, loadMarket, loadOrders]
  );

  if (!market) {
    return (
      <main className="app-shell">
        <SiteHeader
          locale={locale}
          t={t}
          user={user}
          availablePya={wallet?.availablePya ?? null}
          onLogout={() => void signOut()}
          showSearch={false}
        />
        <div className="empty-state" role="alert">
          <strong>{loadError ? t.errors.loadFailed : t.errors.notFound}</strong>
          <p>{t.errors.notFoundHint}</p>
          <Link className="primary-cta" href={`/${locale}`}>
            {t.actions.viewAll} →
          </Link>
        </div>
      </main>
    );
  }

  const question = locale === "my" ? market.questionMy : market.questionEn;
  const description = locale === "my" ? market.descriptionMy : market.descriptionEn;
  const rules = locale === "my" ? market.rulesMy : market.rulesEn;
  const criteria = locale === "my" ? market.resolutionCriteriaMy : market.resolutionCriteriaEn;

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
        showSearch={false}
      />

      <nav className="breadcrumb" aria-label={t.market.allMarkets}>
        <Link href={`/${locale}`}>← {t.market.allMarkets}</Link>
        <span>{locale === "my" ? market.categoryNameMy : market.categoryNameEn}</span>
      </nav>

      <section className="market-detail">
        <div className="market-detail-main">
          <h1>{question}</h1>

          <div className="detail-meta">
            <span className={market.status === "open" ? "status-pill open" : "status-pill"}>
              {market.status === "open" ? t.market.buy : t.market.closes}
            </span>
            <span>◷ {formatTimeLeft(market.closeAt, locale)}</span>
            <span>
              {t.market.closes}: {formatDateTime(market.closeAt, locale)}
            </span>
          </div>

          <div className="detail-stats">
            <div>
              <span>{t.hero.yesProbability}</span>
              <strong>{probability(market.impliedProbability, locale)}</strong>
            </div>
            <div>
              <span>{t.market.openInterest}</span>
              <strong>{number(market.openInterestShares, locale)}</strong>
            </div>
            <div>
              <span>{t.market.openOrders}</span>
              <strong>{number(market.openOrders, locale)}</strong>
            </div>
          </div>

          <div className="probability-track" aria-hidden="true">
            <span style={{ width: `${market.impliedProbability ?? 0}%` }} />
          </div>

          <section className="detail-section">
            <h2>{t.market.about}</h2>
            <p>{description}</p>
          </section>

          <section className="detail-section">
            <h2>{t.market.rules}</h2>
            <p>{rules}</p>
            <h3>{t.market.resolutionCriteria}</h3>
            <p>{criteria}</p>
            {market.sources.length > 0 && (
              <>
                <h3>{t.market.sources}</h3>
                <ul className="source-list">
                  {market.sources.map((source) => (
                    <li key={source.url}>
                      <a href={source.url} rel="noopener noreferrer nofollow" target="_blank">
                        {source.label} ↗
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="detail-section">
            <h2>{t.market.orderBook}</h2>
            <div className="book-grid">
              <div>
                <h3>{t.market.yes}</h3>
                <OrderBook locale={locale} t={t} side="YES" bids={market.book.yes.bids} asks={market.book.yes.asks} />
              </div>
              <div>
                <h3>{t.market.no}</h3>
                <OrderBook locale={locale} t={t} side="NO" bids={market.book.no.bids} asks={market.book.no.asks} />
              </div>
            </div>
          </section>

          <section className="detail-section">
            <h2>{t.market.recentTrades}</h2>
            {market.recentTrades.length === 0 ? (
              <p className="panel-disclaimer">{t.market.noTrades}</p>
            ) : (
              <ul className="trade-list">
                {market.recentTrades.map((trade, index) => (
                  <li key={`${trade.executedAt}-${index}`}>
                    <span className={trade.side === "YES" ? "positive" : "negative"}>
                      {trade.side === "YES" ? t.market.yes : t.market.no}
                    </span>
                    <strong>{number(trade.quantity, locale)}</strong>
                    <span>{trade.pricePya} {locale === "my" ? "ပြား" : "Pyas"}</span>
                    <time>{formatDateTime(trade.executedAt, locale)}</time>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="market-detail-aside">
          <OrderTicket
            market={market}
            locale={locale}
            t={t}
            signedIn={!!user}
            availablePya={wallet?.availablePya ?? null}
            openOrders={openOrders}
            onSubmit={submit}
            onCancel={cancel}
            pending={pending}
            message={message}
          />
        </div>
      </section>

      <footer className="footer">
        <p>{t.footer.tagline}</p>
        <p className="footer-disclaimer">{t.footer.disclaimer}</p>
        <div>
          <Link href={`/${locale}`}>{t.actions.viewAll}</Link>
          <span>{t.footer.rights}</span>
        </div>
      </footer>
    </main>
  );
}
