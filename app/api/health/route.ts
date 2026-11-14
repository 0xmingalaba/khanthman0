import { json, route } from "@/src/api/http";
import { reconcile } from "@/src/domain/ledger";
import { retentionPolicy } from "@/src/db/idempotency-retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Operational health, safe to expose unauthenticated.
 *
 * WHAT IT DELIBERATELY DOES NOT RETURN
 *
 * No connection string, no host, no user count, no balances, no account ids, no
 * per-asset totals. A health endpoint is often reachable by uptime monitors and
 * crawlers, so the rule is: report *whether* the ledger reconciles, never *what* it
 * contains. `assetCount` is a count of distinct assets, not money.
 *
 * WHY RECONCILIATION BELONGS HERE
 *
 * The double-entry invariant is that every asset's balances sum to exactly zero
 * across all accounts. That is the cheapest possible proof that no journal half
 * applied. Checking it here turns "the ledger is correct" from a test-time claim
 * into a runtime canary.
 *
 * Response shape:
 *   200 { status: "ok",        database: "up",   ledger: { balanced: true, ... } }
 *   200 { status: "degraded",  database: "up",   ledger: { balanced: false } }   ← 200
 *   503 { status: "unavailable", database: "down" }
 *
 * A degraded ledger returns 200, not 503: the process is healthy and can serve
 * traffic, and paging should be driven by the explicit `status` field rather than
 * by a load balancer pulling the instance out of rotation (which would turn a
 * bookkeeping alarm into an outage). Unreachable database returns 503 so the
 * platform restarts or removes the instance.
 */
const GET_handler = route(
  async ({ db }) => {
    let database: "up" | "down" = "down";
    let ledger: { balanced: boolean; assetCount: number } | null = null;

    try {
      await db.query("SELECT 1");
      database = "up";
      // reconcile() takes a Transaction; a read-only one is enough and keeps the
      // consistency snapshot to a single transaction.
      const rows = await db.transaction((tx) => reconcile(tx));
      // Only aggregate facts, never the totals themselves.
      ledger = {
        balanced: rows.every((row) => row.total === 0),
        assetCount: rows.length,
      };
    } catch {
      // Swallow the driver error: its message can contain host and credentials
      // fragments. The caller only needs to know the check did not pass.
      return json(
        {
          status: "unavailable",
          database: "down",
          ledger: null,
          idempotencyRetention: retentionPolicy(),
        },
        503
      );
    }

    const balanced = ledger?.balanced ?? false;
    return json({
      status: balanced ? "ok" : "degraded",
      database,
      ledger,
      idempotencyRetention: retentionPolicy(),
    });
  },
  // Unauthenticated on purpose (monitors cannot hold a session) but rate limited so
  // it cannot be used to hammer the database.
  { mutation: false, rateLimit: { key: "api:health", windowMs: 60 * 1000, max: 60 } }
);

/**
 * Next.js requires route handlers to accept a RouteContext second argument. This
 * static route ignores it; the adapter keeps the exported signature correct without
 * polluting the `route()` helper used by dynamic segments.
 */
type RouteContext = { params: Promise<Record<string, string>> };

export async function GET(request: Request, context: RouteContext) {
  return GET_handler(request as never, context);
}
