import { json, route } from "@/src/api/http";
import { getMarketBySlug } from "@/src/domain/markets";
import { notFound } from "@/src/lib/errors";
import { LIMITS } from "@/src/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/markets/[slug] — full market view including both order books. */
export const GET = route<{ slug: string }>(
  async ({ db, params }) => {
    const slug = params.slug;
    if (!/^[a-z0-9][a-z0-9-]{2,120}$/.test(slug)) throw notFound("Market");
    const market = await getMarketBySlug(db, slug);
    if (!market) throw notFound("Market");
    return json({ market, virtualCreditsOnly: true });
  },
  { mutation: false, rateLimit: LIMITS.read }
);
