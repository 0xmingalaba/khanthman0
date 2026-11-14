/**
 * Database-level invariant tests.
 *
 * These bypass the domain layer entirely and attack the schema directly. If a
 * future refactor removes a service-layer check, these still fail.
 */

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import type { Database } from "@/src/db/executor";
import { createTestDb, makeOpenMarket, makeUser, type TestContext } from "../helpers/db";

describe("schema enforces critical invariants", () => {
  let ctx: TestContext;
  let db: Database;

  before(async () => {
    ctx = await createTestDb();
    db = ctx.db;
  });
  after(async () => {
    await ctx.close();
  });

  test("an order can never reserve more than its remaining size could require", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    // 10 shares at a 40 Pyas limit can need at most 400 Pyas.
    await assert.rejects(
      db.query(
        `INSERT INTO orders (market_id, user_id, side, action, price_pya, quantity,
           remaining_quantity, reserved_units, status)
         VALUES ($1, $2, 'YES', 'BUY', 40, 10, 10, 401, 'open')`,
        [market.id, user.id]
      ),
      /orders_reservation_within_limit/
    );
    // A reservation may legitimately be lower after a fill released improvement.
    await db.query(
      `INSERT INTO orders (market_id, user_id, side, action, price_pya, quantity,
         remaining_quantity, reserved_units, status)
       VALUES ($1, $2, 'YES', 'BUY', 40, 10, 10, 1, 'open')`,
      [market.id, user.id]
    );
  });

  test("a negative reservation is impossible", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    await assert.rejects(
      db.query(
        `INSERT INTO orders (market_id, user_id, side, action, price_pya, quantity,
           remaining_quantity, reserved_units, status)
         VALUES ($1, $2, 'YES', 'SELL', 40, 10, 10, -1, 'open')`,
        [market.id, user.id]
      ),
      // Either guard may fire first; both must reject a negative reservation.
      /orders_reserved_non_negative|orders_reservation_within_limit|orders_reserved_check/
    );
  });

  test("a filled order must have zero remaining quantity", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    await assert.rejects(
      db.query(
        `INSERT INTO orders (market_id, user_id, side, action, price_pya, quantity,
           remaining_quantity, reserved_units, status, closed_at)
         VALUES ($1, $2, 'YES', 'BUY', 40, 10, 3, 120, 'filled', now())`,
        [market.id, user.id]
      ),
      /orders_filled_has_no_remainder/
    );
  });

  test("prices outside 1..99 are rejected by the database", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    for (const badPrice of [0, 100, -5]) {
      await assert.rejects(
        db.query(
          `INSERT INTO orders (market_id, user_id, side, action, price_pya, quantity,
             remaining_quantity, reserved_units, status)
           VALUES ($1, $2, 'YES', 'BUY', $3, 1, 1, $4, 'open')`,
          [market.id, user.id, badPrice, badPrice]
        ),
        (error: unknown) => {
          // Either the tick-range check or the reservation formula must reject it;
          // a bad price can never produce a valid order row.
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /orders_price_pya_check|orders_reservation_consistent/);
          return true;
        }
      );
    }
  });

  test("duplicate emails are impossible at the database level", async () => {
    const user = await makeUser(db);
    await assert.rejects(
      db.query(
        "INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Dup')",
        [user.email]
      ),
      /users_email_key|duplicate key/
    );
  });

  test("emails must be stored lowercase", async () => {
    await assert.rejects(
      db.query(
        "INSERT INTO users (email, password_hash, display_name) VALUES ('Mixed@Example.com', 'x', 'D')"
      ),
      /users_email_lowercase/
    );
  });

  test("a user cannot hold two positions for the same outcome", async () => {
    const user = await makeUser(db);
    const market = await makeOpenMarket(db);
    await db.query(
      "INSERT INTO positions (user_id, market_id, side, cost_basis_pya) VALUES ($1, $2, 'YES', 10)",
      [user.id, market.id]
    );
    await assert.rejects(
      db.query(
        "INSERT INTO positions (user_id, market_id, side, cost_basis_pya) VALUES ($1, $2, 'YES', 20)",
        [user.id, market.id]
      ),
      /positions_unique|duplicate key/
    );
  });

  test("a resolution outcome requires the resolved status", async () => {
    const market = await makeOpenMarket(db);
    await assert.rejects(
      db.query("UPDATE markets SET outcome = 'YES' WHERE id = $1", [market.id]),
      /markets_outcome_requires_resolved/
    );
  });

  test("market content is required in both languages", async () => {
    await assert.rejects(
      db.query(
        `INSERT INTO markets (slug, category_id, question_en, question_my, description_en,
           description_my, rules_en, rules_my, resolution_criteria_en, resolution_criteria_my, close_at)
         VALUES ('too-short', 'myanmar', 'short', 'short', 'd', 'd', 'r', 'r', 'c', 'c', now())`
      ),
      /markets_question_en_check/
    );
  });

  test("market status is constrained to the documented lifecycle", async () => {
    const market = await makeOpenMarket(db);
    await assert.rejects(
      db.query("UPDATE markets SET status = 'launched' WHERE id = $1", [market.id]),
      /markets_status_check/
    );
  });

  test("session token hashes must be 32 bytes", async () => {
    const user = await makeUser(db);
    await assert.rejects(
      db.query(
        "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [user.id, new Uint8Array([1, 2, 3])]
      ),
      /sessions_token_hash_len/
    );
  });

  test("ledger account kinds cannot be paired with the wrong asset", async () => {
    await assert.rejects(
      db.query(
        `INSERT INTO ledger_accounts (owner_type, owner_id, asset, kind)
         VALUES ('system', NULL, 'PYA', 'shares_available')`
      ),
      /ledger_accounts_asset_matches_kind/
    );
    await assert.rejects(
      db.query(
        `INSERT INTO ledger_accounts (owner_type, owner_id, asset, kind)
         VALUES ('system', NULL, 'SHARE:00000000-0000-0000-0000-000000000001:YES', 'system_equity')`
      ),
      /ledger_accounts_asset_matches_kind/
    );
  });

  test("zero-value ledger entries are rejected", async () => {
    const user = await makeUser(db);
    const journal = await db.query<{ id: string }>(
      "INSERT INTO ledger_journals (kind) VALUES ('correction') RETURNING id"
    );
    const account = await db.query<{ id: string }>(
      "SELECT id FROM ledger_accounts WHERE owner_type = 'user' AND owner_id = $1 LIMIT 1",
      [user.id]
    );
    await assert.rejects(
      db.query("INSERT INTO ledger_entries (journal_id, account_id, delta) VALUES ($1, $2, 0)", [
        journal.rows[0].id,
        account.rows[0].id,
      ]),
      /ledger_entries_delta_check/
    );
  });

  test("audit logs are append-only", async () => {
    const user = await makeUser(db);
    await assert.rejects(
      db.query("DELETE FROM audit_logs WHERE actor_id = $1", [user.id]),
      /append-only/
    );
  });
});
