import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import type { Database } from "@/src/db/executor";
import { createTestDb, makeAdmin, makeSessionToken, makeUser, type TestContext } from "../helpers/db";
import { registerUser, verifyCredentials } from "@/src/domain/accounts";
import {
  createSession,
  requireRole,
  requireUser,
  resolveSession,
  revokeAllSessions,
  revokeSession,
} from "@/src/auth/session";
import { DomainError } from "@/src/lib/errors";
import { SIGNUP_GRANT_PYA } from "@/src/domain/accounts";
import { cashBalances } from "@/src/domain/ledger";

describe("registration and login", () => {
  let ctx: TestContext;
  let db: Database;

  before(async () => {
    ctx = await createTestDb();
    db = ctx.db;
  });
  after(async () => {
    await ctx.close();
  });

  test("registration creates a user, preferences and one grant of virtual credits", async () => {
    const created = await registerUser(db, {
      email: "  Person@Example.COM ",
      password: "a strong passphrase",
      displayName: "  Person  ",
      locale: "en",
    });
    assert.equal(created.email, "person@example.com", "email is normalised");
    assert.equal(created.displayName, "Person");

    const stored = await db.query<{ email: string; password_hash: string; role: string }>(
      "SELECT email, password_hash, role FROM users WHERE id = $1",
      [created.id]
    );
    assert.equal(stored.rows[0].role, "user", "self-registration must not grant privileges");
    assert.ok(!stored.rows[0].password_hash.includes("a strong passphrase"));

    const cash = await db.transaction((tx) => cashBalances(tx, created.id));
    assert.equal(cash.available, SIGNUP_GRANT_PYA);

    const grants = await db.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM ledger_journals WHERE kind = 'grant' AND actor_id = $1",
      [created.id]
    );
    assert.equal(grants.rows[0].c, 1);
  });

  test("duplicate emails are refused case-insensitively", async () => {
    const user = await makeUser(db);
    await assert.rejects(
      registerUser(db, {
        email: user.email.toUpperCase(),
        password: "another strong passphrase",
        displayName: "Copycat",
      }),
      (error: unknown) => error instanceof DomainError && error.code === "conflict"
    );
  });

  test("weak passwords are refused with a field-level message", async () => {
    await assert.rejects(
      registerUser(db, { email: "weak@example.com", password: "short", displayName: "Weak" }),
      (error: unknown) => error instanceof Error
    );
    const count = await db.query<{ c: number }>("SELECT count(*)::int AS c FROM users WHERE email = 'weak@example.com'");
    assert.equal(count.rows[0].c, 0, "no user is created when validation fails");
  });

  test("invalid email shapes are refused", async () => {
    for (const email of ["no-at-sign", "a@b", "a b@example.com", "@example.com"]) {
      await assert.rejects(
        registerUser(db, { email, password: "a strong passphrase", displayName: "X" }),
        (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
      );
    }
  });

  test("credentials verify correctly and wrong passwords do not", async () => {
    const user = await makeUser(db);
    const ok = await verifyCredentials(db, { email: user.email, password: user.password });
    assert.equal(ok?.id, user.id);
    const wrong = await verifyCredentials(db, { email: user.email, password: "not the password" });
    assert.equal(wrong, null);
    const missing = await verifyCredentials(db, { email: "ghost@example.com", password: user.password });
    assert.equal(missing, null);
  });
});

describe("sessions and authorisation", () => {
  let ctx: TestContext;
  let db: Database;

  before(async () => {
    ctx = await createTestDb();
    db = ctx.db;
  });
  after(async () => {
    await ctx.close();
  });

  test("a valid token resolves to its user; the raw token is never stored", async () => {
    const user = await makeUser(db);
    const token = await makeSessionToken(db, user.id);
    const session = await resolveSession(db, token);
    assert.equal(session?.user.id, user.id);

    const stored = await db.query<{ token_hash: Uint8Array | string }>("SELECT token_hash FROM sessions");
    const asText = Buffer.from(stored.rows[0].token_hash as Uint8Array).toString("utf8");
    assert.ok(!asText.includes(token), "the database must not contain the raw token");
  });

  test("garbage, revoked and expired tokens resolve to null", async () => {
    const user = await makeUser(db);
    assert.equal(await resolveSession(db, undefined), null);
    assert.equal(await resolveSession(db, ""), null);
    assert.equal(await resolveSession(db, "short"), null);
    assert.equal(await resolveSession(db, "x".repeat(64)), null);

    const token = await makeSessionToken(db, user.id);
    const session = await resolveSession(db, token);
    await revokeSession(db, session!.id);
    assert.equal(await resolveSession(db, token), null, "a revoked session is signed out");

    // The schema forbids creating an already-expired session, so create a live one
    // and age it; expiry must then resolve to signed out.
    const aged = await createSession(db, user.id);
    assert.ok(await resolveSession(db, aged.token), "a fresh session resolves");
    // Age creation and expiry together so the (expires_at > created_at) check holds.
    await db.query(
      "UPDATE sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '1 minute' WHERE user_id = $1",
      [user.id]
    );
    assert.equal(await resolveSession(db, aged.token), null, "an expired session is signed out");
  });

  test("suspended users cannot use an existing session", async () => {
    const user = await makeUser(db);
    const token = await makeSessionToken(db, user.id);
    await db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [user.id]);
    assert.equal(await resolveSession(db, token), null);
  });

  test("revoke all sessions kills every token for that user", async () => {
    const user = await makeUser(db);
    const first = await makeSessionToken(db, user.id);
    const second = await makeSessionToken(db, user.id);
    assert.ok(await resolveSession(db, first));
    await revokeAllSessions(db, user.id);
    assert.equal(await resolveSession(db, first), null);
    assert.equal(await resolveSession(db, second), null);
  });

  test("RBAC denies anonymous and under-privileged callers", async () => {
    const user = await makeUser(db);
    const token = await makeSessionToken(db, user.id);
    const session = await resolveSession(db, token);

    assert.throws(() => requireUser(null), (error: unknown) => error instanceof DomainError && error.status === 401);
    assert.throws(() => requireRole(null, "moderator"), (error: unknown) => error instanceof DomainError);
    assert.throws(
      () => requireRole(session, "admin"),
      (error: unknown) => error instanceof DomainError && error.code === "forbidden"
    );
    assert.equal(requireUser(session).user.id, user.id);
    assert.equal(requireRole(session, "user").user.id, user.id);

    await makeAdmin(db, user.id);
    await revokeAllSessions(db, user.id);
    const adminToken = await makeSessionToken(db, user.id);
    const adminSession = await resolveSession(db, adminToken);
    assert.equal(requireRole(adminSession, "admin").user.role, "admin");
  });

  test("a client cannot escalate its own role through the database-facing path", async () => {
    const user = await makeUser(db);
    const token = await makeSessionToken(db, user.id);
    const session = await resolveSession(db, token);
    // The role comes from the users table, never from the session token payload.
    assert.equal(session!.user.role, "user");
    assert.throws(() => requireRole(session, "resolver"));
  });
});
