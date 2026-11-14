import { json, readJson, route } from "@/src/api/http";
import { cancelOrderSchema } from "@/src/lib/schemas";
import { cancelOrder, getCash } from "@/src/domain/trading";
import { LIMITS } from "@/src/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/orders/cancel — cancel one of the caller's own open orders.
 *
 * Ownership is enforced in the domain layer against the order row, so a forged
 * order id belonging to another user is refused with 403.
 */
const POST_handler = route(
  async ({ db, request, session }) => {
    const body = await readJson(request, cancelOrderSchema);
    const order = await cancelOrder(db, {
      userId: session!.user.id,
      orderId: body.orderId,
      idempotencyKey: body.idempotencyKey,
    });

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, target_type, target_id) VALUES ($1, 'order.cancel', 'order', $2::text)",
      [session!.user.id, order.id]
    );

    const cash = await getCash(db, session!.user.id);
    return json({ order, cash, virtualCreditsOnly: true });
  },
  { mutation: true, role: "user", rateLimit: LIMITS.order }
);

/**
 * Next.js requires route handlers to accept a RouteContext second argument. The
 * static routes ignore it; this adapter keeps the exported signature correct
 * without polluting the `route()` helper used by dynamic segments.
 */
type RouteContext = { params: Promise<Record<string, string>> };

export async function POST(request: Request, context: RouteContext) {
  return POST_handler(request as never, context);
}
