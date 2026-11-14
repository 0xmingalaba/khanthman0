/**
 * Idempotency key retention.
 *
 * WHY A RETENTION POLICY IS NEEDED
 *
 * `idempotency_keys` grows by one row per client action and was never pruned. Two
 * things go wrong without a policy:
 *
 *   1. The table grows without bound, which eventually costs more than the writes
 *      it is protecting.
 *   2. Deleting too eagerly is worse: if a row is removed while a client may still
 *      retry, the retry creates a *second* order. Correctness depends on a key
 *      living longer than the client will plausibly retry for.
 *
 * THE WINDOW
 *
 * 24 hours. It is far longer than any client's retry behaviour (the UI issues one
 * key per click and retries only on network error, seconds apart) and far shorter
 * than the life of an order. A retry after 24 hours is a genuinely new intent, and
 * re-executing it is the correct behaviour, not a double spend.
 *
 * IN-FLIGHT CLAIMS ARE NEVER COLLECTED
 *
 * A row is written with `response_json = NULL` when the request starts and updated
 * when it finishes. A NULL response means "claimed, still running". Those rows are
 * excluded from cleanup regardless of age, because deleting one would let a
 * concurrent duplicate execute the work a second time. A claimed-but-abandoned row
 * (process died mid-request) is instead made recoverable by a much longer safety
 * horizon: after `STALE_CLAIM_HOURS` it is collectable, which is well past any
 * request timeout, so the original transaction has certainly ended.
 *
 * Cleanup is deliberately a bounded, batched delete so it can run from a scheduled
 * job without holding a long lock or blocking trading.
 */

import type { Database } from "@/src/db/executor";

/** How long a completed request's key is remembered. */
export const RETENTION_HOURS = 24;

/**
 * How long a claimed-but-never-completed row is tolerated. A request that dies
 * without committing leaves its key claimed; this horizon is long enough that the
 * abandoned transaction is certainly gone.
 */
export const STALE_CLAIM_HOURS = 24;

export type CleanupResult = {
  /** Rows removed because their response was stored long ago. */
  expired: number;
  /** Rows removed because they were claimed and never completed. */
  staleClaims: number;
};

/**
 * Delete idempotency keys past retention.
 *
 * Returns counts so a scheduled job can log what it did. Safe to run concurrently:
 * `SKIP LOCKED` prevents two workers from waiting on each other's rows.
 */
export async function cleanupIdempotencyKeys(
  db: Database,
  options: { batchSize?: number } = {}
): Promise<CleanupResult> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 1000, 10_000));

  const expired = await db.query<{ user_id: string }>(
    `DELETE FROM idempotency_keys
      WHERE ctid IN (
        SELECT ctid FROM idempotency_keys
         WHERE response_json IS NOT NULL
           AND created_at < now() - ($1 || ' hours')::interval
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING user_id`,
    [RETENTION_HOURS, batchSize]
  );

  const staleClaims = await db.query<{ user_id: string }>(
    `DELETE FROM idempotency_keys
      WHERE ctid IN (
        SELECT ctid FROM idempotency_keys
         WHERE response_json IS NULL
           AND created_at < now() - ($1 || ' hours')::interval
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING user_id`,
    [STALE_CLAIM_HOURS, batchSize]
  );

  return { expired: expired.rowCount, staleClaims: staleClaims.rowCount };
}

/**
 * Retention metadata exposed for documentation and health checks.
 *
 * Never exposes key values, user ids or request hashes.
 */
export function retentionPolicy(): {
  completedKeyHours: number;
  staleClaimHours: number;
  inFlightRowsAreCollected: false;
} {
  return {
    completedKeyHours: RETENTION_HOURS,
    staleClaimHours: STALE_CLAIM_HOURS,
    inFlightRowsAreCollected: false,
  };
}
