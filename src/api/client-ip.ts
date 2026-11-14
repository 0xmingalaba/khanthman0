/**
 * Client address resolution for rate limiting and audit hashing.
 *
 * WHY THIS FILE EXISTS
 *
 * `X-Forwarded-For` is written by proxies, but the *client* can also send it, and
 * every proxy in the chain merely appends to whatever arrived. The leftmost value
 * is therefore attacker-controlled in the general case. Trusting it (as an earlier
 * version of this code did) lets an attacker defeat every IP-based rate limit by
 * rotating a forged header on each request, which turns login into an unlimited
 * password-guessing channel.
 *
 * A Next.js route handler has no access to the TCP peer address, so the app cannot
 * discover the real client on its own. It must be *told* how many proxies to trust.
 * That is an explicit deployment decision, not a guess:
 *
 *   TRUSTED_PROXY_HOPS=0   No proxy in front. The forwarding header is ignored
 *                          entirely and every caller shares one bucket. Safe but
 *                          coarse; this is the default because silently trusting a
 *                          header is exactly the bug we are fixing.
 *
 *   TRUSTED_PROXY_HOPS=1   One proxy you control sits in front (the common
 *                          managed-host / load-balancer case). The client address
 *                          is read from the RIGHT of the list, one hop in, so
 *                          client-supplied entries on the left are ignored.
 *
 *   TRUSTED_PROXY_HOPS=n   n trusted proxies. The client address is read at index
 *                          `length - n`.
 *
 *   TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip
 *                          Escape hatch for platforms that expose a single
 *                          dedicated header that the edge overwrites wholesale.
 *                          Only set this when you know the edge overwrites it.
 *
 * The right-anchored rule is what makes spoofing useless: a client can prepend
 * unlimited junk to the left of the list, but cannot add entries to the right,
 * because that position is consumed by the last trusted proxy's append.
 */

import { isIP } from "node:net";

/** Everything the resolver needs; injected so it is testable without a request. */
export type ClientIpConfig = {
  /** Number of trusted proxies between the client and this process. */
  trustedProxyHops: number;
  /** Optional single header to trust wholesale (edge-overwritten). */
  dedicatedHeader?: string | null;
};

/**
 * Subject used when no trustworthy address exists. A single shared bucket is the
 * correct conservative answer: it makes the limit *no weaker* than the per-IP
 * limit, and it never hands an attacker a fresh bucket per request.
 */
export const SHARED_SUBJECT = "untrusted";

/** Cap accepted header length; a rate-limit key must never be unbounded input. */
const MAX_HEADER_LENGTH = 1024;

/**
 * Read deployment configuration.
 *
 * Invalid values fail closed: an unparsable hop count is treated as 0, meaning
 * "trust no forwarded header", rather than falling back to trusting everything.
 */
export function clientIpConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): ClientIpConfig {
  const rawHops = env.TRUSTED_PROXY_HOPS?.trim();
  let hops = 0;
  if (rawHops) {
    const parsed = Number(rawHops);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 10) {
      hops = parsed;
    }
  }

  const rawHeader = env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  // RFC 7230 token characters only; rejects anything that could confuse parsing.
  const dedicatedHeader =
    rawHeader && /^[a-z0-9-]{1,64}$/.test(rawHeader) && rawHeader !== "x-forwarded-for"
      ? rawHeader
      : null;

  return { trustedProxyHops: hops, dedicatedHeader };
}

/** True only for a syntactically valid IPv4/IPv6 literal. */
function isIpLiteral(value: string): boolean {
  return isIP(value) !== 0;
}

/**
 * Pick the client address out of a forwarding list.
 *
 * `entries` arrive left-to-right as the request traversed each proxy. With `hops`
 * trusted proxies, the address appended by the outermost trusted proxy is the
 * last element, so the client sits `hops` positions from the right.
 *
 * Returns null when the list is shorter than the trusted chain (the header cannot
 * be the product of `hops` appends, so it is untrustworthy) or when the selected
 * element is not an IP literal.
 */
export function pickForwardedAddress(entries: string[], hops: number): string | null {
  if (hops <= 0) return null;
  if (!Number.isInteger(hops)) return null;
  if (entries.length < hops) return null;

  const index = entries.length - hops;
  if (index < 0 || index >= entries.length) return null;

  const candidate = entries[index]?.trim();
  if (!candidate) return null;
  // Strip an optional :port from IPv4 (some proxies append it).
  const withoutPort = candidate.replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/, "$1");
  if (!isIpLiteral(withoutPort)) return null;
  return withoutPort;
}

/** Split a header value into trimmed, non-empty entries. */
export function splitForwardedHeader(value: string | null | undefined): string[] {
  if (!value) return [];
  if (value.length > MAX_HEADER_LENGTH) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Resolve the rate-limit / audit subject for a request.
 *
 * `readHeader` is a narrow function rather than the request object so this stays
 * a pure unit under test.
 */
export function resolveClientSubject(
  readHeader: (name: string) => string | null,
  config: ClientIpConfig
): string {
  // A dedicated edge header wins when configured: it is overwritten wholesale by
  // the platform, so its entire value is trustworthy.
  if (config.dedicatedHeader) {
    const dedicated = readHeader(config.dedicatedHeader)?.trim() ?? "";
    if (dedicated.length > 0 && dedicated.length <= MAX_HEADER_LENGTH) {
      const withoutPort = dedicated.replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/, "$1");
      if (isIpLiteral(withoutPort)) return withoutPort;
    }
    // Misconfigured or hostile: fail closed rather than trusting the fallback.
    return SHARED_SUBJECT;
  }

  if (config.trustedProxyHops <= 0) return SHARED_SUBJECT;

  const entries = splitForwardedHeader(readHeader("x-forwarded-for"));
  return pickForwardedAddress(entries, config.trustedProxyHops) ?? SHARED_SUBJECT;
}

/**
 * Stable, non-reversible bucket key.
 *
 * Rate-limit keys end up in a Map and, in a shared deployment, in a store keyed by
 * string. Using the raw address is unnecessary precision; the address itself is
 * hashed with a per-process salt so buckets cannot be enumerated from outside.
 * The salt is process-local on purpose: buckets do not need to survive a restart.
 */
const subjectSalt = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

export function hashSubject(subject: string): string {
  // Small non-cryptographic mix is fine here: this is bucket naming, not a
  // security boundary. The salt prevents trivial correlation across processes.
  const text = `${subjectSalt}\u0000${subject}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
