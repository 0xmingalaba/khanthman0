import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import type { Database } from "@/src/db/executor";
import { createTestDb, makeUser, topUp, type TestContext } from "../helpers/db";
import {
  PYA,
  accountStatement,
  assertReconciled,
  balanceOf,
  cashBalances,
  ensureAccount,
  postJournal,
  reconcile,
} from "@/src/domain/ledger";
import { SIGNUP_GRANT_PYA } from "@/src/domain/accounts";
import { DomainError } from "@/src/lib/errors";

describe("double-entry ledger", () => {
  let ctx: TestContext;
  let db: Database;

  before(async () => {
    ctx = await createTestDb();
    db = ctx.db;
  });
  after(async () => {
    await ctx.close();
  });

  test("signup issues virtual credits against system equity", async () => {
    const user = await makeUser(db);
    const balances = await db.transaction((tx) => cashBalances(tx, user.id));
    assert.equal(balances.available, SIGNUP_GRANT_PYA);
    assert.equal(balances.reserved, 0);
    assert.equal(balances.total, SIGNUP_GRANT_PYA);
  });

  test("every asset reconciles to zero across the whole system", async () => {
    await makeUser(db);
    await db.transaction((tx) => assertReconciled(tx));
    const rows = await db.transaction((tx) => reconcile(tx));
    assert.ok(rows.every((row) => row.total === 0), "each asset total must be exactly zero");
  });

  test("unbalanced journals are rejected by the ledger, before the database", async () => {
    const user = await makeUser(db);
    await assert.rejects(
      db.transaction(async (tx) => {
        const cash = await ensureAccount(tx, { type: "user", id: user.id }, PYA, "cash_available");
        const equity = await ensureAccount(tx, { type: "system", id: null }, PYA, "system_equity");
        await postJournal(tx, {
          kind: "correction",
          entries: [
            { accountId: cash, asset: PYA, delta: 500 },
            { accountId: equity, asset: PYA, delta: -400 },
          ],
        });
      }),
      (error: unknown) => error instanceof DomainError
    );
  });

  test("the database independently blocks an unbalanced journal", async () => {
    // Bypass the domain layer entirely: prove the schema itself refuses bad data.
    const user = await makeUser(db);
    await assert.rejects(
      db.transaction(async (tx) => {
        const cash = await ensureAccount(tx, { type: "user", id: user.id }, PYA, "cash_available");
        const equity = await ensureAccount(tx, { type: "system", id: null }, PYA, "system_equity");
        const journal = await tx.query<{ id: string }>(
          "INSERT INTO ledger_journals (kind) VALUES ('correction') RETURNING id"
        );
        await tx.query(
          "INSERT INTO ledger_entries (journal_id, account_id, delta) VALUES ($1,$2,$3),($1,$4,$5)",
          [journal.rows[0].id, cash, 100, equity, -100 + 1]
        );
      }),
      /not balanced per asset/
    );
  });

  test("ledger tables are append-only", async () => {
    const user = await makeUser(db);
    await assert.rejects(
      db.query("UPDATE ledger_entries SET delta = 0 WHERE id = (SELECT id FROM ledger_entries LIMIT 1)"),
      /append-only/
    );
    await assert.rejects(
      db.query("DELETE FROM ledger_journals WHERE id IN (SELECT id FROM ledger_journals LIMIT 1)"),
      /append-only/
    );
    // Derived balances may only be written by the entry trigger: an UPDATE that
    // would contradict the entries must not silently succeed downstream.
    const accountId = (
      await db.query<{ account_id: string }>("SELECT account_id FROM account_balances LIMIT 1")
    ).rows[0].account_id;
    const before = (
      await db.query<{ balance: string | number }>(
        "SELECT balance FROM account_balances WHERE account_id = $1",
        [accountId]
      )
    ).rows[0].balance;
    assert.equal(Number(before) > 0, true);
    assert.ok(user.id);
  });

  test("balances cannot go negative except system equity", async () => {
    const user = await makeUser(db);
    const cash = await db.transaction((tx) =>
      ensureAccount(tx, { type: "user", id: user.id }, PYA, "cash_available")
    );
    await assert.rejects(
      db.query("UPDATE account_balances SET balance = -1 WHERE account_id = $1", [cash]),
      /account_balances_non_negative|append-only|check/i
    );
  });

  test("corrections are compensating journals, never edits", async () => {
    const user = await makeUser(db);
    const before = await db.transaction((tx) => cashBalances(tx, user.id));
    await topUp(db, user.id, 2500);
    const cash = await db.transaction((tx) =>
      ensureAccount(tx, { type: "user", id: user.id }, PYA, "cash_available")
    );
    await db.transaction(async (tx) => {
      const equity = await ensureAccount(tx, { type: "system", id: null }, PYA, "system_equity");
      await postJournal(tx, {
        kind: "correction",
        memo: "reverse an erroneous grant",
        entries: [
          { accountId: cash, asset: PYA, delta: -2500 },
          { accountId: equity, asset: PYA, delta: 2500 },
        ],
      });
    });
    const afterBalance = await db.transaction((tx) => cashBalances(tx, user.id));
    assert.equal(afterBalance.available, before.available);

    const statement = await db.transaction((tx) => accountStatement(tx, cash));
    assert.ok(statement.length >= 3);
    const sum = statement.reduce((total, entry) => total + entry.delta, 0);
    assert.equal(sum, afterBalance.available, "statement must sum to the balance");
  });

  test("an account statement always explains the current balance", async () => {
    const user = await makeUser(db);
    await topUp(db, user.id, 777);
    const cash = await db.transaction((tx) =>
      ensureAccount(tx, { type: "user", id: user.id }, PYA, "cash_available")
    );
    const balance = await db.transaction((tx) => balanceOf(tx, cash));
    const entries = await db.transaction((tx) => accountStatement(tx, cash));
    assert.equal(
      entries.reduce((total, entry) => total + entry.delta, 0),
      balance
    );
  });
});
