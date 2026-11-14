/**
 * Order placement, cancellation and trade settlement.
 *
 * Scope is exactly what docs/FINANCIAL-SPEC.md declares implemented:
 *   - BUY limit orders reserve `price * quantity` Pyas of collateral.
 *   - SELL limit orders reserve owned shares; no short selling exists.
 *   - Cancellation releases exactly the remaining reservation.
 *   - Settlement transfers reserved cash to the seller and escrowed shares to the
 *     buyer in ONE journal, so neither leg can happen without the other.
 *
 * NOT implemented here (no order crossing, no minting, no merging): the matching
 * policy is not yet specified by the owner, so this module must not guess it.
 *
 * Every mutation runs in a single transaction and every operation is idempotent by
 * request key.
 *
 * LOCK ORDER. Documented in full in the canonical block above `lockCashPool` in
 * src/domain/reservations.ts; that is the authority, this is the summary. There are two
 * phases, and order locks appear in BOTH -- they are not all taken up front:
 *
 *     PHASE A  1. markets row (FOR SHARE, placeOrder only)
 *              2. cash-pool advisory lock
 *              3. the trade's own orders row locks
 *              4. account_balances FOR UPDATE
 *
 *     PHASE B  5. account_balances FOR UPDATE (reallocated user's cash_reserved)
 *              6. ALL open BUY order locks of that user (reallocation)
 *              7. positions row locks
 *
 * `placeOrder` runs phase A only; `cancelOrder` runs phase A only, without a step-3 lock;
 * `settleTrade` runs both. Step 6 locks sibling orders AFTER a balance lock and is safe
 * only because the transaction already holds those users' pool advisory locks -- see
 * THE INVARIANT in reservations.ts before adding a caller or a new lock.
 *
 * The market lock comes first only because it is a SHARE lock -- it never queues against
 * another market lock -- and because it rejects a closed market before anything is
 * reserved. Do not add a market row lock to the other two mutations: it would invert
 * steps 1 and 2 and reintroduce a cycle.
 */

import { createHash } from "node:crypto";
import type { Database } from "@/src/db/executor";
import type { Transaction } from "@/src/db/executor";
import { DomainError, notFound } from "@/src/lib/errors";
import {
  PYA,
  balanceOf,
  ensureAccount,
  lockBalance,
  postJournal,
  requireCovered,
  requireEscrowed,
  shareAsset,
  shareBalances,
} from "@/src/domain/ledger";
import { costOf, price as assertPrice, shares as assertShares } from "@/src/lib/money";
import { isTradingAllowed, type MarketStatus } from "@/src/domain/market-lifecycle";
import { lockCashPools, releasableCash, reallocateCashReservations } from "@/src/domain/reservations";

export type Side = "YES" | "NO";
export type Action = "BUY" | "SELL";

export type PlaceOrderInput = {
  userId: string;
  marketId: string;
  side: Side;
  action: Action;
  pricePya: number;
  quantity: number;
  idempotencyKey: string;
};

export type OrderView = {
  id: string;
  marketId: string;
  userId: string;
  side: Side;
  action: Action;
  pricePya: number;
  quantity: number;
  remainingQuantity: number;
  reservedUnits: number;
  status: "open" | "filled" | "cancelled" | "expired";
  createdAt: string;
};

type OrderRow = {
  id: string;
  market_id: string;
  user_id: string;
  side: Side;
  action: Action;
  price_pya: number | string;
  quantity: number | string;
  remaining_quantity: number | string;
  reserved_units: number | string;
  status: OrderView["status"];
  created_at: Date | string;
};

function toOrderView(row: OrderRow): OrderView {
  return {
    id: row.id,
    marketId: row.market_id,
    userId: row.user_id,
    side: row.side,
    action: row.action,
    pricePya: Number(row.price_pya),
    quantity: Number(row.quantity),
    remainingQuantity: Number(row.remaining_quantity),
    reservedUnits: Number(row.reserved_units),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const ORDER_COLUMNS = `id, market_id, user_id, side, action, price_pya, quantity,
  remaining_quantity, reserved_units, status, created_at`;

/**
 * Idempotency guard.
 *
 * A retried request with the same key and same payload returns the stored
 * response and performs no writes. A retried key with a *different* payload is a
 * client bug and is rejected, rather than silently echoing the wrong result.
 */
async function withIdempotency<T>(
  db: Database,
  input: { userId: string; key: string; endpoint: string; requestHash: string },
  work: (tx: Transaction) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    // Claim the key first. A concurrent duplicate blocks here and then sees the row.
    const claimed = await tx.query<{ response_json: unknown }>(
      `INSERT INTO idempotency_keys (user_id, key, endpoint, request_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, key) DO NOTHING
       RETURNING response_json`,
      [input.userId, input.key, input.endpoint, input.requestHash]
    );

    if (claimed.rows.length === 0) {
      const existing = await tx.query<{ request_hash: string; response_json: unknown }>(
        "SELECT request_hash, response_json FROM idempotency_keys WHERE user_id = $1 AND key = $2",
        [input.userId, input.key]
      );
      const row = existing.rows[0];
      if (!row) {
        throw new DomainError("conflict", { message: "This request is already in progress." });
      }
      if (row.request_hash !== input.requestHash) {
        throw new DomainError("idempotency_conflict");
      }
      if (row.response_json != null) return row.response_json as T;
      // Claimed but not completed: the original request is still running.
      throw new DomainError("conflict", { message: "This request is already in progress." });
    }

    const result = await work(tx);
    await tx.query(
      "UPDATE idempotency_keys SET response_json = $3 WHERE user_id = $1 AND key = $2",
      [input.userId, input.key, JSON.stringify(result)]
    );
    return result;
  });
}

/**
 * Stable fingerprint of the semantically meaningful request fields.
 *
 * SHA-256, truncated to 128 bits (32 hex chars). The previous implementation was a
 * 32-bit FNV-1a hash, which is fine for bucketing but wrong for this job: the
 * fingerprint is what distinguishes "same idempotency key, same request" (replay
 * the stored response) from "same key, different request" (reject as a client bug).
 * At 32 bits, a collision becomes likely around 77k distinct payloads, after which
 * one request could silently receive another's stored response.
 *
 * Input is built with sorted keys so two structurally equal payloads always hash
 * identically regardless of property order, while 128 bits makes accidental
 * collisions negligible.
 */
export function requestFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex").slice(0, 32);
}

/** Deterministic JSON: object keys sorted, so key order cannot change the hash. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

type MarketLock = { id: string; status: MarketStatus; close_at: Date | string };

async function lockTradableMarket(tx: Transaction, marketId: string, now: Date): Promise<MarketLock> {
  const result = await tx.query<MarketLock>(
    "SELECT id, status, close_at FROM markets WHERE id = $1 FOR SHARE",
    [marketId]
  );
  if (result.rows.length === 0) throw notFound("Market");
  const market = result.rows[0];
  if (market.status !== "open") throw new DomainError("market_not_open");
  if (!isTradingAllowed(market.status, new Date(market.close_at), now)) {
    throw new DomainError("market_closed");
  }
  return market;
}

/**
 * Place a limit order and reserve its collateral or shares.
 */
export async function placeOrder(db: Database, input: PlaceOrderInput): Promise<OrderView> {
  const pricePya = assertPrice(input.pricePya);
  const quantity = assertShares(input.quantity);
  const cost = costOf(pricePya, quantity);
  const now = new Date();

  return withIdempotency(
    db,
    {
      userId: input.userId,
      key: input.idempotencyKey,
      endpoint: `placeOrder:${input.marketId}:${input.side}:${input.action}`,
      requestHash: requestFingerprint({
        marketId: input.marketId,
        side: input.side,
        action: input.action,
        pricePya,
        quantity,
      }),
    },
    async (tx) => {
      await lockTradableMarket(tx, input.marketId, now);

      // Step 2 of the canonical order. The market SHARE lock above is step 1, so this is
      // deliberately NOT the first lock of this transaction -- the two are ordered this
      // way because a SHARE lock cannot queue behind another SHARE lock, while the
      // closed-market check has to run before collateral moves.
      //
      // Placing a BUY grows this user's reservation pool and inserts an open order that
      // reallocation will later lock, so it takes the same pool lock as settlement and
      // cancellation. Everything below (order insert, balance locks, journal) sits at
      // steps 3 and 4.
      await lockCashPools(tx, [input.userId]);

      const cashAvailable = await ensureAccount(tx, { type: "user", id: input.userId }, PYA, "cash_available");
      const cashReserved = await ensureAccount(tx, { type: "user", id: input.userId }, PYA, "cash_reserved");
      const asset = shareAsset(input.marketId, input.side);
      const sharesAvailable = await ensureAccount(
        tx,
        { type: "user", id: input.userId },
        asset,
        "shares_available"
      );
      const sharesReserved = await ensureAccount(
        tx,
        { type: "market", id: input.marketId },
        asset,
        "escrow_shares"
      );

      const reservedUnits = input.action === "BUY" ? Number(cost) : quantity;

      const created = await tx.query<{ id: string }>(
        `INSERT INTO orders
           (market_id, user_id, side, action, price_pya, quantity,
            remaining_quantity, reserved_units, status)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'open')
         RETURNING id`,
        [input.marketId, input.userId, input.side, input.action, pricePya, quantity, reservedUnits]
      );
      const orderId = created.rows[0].id;

      if (input.action === "BUY") {
        // Lock the only account this journal debits; the credit side (reserved)
        // can only grow, so it needs no guard.
        const available = await lockBalance(tx, cashAvailable);
        requireCovered(available, Number(cost), new DomainError("insufficient_funds"));
        await postJournal(tx, {
          kind: "order_reserve",
          actorId: input.userId,
          refType: "order",
          refId: orderId,
          memo: `reserve ${cost} Pyas for ${input.side} buy`,
          entries: [
            { accountId: cashReserved, asset: PYA, delta: Number(cost) },
            { accountId: cashAvailable, asset: PYA, delta: -Number(cost) },
          ],
        });
      } else {
        const available = await lockBalance(tx, sharesAvailable);
        requireCovered(available, quantity, new DomainError("insufficient_shares"));
        await postJournal(tx, {
          kind: "order_reserve",
          actorId: input.userId,
          refType: "order",
          refId: orderId,
          memo: `reserve ${quantity} ${input.side} shares`,
          entries: [
            { accountId: sharesReserved, asset, delta: quantity },
            { accountId: sharesAvailable, asset, delta: -quantity },
          ],
        });
      }

      const row = await tx.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`, [orderId]);
      return toOrderView(row.rows[0]);
    }
  );
}

/** Cancel an open order, releasing exactly the remaining reservation. */
export async function cancelOrder(
  db: Database,
  input: { userId: string; orderId: string; idempotencyKey: string }
): Promise<OrderView> {
  return withIdempotency(
    db,
    {
      userId: input.userId,
      key: input.idempotencyKey,
      endpoint: `cancelOrder:${input.orderId}`,
      requestHash: requestFingerprint({ orderId: input.orderId }),
    },
    async (tx) => {
      // Step 2 of the canonical order, and the first lock this transaction takes (there is
      // no market lock on cancellation). Cancellation reads and rewrites this user's
      // reservation pool, so it must take the same pool lock settlement takes; the order
      // row lock below is step 3. See reservations.ts.
      await lockCashPools(tx, [input.userId]);

      const found = await tx.query<OrderRow>(
        `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1 FOR UPDATE`,
        [input.orderId]
      );
      if (found.rows.length === 0) throw notFound("Order");
      const order = found.rows[0];

      // Ownership check: a user may only cancel their own orders.
      if (order.user_id !== input.userId) throw new DomainError("forbidden");
      if (order.status !== "open") {
        throw new DomainError("conflict", { message: "Only open orders can be cancelled." });
      }

      const remaining = Number(order.remaining_quantity);

      if (remaining > 0) {
        if (order.action === "BUY") {
          // Release only what this order may legitimately claim; the pool may be
          // shared with sibling orders that have since been settled.
          const release = await releasableCash(tx, {
            userId: input.userId,
            orderReservedUnits: Number(order.reserved_units),
            orderId: order.id,
          });
          if (release <= 0) {
            // Nothing left to release for this order: close it without a journal.
            const closed = await tx.query<OrderRow>(
              `UPDATE orders
                  SET status = 'cancelled', remaining_quantity = 0, reserved_units = 0,
                      closed_at = now(), updated_at = now()
                WHERE id = $1
                RETURNING ${ORDER_COLUMNS}`,
              [order.id]
            );
            return toOrderView(closed.rows[0]);
          }
          const cashAvailable = await ensureAccount(tx, { type: "user", id: input.userId }, PYA, "cash_available");
          const cashReserved = await ensureAccount(tx, { type: "user", id: input.userId }, PYA, "cash_reserved");
          const reservedBalance = await lockBalance(tx, cashReserved);
          requireCovered(
            reservedBalance,
            release,
            new DomainError("conflict", { message: "Reserved balance is inconsistent for this order." })
          );
          await postJournal(tx, {
            kind: "order_release",
            actorId: input.userId,
            refType: "order",
            refId: order.id,
            memo: `release ${release} Pyas from cancelled ${order.side} buy`,
            entries: [
              { accountId: cashAvailable, asset: PYA, delta: release },
              { accountId: cashReserved, asset: PYA, delta: -release },
            ],
          });
        } else {
          const asset = shareAsset(order.market_id, order.side);
          const userShares = await ensureAccount(
            tx,
            { type: "user", id: input.userId },
            asset,
            "shares_available"
          );
          const escrow = await ensureAccount(
            tx,
            { type: "market", id: order.market_id },
            asset,
            "escrow_shares"
          );
          const escrowBalance = await lockBalance(tx, escrow);
          requireEscrowed(
            escrowBalance,
            remaining,
            new DomainError("conflict", { message: "Reserved shares are inconsistent for this order." })
          );
          await postJournal(tx, {
            kind: "order_release",
            actorId: input.userId,
            refType: "order",
            refId: order.id,
            memo: `release ${remaining} ${order.side} shares from cancelled sell`,
            entries: [
              { accountId: userShares, asset, delta: remaining },
              { accountId: escrow, asset, delta: -remaining },
            ],
          });
        }
      }

      const updated = await tx.query<OrderRow>(
        `UPDATE orders
            SET status = 'cancelled',
                remaining_quantity = 0,
                reserved_units = 0,
                closed_at = now(),
                updated_at = now()
          WHERE id = $1
          RETURNING ${ORDER_COLUMNS}`,
        [order.id]
      );

      return toOrderView(updated.rows[0]);
    }
  );
}

/**
 * Settle a transfer of existing shares from a seller's escrow to a buyer.
 *
 * Both cash and share legs are written in one journal, so the transfer is atomic.
 * The caller must already hold: the buy order (with reserved cash) and the sell
 * order (with escrowed shares). This function does not decide prices; it settles
 * at the trade price it is given, and refuses quantities beyond either order.
 */
export async function settleTrade(
  tx: Transaction,
  input: {
    buyOrderId: string;
    sellOrderId: string;
    quantity: number;
    actorId?: string | null;
  }
): Promise<{ tradeId: string; journalId: string; pricePya: number; quantity: number }> {
  const quantity = assertShares(input.quantity);

  // FIRST locks in this transaction: step 2 of the canonical order, with no market lock
  // ahead of it. Settlement rewrites BOTH users' reservation pools (the buyer's via
  // reallocateCashReservations, the seller's via share escrow), and reallocation locks
  // every open buy order of that user. Taking the pools up front, in sorted user order,
  // is what prevents the lock cycle documented in reservations.ts -- it is also what lets
  // the sibling-order locks at the end of this function happen safely, long after the
  // balance locks. The two trade orders are locked at step 3, balances at step 4.
  const parties = await tx.query<{ buyer_id: string; seller_id: string }>(
    `SELECT b.user_id AS buyer_id, s.user_id AS seller_id
       FROM orders b, orders s
      WHERE b.id = $1 AND s.id = $2`,
    [input.buyOrderId, input.sellOrderId]
  );
  if (parties.rows.length === 0) throw notFound("Order");
  await lockCashPools(tx, [parties.rows[0].buyer_id, parties.rows[0].seller_id]);

  const orders = await tx.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders
      WHERE id = $1 OR id = $2
      ORDER BY id
      FOR UPDATE`,
    [input.buyOrderId, input.sellOrderId]
  );
  if (orders.rows.length !== 2) throw notFound("Order");

  const buy = orders.rows.find((row) => row.id === input.buyOrderId)!;
  const sell = orders.rows.find((row) => row.id === input.sellOrderId)!;

  if (buy.action !== "BUY" || sell.action !== "SELL") {
    throw new DomainError("validation_failed", { message: "Order actions are inconsistent." });
  }
  if (buy.side !== sell.side) {
    throw new DomainError("validation_failed", { message: "Both orders must be for the same outcome." });
  }
  if (buy.market_id !== sell.market_id) {
    throw new DomainError("validation_failed", { message: "Both orders must be in the same market." });
  }
  if (buy.user_id === sell.user_id) {
    throw new DomainError("validation_failed", { message: "A user cannot trade with themselves." });
  }
  if (buy.status !== "open" || sell.status !== "open") {
    throw new DomainError("conflict", { message: "Both orders must be open to settle." });
  }
  if (quantity > Number(buy.remaining_quantity) || quantity > Number(sell.remaining_quantity)) {
    throw new DomainError("validation_failed", { message: "Quantity exceeds an order's remaining size." });
  }

  const buyPrice = Number(buy.price_pya);
  const sellPrice = Number(sell.price_pya);
  if (buyPrice < sellPrice) {
    throw new DomainError("validation_failed", {
      message: "A buy price must be at least the sell price to settle.",
    });
  }

  // PENDING OWNER DECISION: maker vs taker price when the limits cross. We settle
  // at the seller's (maker) price, the conservative choice that never charges the
  // buyer more than their limit. This must be confirmed before matching ships.
  const tradePrice = sellPrice;
  const cash = tradePrice * quantity;
  // The buyer reserved at their limit price. Anything between the trade price and
  // that limit is unused collateral and must be released, not left stranded in
  // reserve: a buy limit of 65 filled at 60 releases 5 Pyas per share.
  const priceImprovement = (buyPrice - tradePrice) * quantity;

  const asset = shareAsset(buy.market_id, buy.side);
  const buyerCashReserved = await ensureAccount(tx, { type: "user", id: buy.user_id }, PYA, "cash_reserved");
  const buyerCashAvailable = await ensureAccount(tx, { type: "user", id: buy.user_id }, PYA, "cash_available");
  const sellerCashAvailable = await ensureAccount(tx, { type: "user", id: sell.user_id }, PYA, "cash_available");
  const buyerShares = await ensureAccount(tx, { type: "user", id: buy.user_id }, asset, "shares_available");
  const escrow = await ensureAccount(tx, { type: "market", id: buy.market_id }, asset, "escrow_shares");

  // Lock debit-side balances in a stable order before writing anything.
  const locked = new Map<string, number>();
  for (const accountId of [buyerCashReserved, escrow].sort()) {
    locked.set(accountId, await lockBalance(tx, accountId));
  }
  requireCovered(
    locked.get(buyerCashReserved)!,
    cash + priceImprovement,
    new DomainError("insufficient_funds", { message: "Buyer's reservation does not cover this trade." })
  );
  requireEscrowed(
    locked.get(escrow)!,
    quantity,
    new DomainError("conflict", { message: "Seller's escrow does not cover this trade." })
  );

  const journal = await postJournal(tx, {
    kind: "trade_settlement",
    actorId: input.actorId ?? null,
    refType: "market",
    refId: buy.market_id,
    memo: `settle ${quantity} ${buy.side} @ ${tradePrice} Pyas`,
    entries: [
      { accountId: buyerCashReserved, asset: PYA, delta: -(cash + priceImprovement) },
      { accountId: sellerCashAvailable, asset: PYA, delta: cash },
      { accountId: buyerCashAvailable, asset: PYA, delta: priceImprovement },
      { accountId: buyerShares, asset, delta: quantity },
      { accountId: escrow, asset, delta: -quantity },
    ].filter((entry) => entry.delta !== 0),
  });

  const trade = await tx.query<{ id: string }>(
    `INSERT INTO trades
       (market_id, side, price_pya, quantity, buy_order_id, sell_order_id,
        buyer_id, seller_id, journal_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [buy.market_id, buy.side, tradePrice, quantity, buy.id, sell.id, buy.user_id, sell.user_id, journal.journalId]
  );

  // Advance both orders. For a BUY, reserved_units is the cash actually still
  // held in reserve: it falls by exactly what the settlement journal debited,
  // which includes any price improvement released to the buyer. Deriving it from
  // the debited amount (rather than remaining * limit) is what keeps the order row
  // and the ledger in agreement after a partial fill at a better price.
  for (const [order, role] of [
    [buy, "BUY"],
    [sell, "SELL"],
  ] as const) {
    const nextRemaining = Number(order.remaining_quantity) - quantity;
    const debited = role === "BUY" ? cash + priceImprovement : quantity;
    const nextReserved = Math.max(Number(order.reserved_units) - debited, 0);
    await tx.query(
      `UPDATE orders
          SET remaining_quantity = $2::bigint,
              reserved_units = $3::bigint,
              status = CASE WHEN $2::bigint = 0 THEN 'filled' ELSE 'open' END,
              closed_at = CASE WHEN $2::bigint = 0 THEN now() ELSE NULL END,
              updated_at = now()
        WHERE id = $1`,
      [order.id, nextRemaining, nextReserved]
    );
  }

  // Phase B (steps 5 and 6), and the only phase B in the codebase. Keep every open buy
  // order's share of the cash pool true to the ledger. Both users are reallocated, not
  // just the buyer: the seller's own resting buy orders share a pool that this settlement
  // has just moved value through.
  //
  // Each call locks that user's cash_reserved row and then ALL of their open BUY orders,
  // which is why these row locks land after the balance locks above rather than before.
  // Safe only because lockCashPools already covered both users, so no competing
  // transaction can reach these sibling rows; see THE INVARIANT in reservations.ts.
  await reallocateCashReservations(tx, buy.user_id);
  await reallocateCashReservations(tx, sell.user_id);

  await applyCostBasis(tx, {
    buyerId: buy.user_id,
    sellerId: sell.user_id,
    marketId: buy.market_id,
    side: buy.side,
    quantity,
    pricePya: tradePrice,
  });

  return { tradeId: trade.rows[0].id, journalId: journal.journalId, pricePya: tradePrice, quantity };
}

/**
 * Position cost basis and realised P&L (integer Pyas).
 *
 * Basis is tracked for reporting only; share ownership lives in the ledger.
 * When a seller disposes of part of a holding, the released basis is allocated
 * proportionally with integer floor division, so the remainder stays with the
 * retained shares and a fully sold position ends at exactly zero. This avoids
 * inventing a FIFO/LIFO policy that the owner has not specified.
 */
async function applyCostBasis(
  tx: Transaction,
  input: {
    buyerId: string;
    sellerId: string;
    marketId: string;
    side: Side;
    quantity: number;
    pricePya: number;
  }
): Promise<void> {
  const purchaseCost = input.quantity * input.pricePya;

  await tx.query(
    `INSERT INTO positions (user_id, market_id, side, cost_basis_pya)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, market_id, side)
     DO UPDATE SET cost_basis_pya = positions.cost_basis_pya + EXCLUDED.cost_basis_pya,
                   updated_at = now()`,
    [input.buyerId, input.marketId, input.side, purchaseCost]
  );

  const sellerPosition = await tx.query<{ cost_basis_pya: string | number }>(
    `SELECT cost_basis_pya FROM positions
      WHERE user_id = $1 AND market_id = $2 AND side = $3
      FOR UPDATE`,
    [input.sellerId, input.marketId, input.side]
  );
  if (sellerPosition.rows.length === 0) {
    // Escrowed shares without a recorded position would make P&L unverifiable.
    throw new DomainError("internal_error", { message: "Seller has no position record for this market." });
  }

  const totalBasis = Number(sellerPosition.rows[0].cost_basis_pya);
  // Shares held by the seller are: free shares, plus shares escrowed behind their
  // own open sell orders, plus the shares just settled out of escrow. Counting all
  // three is what makes the proportional release exact even with resting orders.
  const free = await shareBalances(tx, input.sellerId, input.marketId, input.side);
  const escrowedForSeller = await tx.query<{ total: string | number | null }>(
    `SELECT COALESCE(sum(remaining_quantity), 0) AS total
       FROM orders
      WHERE user_id = $1 AND market_id = $2 AND side = $3
        AND action = 'SELL' AND status = 'open'`,
    [input.sellerId, input.marketId, input.side]
  );
  const heldBefore =
    free.available + Number(escrowedForSeller.rows[0]?.total ?? 0) + input.quantity;
  if (heldBefore < input.quantity) {
    throw new DomainError("internal_error", { message: "Seller holding is inconsistent with the trade." });
  }

  const releasedBasis =
    heldBefore === input.quantity
      ? totalBasis
      : Math.floor((totalBasis * input.quantity) / heldBefore);
  const proceeds = input.quantity * input.pricePya;

  await tx.query(
    `UPDATE positions
        SET cost_basis_pya = cost_basis_pya - $4,
            realised_pnl_pya = realised_pnl_pya + $5,
            updated_at = now()
      WHERE user_id = $1 AND market_id = $2 AND side = $3`,
    [input.sellerId, input.marketId, input.side, releasedBasis, proceeds - releasedBasis]
  );
}

/** List a user's open orders, newest first. */
export async function listOpenOrders(db: Database, userId: string): Promise<OrderView[]> {
  const result = await db.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders
      WHERE user_id = $1 AND status = 'open'
      ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows.map(toOrderView);
}

/** Aggregate depth of one side of the book. Depth is derived, never stored. */
export async function bookDepth(
  db: Database,
  marketId: string,
  side: Side
): Promise<{ bids: { pricePya: number; quantity: number }[]; asks: { pricePya: number; quantity: number }[] }> {
  const result = await db.query<{ action: Action; price_pya: number | string; quantity: number | string }>(
    `SELECT action, price_pya, sum(remaining_quantity) AS quantity
       FROM orders
      WHERE market_id = $1 AND side = $2 AND status = 'open' AND remaining_quantity > 0
      GROUP BY action, price_pya`,
    [marketId, side]
  );
  const bids: { pricePya: number; quantity: number }[] = [];
  const asks: { pricePya: number; quantity: number }[] = [];
  for (const row of result.rows) {
    const entry = { pricePya: Number(row.price_pya), quantity: Number(row.quantity) };
    if (row.action === "BUY") bids.push(entry);
    else asks.push(entry);
  }
  bids.sort((a, b) => b.pricePya - a.pricePya);
  asks.sort((a, b) => a.pricePya - b.pricePya);
  return { bids, asks };
}

/** Current cash figures for the API/UI. */
export async function getCash(db: Database, userId: string): Promise<{ available: number; reserved: number; total: number }> {
  return db.transaction(async (tx) => {
    const available = await ensureAccount(tx, { type: "user", id: userId }, PYA, "cash_available");
    const reserved = await ensureAccount(tx, { type: "user", id: userId }, PYA, "cash_reserved");
    return {
      available: await balanceOf(tx, available),
      reserved: await balanceOf(tx, reserved),
      total: (await balanceOf(tx, available)) + (await balanceOf(tx, reserved)),
    };
  });
}
