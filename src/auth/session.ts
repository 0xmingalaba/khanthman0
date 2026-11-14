/**
 * Server-side sessions.
 *
 * The client only ever sees an opaque 256-bit random token in an HttpOnly cookie.
 * The database stores a SHA-256 hash of that token, so a database leak does not
 * yield usable sessions, and a token cannot be recovered from the row.
 *
 * Session tokens are rotated on login and on privilege change; revocation is a
 * row update, which makes logout and "sign out everywhere" reliable.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Database } from "@/src/db/executor";
import { DomainError } from "@/src/lib/errors";

export const SESSION_COOKIE = "mingala_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const TOKEN_BYTES = 32;

export type Role = "user" | "creator" | "resolver" | "moderator" | "admin";

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: "active" | "suspended" | "closed";
  locale: "my" | "en";
};

export type Session = {
  id: string;
  user: SessionUser;
  expiresAt: Date;
};

export function createSessionToken(): { token: string; tokenHash: Buffer } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Cookie attributes: HttpOnly, SameSite=Lax, Secure outside development. */
export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export async function createSession(
  db: Database,
  userId: string,
  userAgent?: string | null
): Promise<{ token: string; expiresAt: Date }> {
  const { token, tokenHash } = createSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [userId, tokenHash, expiresAt, userAgent?.slice(0, 300) ?? null]
  );
  return { token, expiresAt };
}

const USER_COLUMNS = `
  u.id, u.email, u.display_name, u.role, u.status,
  COALESCE(p.locale, 'my') AS locale
`;

/**
 * Resolve a token to a live session. Expired, revoked and suspended-user
 * sessions all resolve to null: callers must treat null as "signed out".
 */
export async function resolveSession(db: Database, token: string | undefined): Promise<Session | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const tokenHash = hashToken(token);

  const result = await db.query<{
    session_id: string;
    expires_at: Date | string;
    id: string;
    email: string;
    display_name: string;
    role: Role;
    status: SessionUser["status"];
    locale: "my" | "en";
  }>(
    `SELECT s.id AS session_id, s.expires_at, ${USER_COLUMNS}
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN user_preferences p ON p.user_id = u.id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.status = 'active'`,
    [tokenHash]
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.session_id,
    expiresAt: new Date(row.expires_at),
    user: {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      locale: row.locale,
    },
  };
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [
    sessionId,
  ]);
}

export async function revokeAllSessions(db: Database, userId: string): Promise<void> {
  await db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [
    userId,
  ]);
}

const ROLE_RANK: Record<Role, number> = {
  user: 0,
  creator: 1,
  resolver: 2,
  moderator: 3,
  admin: 4,
};

/** Authorisation gate. Never trust a role supplied by the client. */
export function requireRole(session: Session | null, minimum: Role): Session {
  if (!session) throw new DomainError("unauthenticated");
  if (ROLE_RANK[session.user.role] < ROLE_RANK[minimum]) throw new DomainError("forbidden");
  return session;
}

export function requireUser(session: Session | null): Session {
  if (!session) throw new DomainError("unauthenticated");
  if (session.user.status !== "active") throw new DomainError("forbidden");
  return session;
}

export function hasRole(session: Session | null, minimum: Role): boolean {
  return !!session && ROLE_RANK[session.user.role] >= ROLE_RANK[minimum];
}
