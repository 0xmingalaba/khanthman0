"use client";

import { useMemo, useState } from "react";
import type { MarketDetail, OrderView } from "@/src/lib/api-client";
import type { Locale } from "@/src/lib/locale";
import type { Dictionary } from "@/src/i18n/dictionary";
import { money, number, price, shares as formatShares } from "@/src/components/ui/format";
import { costOf, payoutOf, MIN_PRICE_PYA, MAX_PRICE_PYA, complementPrice } from "@/src/lib/money";

type Props = {
  market: MarketDetail;
  locale: Locale;
  t: Dictionary;
  signedIn: boolean;
  availablePya: number | null;
  openOrders: OrderView[];
  onSubmit: (input: { side: "YES" | "NO"; action: "BUY" | "SELL"; pricePya: number; quantity: number }) => Promise<void>;
  onCancel: (orderId: string) => Promise<void>;
  pending: boolean;
  message: { kind: "error" | "success"; text: string } | null;
};

/**
 * Order ticket.
 *
 * The ticket shows a *preview* computed locally for responsiveness, but the
 * server is the authority: collateral, reservation and validation all happen
 * again in the domain layer.
 */
export function OrderTicket({
  market,
  locale,
  t,
  signedIn,
  availablePya,
  openOrders,
  onSubmit,
  onCancel,
  pending,
  message,
}: Props) {
  const [side, setSide] = useState<"YES" | "NO">("YES");
  const [action, setAction] = useState<"BUY" | "SELL">("BUY");
  const [priceInput, setPriceInput] = useState("");
  const [quantityInput, setQuantityInput] = useState("100");

  const impliedYes = market.impliedProbability;
  const defaultPrice =
    impliedYes ?? (side === "YES" ? market.yesBidPya ?? 50 : market.yesAskPya === null ? 50 : complementPrice(market.yesAskPya));

  const effectivePrice = priceInput === "" ? defaultPrice : Number(priceInput);
  const quantity = Number(quantityInput);

  const priceValid = Number.isInteger(effectivePrice) && effectivePrice >= MIN_PRICE_PYA && effectivePrice <= MAX_PRICE_PYA;
  const quantityValid = Number.isInteger(quantity) && quantity > 0;

  const preview = useMemo(() => {
    if (!priceValid || !quantityValid) return null;
    const collateral = costOf(effectivePrice, quantity);
    const payout = payoutOf(quantity);
    return { collateral, payout, profit: payout - collateral };
  }, [effectivePrice, quantity, priceValid, quantityValid]);

  const insufficient = action === "BUY" && preview !== null && availablePya !== null && preview.collateral > availablePya;
  const canSubmit = priceValid && quantityValid && !insufficient && !pending && market.status === "open";

  if (!signedIn) {
    return (
      <aside className="trade-panel">
        <div className="panel-heading">
          <div>
            <span className="panel-kicker">{t.market.orderBook}</span>
            <h3>{t.trade.signInToTrade}</h3>
          </div>
        </div>
        <p className="panel-disclaimer">{t.trade.signInHint}</p>
        <a className="preview-button" href={`/${locale}/login`}>
          {t.nav.login} <span>→</span>
        </a>
      </aside>
    );
  }

  return (
    <aside className="trade-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">{t.market.orderBook}</span>
          <h3>{action === "BUY" ? t.market.buy : t.market.sell}</h3>
        </div>
        <span className="demo-tag">{t.notice.virtual}</span>
      </div>

      <div className="segmented" role="group" aria-label={t.market.buy}>
        <button
          type="button"
          className={action === "BUY" ? "segment active" : "segment"}
          aria-pressed={action === "BUY"}
          onClick={() => setAction("BUY")}
        >
          {t.market.buy}
        </button>
        <button
          type="button"
          className={action === "SELL" ? "segment active" : "segment"}
          aria-pressed={action === "SELL"}
          onClick={() => setAction("SELL")}
        >
          {t.market.sell}
        </button>
      </div>

      <div className="outcome-switch" role="group" aria-label={t.trade.outcome}>
        <button
          type="button"
          className={side === "YES" ? "outcome-yes active" : "outcome-yes"}
          aria-pressed={side === "YES"}
          onClick={() => setSide("YES")}
        >
          {t.market.yes} <b>{price(market.yesBidPya ?? 50, locale)}</b>
        </button>
        <button
          type="button"
          className={side === "NO" ? "outcome-no active" : "outcome-no"}
          aria-pressed={side === "NO"}
          onClick={() => setSide("NO")}
        >
          {t.market.no}{" "}
          <b>{market.yesAskPya === null ? "—" : price(complementPrice(market.yesAskPya), locale)}</b>
        </button>
      </div>

      <label className="quantity-label" htmlFor="limit-price">
        {t.market.priceLabel}
      </label>
      <div className="quantity-input">
        <button
          type="button"
          onClick={() => setPriceInput(String(Math.max(MIN_PRICE_PYA, (Number.isInteger(effectivePrice) ? effectivePrice : 50) - 1)))}
          aria-label="−"
        >
          −
        </button>
        <input
          id="limit-price"
          inputMode="numeric"
          value={priceInput === "" ? String(defaultPrice) : priceInput}
          onChange={(event) => setPriceInput(event.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
          aria-describedby="price-hint"
        />
        <button
          type="button"
          onClick={() => setPriceInput(String(Math.min(MAX_PRICE_PYA, (Number.isInteger(effectivePrice) ? effectivePrice : 50) + 1)))}
          aria-label="+"
        >
          +
        </button>
      </div>
      <p id="price-hint" className="field-hint">
        {t.market.priceLabel}: {MIN_PRICE_PYA}–{MAX_PRICE_PYA} {locale === "my" ? "ပြား" : "Pyas"}
      </p>

      <label className="quantity-label" htmlFor="order-quantity">
        {t.market.quantityLabel}
      </label>
      <div className="quantity-input">
        <button
          type="button"
          onClick={() => setQuantityInput(String(Math.max(1, (Number.isInteger(quantity) ? quantity : 0) - 10)))}
          aria-label="−"
        >
          −
        </button>
        <input
          id="order-quantity"
          inputMode="numeric"
          value={quantityInput}
          onChange={(event) => setQuantityInput(event.target.value.replace(/[^0-9]/g, "").slice(0, 9))}
        />
        <button
          type="button"
          onClick={() => setQuantityInput(String((Number.isInteger(quantity) ? quantity : 0) + 10))}
          aria-label="+"
        >
          +
        </button>
      </div>
      <div className="quick-quantities">
        {[10, 50, 100, 500].map((value) => (
          <button
            key={value}
            type="button"
            className={quantity === value ? "quick-selected" : ""}
            onClick={() => setQuantityInput(String(value))}
          >
            {number(value, locale)}
          </button>
        ))}
      </div>

      <div className="trade-summary">
        <div>
          <span>{t.market.cost}</span>
          <strong>{preview ? money(preview.collateral, locale) : "—"}</strong>
        </div>
        <div>
          <span>{t.market.potentialPayout}</span>
          <strong>{preview ? money(preview.payout, locale) : "—"}</strong>
        </div>
        <div className="summary-profit">
          <span>{t.market.potentialProfit}</span>
          <strong>{preview ? money(preview.profit, locale) : "—"}</strong>
        </div>
        <small>{t.trade.disclaimer}</small>
      </div>

      {!priceValid && <p className="field-error" role="alert">{t.trade.invalidPrice}</p>}
      {!quantityValid && <p className="field-error" role="alert">{t.trade.invalidQuantity}</p>}
      {insufficient && <p className="field-error" role="alert">{t.trade.insufficientFunds}</p>}
      {message && (
        <p className={message.kind === "error" ? "field-error" : "notice-message"} role="status" aria-live="polite">
          {message.text}
        </p>
      )}

      <button
        type="button"
        className="preview-button"
        disabled={!canSubmit}
        onClick={() => onSubmit({ side, action, pricePya: effectivePrice, quantity })}
      >
        {pending ? t.actions.loading : t.market.placeOrder} <span>→</span>
      </button>

      {availablePya !== null && (
        <p className="panel-disclaimer">
          {t.portfolio.available}: {money(availablePya, locale)}
        </p>
      )}

      <div className="open-orders">
        <h4>{t.market.openOrders}</h4>
        {openOrders.length === 0 ? (
          <p className="panel-disclaimer">{t.market.noOpenOrders}</p>
        ) : (
          <ul>
            {openOrders.map((order) => (
              <li key={order.id}>
                <div>
                  <strong>
                    {order.action === "BUY" ? t.market.buy : t.market.sell}{" "}
                    {order.side === "YES" ? t.market.yes : t.market.no}
                  </strong>
                  <small>
                    {price(order.pricePya, locale)} · {t.market.remaining} {formatShares(order.remainingQuantity, locale)}
                  </small>
                </div>
                <button type="button" className="text-action" onClick={() => onCancel(order.id)} disabled={pending}>
                  {t.market.cancelOrder}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
