import { json, readJson, route } from "@/src/api/http";
import { placeOrderSchema } from "@/src/lib/schemas";
import { getCash, listOpenOrders, placeOrder } from "@/src/domain/trading";
import { LIMITS } from "@/src/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/orders — the caller's own open orders and cash position. */
const GET_handler = route(
  async ({ db, session }) => {
    const user = session!;
    const [orders, cash] = await Promise.all([
      listOpenOrders(db, user.user.id),
      getCash(db, user.user.id),
    ]);
    return json({ orders, cash, virtualCreditsOnly: true });
  },
  { mutation: false, role: "user", rateLimit: LIMITS.read }
);

/**
 * POST /api/orders — place a fully collateralised limit order.
 *
 * The user id comes from the session, never from the body. All financial
 * arithmetic happens server-side; the client sends only side, action, price,
 * quantity and an idempotency key.
 */
const POST_handler = route(
  async ({ db, request, session }) => {
    const body = await readJson(request, placeOrderSchema);

    const order = await placeOrder(db, {
      userId: session!.user.id,
      marketId: body.marketId,
      side: body.side,
      action: body.action,
      pricePya: body.pricePya,
      quantity: body.quantity,
      idempotencyKey: body.idempotencyKey,
    });

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, target_type, target_id, metadata) VALUES ($1, 'order.place', 'order', $2::text, $3::jsonb)",
      [
        session!.user.id,
        order.id,
        JSON.stringify({
          marketId: order.marketId,
          side: order.side,
          action: order.action,
          pricePya: order.pricePya,
          quantity: order.quantity,
        }),
      ]
    );

    const cash = await getCash(db, session!.user.id);
    return json({ order, cash, virtualCreditsOnly: true }, 201);
  },
  { mutation: true, role: "user", rateLimit: LIMITS.order }
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

export async function POST(request: Request, context: RouteContext) {
  return POST_handler(request as never, context);
}
