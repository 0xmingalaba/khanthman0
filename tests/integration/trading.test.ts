import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import type { Database } from "@/src/db/executor";
import {
  createTestDb,
  grantShares,
  makeOpenMarket,
  makeUser,
  topUp,
  type TestContext,
} from "../helpers/db";
import { PYA, assertReconciled, cashBalances, ensureAccount, shareBalances } from "@/src/domain/ledger";
import {
  bookDepth,
  cancelOrder,
  getCash,
  listOpenOrders,
  placeOrder,
  requestFingerprint,
  settleTrade,
} from "@/src/domain/trading";
import { SIGNUP_GRANT_PYA } from "@/src/domain/accounts";
import { DomainError } from "@/src/lib/errors";

let keySeq = 0;
const key = (label: string) => `${label}-${(keySeq += 1)}-${Math.random().toString(36).slice(2, 10)}`;

describe("order placement, reservation and cancellation", () => {
  let ctx: TestContext;
  let db: Database;

  before(async () => {
    ctx = await createTestDb();
    db = ctx.db;
  });
  after(async () => {
    await ctx.close();
  });

  test("buying reserves exactly price x quantity and reduces available cash", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);

    const order = await placeOrder(db, {
      userId: user.id,
      marketId: market.id,
      side: "YES",
      action: "BUY",
      pricePya: 34,
      quantity: 100,
      idempotencyKey: key("buy"),
    });

    assert.equal(order.status, "open");
    assert.equal(order.reservedUnits, 3400);
    const cash = await getCash(db, user.id);
    assert.equal(cash.reserved, 3400);
    assert.equal(cash.available, SIGNUP_GRANT_PYA - 3400);
    assert.equal(cash.total, SIGNUP_GRANT_PYA, "total cash is unchanged by a reservation");
    await db.transaction((tx) => assertReconciled(tx));
  });

  test("an order larger than available cash is refused and writes nothing", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    const before = await getCash(db, user.id);

    await assert.rejects(
      placeOrder(db, {
        userId: user.id,
        marketId: market.id,
        side: "YES",
        action: "BUY",
        pricePya: 99,
        quantity: 1_000_000,
        idempotencyKey: key("too-big"),
      }),
      (error: unknown) => error instanceof DomainError && error.code === "insufficient_funds"
    );

    const after = await getCash(db, user.id);
    assert.deepEqual(after, before);
    const orders = await listOpenOrders(db, user.id);
    assert.equal(orders.length, 0, "a rejected order must not be persisted");
  });

  test("a user cannot sell shares they do not own", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    await assert.rejects(
      placeOrder(db, {
        userId: user.id,
        marketId: market.id,
        side: "YES",
        action: "SELL",
        pricePya: 60,
        quantity: 10,
        idempotencyKey: key("naked-short"),
      }),
      (error: unknown) => error instanceof DomainError && error.code === "insufficient_shares"
    );
  });

  test("selling escrows owned shares without changing total holdings", async () => {
    const seller = await makeUser(db);
    const market = await makeOpenMarket(db);
    await grantShares(db, {
      userId: seller.id,
      marketId: market.id,
      side: "YES",
      quantity: 50,
      pricePya: 40,
    });

    await placeOrder(db, {
      userId: seller.id,
      marketId: market.id,
      side: "YES",
      action: "SELL",
      pricePya: 55,
      quantity: 20,
      idempotencyKey: key("sell"),
    });

    const shares = await db.transaction((tx) => shareBalances(tx, seller.id, market.id, "YES"));
    assert.equal(shares.available, 30);
    assert.equal(shares.reserved, 0, "escrow belongs to the market account, not the user");
    assert.equal(shares.total, 30);
    await db.transaction((tx) => assertReconciled(tx));
  });

  test("cancelling a buy releases exactly the reservation", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    const order = await placeOrder(db, {
      userId: user.id,
      marketId: market.id,
      side: "NO",
      action: "BUY",
      pricePya: 47,
      quantity: 60,
      idempotencyKey: key("cancel-me"),
    });
    assert.equal((await getCash(db, user.id)).reserved, 47 * 60);

    const cancelled = await cancelOrder(db, {
      userId: user.id,
      orderId: order.id,
      idempotencyKey: key("cancel"),
    });
    assert.equal(cancelled.status, "cancelled");
    const cash = await getCash(db, user.id);
    assert.equal(cash.reserved, 0);
    assert.equal(cash.available, SIGNUP_GRANT_PYA);
    await db.transaction((tx) => assertReconciled(tx));
  });

  test("cancelling a sell returns the escrowed shares", async () => {
    const seller = await makeUser(db);
    const market = await makeOpenMarket(db);
    await grantShares(db, {
      userId: seller.id,
      marketId: market.id,
      side: "NO",
      quantity: 25,
      pricePya: 35,
    });
    const order = await placeOrder(db, {
      userId: seller.id,
      marketId: market.id,
      side: "NO",
      action: "SELL",
      pricePya: 65,
      quantity: 25,
      idempotencyKey: key("sell-cancel"),
    });
    await cancelOrder(db, { userId: seller.id, orderId: order.id, idempotencyKey: key("c2") });

    const shares = await db.transaction((tx) => shareBalances(tx, seller.id, market.id, "NO"));
    assert.equal(shares.available, 25);
    assert.equal(shares.total, 25);
  });

  test("only the owner can cancel an order", async () => {
    const owner = await makeUser(db);
    const attacker = await makeUser(db);
    const market = await makeOpenMarket(db);
    const order = await placeOrder(db, {
      userId: owner.id,
      marketId: market.id,
      side: "YES",
      action: "BUY",
      pricePya: 30,
      quantity: 10,
      idempotencyKey: key("owned"),
    });

    await assert.rejects(
      cancelOrder(db, { userId: attacker.id, orderId: order.id, idempotencyKey: key("steal") }),
      (error: unknown) => error instanceof DomainError && error.code === "forbidden"
    );

    const stillOpen = await listOpenOrders(db, owner.id);
    assert.equal(stillOpen.length, 1);
    assert.equal((await getCash(db, owner.id)).reserved, 300);
  });

  test("a cancelled order cannot be cancelled twice", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    const order = await placeOrder(db, {
      userId: user.id,
      marketId: market.id,
      side: "YES",
      action: "BUY",
      pricePya: 20,
      quantity: 10,
      idempotencyKey: key("double-cancel-source"),
    });
    await cancelOrder(db, { userId: user.id, orderId: order.id, idempotencyKey: key("dc1") });
    await assert.rejects(
      cancelOrder(db, { userId: user.id, orderId: order.id, idempotencyKey: key("dc2") }),
      (error: unknown) => error instanceof DomainError && error.code === "conflict"
    );
    assert.equal((await getCash(db, user.id)).available, SIGNUP_GRANT_PYA, "no double release");
  });

  test("trading is refused once a market is closed or past its close time", async () => {
    const user = await makeUser(db);
    const expired = await makeOpenMarket(db, { closeAt: new Date(Date.now() - 1000) });
    await assert.rejects(
      placeOrder(db, {
        userId: user.id,
        marketId: expired.id,
        side: "YES",
        action: "BUY",
        pricePya: 10,
        quantity: 1,
        idempotencyKey: key("late"),
      }),
      (error: unknown) => error instanceof DomainError && error.code === "market_closed"
    );

    const closed = await makeOpenMarket(db, { status: "pending_review" });
    await assert.rejects(
      placeOrder(db, {
        userId: user.id,
        marketId: closed.id,
        side: "YES",
        action: "BUY",
        pricePya: 10,
        quantity: 1,
        idempotencyKey: key("unopened"),
      }),
      (error: unknown) => error instanceof DomainError && error.code === "market_not_open"
    );
  });

  test("price and quantity validation happens on the server", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    for (const bad of [
      { pricePya: 0, quantity: 1 },
      { pricePya: 100, quantity: 1 },
      { pricePya: 50, quantity: 0 },
      { pricePya: 50, quantity: -3 },
      { pricePya: 50, quantity: 1.5 },
    ]) {
      const before = await getCash(db, user.id);
      await assert.rejects(
        placeOrder(db, {
          userId: user.id,
          marketId: market.id,
          side: "YES",
          action: "BUY",
          idempotencyKey: key("bad"),
          ...bad,
        })
      );
      assert.deepEqual(await getCash(db, user.id), before);
    }
  });

  test("an idempotent replay performs no additional financial effect", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    const idempotencyKey = key("replay");

    const first = await placeOrder(db, {
      userId: user.id,
      marketId: market.id,
      side: "YES",
      action: "BUY",
      pricePya: 25,
      quantity: 40,
      idempotencyKey,
    });
    const reservedAfterFirst = (await getCash(db, user.id)).reserved;

    const replay = await placeOrder(db, {
      userId: user.id,
      marketId: market.id,
      side: "YES",
      action: "BUY",
      pricePya: 25,
      quantity: 40,
      idempotencyKey,
    });

    assert.equal(replay.id, first.id, "the replay returns the original order");
    assert.equal((await getCash(db, user.id)).reserved, reservedAfterFirst, "no second reservation");
    assert.equal((await listOpenOrders(db, user.id)).length, 1);
  });

  test("reusing an idempotency key with different contents is rejected", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    const idempotencyKey = key("conflict");

    await placeOrder(db, {
      userId: user.id,
      marketId: market.id,
      side: "YES",
      action: "BUY",
      pricePya: 25,
      quantity: 10,
      idempotencyKey,
    });
    await assert.rejects(
      placeOrder(db, {
        userId: user.id,
        marketId: market.id,
        side: "YES",
        action: "BUY",
        pricePya: 25,
        quantity: 999,
        idempotencyKey,
      }),
      (error: unknown) => error instanceof DomainError && error.code === "idempotency_conflict"
    );
  });

  test("concurrent placements cannot spend the same Pyas twice", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    // Balance is 1,000,000 Pyas. 11 x 99 x 1000 = 1,089,000, so at most 10 can win.
    const attempts = Array.from({ length: 11 }, (_unused, index) =>
      placeOrder(db, {
        userId: user.id,
        marketId: market.id,
        side: "YES",
        action: "BUY",
        pricePya: 99,
        quantity: 1000,
        idempotencyKey: key(`race-${index}`),
      }).then(
        () => "ok" as const,
        (error: unknown) => {
          assert.ok(error instanceof DomainError, `unexpected error type: ${String(error)}`);
          return "rejected" as const;
        }
      )
    );

    const results = await Promise.all(attempts);
    const accepted = results.filter((value) => value === "ok").length;
    const cash = await getCash(db, user.id);

    assert.equal(accepted, 10, "exactly ten orders fit inside the balance");
    assert.equal(cash.reserved, 10 * 99 * 1000);
    assert.ok(cash.available >= 0, "available balance can never go negative");
    await db.transaction((tx) => assertReconciled(tx));
  });

  test("the book depth is derived from open orders only", async () => {
    const market = await makeOpenMarket(db);
    const a = await makeUser(db);
    const b = await makeUser(db);
    await placeOrder(db, {
      userId: a.id, marketId: market.id, side: "YES", action: "BUY", pricePya: 30, quantity: 10,
      idempotencyKey: key("d1"),
    });
    const staging = await placeOrder(db, {
      userId: b.id, marketId: market.id, side: "YES", action: "BUY", pricePya: 32, quantity: 5,
      idempotencyKey: key("d2"),
    });
    await cancelOrder(db, { userId: b.id, orderId: staging.id, idempotencyKey: key("d3") });

    const depth = await bookDepth(db, market.id, "YES");
    assert.deepEqual(depth.bids, [{ pricePya: 30, quantity: 10 }]);
    assert.deepEqual(depth.asks, []);
  });
});

describe("trade settlement", () => {
  let ctx: TestContext;
  let db: Database;

  before(async () => {
    ctx = await createTestDb();
    db = ctx.db;
  });
  after(async () => {
    await ctx.close();
  });

  async function setupTrade(quantity = 10, price = 40) {
    const seller = await makeUser(db);
    const buyer = await makeUser(db);
    const market = await makeOpenMarket(db);
    await grantShares(db, { userId: seller.id, marketId: market.id, side: "YES", quantity, pricePya: 50 });

    const sell = await placeOrder(db, {
      userId: seller.id, marketId: market.id, side: "YES", action: "SELL",
      pricePya: price, quantity, idempotencyKey: key("s"),
    });
    const buy = await placeOrder(db, {
      userId: buyer.id, marketId: market.id, side: "YES", action: "BUY",
      pricePya: price, quantity, idempotencyKey: key("b"),
    });
    return { seller, buyer, market, sell, buy };
  }

  test("settlement moves cash and shares atomically in one journal", async () => {
    const { seller, buyer, market, sell, buy } = await setupTrade(10, 40);
    const buyerBefore = await getCash(db, buyer.id);
    const sellerBefore = await getCash(db, seller.id);

    const trade = await db.transaction((tx) =>
      settleTrade(tx, { buyOrderId: buy.id, sellOrderId: sell.id, quantity: 10 })
    );

    assert.equal(trade.pricePya, 40);
    assert.equal(trade.quantity, 10);

    const buyerAfter = await getCash(db, buyer.id);
    const sellerAfter = await getCash(db, seller.id);
    assert.equal(buyerAfter.reserved, 0);
    assert.equal(buyerAfter.total, buyerBefore.total - 400);
    assert.equal(sellerAfter.available, sellerBefore.available + 400);

    const buyerShares = await db.transaction((tx) => shareBalances(tx, buyer.id, market.id, "YES"));
    assert.equal(buyerShares.available, 10);
    const sellerShares = await db.transaction((tx) => shareBalances(tx, seller.id, market.id, "YES"));
    assert.equal(sellerShares.total, 0);

    const tradeCount = await db.query<{ c: number }>("SELECT count(*)::int AS c FROM trades");
    assert.equal(tradeCount.rows[0].c, 1);
    await db.transaction((tx) => assertReconciled(tx));
  });

  test("a partially filled order can be cancelled for exactly the remainder", async () => {
    const seller = await makeUser(db);
    const buyer = await makeUser(db);
    const market = await makeOpenMarket(db);
    await grantShares(db, { userId: seller.id, marketId: market.id, side: "NO", quantity: 100, pricePya: 55 });

    const sell = await placeOrder(db, {
      userId: seller.id, marketId: market.id, side: "NO", action: "SELL",
      pricePya: 60, quantity: 100, idempotencyKey: key("ps"),
    });
    const buy = await placeOrder(db, {
      userId: buyer.id, marketId: market.id, side: "NO", action: "BUY",
      pricePya: 65, quantity: 40, idempotencyKey: key("pb"),
    });

    await db.transaction((tx) => settleTrade(tx, { buyOrderId: buy.id, sellOrderId: sell.id, quantity: 25 }));

    const afterPartial = await db.transaction((tx) => shareBalances(tx, seller.id, market.id, "NO"));
    assert.equal(afterPartial.available, 0);
    assert.equal(afterPartial.total, 0);

    // Settlement released the 5 Pyas/share price improvement on the filled part, and
    // the unfilled part is still reserved at the buyer's limit price.
    const buyerCashAfterSettle = await getCash(db, buyer.id);
    assert.equal(buyerCashAfterSettle.reserved, 15 * 65);

    await cancelOrder(db, { userId: buyer.id, orderId: buy.id, idempotencyKey: key("pc") });
    const buyerCashFinal = await getCash(db, buyer.id);
    assert.equal(buyerCashFinal.reserved, 0);
    assert.equal(
      buyerCashFinal.total,
      SIGNUP_GRANT_PYA - 25 * 60,
      "the buyer paid the maker price for filled shares only"
    );
    await db.transaction((tx) => assertReconciled(tx));
  });

  test("settling more than an order's remainder is refused", async () => {
    const { sell, buy } = await setupTrade(5, 40);
    await assert.rejects(
      db.transaction((tx) => settleTrade(tx, { buyOrderId: buy.id, sellOrderId: sell.id, quantity: 6 })),
      (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
    );
  });

  test("a user cannot trade with themselves", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    await grantShares(db, { userId: user.id, marketId: market.id, side: "YES", quantity: 10, pricePya: 50 });
    const sell = await placeOrder(db, {
      userId: user.id, marketId: market.id, side: "YES", action: "SELL",
      pricePya: 45, quantity: 10, idempotencyKey: key("self-s"),
    });
    const buy = await placeOrder(db, {
      userId: user.id, marketId: market.id, side: "YES", action: "BUY",
      pricePya: 45, quantity: 10, idempotencyKey: key("self-b"),
    });
    await assert.rejects(
      db.transaction((tx) => settleTrade(tx, { buyOrderId: buy.id, sellOrderId: sell.id, quantity: 10 })),
      (error: unknown) => error instanceof DomainError
    );
  });

  test("a buyer cannot settle below the seller's limit price", async () => {
    const seller = await makeUser(db);
    const buyer = await makeUser(db);
    const market = await makeOpenMarket(db);
    await grantShares(db, { userId: seller.id, marketId: market.id, side: "YES", quantity: 10, pricePya: 80 });
    const sell = await placeOrder(db, {
      userId: seller.id, marketId: market.id, side: "YES", action: "SELL",
      pricePya: 80, quantity: 10, idempotencyKey: key("hi-s"),
    });
    const buy = await placeOrder(db, {
      userId: buyer.id, marketId: market.id, side: "YES", action: "BUY",
      pricePya: 70, quantity: 10, idempotencyKey: key("hi-b"),
    });
    await assert.rejects(
      db.transaction((tx) => settleTrade(tx, { buyOrderId: buy.id, sellOrderId: sell.id, quantity: 10 })),
      /at least the sell price/
    );
  });

  test("realised P&L is recorded in integer Pyas", async () => {
    const { seller, sell, buy } = await setupTrade(10, 40);
    await db.transaction((tx) =>
      settleTrade(tx, { buyOrderId: buy.id, sellOrderId: sell.id, quantity: 10 })
    );
    const position = await db.query<{ cost_basis_pya: string | number; realised_pnl_pya: string | number }>(
      "SELECT cost_basis_pya, realised_pnl_pya FROM positions WHERE user_id = $1",
      [seller.id]
    );
    // Seller minted 10 shares at a 50 Pyas basis (500) and sold at 40 (400).
    assert.equal(Number(position.rows[0].cost_basis_pya), 0);
    assert.equal(Number(position.rows[0].realised_pnl_pya), -100);
  });

  test("the request fingerprint is stable and distinguishes payloads", () => {
    assert.equal(requestFingerprint({ a: 1 }), requestFingerprint({ a: 1 }));
    assert.notEqual(requestFingerprint({ a: 1 }), requestFingerprint({ a: 2 }));
  });

  test("a partial fill at a better price releases the unused collateral immediately", async () => {
    const buyer = await makeUser(db);
    const s1 = await makeUser(db);
    const s2 = await makeUser(db);
    const market = await makeOpenMarket(db);
    await grantShares(db, { userId: s1.id, marketId: market.id, side: "YES", quantity: 10, pricePya: 60 });
    await grantShares(db, { userId: s2.id, marketId: market.id, side: "YES", quantity: 10, pricePya: 62 });

    const buy = await placeOrder(db, {
      userId: buyer.id, marketId: market.id, side: "YES", action: "BUY",
      pricePya: 65, quantity: 20, idempotencyKey: key("pi-buy"),
    });
    assert.equal((await getCash(db, buyer.id)).reserved, 20 * 65);

    const sell1 = await placeOrder(db, {
      userId: s1.id, marketId: market.id, side: "YES", action: "SELL",
      pricePya: 60, quantity: 10, idempotencyKey: key("pi-s1"),
    });
    await db.transaction((tx) => settleTrade(tx, { buyOrderId: buy.id, sellOrderId: sell1.id, quantity: 10 }));

    // Paid 600 for the filled half. The unfilled half stays reserved at its limit
    // (10 x 65 = 650), and the 50 Pyas of price improvement is spendable again.
    const cashAfterFirst = await getCash(db, buyer.id);
    assert.equal(cashAfterFirst.reserved, 10 * 65, "only the unfilled half stays reserved");
    assert.equal(cashAfterFirst.available, SIGNUP_GRANT_PYA - 600 - 650);
    assert.equal(cashAfterFirst.total, SIGNUP_GRANT_PYA - 600, "total cash drops by the executed value only");

    const sell2 = await placeOrder(db, {
      userId: s2.id, marketId: market.id, side: "YES", action: "SELL",
      pricePya: 62, quantity: 10, idempotencyKey: key("pi-s2"),
    });
    await db.transaction((tx) => settleTrade(tx, { buyOrderId: buy.id, sellOrderId: sell2.id, quantity: 10 }));

    const final = await getCash(db, buyer.id);
    assert.equal(final.reserved, 0, "a fully filled order reserves nothing");
    assert.equal(final.available, SIGNUP_GRANT_PYA - 600 - 620, "the buyer paid exactly the maker prices");
    await db.transaction((tx) => assertReconciled(tx));
  });

  test("cancelling one order never releases a sibling order's collateral", async () => {
    const buyer = await makeUser(db);
    const seller = await makeUser(db);
    const market = await makeOpenMarket(db);
    await grantShares(db, { userId: seller.id, marketId: market.id, side: "YES", quantity: 10, pricePya: 40 });

    const first = await placeOrder(db, {
      userId: buyer.id, marketId: market.id, side: "YES", action: "BUY",
      pricePya: 60, quantity: 10, idempotencyKey: key("sib-1"),
    });
    const second = await placeOrder(db, {
      userId: buyer.id, marketId: market.id, side: "YES", action: "BUY",
      pricePya: 50, quantity: 10, idempotencyKey: key("sib-2"),
    });
    assert.equal((await getCash(db, buyer.id)).reserved, 600 + 500);

    const sell = await placeOrder(db, {
      userId: seller.id, marketId: market.id, side: "YES", action: "SELL",
      pricePya: 45, quantity: 10, idempotencyKey: key("sib-s"),
    });
    // Fill the first order at 45: it releases 15 Pyas/share of improvement.
    await db.transaction((tx) => settleTrade(tx, { buyOrderId: first.id, sellOrderId: sell.id, quantity: 10 }));

    const afterFill = await getCash(db, buyer.id);
    assert.equal(afterFill.reserved, 500, "the sibling order keeps its full reservation");

    await cancelOrder(db, { userId: buyer.id, orderId: second.id, idempotencyKey: key("sib-c") });
    const afterCancel = await getCash(db, buyer.id);
    assert.equal(afterCancel.reserved, 0);
    assert.equal(
      afterCancel.available,
      SIGNUP_GRANT_PYA - 450,
      "only the executed value was spent; all reservations were returned"
    );
    await db.transaction((tx) => assertReconciled(tx));
  });

  test("settlement never leaves an order in an inconsistent reservation state", async () => {
    const { sell, buy } = await setupTrade(7, 33);
    await db.transaction((tx) => settleTrade(tx, { buyOrderId: buy.id, sellOrderId: sell.id, quantity: 7 }));
    const rows = await db.query<{ status: string; remaining_quantity: string; reserved_units: string }>(
      "SELECT status, remaining_quantity, reserved_units FROM orders WHERE id = $1::uuid OR id = $2::uuid",
      [buy.id, sell.id]
    );
    for (const row of rows.rows) {
      assert.equal(row.status, "filled");
      assert.equal(Number(row.remaining_quantity), 0);
      assert.equal(Number(row.reserved_units), 0);
    }
  });
});

describe("cash account bootstrap", () => {
  let ctx: TestContext;
  let db: Database;

  before(async () => {
    ctx = await createTestDb();
    db = ctx.db;
  });
  after(async () => {
    await ctx.close();
  });

  test("accounts are created once even under repeated lookups", async () => {
    const user = await makeUser(db);
    const ids = await db.transaction(async (tx) => {
      const a = await ensureAccount(tx, { type: "user", id: user.id }, PYA, "cash_available");
      const b = await ensureAccount(tx, { type: "user", id: user.id }, PYA, "cash_available");
      return [a, b];
    });
    assert.equal(ids[0], ids[1]);
    const count = await db.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM ledger_accounts WHERE owner_type = 'user' AND owner_id = $1",
      [user.id]
    );
    assert.equal(count.rows[0].c, 1);
  });

  test("topping up keeps reserves intact", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    await placeOrder(db, {
      userId: user.id, marketId: market.id, side: "YES", action: "BUY",
      pricePya: 10, quantity: 100, idempotencyKey: key("t"),
    });
    await topUp(db, user.id, 5000);
    const cash = await db.transaction((tx) => cashBalances(tx, user.id));
    assert.equal(cash.reserved, 1000);
    assert.equal(cash.available, SIGNUP_GRANT_PYA - 1000 + 5000);
  });
});
