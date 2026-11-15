/**
 * Client address resolution for rate limiting and audit hashing.
 *
 * WHY THIS FILE EXISTS
 *
 * `X-Forwarded-For` is written by proxies, but the *client* can also send it, and
 * every proxy in the chain merely appends to whatever arrived. The leftmost value
 * is therefore attacker-controlled in the general case. Trusting it lets an
 * attacker defeat every IP-based rate limit by rotating a forged header on each
 * request.
 *
 * A hop count alone is not a trust boundary: if a caller can reach the origin
 * directly, it can supply a whole plausible-looking chain itself. Forwarded
 * headers are therefore honored only when the immediate TCP peer is explicitly
 * listed in `TRUSTED_PROXY_CIDRS`. The peer address is captured from the Node
 * socket by `src/api/peer-address.ts` (installed via `instrumentation.ts`) and
 * passed into `resolveClientSubject`; it is never read from a header.
 *
 *   TRUSTED_PROXY_CIDRS=10.0.0.1/32,10.0.0.2/32
 *                          Explicit allowlist of proxy addresses that may connect
 *                          to this process. Empty (the default) trusts no proxy.
 *
 *   TRUSTED_PROXY_HOPS=0   No forwarded-header trust. Direct connections are
 *                          bucketed by their captured socket address when one is
 *                          available; otherwise callers share one bucket.
 *
 *   TRUSTED_PROXY_HOPS=1   One trusted proxy in front. The client address is read
 *                          from the RIGHT of `X-Forwarded-For`, one hop in, so
 *                          client-supplied entries on the left are ignored.
 *
 *   TRUSTED_PROXY_HOPS=n   n trusted proxies. The client address is read at index
 *                          `length - n`, and the proxy entries to its right must
 *                          themselves be in the trusted allowlist.
 *
 *   TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip
 *                          Escape hatch for platforms that expose a single
 *                          dedicated header that the edge overwrites wholesale.
 *                          It is still honored only from a trusted immediate peer.
 *
 * When the peer cannot be captured, or is not trusted, forwarding headers are
 * ignored. The resolver fails closed rather than guessing.
 */

import { BlockList, isIP } from "node:net";

/** Everything the resolver needs; injected so it is testable without a request. */
export type ClientIpConfig = {
  /** Number of trusted proxies between the client and this process. */
  trustedProxyHops: number;
  /** Optional single header to trust wholesale (edge-overwritten). */
  dedicatedHeader?: string | null;
  /** Explicit allowlist of immediate proxy peers, as IP literals or CIDRs. */
  trustedProxyCidrs: string[];
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
 * Invalid values fail closed: an unparsable hop count is treated as 0, and a
 * malformed proxy allowlist is treated as empty, meaning "trust no forwarded
 * header", rather than falling back to trusting everything.
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

  return {
    trustedProxyHops: hops,
    dedicatedHeader,
    trustedProxyCidrs: parseTrustedProxyCidrs(env.TRUSTED_PROXY_CIDRS),
  };
}

/**
 * Parse a comma-separated proxy allowlist.
 *
 * Every entry must be a valid IPv4/IPv6 literal or CIDR. Wildcard ranges
 * (`0.0.0.0/0`, `::/0`) are rejected because they would trust arbitrary peers.
 * If any entry is invalid the whole list fails closed to empty.
 */
export function parseTrustedProxyCidrs(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];

  const entries: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;

    const pieces = entry.split("/");
    if (pieces.length > 2) return [];

    const base = pieces[0].trim().toLowerCase();
    const family = isIP(base);
    if (family === 0) return [];

    if (pieces.length === 1) {
      entries.push(base);
      continue;
    }

    const prefixText = pieces[1].trim();
    if (!/^\d{1,3}$/.test(prefixText)) return [];
    const prefix = Number(prefixText);
    const maxPrefix = family === 4 ? 32 : 128;
    if (prefix <= 0 || prefix > maxPrefix) return [];

    entries.push(`${base}/${prefix}`);
  }

  return entries;
}

function validPort(port: string): boolean {
  const parsed = Number(port);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535;
}

/** True only for a syntactically valid IPv4/IPv6 literal, normalised for keys. */
function normalizeIpLiteral(value: string | null | undefined): string | null {
  if (!value) return null;
  let candidate = value.trim();
  if (!candidate || candidate.length > MAX_HEADER_LENGTH) return null;

  // Some proxies append `[IPv6]:port`; others append `IPv4:port`.
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(candidate);
  if (bracketed) {
    if (bracketed[2] !== undefined && !validPort(bracketed[2])) return null;
    candidate = bracketed[1];
  } else {
    const ipv4Port = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(candidate);
    if (ipv4Port) {
      if (!validPort(ipv4Port[2])) return null;
      candidate = ipv4Port[1];
    }
  }

  if (isIP(candidate) === 0) return null;

  // Node sockets often report IPv4 peers as IPv4-mapped IPv6 addresses.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(candidate);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];

  return candidate.toLowerCase();
}

/**
 * Check an immediate peer against the explicit proxy allowlist.
 *
 * The peer address must come from the transport layer, never from a forwarding
 * header. Both the raw and normalised forms are checked so IPv4-mapped IPv6
 * socket addresses match IPv4 allowlist entries.
 */
export function isTrustedProxyAddress(
  peerAddress: string | null | undefined,
  trustedProxyCidrs: readonly string[]
): boolean {
  if (!peerAddress || trustedProxyCidrs.length === 0) return false;

  const candidates = new Set<string>();
  const normalized = normalizeIpLiteral(peerAddress);
  if (normalized) candidates.add(normalized);
  const raw = peerAddress.trim().toLowerCase();
  if (isIP(raw) !== 0) candidates.add(raw);
  if (candidates.size === 0) return false;

  try {
    const blockList = new BlockList();
    for (const entry of trustedProxyCidrs) {
      const [base, prefix] = entry.split("/");
      const family = isIP(base) === 4 ? "ipv4" : "ipv6";
      if (prefix === undefined) blockList.addAddress(base, family);
      else blockList.addSubnet(base, Number(prefix), family);
    }

    for (const candidate of candidates) {
      const family = isIP(candidate) === 4 ? "ipv4" : "ipv6";
      if (blockList.check(candidate, family)) return true;
    }
  } catch {
    // Invalid allowlist or address: fail closed.
    return false;
  }

  return false;
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

  return normalizeIpLiteral(entries[index]);
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
 * a pure unit under test. `peerAddress` must be the captured TCP peer; if it is
 * absent or untrusted, no forwarding header is consulted.
 */
export function resolveClientSubject(
  readHeader: (name: string) => string | null,
  config: ClientIpConfig,
  peerAddress?: string | null
): string {
  const peer = normalizeIpLiteral(peerAddress);
  const peerIsTrustedProxy =
    peer !== null && isTrustedProxyAddress(peerAddress, config.trustedProxyCidrs);

  if (!peerIsTrustedProxy) {
    // Direct connection (or peer capture unavailable): never trust forwarding
    // headers. Use the socket address when we have it, otherwise fail closed.
    return peer ?? SHARED_SUBJECT;
  }

  // A dedicated edge header wins when configured, but only from a trusted peer.
  if (config.dedicatedHeader) {
    const dedicated = normalizeIpLiteral(readHeader(config.dedicatedHeader));
    // Misconfigured or hostile: fail closed rather than trusting the fallback.
    return dedicated ?? SHARED_SUBJECT;
  }

  if (config.trustedProxyHops <= 0) return SHARED_SUBJECT;

  const entries = splitForwardedHeader(readHeader("x-forwarded-for"));
  const picked = pickForwardedAddress(entries, config.trustedProxyHops);
  if (!picked) return SHARED_SUBJECT;

  // For a multi-hop chain, the entries to the right of the client are the
  // upstream proxies that appended after it. They must themselves be trusted;
  // otherwise an untrusted upstream proxy could have forged the client entry.
  if (config.trustedProxyHops > 1) {
    const firstProxyIndex = entries.length - config.trustedProxyHops + 1;
    for (let index = firstProxyIndex; index < entries.length; index += 1) {
      if (
        !normalizeIpLiteral(entries[index]) ||
        !isTrustedProxyAddress(entries[index], config.trustedProxyCidrs)
      ) {
        return SHARED_SUBJECT;
      }
    }
  }

  return picked;
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
