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

/*
 * CANONICAL LOCK ORDER for every book mutation. Read this before adding a lock.
 *
 * There are TWO PHASES, and row locks are grouped by phase rather than by table. The
 * sibling-order locks in phase B are deliberately taken AFTER a balance lock, so the
 * invariant is NOT "every order lock precedes every balance lock". Do not restate it
 * that way.
 *
 * PHASE A -- one shared prefix, taken before anything is mutated:
 *
 *   1. `markets` row, FOR SHARE       `placeOrder` only, via lockTradableMarket
 *   2. cash-pool advisory lock        per user, via lockCashPool/lockCashPools
 *   3. `orders` row locks             `settleTrade`'s two trade orders, or
 *                                     `cancelOrder`'s one order
 *   4. `account_balances` FOR UPDATE  via lockBalance/lockBalances
 *
 * PHASE B -- reservation reallocation, reached only from `settleTrade`:
 *
 *   5. `account_balances` FOR UPDATE  lockedReservedPool: the reallocated user's
 *                                     cash_reserved row (already held for the buyer,
 *                                     first taken here for the seller)
 *   6. `orders` row locks             EVERY open BUY order of that user, via
 *                                     reallocateCashReservations (ORDER BY created_at, id)
 *   7. `positions` row locks          via applyCostBasis, after both reallocations
 *
 * `cancelOrder` runs phase A only; `placeOrder` runs phase A with no step-3 order lock
 * (it inserts a new row) and skips phase B entirely.
 *
 * Step 1 is the one exception to "pool lock first", and it is deliberate: the market
 * lock is a SHARE lock, which does not conflict with another SHARE lock, so two
 * `placeOrder` calls can hold it simultaneously and cannot queue behind each other. It
 * is also the lock that rejects a closed market, so it has to come before anything is
 * reserved. Nothing in the codebase takes a market row exclusively -- there is no
 * UPDATE of `markets` outside tests -- which is what keeps the exception safe.
 *
 * THE INVARIANT THAT MAKES PHASE B SAFE. Phase B's locks are safe despite coming after
 * a balance lock, because every row it reaches is owned by a user whose cash-pool
 * advisory lock this transaction already holds at step 2. A competing transaction
 * cannot lock those sibling BUY rows at all until it acquires that same advisory lock,
 * so step 6 can never block on a concurrent holder, and no lock cycle can pass through
 * it. The ordering inside phase B is therefore irrelevant to deadlock; it is only
 * required to be consistent, which it is (balance, then ascending orders).
 *
 * That invariant is worth checking, not assuming. Every statement that locks an `orders`
 * row, and how it gets there:
 *
 *   - trading.ts `settleTrade`  its own two orders, under BOTH parties' pool locks. The
 *     pool locks cover both users, so this is exactly the invariant, with no exception.
 *   - reservations.ts           every open BUY order of one user, reached only from
 *     reallocateCashReservations, whose sole caller is `settleTrade`, which holds the
 *     pool locks of exactly the two users it then reallocates.
 *   - trading.ts `cancelOrder`  a single order row. This is the ONE case where the row
 *     locked is not yet known to belong to the caller, and it is documented separately
 *     below.
 *
 * THE REJECTED-OWNERSHIP EXCEPTION (`cancelOrder`). The caller's own pool lock is taken
 * first, at step 2, and only then is the target row locked at step 3 -- because the row
 * has to be read before its owner can be known. So for one statement the locked row may
 * belong to a DIFFERENT user, whose pool lock this transaction does not hold. That does
 * not weaken the invariant, because the function checks ownership immediately after the
 * lock and, if the order belongs to someone else, throws `forbidden` right there. The
 * throw rolls the transaction back: no further locks are taken and nothing is mutated.
 * So no cash_reserved row, no sibling BUY order and no position is ever reached on a
 * path where ownership was rejected.
 *
 * Worth being precise about what this does and does not cost. It is not a deadlock risk:
 * the caller holds their own pool lock first, and a rejected cancellation is a short
 * read-then-abort that acquires one order row and nothing else, so it cannot be part of a
 * cycle involving a pool lock. What it does mean is that a caller can briefly hold a
 * `FOR UPDATE` lock on another user's order row, which blocks that user's own settlement
 * of that order for the duration of the (immediately failing) transaction. Treat that as
 * an accepted property of this shape, not as a break in the ordering.
 *
 * `lockedReservedPool` likewise has only two callers -- `releasableCash` (from
 * `cancelOrder`, under that user's pool lock, and only reached AFTER the ownership check
 * has passed) and `reallocateCashReservations` -- so every path into the cash_reserved row
 * holds the matching advisory lock first.
 *
 * RULES THAT MUST NOT BREAK. (a) If any path ever writes a `markets` row, it must take
 * the pool lock first and then the market row exclusively; that inverts steps 1 and 2
 * and would make `placeOrder` cycle. (b) Any new caller of
 * `reallocateCashReservations` or `lockedReservedPool` MUST already hold that user's
 * pool lock, or step 6 stops being unreachable by competitors and the original 40P01
 * deadlock returns in a new shape.
 */

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
 * WHERE IT SITS. Step 2 of the canonical order above: after `placeOrder`'s market
 * SHARE lock, before every orders and balances lock in both phases. It is the first lock
 * in `settleTrade` and `cancelOrder`, and the first *conflicting* lock in `placeOrder`.
 * Holding it for a user is what lets phase B take that user's sibling BUY order locks
 * after a balance lock without risk; see THE INVARIANT in the canonical block above.
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
 * Lock ordering: this takes the cash_reserved row at step 5 (phase B), so callers must
 * already hold that user's cash-pool advisory lock. Both call sites do: `releasableCash`
 * runs under `cancelOrder`'s pool lock, and `reallocateCashReservations` runs under
 * `settleTrade`'s pool locks for both parties. The advisory lock is what makes the
 * interleaving safe; the balance lock alone would not, because two transactions could
 * each be holding a different orders row while waiting for it.
 *
 * Note this is NOT the first time a settlement touches a balance: `settleTrade` already
 * locked cash_reserved at step 4, so for the buyer this reuses a lock it holds. That is
 * fine -- re-locking a row a transaction already owns is a no-op -- but it is why the
 * canonical order numbers phase B from 5 rather than pretending balances all come at 4.
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
  //
  // Lock order here is phase B, steps 5 then 6: the pool balance row first, then every
  // open BUY order of this user in (created_at, id) order. Those sibling order locks
  // deliberately come AFTER a balance lock. They are safe because the only caller,
  // settleTrade, already holds this user's cash-pool advisory lock, so no competing
  // transaction can hold or want these rows. If a new caller is added, it must take the
  // same pool lock first. See THE INVARIANT in the canonical block above.
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
