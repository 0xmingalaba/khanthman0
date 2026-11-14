import { json, route } from "@/src/api/http";
import { listMarkets, type ListOptions } from "@/src/domain/markets";
import { LIMITS } from "@/src/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SORTS = new Set(["closing", "newest", "activity"]);

/** GET /api/markets?category=&q=&sort=&limit=&offset= */
const GET_handler = route(
  async ({ db, request }) => {
    const params = request.nextUrl.searchParams;
    const sortParam = params.get("sort") ?? "closing";
    const options: ListOptions = {
      categoryId: params.get("category")?.slice(0, 32) || undefined,
      search: params.get("q")?.slice(0, 120) || undefined,
      sort: (SORTS.has(sortParam) ? sortParam : "closing") as ListOptions["sort"],
      limit: Number(params.get("limit") ?? 50) || 50,
      offset: Number(params.get("offset") ?? 0) || 0,
    };

    const markets = await listMarkets(db, options);
    return json({ markets, virtualCreditsOnly: true });
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
