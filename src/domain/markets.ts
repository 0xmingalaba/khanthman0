/**
 * Market reads.
 *
 * Prices are derived from the order book, never stored as a "current price", so a
 * displayed probability is always reproducible from resting orders. When a book is
 * empty the market has no price and we say so (null) instead of inventing one.
 *
 * Deliberately absent: fake volume, fake "change since yesterday" and fake
 * trending scores. Those require historical snapshots that do not exist yet, and
 * inventing them would repeat the prototype's core defect.
 */

import type { Database } from "@/src/db/executor";
import { isPubliclyVisible, type MarketStatus } from "@/src/domain/market-lifecycle";

export type MarketSummary = {
  id: string;
  slug: string;
  categoryId: string;
  categoryNameEn: string;
  categoryNameMy: string;
  questionEn: string;
  questionMy: string;
  status: MarketStatus;
  closeAt: string;
  /** Best bid / best ask for YES, in Pyas, or null when the book is empty. */
  yesBidPya: number | null;
  yesAskPya: number | null;
  /** Midpoint implied probability, 0-100, or null with no two-sided book. */
  impliedProbability: number | null;
  /** Total open interest in shares across both outcomes. */
  openInterestShares: number;
  openOrders: number;
};

export type MarketDetail = MarketSummary & {
  descriptionEn: string;
  descriptionMy: string;
  rulesEn: string;
  rulesMy: string;
  resolutionCriteriaEn: string;
  resolutionCriteriaMy: string;
  sources: { label: string; url: string }[];
  book: {
    yes: { bids: DepthLevel[]; asks: DepthLevel[] };
    no: { bids: DepthLevel[]; asks: DepthLevel[] };
  };
  recentTrades: {
    side: "YES" | "NO";
    pricePya: number;
    quantity: number;
    executedAt: string;
  }[];
};

export type DepthLevel = { pricePya: number; quantity: number };

type SummaryRow = {
  id: string;
  slug: string;
  category_id: string;
  category_name_en: string;
  category_name_my: string;
  question_en: string;
  question_my: string;
  status: MarketStatus;
  close_at: Date | string;
  yes_bid: number | string | null;
  yes_ask: number | string | null;
  open_interest: string | number | null;
  open_orders: string | number | null;
};

/**
 * The book-derived columns.
 *
 * Best bid for YES is the highest open YES buy. Best ask for YES is 100 minus the
 * highest open NO buy: buying NO at q is economically identical to selling YES at
 * 100-q, which is exactly the complementary relation the product specifies.
 */
const SUMMARY_SELECT = `
  m.id, m.slug, m.category_id, c.name_en AS category_name_en, c.name_my AS category_name_my,
  m.question_en, m.question_my, m.status, m.close_at,
  (
    SELECT max(o.price_pya) FROM orders o
     WHERE o.market_id = m.id AND o.side = 'YES' AND o.action = 'BUY'
       AND o.status = 'open' AND o.remaining_quantity > 0
  ) AS yes_bid,
  (
    100 - (
      SELECT max(o.price_pya) FROM orders o
       WHERE o.market_id = m.id AND o.side = 'NO' AND o.action = 'BUY'
         AND o.status = 'open' AND o.remaining_quantity > 0
    )
  ) AS yes_ask,
  (
    SELECT COALESCE(sum(o.remaining_quantity), 0) FROM orders o
     WHERE o.market_id = m.id AND o.status = 'open'
  ) AS open_interest,
  (
    SELECT count(*) FROM orders o
     WHERE o.market_id = m.id AND o.status = 'open'
  ) AS open_orders
`;

function toSummary(row: SummaryRow): MarketSummary {
  const yesBid = row.yes_bid === null ? null : Number(row.yes_bid);
  const rawAsk = row.yes_ask === null ? null : Number(row.yes_ask);
  // A NULL from the NO subquery propagates through the arithmetic; treat a
  // nonsensical ask (outside the tick range) as "no ask".
  const yesAsk = rawAsk !== null && rawAsk >= 1 && rawAsk <= 99 ? rawAsk : null;

  const impliedProbability =
    yesBid !== null && yesAsk !== null ? Math.round((yesBid + yesAsk) / 2) : null;

  return {
    id: row.id,
    slug: row.slug,
    categoryId: row.category_id,
    categoryNameEn: row.category_name_en,
    categoryNameMy: row.category_name_my,
    questionEn: row.question_en,
    questionMy: row.question_my,
    status: row.status,
    closeAt: new Date(row.close_at).toISOString(),
    yesBidPya: yesBid,
    yesAskPya: yesAsk,
    impliedProbability,
    openInterestShares: Number(row.open_interest ?? 0),
    openOrders: Number(row.open_orders ?? 0),
  };
}

export type ListOptions = {
  categoryId?: string;
  search?: string;
  sort?: "closing" | "newest" | "activity";
  limit?: number;
  offset?: number;
};

/** Public catalogue. Draft and in-review markets are never exposed. */
export async function listMarkets(db: Database, options: ListOptions = {}): Promise<MarketSummary[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const params: (string | number)[] = [];
  const where: string[] = [`m.status NOT IN ('draft', 'pending_review')`];

  if (options.categoryId) {
    params.push(options.categoryId);
    where.push(`m.category_id = $${params.length}`);
  }
  if (options.search) {
    params.push(`%${options.search.trim().toLowerCase()}%`);
    const index = params.length;
    where.push(
      `(lower(m.question_en) LIKE $${index} OR lower(m.question_my) LIKE $${index} OR lower(m.description_en) LIKE $${index})`
    );
  }

  const order =
    options.sort === "newest"
      ? "m.created_at DESC"
      : options.sort === "activity"
        ? "open_interest DESC"
        : "m.close_at ASC";

  params.push(limit, offset);
  const result = await db.query<SummaryRow>(
    `SELECT ${SUMMARY_SELECT}
       FROM markets m
       JOIN market_categories c ON c.id = m.category_id
      WHERE ${where.join(" AND ")}
      ORDER BY ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return result.rows.map(toSummary).filter(() => true);
}

export async function getMarketBySlug(db: Database, slug: string): Promise<MarketDetail | null> {
  const result = await db.query<
    SummaryRow & {
      description_en: string;
      description_my: string;
      rules_en: string;
      rules_my: string;
      resolution_criteria_en: string;
      resolution_criteria_my: string;
    }
  >(
    `SELECT ${SUMMARY_SELECT},
            m.description_en, m.description_my, m.rules_en, m.rules_my,
            m.resolution_criteria_en, m.resolution_criteria_my
       FROM markets m
       JOIN market_categories c ON c.id = m.category_id
      WHERE m.slug = $1`,
    [slug]
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (!isPubliclyVisible(row.status)) return null;

  const [sources, trades, yesBook, noBook] = await Promise.all([
    db.query<{ label: string; url: string }>(
      "SELECT label, url FROM market_sources WHERE market_id = $1 ORDER BY sort_order, created_at",
      [row.id]
    ),
    db.query<{ side: "YES" | "NO"; price_pya: number | string; quantity: string | number; executed_at: Date | string }>(
      `SELECT side, price_pya, quantity, executed_at FROM trades
        WHERE market_id = $1 ORDER BY executed_at DESC LIMIT 20`,
      [row.id]
    ),
    book(db, row.id, "YES"),
    book(db, row.id, "NO"),
  ]);

  return {
    ...toSummary(row),
    descriptionEn: row.description_en,
    descriptionMy: row.description_my,
    rulesEn: row.rules_en,
    rulesMy: row.rules_my,
    resolutionCriteriaEn: row.resolution_criteria_en,
    resolutionCriteriaMy: row.resolution_criteria_my,
    sources: sources.rows,
    book: { yes: yesBook, no: noBook },
    recentTrades: trades.rows.map((trade) => ({
      side: trade.side,
      pricePya: Number(trade.price_pya),
      quantity: Number(trade.quantity),
      executedAt: new Date(trade.executed_at).toISOString(),
    })),
  };
}

async function book(
  db: Database,
  marketId: string,
  side: "YES" | "NO"
): Promise<{ bids: DepthLevel[]; asks: DepthLevel[] }> {
  const result = await db.query<{ action: string; price_pya: number | string; quantity: string | number }>(
    `SELECT action, price_pya, sum(remaining_quantity) AS quantity
       FROM orders
      WHERE market_id = $1 AND side = $2 AND status = 'open' AND remaining_quantity > 0
      GROUP BY action, price_pya`,
    [marketId, side]
  );

  const bids: DepthLevel[] = [];
  const asks: DepthLevel[] = [];
  for (const row of result.rows) {
    const level = { pricePya: Number(row.price_pya), quantity: Number(row.quantity) };
    if (row.action === "BUY") bids.push(level);
    else asks.push(level);
  }
  bids.sort((a, b) => b.pricePya - a.pricePya);
  asks.sort((a, b) => a.pricePya - b.pricePya);
  return { bids, asks };
}
