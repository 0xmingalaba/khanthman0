import "server-only";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/src/auth/session";

/** Set the session cookie on a response (login/register). */
export async function attachSessionCookie(response: NextResponse, token: string): Promise<NextResponse> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions());
  return response;
}

/** Clear the session cookie (logout). */
export async function clearSessionCookie(response: NextResponse): Promise<NextResponse> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return response;
}

export async function readSessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}
