/**
 * In-memory fixed-window rate limiter.
 *
 * Deliberately dependency-free and process-local: it protects the auth endpoints
 * against casual brute force and request floods in a single instance. It is NOT a
 * distributed limiter, and that limitation is stated in docs rather than hidden.
 * A multi-instance deployment must move this to a shared store (e.g. Redis or a
 * Postgres table) before relying on it for abuse prevention.
 *
 * TWO DIMENSIONS, ON PURPOSE
 *
 * An IP-keyed limit alone is defeatable: rotate the source address and the bucket
 * resets. That matters most on login, where the attacker is trying to guess one
 * specific account's password. So auth endpoints apply BOTH:
 *
 *   - a per-client limit (`LIMITS.login`) to stop floods from one source, and
 *   - a per-identity limit (`LIMITS.loginAccount`) keyed on the normalised email
 *     being attacked, which rotation cannot reset.
 *
 * The identity key is hashed so that a memory dump or a future shared store never
 * contains a plaintext email-to-failure-count index.
 */

import { DomainError } from "@/src/lib/errors";

export type RateLimitRule = {
  /** Namespace, e.g. "auth:login". */
  key: string;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed per window per subject. */
  max: number;
};

type Window = { count: number; resetAt: number };

const buckets = new Map<string, Window>();
const MAX_BUCKETS = 50_000;

function sweep(now: number): void {
  if (buckets.size <= MAX_BUCKETS) return;
  for (const [key, window] of buckets) {
    if (window.resetAt <= now) buckets.delete(key);
  }
}

/** Seconds until the caller may retry. */
export function rateLimitRemaining(rule: RateLimitRule, subject: string): number {
  const window = buckets.get(`${rule.key}:${subject}`);
  if (!window) return 0;
  return Math.max(0, Math.ceil((window.resetAt - Date.now()) / 1000));
}

export async function checkRateLimit(rule: RateLimitRule, subject: string): Promise<void> {
  const now = Date.now();
  sweep(now);
  const bucketKey = `${rule.key}:${subject}`;
  const existing = buckets.get(bucketKey);

  if (!existing || existing.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + rule.windowMs });
    return;
  }

  existing.count += 1;
  if (existing.count > rule.max) {
    const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    throw new DomainError("rate_limited", {
      message: `Too many requests. Try again in ${retryAfter}s.`,
    });
  }
}

/** Test hook: clear all windows. */
export function resetRateLimits(): void {
  buckets.clear();
}

/**
 * Per-identity auth limits. Tighter than the per-IP limits because the attack they
 * block (guessing one account's password) does not benefit from being distributed
 * across addresses, and a legitimate user rarely fails ten times in fifteen minutes.
 */
export function againstAccount(rule: RateLimitRule, email: string): string {
  return `${rule.key}:acct:${hashAccount(email)}`;
}

/** Non-reversible, normalised account key. Email is lowercased first. */
export function hashAccount(email: string): string {
  const normalised = email.trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalised.length; i += 1) {
    hash ^= normalised.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export const LIMITS = {
  register: { key: "auth:register", windowMs: 60 * 60 * 1000, max: 5 } as RateLimitRule,
  login: { key: "auth:login", windowMs: 15 * 60 * 1000, max: 10 } as RateLimitRule,
  /** Per-account ceiling: a distributed attack on one mailbox hits this wall. */
  loginAccount: { key: "auth:login-acct", windowMs: 15 * 60 * 1000, max: 10 } as RateLimitRule,
  /** Per-account signup ceiling, so one address cannot be mass-registered. */
  registerAccount: { key: "auth:register-acct", windowMs: 60 * 60 * 1000, max: 3 } as RateLimitRule,
  order: { key: "trade:order", windowMs: 60 * 1000, max: 30 } as RateLimitRule,
  read: { key: "api:read", windowMs: 60 * 1000, max: 240 } as RateLimitRule,
};
