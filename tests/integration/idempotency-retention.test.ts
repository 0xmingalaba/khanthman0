import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Database } from "@/src/db/executor";
import {
  RETENTION_HOURS,
  STALE_CLAIM_HOURS,
  cleanupIdempotencyKeys,
  retentionPolicy,
} from "@/src/db/idempotency-retention";
import { createTestDb, makeUser, type TestContext } from "../helpers/db";

/**
 * Idempotency retention semantics.
 *
 * The dangerous direction is deleting too much: a key that disappears while a client
 * may still retry turns one intent into two orders. So the rule under test is that
 * completed keys live for a documented window, and claimed-but-unfinished rows are
 * never collected while they are still plausibly in flight.
 */

let ctx: TestContext;
let db: Database;

before(async () => {
  ctx = await createTestDb();
  db = ctx.db;
});

after(async () => {
  await ctx.close();
});

/** Insert a key row with an explicit age and completion state. */
async function insertKey(input: {
  userId: string;
  key: string;
  hoursAgo: number;
  completed: boolean;
}): Promise<void> {
  await db.query(
    `INSERT INTO idempotency_keys (user_id, key, endpoint, request_hash, response_json, created_at)
     VALUES ($1, $2, 'test:endpoint', 'fingerprint', $3, now() - ($4 || ' hours')::interval)`,
    [input.userId, input.key, input.completed ? JSON.stringify({ ok: true }) : null, input.hoursAgo]
  );
}

async function keyExists(userId: string, key: string): Promise<boolean> {
  const result = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM idempotency_keys WHERE user_id = $1 AND key = $2",
    [userId, key]
  );
  return result.rows[0].n > 0;
}

describe("idempotency key retention", () => {
  test("the policy is documented, not implicit", () => {
    const policy = retentionPolicy();
    assert.equal(policy.completedKeyHours, RETENTION_HOURS);
    assert.equal(policy.staleClaimHours, STALE_CLAIM_HOURS);
    assert.equal(policy.inFlightRowsAreCollected, false);
    assert.ok(RETENTION_HOURS >= 1, "a window shorter than an hour would break retries");
  });

  test("a recent completed key is kept", async () => {
    const user = await makeUser(db);
    await insertKey({ userId: user.id, key: "recent-completed-key", hoursAgo: 1, completed: true });
    await cleanupIdempotencyKeys(db);
    assert.equal(await keyExists(user.id, "recent-completed-key"), true);
  });

  test("a completed key past the window is removed", async () => {
    const user = await makeUser(db);
    await insertKey({
      userId: user.id,
      key: "ancient-completed-key",
      hoursAgo: RETENTION_HOURS + 2,
      completed: true,
    });
    await cleanupIdempotencyKeys(db);
    assert.equal(await keyExists(user.id, "ancient-completed-key"), false);
  });

  test("a recently claimed but unfinished key is never collected", async () => {
    const user = await makeUser(db);
    await insertKey({ userId: user.id, key: "in-flight-key-001", hoursAgo: 0.1, completed: false });
    await cleanupIdempotencyKeys(db);
    assert.equal(
      await keyExists(user.id, "in-flight-key-001"),
      true,
      "deleting an in-flight claim would let a concurrent duplicate execute twice"
    );
  });

  test("an abandoned claim is collected once well past any request timeout", async () => {
    const user = await makeUser(db);
    await insertKey({
      userId: user.id,
      key: "abandoned-claim-key",
      hoursAgo: STALE_CLAIM_HOURS + 2,
      completed: false,
    });
    await cleanupIdempotencyKeys(db);
    assert.equal(await keyExists(user.id, "abandoned-claim-key"), false);
  });

  test("cleanup reports what it removed and respects its batch size", async () => {
    const user = await makeUser(db);
    for (let i = 0; i < 6; i += 1) {
      await insertKey({
        userId: user.id,
        key: `batch-expired-key-${i}`,
        hoursAgo: RETENTION_HOURS + 5,
        completed: true,
      });
    }
    const first = await cleanupIdempotencyKeys(db, { batchSize: 2 });
    assert.equal(first.expired, 2, "bounded batches, so cleanup cannot hold a long lock");

    const second = await cleanupIdempotencyKeys(db, { batchSize: 100 });
    assert.ok(second.expired >= 4, "a larger batch clears the remainder");
  });

  test("cleanup is idempotent: a second run finds nothing to do", async () => {
    const result = await cleanupIdempotencyKeys(db, { batchSize: 100 });
    assert.equal(result.expired, 0);
    assert.equal(result.staleClaims, 0);
  });
});
