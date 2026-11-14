import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Database } from "@/src/db/executor";
import { cashBalances, ensureAccount, lockBalance, shareBalances } from "@/src/domain/ledger";
import { DomainError } from "@/src/lib/errors";
import { cancelOrder, placeOrder, settleTrade } from "@/src/domain/trading";
import { SIGNUP_GRANT_PYA } from "@/src/domain/accounts";
import { createPgTestDb, hasRealPostgres, sleep, type PgTestContext } from "../helpers/pg-db";
import { grantShares, makeOpenMarket, makeUser, topUp } from "../helpers/db";

/**
 * REAL POSTGRESQL CONCURRENCY SUITE
 *
 * Every test here runs against a genuine PostgreSQL server over several
 * independent pool connections. PGlite is deliberately NOT used: its single
 * connection serialises all transactions (src/db/pglite.ts), so it can never
 * contend a row lock, and a "concurrency" test on it proves nothing.
 *
 * What is proven here:
 *   - two transactions really do block on the same balance row (`FOR UPDATE`);
 *   - a lock waiter re-reads the committed value and refuses an unaffordable spend;
 *   - concurrent cancellation and settlement cannot both release the same Pyas;
 *   - concurrent duplicate requests with one idempotency key execute once;
 *   - the production node-postgres adapter behaves correctly, including rollback.
 */

const suite = hasRealPostgres ? describe : describe.skip;

suite("PostgreSQL row-lock contention (real server, multiple connections)", () => {
  let ctx: PgTestContext;
  let db: Database;

  before(async () => {
    ctx = await createPgTestDb();
    db = ctx.db;
  });

  after(async () => {
    await ctx.close();
  });

  test("FOR UPDATE genuinely blocks a second connection until the first commits", async () => {
    const user = await makeUser(db);
    const account = await db.transaction((tx) =>
      ensureAccount(tx, { type: "user", id: user.id }, "PYA", "cash_available")
    );

    let firstHolds = false;
    let secondAcquired = false;

    // Transaction A takes the row lock and holds it briefly.
    const a = db.transaction(async (tx) => {
      await lockBalance(tx, account);
      firstHolds = true;
      await sleep(400);
      return "a";
    });

    // Give A time to acquire the lock, then start B on a different connection.
    await sleep(100);
    assert.equal(firstHolds, true, "first transaction should hold the lock");

    const b = db.transaction(async (tx) => {
      // This must block until A commits; if PGlite were used here it would not.
      await lockBalance(tx, account);
      secondAcquired = true;
      return "b";
    });

    await sleep(150);
    assert.equal(
      secondAcquired,
      false,
      "second transaction must still be blocked while the first holds the row lock"
    );

    await Promise.all([a, b]);
    assert.equal(secondAcquired, true, "second transaction proceeds after the first commits");
  });

  test("concurrent placements cannot spend the same Pyas twice (real contention)", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);

    // Balance = 1,000,000. Each order costs 99 * 1000 = 99,000, so exactly 10 fit.
    const attempts = Array.from({ length: 14 }, (_unused, index) =>
      placeOrder(db, {
        userId: user.id,
        marketId: market.id,
        side: "YES",
        action: "BUY",
        pricePya: 99,
        quantity: 1000,
        idempotencyKey: `real-race-place-${index}`,
      }).then(
        () => "ok" as const,
        (error: unknown) => {
          assert.ok(error instanceof DomainError, `unexpected: ${String(error)}`);
          return "rejected" as const;
        }
      )
    );

    const results = await Promise.all(attempts);
    const accepted = results.filter((value) => value === "ok").length;
    const cash = await db.transaction((tx) => cashBalances(tx, user.id));

    assert.equal(accepted, 10, "exactly ten orders fit inside the balance");
    assert.equal(cash.reserved, 10 * 99 * 1000);
    assert.ok(cash.available >= 0, "available cash can never go negative");
    assert.equal(cash.available + cash.reserved, SIGNUP_GRANT_PYA, "no Pyas created or lost");
    await db.transaction(async (tx) => {
      const rows = await tx.query<{ asset: string; total: string | number }>(
        `SELECT asset, COALESCE(sum(balance), 0) AS total FROM account_balances GROUP BY asset`
      );
      for (const row of rows.rows) {
        assert.equal(Number(row.total), 0, `asset ${row.asset} must reconcile to zero`);
      }
    });
  });

  test("concurrent placements from two users are not serialised into failure", async () => {
    // Guards against over-locking: separate users must be able to trade at once.
    const first = await makeUser(db);
    const second = await makeUser(db);
    const market = await makeOpenMarket(db);

    await Promise.all([
      placeOrder(db, {
        userId: first.id,
        marketId: market.id,
        side: "YES",
        action: "BUY",
        pricePya: 50,
        quantity: 100,
        idempotencyKey: "two-user-a",
      }),
      placeOrder(db, {
        userId: second.id,
        marketId: market.id,
        side: "YES",
        action: "BUY",
        pricePya: 50,
        quantity: 100,
        idempotencyKey: "two-user-b",
      }),
    ]);

    for (const user of [first, second]) {
      const cash = await db.transaction((tx) => cashBalances(tx, user.id));
      assert.equal(cash.reserved, 5000);
    }
  });
});

suite("PostgreSQL cancellation versus settlement", () => {
  let ctx: PgTestContext;
  let db: Database;

  before(async () => {
    ctx = await createPgTestDb();
    db = ctx.db;
  });

  after(async () => {
    await ctx.close();
  });

  test("cancelling while settling cannot release the same collateral twice", async () => {
    const seller = await makeUser(db);
    const buyer = await makeUser(db);
    const market = await makeOpenMarket(db);
    await grantShares(db, {
      userId: seller.id,
      marketId: market.id,
      side: "YES",
      quantity: 100,
      pricePya: 50,
    });

    const buy = await placeOrder(db, {
      userId: buyer.id,
      marketId: market.id,
      side: "YES",
      action: "BUY",
      pricePya: 60,
      quantity: 50,
      idempotencyKey: "cvb-buy-0001",
    });
    const sell = await placeOrder(db, {
      userId: seller.id,
      marketId: market.id,
      side: "YES",
      action: "SELL",
      pricePya: 50,
      quantity: 50,
      idempotencyKey: "cvb-sell",
    });

    // Race a settlement of 30 against a full cancellation of the same buy order.
    const settled = settleRace(db, buy.id, sell.id, 30);
    const cancelled = cancelOrder(db, {
      userId: buyer.id,
      orderId: buy.id,
      idempotencyKey: "cvb-cancel",
    }).then(
      () => "cancelled" as const,
      () => "refused" as const
    );

    const [settleOutcome, cancelOutcome] = await Promise.all([settled, cancelled]);

    // Whichever order the lock grants, the ledger must stay consistent and no Pyas
    // may be released that the other operation already spent.
    assert.ok(
      ["settled", "conflict", "refused"].includes(settleOutcome),
      `unexpected settle outcome ${settleOutcome}`
    );
    assert.ok(["cancelled", "refused"].includes(cancelOutcome));

    const cash = await db.transaction((tx) => cashBalances(tx, buyer.id));
    // Reserved can never exceed what the remaining open buy orders claim, and it can
    // never go negative regardless of interleaving.
    assert.ok(cash.reserved >= 0, "reserved cash must never be negative");
    assert.ok(cash.available >= 0, "available cash must never be negative");

    // The buyer's total must equal the grant minus whatever actually settled: a
    // settlement deliberately transfers Pyas to the seller, so "no Pyas created or
    // lost" has to be measured against the trades that really happened.
    const spent = await db.query<{ total: string | number }>(
      `SELECT COALESCE(sum(price_pya * quantity), 0) AS total
         FROM trades WHERE buy_order_id = $1`,
      [buy.id]
    );
    assert.equal(
      cash.available + cash.reserved,
      SIGNUP_GRANT_PYA - Number(spent.rows[0].total),
      "buyer total equals grant minus settled consideration"
    );

    await assertReconciled(db);
  });

  test("two concurrent cancellations of one order release its collateral only once", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    const order = await placeOrder(db, {
      userId: user.id,
      marketId: market.id,
      side: "YES",
      action: "BUY",
      pricePya: 40,
      quantity: 100,
      idempotencyKey: "double-cancel-place",
    });

    const attempts = await Promise.all(
      [1, 2, 3].map((n) =>
        cancelOrder(db, {
          userId: user.id,
          orderId: order.id,
          idempotencyKey: `double-cancel-${n}`,
        }).then(
          () => "ok" as const,
          () => "refused" as const
        )
      )
    );

    assert.equal(
      attempts.filter((value) => value === "ok").length,
      1,
      "exactly one cancellation may succeed"
    );

    const cash = await db.transaction((tx) => cashBalances(tx, user.id));
    assert.equal(cash.reserved, 0, "all reserved cash released");
    assert.equal(cash.available, SIGNUP_GRANT_PYA, "released exactly once, not twice");
    await assertReconciled(db);
  });

  test("concurrent settlements keep every open order's reservation equal to the pool", async () => {
    // This is the invariant the reservation-allocation lock protects: one user's
    // cash_reserved pool is shared by all their open buy orders, so reallocation
    // after each fill must re-derive every slice without double-allocating.
    const buyer = await makeUser(db);
    const sellerA = await makeUser(db);
    const sellerB = await makeUser(db);
    const market = await makeOpenMarket(db);

    for (const seller of [sellerA, sellerB]) {
      await grantShares(db, {
        userId: seller.id,
        marketId: market.id,
        side: "YES",
        quantity: 100,
        pricePya: 50,
      });
    }

    // Two buy orders from the same buyer: 40 @ 50 and 40 @ 50 => 4,000 reserved.
    const buyOne = await placeOrder(db, {
      userId: buyer.id,
      marketId: market.id,
      side: "YES",
      action: "BUY",
      pricePya: 50,
      quantity: 40,
      idempotencyKey: "realloc-buy-one",
    });
    const buyTwo = await placeOrder(db, {
      userId: buyer.id,
      marketId: market.id,
      side: "YES",
      action: "BUY",
      pricePya: 50,
      quantity: 40,
      idempotencyKey: "realloc-buy-two",
    });
    const sellA = await placeOrder(db, {
      userId: sellerA.id,
      marketId: market.id,
      side: "YES",
      action: "SELL",
      pricePya: 50,
      quantity: 20,
      idempotencyKey: "realloc-sell-a",
    });
    const sellB = await placeOrder(db, {
      userId: sellerB.id,
      marketId: market.id,
      side: "YES",
      action: "SELL",
      pricePya: 50,
      quantity: 20,
      idempotencyKey: "realloc-sell-b",
    });

    // Fill both of the buyer's orders at once, on separate connections.
    await Promise.all([
      settleRace(db, buyOne.id, sellA.id, 20),
      settleRace(db, buyTwo.id, sellB.id, 20),
    ]);

    const pool = await db.transaction((tx) => cashBalances(tx, buyer.id));
    const allocation = await db.query<{ total: string | number }>(
      `SELECT COALESCE(sum(reserved_units), 0) AS total
         FROM orders WHERE user_id = $1 AND action = 'BUY' AND status = 'open'`,
      [buyer.id]
    );

    assert.equal(
      Number(allocation.rows[0].total),
      pool.reserved,
      "open orders must claim exactly the reserved pool, never more"
    );
    // 40 shares bought at 50 each = 2,000 Pyas of the original 4,000 released to sellers.
    assert.ok(pool.reserved >= 0);
    assert.ok(pool.available >= 0);
    await assertReconciled(db);
  });

  test("concurrent settlements of one buy order cannot oversell it", async () => {
    const sellerA = await makeUser(db);
    const sellerB = await makeUser(db);
    const buyer = await makeUser(db);
    const market = await makeOpenMarket(db);

    for (const seller of [sellerA, sellerB]) {
      await grantShares(db, {
        userId: seller.id,
        marketId: market.id,
        side: "YES",
        quantity: 100,
        pricePya: 50,
      });
    }

    const buy = await placeOrder(db, {
      userId: buyer.id,
      marketId: market.id,
      side: "YES",
      action: "BUY",
      pricePya: 50,
      quantity: 60,
      idempotencyKey: "oversell-buy",
    });
    const sellA = await placeOrder(db, {
      userId: sellerA.id,
      marketId: market.id,
      side: "YES",
      action: "SELL",
      pricePya: 50,
      quantity: 40,
      idempotencyKey: "oversell-sell-a",
    });
    const sellB = await placeOrder(db, {
      userId: sellerB.id,
      marketId: market.id,
      side: "YES",
      action: "SELL",
      pricePya: 50,
      quantity: 40,
      idempotencyKey: "oversell-sell-b",
    });

    // Both settlements race for the same 60-share buy order; 40 + 40 > 60.
    const results = await Promise.all([
      settleRace(db, buy.id, sellA.id, 40),
      settleRace(db, buy.id, sellB.id, 40),
    ]);

    const succeeded = results.filter((value) => value === "settled").length;
    assert.ok(
      succeeded <= 1 || results.includes("conflict"),
      `at most one full settlement may pass; got ${JSON.stringify(results)}`
    );

    // The decisive invariant: the buyer's filled shares never exceed the order size.
    const filled = await db.query<{ quantity: string | number }>(
      `SELECT COALESCE(sum(quantity), 0) AS quantity FROM trades WHERE buy_order_id = $1`,
      [buy.id]
    );
    assert.ok(
      Number(filled.rows[0].quantity) <= 60,
      `buy order overfilled: ${filled.rows[0].quantity} > 60`
    );
    await assertReconciled(db);
  });
});

suite("PostgreSQL idempotency under concurrency", () => {
  let ctx: PgTestContext;
  let db: Database;

  before(async () => {
    ctx = await createPgTestDb();
    db = ctx.db;
  });

  after(async () => {
    await ctx.close();
  });

  test("concurrent duplicate placements with one key execute exactly once", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    const key = "concurrent-idempotent-key-001";

    const attempts = Array.from({ length: 8 }, () =>
      placeOrder(db, {
        userId: user.id,
        marketId: market.id,
        side: "YES",
        action: "BUY",
        pricePya: 25,
        quantity: 100,
        idempotencyKey: key,
      }).then(
        (order) => ({ ok: true as const, order }),
        (error: unknown) => ({ ok: false as const, error })
      )
    );

    const results = await Promise.all(attempts);
    const successes = results.filter((result) => result.ok);
    assert.ok(successes.length >= 1, "the first request must succeed");

    // Every successful response must describe the SAME order: the key identifies one
    // operation, so a replay returns the stored result rather than creating a new one.
    const ids = new Set(
      successes.map((result) => (result.ok ? result.order.id : ""))
    );
    assert.equal(ids.size, 1, `all replays must return one order id, got ${[...ids].join(",")}`);

    const orderCount = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM orders WHERE user_id = $1",
      [user.id]
    );
    assert.equal(orderCount.rows[0].n, 1, "exactly one order may exist");

    const cash = await db.transaction((tx) => cashBalances(tx, user.id));
    assert.equal(cash.reserved, 2500, "collateral reserved once");
    await assertReconciled(db);
  });

  test("a concurrent replay with a different payload is rejected, not silently accepted", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    const key = "concurrent-idempotent-conflict-001";

    // Two DIFFERENT payloads sharing one key, issued simultaneously. Whichever
    // transaction claims the key first is the legitimate request; the other must be
    // rejected. Both orderings are valid, so the assertion is on the *shape* of the
    // outcome rather than on which one wins — a genuine race has no fixed winner.
    const attempt = (
      pricePya: number
    ): Promise<{ outcome: "accepted" } | { outcome: "rejected"; code: string }> =>
      placeOrder(db, {
        userId: user.id,
        marketId: market.id,
        side: "YES",
        action: "BUY",
        pricePya,
        quantity: 10,
        idempotencyKey: key,
      }).then(
        () => ({ outcome: "accepted" as const }),
        (error: unknown) => {
          assert.ok(error instanceof DomainError, `unexpected: ${String(error)}`);
          return { outcome: "rejected" as const, code: error.code };
        }
      );

    const results = await Promise.all([attempt(30), attempt(31)]);
    const accepted = results.filter((result) => result.outcome === "accepted");
    const rejected = results.filter(
      (result): result is { outcome: "rejected"; code: string } =>
        result.outcome === "rejected"
    );

    assert.equal(accepted.length, 1, "exactly one payload may own an idempotency key");
    assert.equal(rejected.length, 1, "the other payload must be refused");
    assert.ok(
      ["idempotency_conflict", "conflict"].includes(rejected[0].code),
      `expected an idempotency conflict, got ${rejected[0].code}`
    );

    const orderCount = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM orders WHERE user_id = $1",
      [user.id]
    );
    assert.equal(orderCount.rows[0].n, 1, "the conflicting request must not create a second order");
  });
});

suite("production pg adapter", () => {
  let ctx: PgTestContext;

  before(async () => {
    ctx = await createPgTestDb();
  });

  after(async () => {
    await ctx.close();
  });

  test("connects, migrates and answers a query", async () => {
    const result = await ctx.db.query<{ one: number }>("SELECT 1 AS one");
    assert.equal(result.rows[0].one, 1);
    const version = await ctx.db.query<{ version: string }>("SELECT version() AS version");
    assert.match(version.rows[0].version, /PostgreSQL/);
  });

  test("a transaction rolls back on throw and commits on success", async () => {
    await ctx.db.query("CREATE TABLE adapter_probe (id int)");

    await assert.rejects(() =>
      ctx.db.transaction(async (tx) => {
        await tx.query("INSERT INTO adapter_probe VALUES (1)");
        throw new Error("deliberate");
      })
    );
    let count = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM adapter_probe");
    assert.equal(count.rows[0].n, 0, "rolled back");

    await ctx.db.transaction(async (tx) => {
      await tx.query("INSERT INTO adapter_probe VALUES (2)");
    });
    count = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM adapter_probe");
    assert.equal(count.rows[0].n, 1, "committed");
  });

  test("a connection is released even when the transaction throws", async () => {
    // A leaked connection would exhaust the pool after `max` failures.
    for (let i = 0; i < 25; i += 1) {
      await assert.rejects(() =>
        ctx.db.transaction(async () => {
          throw new Error("boom");
        })
      );
    }
    const result = await ctx.db.query<{ one: number }>("SELECT 1 AS one");
    assert.equal(result.rows[0].one, 1, "pool still usable after repeated failures");
  });

  test("the executor exposes a working advisory lock", async () => {
    await ctx.db.transaction(async (tx) => {
      await tx.lock("market:some-id");
    });
  });

  test("topUp and share grants keep the ledger reconciled", async () => {
    const user = await makeUser(ctx.db);
    const market = await makeOpenMarket(ctx.db);
    await topUp(ctx.db, user.id, 500);
    await grantShares(ctx.db, {
      userId: user.id,
      marketId: market.id,
      side: "NO",
      quantity: 5,
      pricePya: 20,
    });
    const shares = await ctx.db.transaction((tx) =>
      shareBalances(tx, user.id, market.id, "NO")
    );
    assert.equal(shares.total, 5);
    await assertReconciled(ctx.db);
  });
});

/** Settle in its own transaction, classifying the outcome instead of throwing. */
async function settleRace(
  db: Database,
  buyOrderId: string,
  sellOrderId: string,
  quantity: number
): Promise<"settled" | "conflict" | "refused"> {
  try {
    await db.transaction((tx) =>
      settleTrade(tx, { buyOrderId, sellOrderId, quantity })
    );
    return "settled";
  } catch (error) {
    if (error instanceof DomainError) {
      return error.code === "conflict" || error.code === "validation_failed"
        ? "conflict"
        : "refused";
    }
    // Deadlock or serialisation aborts are legitimate outcomes of a real race.
    const message = error instanceof Error ? error.message : String(error);
    if (/deadlock|serializ|could not serialize/i.test(message)) return "conflict";
    throw error;
  }
}

/** Every asset must sum to zero across all accounts. */
async function assertReconciled(db: Database): Promise<void> {
  const rows = await db.query<{ asset: string; total: string | number }>(
    "SELECT asset, COALESCE(sum(balance), 0) AS total FROM account_balances GROUP BY asset"
  );
  for (const row of rows.rows) {
    assert.equal(Number(row.total), 0, `asset ${row.asset} is out of balance: ${row.total}`);
  }
}
