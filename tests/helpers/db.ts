/**
 * Test harness: a fresh PostgreSQL-compatible database (PGlite) with the real
 * migration applied, plus fixtures for users and an open market.
 */

import { createPgliteDatabase } from "@/src/db/pglite";
import type { Database, Transaction } from "@/src/db/executor";
import { migrate } from "@/src/db/migrate";
import { registerUser } from "@/src/domain/accounts";
import { PYA, ensureAccount, postJournal } from "@/src/domain/ledger";
import { createSession } from "@/src/auth/session";

export type TestContext = {
  db: Database;
  close: () => Promise<void>;
};

export async function createTestDb(): Promise<TestContext> {
  const db = await createPgliteDatabase();
  await migrate(db);
  return { db, close: () => db.close() };
}

let userSeq = 0;

export async function makeUser(
  db: Database,
  overrides: Partial<Parameters<typeof registerUser>[1]> = {}
): Promise<{ id: string; email: string; password: string }> {
  userSeq += 1;
  const email = overrides.email ?? `user${userSeq}.${Date.now().toString(36)}@example.com`;
  const password = overrides.password ?? "correct horse battery staple";
  const created = await registerUser(db, {
    email,
    password,
    displayName: overrides.displayName ?? `Test User ${userSeq}`,
    locale: overrides.locale ?? "en",
  });
  return { id: created.id, email, password };
}

export async function makeAdmin(db: Database, userId: string): Promise<void> {
  await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [userId]);
}

export async function makeOpenMarket(
  db: Database,
  options: {
    slug?: string;
    closeAt?: Date;
    creatorId?: string;
    status?: "draft" | "pending_review" | "open";
  } = {}
): Promise<{ id: string; slug: string }> {
  const slug = options.slug ?? `test-market-${Math.random().toString(36).slice(2, 10)}`;
  const closeAt = options.closeAt ?? new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  const result = await db.query<{ id: string; slug: string }>(
    `INSERT INTO markets
       (slug, category_id, question_en, question_my, description_en, description_my,
        rules_en, rules_my, resolution_criteria_en, resolution_criteria_my,
        status, creator_id, opens_at, close_at)
     VALUES ($1, 'myanmar',
             'Will this test market resolve YES?',
             'ဤစမ်းသပ်ဈေးကွက်သည် မှန်ပါမည်လား။',
             'Description', 'ဖော်ပြချက်', 'Rules', 'စည်းမျဉ်းများ',
             'Criteria', 'သတ်မှတ်ချက်များ',
             $2, $3, now() - interval '1 day', $4)
     RETURNING id, slug`,
    [slug, options.status ?? "open", options.creatorId ?? null, closeAt]
  );
  return result.rows[0];
}

/** Give an existing user extra virtual cash, recorded as a balanced grant. */
export async function topUp(db: Database, userId: string, amountPya: number): Promise<void> {
  await db.transaction(async (tx: Transaction) => {
    const cash = await ensureAccount(tx, { type: "user", id: userId }, PYA, "cash_available");
    const equity = await ensureAccount(tx, { type: "system", id: null }, PYA, "system_equity");
    await postJournal(tx, {
      kind: "grant",
      actorId: null,
      refType: "test",
      refId: userId,
      memo: "test top-up",
      entries: [
        { accountId: cash, asset: PYA, delta: amountPya },
        { accountId: equity, asset: PYA, delta: -amountPya },
      ],
    });
  });
}

/**
 * Mint shares for a user, fully collateralised.
 *
 * A real mint would issue a YES and a NO share against 100 Pyas of locked
 * collateral (complete-set minting). Complete-set minting is deliberately not
 * implemented in the product yet, so this test-only helper issues a single
 * outcome's shares backed by equal collateral. Everything is written as ONE
 * balanced journal per asset, so no intermediate state violates the
 * non-negative balance constraint.
 */
export async function grantShares(
  db: Database,
  input: { userId: string; marketId: string; side: "YES" | "NO"; quantity: number; pricePya: number }
): Promise<void> {
  await db.transaction(async (tx: Transaction) => {
    const asset = `SHARE:${input.marketId}:${input.side}` as const;
    const userShares = await ensureAccount(tx, { type: "user", id: input.userId }, asset, "shares_available");
    // Shares are issued against a dedicated system credit account, exactly as a
    // complete-set mint would. The market escrow only ever holds escrowed shares.
    const issuer = await ensureAccount(tx, { type: "system", id: null }, asset, "system_issued");
    const cash = await ensureAccount(tx, { type: "user", id: input.userId }, PYA, "cash_available");
    const payoutEscrow = await ensureAccount(
      tx,
      { type: "market", id: input.marketId },
      PYA,
      "escrow_payout"
    );

    // 100 Pyas of collateral per share keeps the position fully backed.
    const collateral = input.quantity * 100;

    await postJournal(tx, {
      kind: "grant",
      actorId: null,
      refType: "test",
      refId: input.marketId,
      memo: "test share mint",
      entries: [
        { accountId: userShares, asset, delta: input.quantity },
        { accountId: issuer, asset, delta: -input.quantity },
      ],
    });

    // Mirror a real acquisition: the holder's cost basis is recorded so realised
    // P&L on a later sale is verifiable.
    await tx.query(
      `INSERT INTO positions (user_id, market_id, side, cost_basis_pya)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, market_id, side)
       DO UPDATE SET cost_basis_pya = positions.cost_basis_pya + EXCLUDED.cost_basis_pya,
                     updated_at = now()`,
      [input.userId, input.marketId, input.side, input.quantity * input.pricePya]
    );

    await postJournal(tx, {
      kind: "grant",
      actorId: null,
      refType: "test",
      refId: input.marketId,
      memo: "test collateral backing",
      entries: [
        { accountId: payoutEscrow, asset: PYA, delta: collateral },
        { accountId: cash, asset: PYA, delta: -collateral },
      ],
    });
  });
}

export async function makeSessionToken(db: Database, userId: string): Promise<string> {
  const { token } = await createSession(db, userId, "test-agent");
  return token;
}
