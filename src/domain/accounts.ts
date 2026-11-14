/**
 * Account creation and the virtual credit grant.
 *
 * Virtual credits only. Mingala issues 10,000 MMK (1,000,000 Pyas) of play money
 * to each new account. This is not a deposit, has no cash value, and is recorded
 * as a balanced journal against `system_equity` so the ledger stays reconciled.
 */

import type { Database, Transaction } from "@/src/db/executor";
import { DomainError } from "@/src/lib/errors";
import { PYA, ensureAccount, postJournal } from "@/src/domain/ledger";
import { hashPassword, validatePassword } from "@/src/auth/password";

/** 10,000 MMK expressed in Pyas. */
export const SIGNUP_GRANT_PYA = 1_000_000;

export type RegisterInput = {
  email: string;
  password: string;
  displayName: string;
  locale?: "my" | "en";
};

export type RegisteredUser = {
  id: string;
  email: string;
  displayName: string;
  locale: "my" | "en";
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Create a user, their cash accounts, preferences and the initial grant. */
export async function registerUser(
  db: Database,
  input: RegisterInput
): Promise<RegisteredUser> {
  const email = normalizeEmail(input.email);
  const displayName = input.displayName.trim();
  const locale = input.locale === "en" ? "en" : "my";
  const password = validatePassword(input.password);

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    throw new DomainError("validation_failed", {
      details: { email: "Enter a valid email address." },
    });
  }
  if (displayName.length < 1 || displayName.length > 60) {
    throw new DomainError("validation_failed", {
      details: { displayName: "Display name must be 1-60 characters." },
    });
  }

  const passwordHash = await hashPassword(password);

  return db.transaction(async (tx: Transaction) => {
    // The unique index on users.email is what actually prevents duplicates under
    // concurrency; we check first only to return a clean message in the common case.
    const existing = await tx.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      throw new DomainError("conflict", {
        message: "An account with that email already exists.",
        details: { email: "An account with that email already exists." },
      });
    }

    const created = await tx.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, role)
       VALUES ($1, $2, $3, 'user')
       RETURNING id`,
      [email, passwordHash, displayName]
    );
    const userId = created.rows[0].id;

    await tx.query("INSERT INTO user_preferences (user_id, locale) VALUES ($1, $2)", [userId, locale]);
    await tx.query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id)
       VALUES ($1::uuid, 'user.register', 'user', $1::text)`,
      [userId]
    );

    const cashAvailable = await ensureAccount(tx, { type: "user", id: userId }, PYA, "cash_available");
    const equity = await ensureAccount(tx, { type: "system", id: null }, PYA, "system_equity");

    await postJournal(tx, {
      kind: "grant",
      actorId: userId,
      refType: "user",
      refId: userId,
      memo: "signup virtual credit grant",
      entries: [
        { accountId: cashAvailable, asset: PYA, delta: SIGNUP_GRANT_PYA },
        { accountId: equity, asset: PYA, delta: -SIGNUP_GRANT_PYA },
      ],
    });

    return { id: userId, email, displayName, locale };
  });
}

export type LoginInput = { email: string; password: string };

/** Verify credentials. Returns the user id when valid; null otherwise. */
export async function verifyCredentials(
  db: Database,
  input: LoginInput
): Promise<{ id: string; status: string } | null> {
  const email = normalizeEmail(input.email);
  const result = await db.query<{ id: string; password_hash: string; status: string }>(
    "SELECT id, password_hash, status FROM users WHERE email = $1",
    [email]
  );

  // Imported lazily so the timing-equalisation helper stays in one place.
  const { verifyPassword, dummyVerify } = await import("@/src/auth/password");

  if (result.rows.length === 0) {
    await dummyVerify();
    return null;
  }

  const row = result.rows[0];
  const valid = await verifyPassword(input.password, row.password_hash);
  if (!valid) return null;
  return { id: row.id, status: row.status };
}
