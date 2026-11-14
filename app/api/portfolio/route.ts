import { json, route } from "@/src/api/http";
import { cashBalances, shareBalances } from "@/src/domain/ledger";
import { LIMITS } from "@/src/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PositionRow = {
  market_id: string;
  slug: string;
  question_en: string;
  question_my: string;
  side: "YES" | "NO";
  cost_basis_pya: string | number;
  realised_pnl_pya: string | number;
  status: string;
  close_at: Date | string;
};

/**
 * GET /api/portfolio — the caller's own cash, positions and realised P&L.
 *
 * Share counts come from the ledger, not from a cached column, so the numbers
 * here always agree with the trades that produced them. Unrealised P&L is
 * intentionally omitted until a defensible mark-price rule is approved; showing
 * a midpoint-based unrealised figure would be a product decision, not an
 * engineering shortcut.
 */
const GET_handler = route(
  async ({ db, session }) => {
    const userId = session!.user.id;

    const [cash, positions] = await Promise.all([
      db.transaction((tx) => cashBalances(tx, userId)),
      db.query<PositionRow>(
        `SELECT p.market_id, m.slug, m.question_en, m.question_my, p.side,
                p.cost_basis_pya, p.realised_pnl_pya, m.status, m.close_at
           FROM positions p
           JOIN markets m ON m.id = p.market_id
          WHERE p.user_id = $1
          ORDER BY p.updated_at DESC`,
        [userId]
      ),
    ]);

    const enriched = await db.transaction(async (tx) => {
      const rows = [];
      for (const position of positions.rows) {
        const held = await shareBalances(tx, userId, position.market_id, position.side);
        if (held.total === 0 && Number(position.realised_pnl_pya) === 0) continue;
        rows.push({
          marketId: position.market_id,
          slug: position.slug,
          questionEn: position.question_en,
          questionMy: position.question_my,
          side: position.side,
          sharesHeld: held.total,
          sharesEscrowedElsewhere: held.reserved,
          costBasisPya: Number(position.cost_basis_pya),
          realisedPnlPya: Number(position.realised_pnl_pya),
          marketStatus: position.status,
          closeAt: new Date(position.close_at).toISOString(),
        });
      }
      return rows;
    });

    return json(
      {
        cash: { availablePya: cash.available, reservedPya: cash.reserved, totalPya: cash.total },
        positions: enriched,
        virtualCreditsOnly: true,
      },
      200
    );
  },
  { mutation: false, role: "user", rateLimit: LIMITS.read }
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
