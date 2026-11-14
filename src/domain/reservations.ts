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
 * LOCK ORDER. This is the FIRST lock any caller takes. When a transaction involves two
 * users, acquire both pools in a sorted order so two settlements that mirror each other
 * cannot deadlock on the pair:
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
 * Lock ordering: callers must not already hold an `orders` row lock in a way that
 * inverts this. `settleTrade` locks orders first, then balances, and `cancelOrder`
 * does the same — so the pool lock is always taken last and consistently.
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
