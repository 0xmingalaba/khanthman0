import { json, route } from "@/src/api/http";
import { cashBalances } from "@/src/domain/ledger";
import { listOpenOrders } from "@/src/domain/trading";
import { LIMITS } from "@/src/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/session — the caller's own identity and wallet.
 *
 * Returns 200 with `user: null` when signed out (rather than 401) so the client
 * can render the signed-out shell without treating it as an error.
 */
const GET_handler = route(
  async ({ db, session }) => {
    if (!session) return json({ user: null, wallet: null }, 200);

    const cash = await db.transaction((tx) => cashBalances(tx, session.user.id));
    const orders = await listOpenOrders(db, session.user.id);

    return json(
      {
        user: {
          id: session.user.id,
          email: session.user.email,
          displayName: session.user.displayName,
          role: session.user.role,
          locale: session.user.locale,
        },
        wallet: { availablePya: cash.available, reservedPya: cash.reserved, totalPya: cash.total },
        openOrders: orders.length,
        virtualCreditsOnly: true,
      },
      200
    );
  },
  { mutation: false, rateLimit: LIMITS.read }
);

/**
 * Next.js requires route handlers to accept a RouteContext second argument. The
 * static routes ignore it; this adapter keeps the exported signature correct
 * without polluting the `route()` helper used by dynamic segments.
 */
type RouteContext = { params: Promise<Record<string, string>> };

export async function GET(request: Request, context: RouteContext) {
  return GET_handler(request as never, context);
}
