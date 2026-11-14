import { json, route } from "@/src/api/http";
import { clearSessionCookie } from "@/src/api/session-cookie";
import { revokeSession } from "@/src/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/logout — revokes the server-side session and clears the cookie. */
const POST_handler = route(async ({ db, session }) => {
  if (session) {
    await revokeSession(db, session.id);
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, target_type, target_id) VALUES ($1, 'auth.logout', 'user', $1::text)",
      [session.user.id]
    );
  }
  return clearSessionCookie(json({ ok: true }));
});

/**
 * Next.js requires route handlers to accept a RouteContext second argument. The
 * static routes ignore it; this adapter keeps the exported signature correct
 * without polluting the `route()` helper used by dynamic segments.
 */
type RouteContext = { params: Promise<Record<string, string>> };

export async function POST(request: Request, context: RouteContext) {
  return POST_handler(request as never, context);
}
