import { json, readJson, route } from "@/src/api/http";
import { attachSessionCookie } from "@/src/api/session-cookie";
import { registerSchema } from "@/src/lib/schemas";
import { registerUser } from "@/src/domain/accounts";
import { createSession } from "@/src/auth/session";
import { cashBalances } from "@/src/domain/ledger";
import { LIMITS, againstAccount, checkRateLimit } from "@/src/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/register
 *
 * Creates the account, its preferences and the one-time virtual credit grant in a
 * single transaction, then starts a session. The client is never trusted to send
 * a role, a balance or a user id.
 */
const POST_handler = route(
  async ({ db, request, ip }) => {
    const body = await readJson(request, registerSchema);
    // Per-address ceiling: stops one mailbox being registered in bulk from many
    // apparent source addresses.
    await checkRateLimit(
      LIMITS.registerAccount,
      againstAccount(LIMITS.registerAccount, body.email)
    );
    const user = await registerUser(db, body);
    const { token } = await createSession(db, user.id, request.headers.get("user-agent"));

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, target_type, target_id, ip_hash) VALUES ($1, 'auth.register', 'user', $2::text, $3)",
      [user.id, user.id, hashIp(ip)]
    );

    const balances = await db.transaction((tx) => cashBalances(tx, user.id));
    const response = json(
      {
        user: { id: user.id, email: user.email, displayName: user.displayName, locale: user.locale },
        wallet: { availablePya: balances.available, reservedPya: balances.reserved },
        virtualCreditsOnly: true,
      },
      201
    );
    return attachSessionCookie(response, token);
  },
  { mutation: true, rateLimit: LIMITS.register }
);

function hashIp(ip: string): string {
  // Store a hash, never the address itself: enough for abuse correlation.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

export type RegisterResponse = {
  user: { id: string; email: string; displayName: string; locale: "my" | "en" };
  wallet: { availablePya: number; reservedPya: number };
  virtualCreditsOnly: true;
};

/**
 * Next.js requires route handlers to accept a RouteContext second argument. The
 * static routes ignore it; this adapter keeps the exported signature correct
 * without polluting the `route()` helper used by dynamic segments.
 */
type RouteContext = { params: Promise<Record<string, string>> };

export async function POST(request: Request, context: RouteContext) {
  return POST_handler(request as never, context);
}
