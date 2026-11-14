/**
 * Reservation accounting helpers.
 *
 * A user's `cash_reserved` balance is shared by all of their open buy orders, and
 * the market's share escrow is shared by all open sell orders in that market.
 * Releasing a single order must therefore release at most the *unallocated* part
 * of the pool, otherwise a cancellation could free another order's collateral.
 *
 * `order.reserved_units` records how much of the pool belongs to that order.
 * The helpers below keep `sum(open orders) <= pool` true after every mutation.
 */

import type { Transaction } from "@/src/db/executor";
import { DomainError } from "@/src/lib/errors";
import { ensureAccount, lockBalance } from "@/src/domain/ledger";

export type Side = "YES" | "NO";

/**
 * CANONICAL LOCK ORDER for every book mutation. Read this before adding a lock.
 *
 *   1. `markets` row, FOR SHARE      — `placeOrder` only, via lockTradableMarket.
 *   2. cash-pool advisory lock       — per user, via lockCashPool/lockCashPools.
 *   3. `orders` row locks            — ascending id, or a single row.
 *   4. `account_balances` FOR UPDATE — via lockBalance/lockBalances.
 *
 * Step 1 is the one exception to "pool lock first", and it is deliberate: the market
 * lock is a SHARE lock, which does not conflict with another SHARE lock, so two
 * `placeOrder` calls can hold it simultaneously and cannot queue behind each other. It
 * is also the lock that rejects a closed market, so it has to come before anything is
 * reserved. Nothing in the codebase takes a market row exclusively -- there is no
 * UPDATE of `markets` outside tests -- which is what keeps the exception safe.
 *
 * THE RULE THAT MUST NOT BREAK: if any path ever needs to write a `markets` row, it
 * must take the pool lock FIRST and then the market row exclusively. That inverts
 * step 1 and step 2, and `placeOrder` holding a market SHARE lock while waiting for a
 * pool lock would then cycle against it. Until such a path exists, the current order is
 * correct.
 *
 * ---------------------------------------------------------------------------
 *
 * Serialise every mutation that touches one user's cash reservation pool.
 *
 * WHY THIS EXISTS. `reallocateCashReservations` locks EVERY open buy order of the
 * buyer while rewriting their slices of the shared pool. Without a coarser guard, two
 * concurrent settlements for the same buyer each lock their own pair of orders first and
 * then each reach for the other's — a textbook lock cycle that PostgreSQL breaks by
 * aborting one side with 40P01 (deadlock detected). Reproduced 5/5 against a real server
 * before this guard was added.
 *
 * Taking a per-user advisory lock BEFORE any order or balance row lock makes those
 * transactions serial for that user, so the cycle cannot form, and the loser simply
 * waits instead of failing.
 *
 * WHERE IT SITS. Second in the canonical order above — after `placeOrder`'s market
 * SHARE lock and before every orders/balances lock. It is the first lock in
 * `settleTrade` and `cancelOrder`, and the first *conflicting* lock in `placeOrder`.
 * When a transaction involves two users, acquire both pools sorted, so two settlements
 * that mirror each other cannot deadlock on the pair:
 *
 *     lockCashPools(tx, [buyerId, sellerId])
 *
 * Advisory locks are re-entrant within a transaction and are released at commit or
 * rollback, so this cannot leak across requests.
 */
export async function lockCashPool(tx: Transaction, userId: string): Promise<void> {
  await tx.lock(`cash-pool:${userId}`);
}

/** Lock several users' pools in a stable order. See lockCashPool. */
export async function lockCashPools(tx: Transaction, userIds: string[]): Promise<void> {
  for (const userId of [...new Set(userIds)].sort()) {
    await lockCashPool(tx, userId);
  }
}

/** Total reserved by a user's open buy orders (in Pyas). */
export async function sumOpenBuyReservations(tx: Transaction, userId: string): Promise<number> {
  const result = await tx.query<{ total: string | number | null }>(
    `SELECT COALESCE(sum(reserved_units), 0) AS total
       FROM orders
      WHERE user_id = $1 AND action = 'BUY' AND status = 'open'`,
    [userId]
  );
  return Number(result.rows[0]?.total ?? 0);
}

/** Total shares escrowed by open sell orders in a market for one outcome. */
export async function sumOpenSellReservations(
  tx: Transaction,
  marketId: string,
  side: Side
): Promise<number> {
  const result = await tx.query<{ total: string | number | null }>(
    `SELECT COALESCE(sum(reserved_units), 0) AS total
       FROM orders
      WHERE market_id = $1 AND side = $2 AND action = 'SELL' AND status = 'open'`,
    [marketId, side]
  );
  return Number(result.rows[0]?.total ?? 0);
}

/**
 * How much cash a cancellation may safely release.
 *
 * The order claims `orderReservedUnits`, but the pool may hold less if other
 * orders were settled first. Releasing the pool's surplus would steal collateral
 * from a sibling order, so the release is capped at the unallocated surplus.
 */
export async function releasableCash(
  tx: Transaction,
  input: { userId: string; orderReservedUnits: number; orderId: string }
): Promise<number> {
  // Locked: cancellation is about to debit this pool, so the decision must be made
  // against a value no concurrent transaction can change underneath us.
  const pool = await lockedReservedPool(tx, input.userId);
  const claimedByOthers = Math.max(
    (await sumOpenBuyReservations(tx, input.userId)) - input.orderReservedUnits,
    0
  );
  const unallocated = Math.max(pool - claimedByOthers, 0);
  return Math.min(input.orderReservedUnits, unallocated);
}

/**
 * Read the pool under a row lock.
 *
 * Reallocation rewrites every open order's slice of one shared pool, so it must hold
 * the pool's balance row for the whole read-modify-write. Without the lock, two
 * concurrent mutations touching the same user's pool (two settlements, or a
 * settlement racing a cancellation) could each read the pre-mutation balance and
 * write slices that sum to more than the pool — leaving an order claiming collateral
 * another order has already spent. `lockBalance` blocks the second transaction until
 * the first commits, so it re-reads the committed value.
 *
 * Lock ordering: this takes the balance row at step 4 of the canonical order, so
 * callers must already hold the cash-pool advisory lock and their `orders` row locks.
 * Both call sites satisfy that -- `settleTrade` and `cancelOrder` take the pool lock
 * before touching rows, then order locks, then balances. The advisory lock is what makes
 * the interleaving safe; the balance lock alone would not, because two transactions
 * could each be holding a different order row while waiting for it.
 */
async function lockedReservedPool(tx: Transaction, userId: string): Promise<number> {
  const account = await ensureAccount(tx, { type: "user", id: userId }, "PYA", "cash_reserved");
  return lockBalance(tx, account);
}

/**
 * Recalculate one order's share of the cash pool after a fill.
 *
 * The settlement journal already debited the pool by `debited`. Every open buy
 * order is re-derived from the current pool, in creation order, capped by its own
 * remaining * limit. A single-order book therefore releases price improvement
 * immediately, while a multi-order book can never over-allocate the pool.
 */
export async function reallocateCashReservations(tx: Transaction, userId: string): Promise<void> {
  // Locked, not merely read: this function rewrites every open order's slice of a
  // single shared pool, so a concurrent reader would otherwise allocate the same
  // Pyas twice. See lockedReservedPool for the full reasoning.
  const pool = await lockedReservedPool(tx, userId);
  const orders = await tx.query<{
    id: string;
    remaining_quantity: string | number;
    price_pya: string | number;
  }>(
    `SELECT id, remaining_quantity, price_pya
       FROM orders
      WHERE user_id = $1 AND action = 'BUY' AND status = 'open'
      ORDER BY created_at, id
      FOR UPDATE`,
    [userId]
  );

  let budget = pool;
  for (const order of orders.rows) {
    const ceiling = Number(order.remaining_quantity) * Number(order.price_pya);
    const allocation = Math.min(ceiling, budget);
    budget -= allocation;
    await tx.query("UPDATE orders SET reserved_units = $2::bigint, updated_at = now() WHERE id = $1", [
      order.id,
      allocation,
    ]);
  }

  if (budget !== 0) {
    // The pool holds cash that no open order claims. That is an accounting bug, not
    // a user error, so fail loudly rather than silently stranding the funds.
    throw new DomainError("internal_error", {
      message: "Reserved cash is not fully allocated to open orders.",
    });
  }
}
