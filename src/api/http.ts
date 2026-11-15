/**
 * HTTP boundary helpers.
 *
 * Responsibilities, in order:
 *   1. Rate limit (cheap, before parsing).
 *   2. Enforce same-origin for cookie-authenticated mutations (CSRF).
 *   3. Parse and validate the body with Zod (never trust the client).
 *   4. Resolve the session from the HttpOnly cookie.
 *   5. Run the handler and map typed domain errors to safe responses.
 *
 * Anything thrown as a DomainError is mapped to its documented status; anything
 * else becomes a generic 500 with no internal detail.
 */

import "server-only";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { DomainError, toApiError, validationError } from "@/src/lib/errors";
import {
  SESSION_COOKIE,
  resolveSession,
  type Session,
  type Role,
  requireRole,
  requireUser,
} from "@/src/auth/session";
import { getDatabase } from "@/src/db";
import type { Database } from "@/src/db/executor";
import { checkRateLimit, type RateLimitRule } from "@/src/lib/rate-limit";
import { clientIpConfigFromEnv, resolveClientSubject } from "@/src/api/client-ip";
import { getPeerAddress } from "@/src/api/peer-address";

/** Route params for dynamic segments, e.g. `{ slug: string }`. */
export type RouteParams = Record<string, string>;

export type HandlerContext<P extends RouteParams = RouteParams> = {
  db: Database;
  request: NextRequest;
  session: Session | null;
  /** Client IP, used only for rate limiting and audit hashing. */
  ip: string;
  /** Already-awaited dynamic segment values. */
  params: P;
};

/**
 * Rate-limit and audit subject for this request.
 *
 * Delegates to `resolveClientSubject`, which reads deployment configuration and
 * refuses to trust a client-supplied forwarding header unless the captured TCP
 * peer is an explicitly trusted proxy. See src/api/client-ip.ts for the trust
 * model and src/api/peer-address.ts for how the socket address is captured.
 */
export function clientIp(request: NextRequest): string {
  return resolveClientSubject(
    (name) => request.headers.get(name),
    clientIpConfigFromEnv(),
    getPeerAddress()
  );
}

/**
 * CSRF defence for cookie-authenticated mutations.
 *
 * SameSite=Lax already blocks cross-site POSTs in modern browsers; this adds a
 * same-origin check on Origin/Referer so a request that reaches us without those
 * headers, or from another origin, is refused outright.
 */
export function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!host) throw new DomainError("forbidden", { message: "Missing host header." });

  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new DomainError("forbidden", { message: "Malformed origin." });
    }
    if (originHost !== host) {
      throw new DomainError("forbidden", { message: "Cross-origin request refused." });
    }
    return;
  }

  // Non-browser clients (curl, tests) may omit Origin; require the referer then.
  const referer = request.headers.get("referer");
  if (!referer) return;
  try {
    if (new URL(referer).host !== host) {
      throw new DomainError("forbidden", { message: "Cross-origin request refused." });
    }
  } catch {
    throw new DomainError("forbidden", { message: "Malformed referer." });
  }
}

/** Parse and validate a JSON body. Invalid input never reaches the domain layer. */
export async function readJson<T>(request: NextRequest, schema: ZodType<T>): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new DomainError("validation_failed", {
      details: { body: "Content-Type must be application/json." },
    });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new DomainError("validation_failed", { details: { body: "Body is not valid JSON." } });
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw validationError(fieldErrors(parsed.error));
  }
  return parsed.data;
}

export function fieldErrors(error: ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "body";
    // Zod's own messages are safe, structural descriptions; never echo values.
    if (!details[key]) details[key] = issue.message;
  }
  return details;
}

export async function currentSession(db: Database): Promise<Session | null> {
  const store = await cookies();
  return resolveSession(db, store.get(SESSION_COOKIE)?.value);
}

type Options = {
  /** Require a signed-in, active user at this role or higher. */
  role?: Role;
  /** Same-origin (CSRF) check. Defaults to true: mutations are the common case. */
  mutation?: boolean;
  /** Require an authenticated session even without a role requirement. */
  auth?: boolean;
  rateLimit?: RateLimitRule;
};

/**
 * Wrap a route handler with the standard guard sequence and error mapping.
 */
export function route<P extends RouteParams = RouteParams>(
  handler: (ctx: HandlerContext<P>) => Promise<NextResponse | Response>,
  options: Options = {}
) {
  // The second parameter is typed to match Next.js 15's generated route contract:
  // a required context whose `params` is always a promise.
  return async (
    request: NextRequest,
    context: { params: Promise<P> }
  ): Promise<NextResponse | Response> => {
    try {
      const ip = clientIp(request);

      if (options.mutation !== false) assertSameOrigin(request);

      if (options.rateLimit) {
        await checkRateLimit(options.rateLimit, `${options.rateLimit.key}:${ip}`);
      }

      const db = await getDatabase();
      const session = await currentSession(db);
      // Authorisation is explicit, never implied by the HTTP method: only routes
      // that ask for a role or auth are protected.
      if (options.role) requireRole(session, options.role);
      else if (options.auth) requireUser(session);

      const params = (await context?.params) as P;
      return await handler({ db, request, session, ip, params });
    } catch (error) {
      const { status, body } = toApiError(error);
      return NextResponse.json(body, {
        status,
        headers: { "cache-control": "no-store" },
      });
    }
  };
}

/** Small helper for successful JSON responses that must never be cached. */
export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}
