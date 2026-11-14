/**
 * Browser API client.
 *
 * All calls are same-origin relative URLs so the app works behind any preview
 * host. Errors are normalised into a typed shape that the UI can render in the
 * user's language without ever showing a raw server message.
 */

export type ApiError = {
  code: string;
  message: string;
  details?: Record<string, string>;
  status: number;
};

export class ApiRequestError extends Error {
  readonly api: ApiError;
  constructor(api: ApiError) {
    super(api.message);
    this.name = "ApiRequestError";
    this.api = api;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const body = payload as { error?: { code?: string; message?: string; details?: Record<string, string> } } | null;
    throw new ApiRequestError({
      status: response.status,
      code: body?.error?.code ?? "internal_error",
      message: body?.error?.message ?? "Request failed.",
      details: body?.error?.details,
    });
  }

  return payload as T;
}

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  locale: "my" | "en";
};

export type Wallet = { availablePya: number; reservedPya: number; totalPya: number };

export type MarketSummary = {
  id: string;
  slug: string;
  categoryId: string;
  categoryNameEn: string;
  categoryNameMy: string;
  questionEn: string;
  questionMy: string;
  status: string;
  closeAt: string;
  yesBidPya: number | null;
  yesAskPya: number | null;
  impliedProbability: number | null;
  openInterestShares: number;
  openOrders: number;
};

export type DepthLevel = { pricePya: number; quantity: number };

export type MarketDetail = MarketSummary & {
  descriptionEn: string;
  descriptionMy: string;
  rulesEn: string;
  rulesMy: string;
  resolutionCriteriaEn: string;
  resolutionCriteriaMy: string;
  sources: { label: string; url: string }[];
  book: { yes: { bids: DepthLevel[]; asks: DepthLevel[] }; no: { bids: DepthLevel[]; asks: DepthLevel[] } };
  recentTrades: { side: "YES" | "NO"; pricePya: number; quantity: number; executedAt: string }[];
};

export type OrderView = {
  id: string;
  marketId: string;
  side: "YES" | "NO";
  action: "BUY" | "SELL";
  pricePya: number;
  quantity: number;
  remainingQuantity: number;
  reservedUnits: number;
  status: string;
  createdAt: string;
};

export type Portfolio = {
  cash: { availablePya: number; reservedPya: number; totalPya: number };
  positions: {
    marketId: string;
    slug: string;
    questionEn: string;
    questionMy: string;
    side: "YES" | "NO";
    sharesHeld: number;
    costBasisPya: number;
    realisedPnlPya: number;
    marketStatus: string;
    closeAt: string;
  }[];
  virtualCreditsOnly: true;
};

export const api = {
  session: () =>
    request<{ user: SessionUser | null; wallet: Wallet | null; openOrders: number }>("/api/auth/session"),

  register: (body: { email: string; password: string; displayName: string; locale: "my" | "en" }) =>
    request<{ user: SessionUser; wallet: { availablePya: number; reservedPya: number } }>(
      "/api/auth/register",
      { method: "POST", body: JSON.stringify(body) }
    ),

  login: (body: { email: string; password: string }) =>
    request<{ ok: true }>("/api/auth/login", { method: "POST", body: JSON.stringify(body) }),

  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),

  markets: (params: { category?: string; q?: string; sort?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.category) query.set("category", params.category);
    if (params.q) query.set("q", params.q);
    if (params.sort) query.set("sort", params.sort);
    const suffix = query.toString() ? `?${query}` : "";
    return request<{ markets: MarketSummary[] }>(`/api/markets${suffix}`);
  },

  market: (slug: string) => request<{ market: MarketDetail }>(`/api/markets/${encodeURIComponent(slug)}`),

  orders: () => request<{ orders: OrderView[]; cash: { available: number; reserved: number; total: number } }>("/api/orders"),

  placeOrder: (body: {
    marketId: string;
    side: "YES" | "NO";
    action: "BUY" | "SELL";
    pricePya: number;
    quantity: number;
    idempotencyKey: string;
  }) =>
    request<{ order: OrderView; cash: { available: number; reserved: number; total: number } }>("/api/orders", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  cancelOrder: (body: { orderId: string; idempotencyKey: string }) =>
    request<{ order: OrderView; cash: { available: number; reserved: number; total: number } }>(
      "/api/orders/cancel",
      { method: "POST", body: JSON.stringify(body) }
    ),

  portfolio: () => request<Portfolio>("/api/portfolio"),
};

/** Cryptographically random idempotency key for a single user action. */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `ord-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
