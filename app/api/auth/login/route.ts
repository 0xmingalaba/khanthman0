import { json, readJson, route } from "@/src/api/http";
import { attachSessionCookie } from "@/src/api/session-cookie";
import { loginSchema } from "@/src/lib/schemas";
import { verifyCredentials } from "@/src/domain/accounts";
import { createSession } from "@/src/auth/session";
import { DomainError } from "@/src/lib/errors";
import { LIMITS, againstAccount, checkRateLimit } from "@/src/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/login
 *
 * Wrong password, unknown email and suspended account all return the same 401 so
 * the endpoint cannot be used to enumerate registered addresses.
 */
const POST_handler = route(
  async ({ db, request }) => {
    const body = await readJson(request, loginSchema);
    // Second dimension: a per-account ceiling that survives IP rotation. The
    // per-client limit in `route()` cannot be relied on alone, because an attacker
    // who can vary their apparent address gets a fresh bucket each time.
    await checkRateLimit(LIMITS.loginAccount, againstAccount(LIMITS.loginAccount, body.email));
    const result = await verifyCredentials(db, body);
    if (!result) {
      throw new DomainError("unauthenticated", { message: "Email or password is incorrect." });
    }
    if (result.status !== "active") {
      throw new DomainError("forbidden", { message: "This account is not active." });
    }

    const { token } = await createSession(db, result.id, request.headers.get("user-agent"));
    await db.query("INSERT INTO audit_logs (actor_id, action, target_type, target_id) VALUES ($1, 'auth.login', 'user', $1::text)", [
      result.id,
    ]);

    return attachSessionCookie(json({ ok: true }), token);
  },
  { mutation: true, rateLimit: LIMITS.login }
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
