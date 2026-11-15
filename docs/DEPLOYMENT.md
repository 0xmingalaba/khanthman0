# Deployment Configuration — client address trust and rate limiting

This document exists because of a security defect found in independent review: the
application trusted the **leftmost** `X-Forwarded-For` entry as the client address.
That value is client-controlled, so an attacker could rotate a forged header per
request and land in a fresh rate-limit bucket every time, turning login into an
unlimited password-guessing channel.

A hop count alone is not a trust boundary. If a caller can reach the origin
directly, it can supply a whole plausible-looking forwarding chain itself. The
current fix therefore has three parts:

1. **Transport peer capture** — `instrumentation.ts` installs a Node diagnostics
   channel subscriber (`src/api/peer-address.ts`) that records `socket.remoteAddress`
   for each request. This value is never derived from a header.
2. **Explicit proxy trust** — forwarded headers are honored only when the captured
   immediate peer matches `TRUSTED_PROXY_CIDRS`, and the chain is read from the
   trustworthy right-hand end using `TRUSTED_PROXY_HOPS`.
3. **Application** — auth endpoints are limited on *two* dimensions, so even a
   working IP rotation cannot reset the per-account counter.

---

## 1. Required trusted-proxy configuration

### `TRUSTED_PROXY_CIDRS`

Comma-separated IP literals or CIDRs of proxies that are allowed to connect
directly to this process. Empty is the default and trusts no proxy.

```bash
# Local reverse proxy on the same host
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128

# Private network load balancer / proxy tier
TRUSTED_PROXY_CIDRS=10.0.0.0/8,192.168.0.0/16

# Multi-hop example: immediate nginx plus upstream Cloudflare ranges
TRUSTED_PROXY_CIDRS=10.0.0.1/32,173.245.48.0/20,103.21.244.0/22
```

Rules:
- List only infrastructure you control or have verified. Do not use `0.0.0.0/0`
  or `::/0`; wildcard ranges are rejected.
- Any malformed entry makes the whole allowlist fail closed to empty.
- Restrict origin access to these proxies at the network/firewall level as well.
  The application check is a second layer, not a replacement for network policy.

### `TRUSTED_PROXY_HOPS`

The committed `.env.example` sets `TRUSTED_PROXY_HOPS=0` and leaves
`TRUSTED_PROXY_CIDRS` empty. Zero means no forwarded-header trust: forwarding
headers are ignored unless the deployment explicitly opts in.

| Value | Meaning | Effect |
| --- | --- | --- |
| `0` (default) | No forwarded-header trust | Forwarding headers are ignored. Direct connections are bucketed by their captured socket address when available; otherwise **all callers share one bucket.** Safe but coarse. |
| `1` | One trusted proxy in front (nginx, ALB, Cloudflare with a single hop) | Client address read **1 position from the right** of `X-Forwarded-For`, only from a trusted immediate peer. |
| `n` | `n` trusted proxies | Client address read `n` positions from the right. The proxy entries to its right must themselves be in `TRUSTED_PROXY_CIDRS`. |

An unparsable hop count fails closed to `0`. A header shorter than the configured
chain, or a chain containing an untrusted upstream proxy, fails closed to the
shared `untrusted` bucket.

### Why "from the right" matters

Every proxy *appends* the address it saw. A client may send:

```
X-Forwarded-For: 1.2.3.4, 5.6.7.8        ← attacker wrote both entries
```

Your single trusted proxy then appends the real peer:

```
X-Forwarded-For: 1.2.3.4, 5.6.7.8, 203.0.113.9
```

With `TRUSTED_PROXY_HOPS=1` and the proxy in `TRUSTED_PROXY_CIDRS`, the app reads
`203.0.113.9` — the real address. The attacker can prepend unlimited junk and it is
ignored, because the right-hand position is written by infrastructure they do not
control.

If the same header arrives from a direct, untrusted peer, it is ignored entirely
and the request is bucketed by the captured socket address (or the shared bucket
if peer capture is unavailable).

### Choosing a value

| Your setup | Set |
| --- | --- |
| `next start` directly exposed, no proxy | `TRUSTED_PROXY_CIDRS=` empty, `TRUSTED_PROXY_HOPS=0` |
| nginx / Caddy / Traefik reverse proxy on the same host | `TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128`, `TRUSTED_PROXY_HOPS=1` |
| ALB → nginx → app | Allowlist the nginx and ALB addresses, `TRUSTED_PROXY_HOPS=2` |
| Cloudflare → nginx → app | Allowlist nginx plus verified Cloudflare ranges, `TRUSTED_PROXY_HOPS=2` (or use `cf-connecting-ip` as the dedicated header) |
| Vercel / another managed platform | Verify how the platform exposes the client address and whether peer capture works in that runtime; consider `TRUSTED_CLIENT_IP_HEADER=x-vercel-forwarded-for` only with the platform's verified proxy trust. If the socket peer cannot be captured, the app fails closed; use the platform WAF/rate limiting. |

Configure hops only after verifying the actual proxy topology and how each proxy
handles forwarding headers. These setups are examples, not verified defaults.

## 2. `TRUSTED_CLIENT_IP_HEADER` (optional)

Some platforms expose a single header the edge overwrites wholesale rather than
appending to. When it is correct, it is stronger than hop counting.

```bash
TRUSTED_CLIENT_IP_HEADER=x-vercel-forwarded-for   # Vercel
TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip         # Cloudflare
```

Rules:
- It is honored **only** when the immediate captured peer is in
  `TRUSTED_PROXY_CIDRS`. From an untrusted peer it is ignored.
- Only enable when you are **certain** the edge strips or overwrites any
  client-supplied value for that header. If it does not, you have reintroduced the
  original vulnerability.
- `x-forwarded-for` is explicitly rejected as a dedicated header.
- Values must be IP literals; anything else falls back to the shared bucket.

## 3. Two-dimension rate limiting

| Endpoint | Per-client limit | Per-account limit |
| --- | --- | --- |
| `POST /api/auth/login` | 10 / 15 min per address | 10 / 15 min per email |
| `POST /api/auth/register` | 5 / hour per address | 3 / hour per email |
| `POST /api/orders` | 30 / min per address | — |
| `POST /api/orders/cancel` | 30 / min per address | — |
| reads | 240 / min per address | — |
| `GET /api/health` | 60 / min per address | — |

The per-account limit is keyed on a hash of the normalised email, so a distributed
attack against one mailbox — the realistic threat — hits a wall that changing source
address cannot reset. The hash keeps plaintext emails out of the limiter's memory.

## 4. Known limitation: the limiter is process-local

`src/lib/rate-limit.ts` stores counters in a `Map` in the process. This is stated
plainly rather than hidden:

- **Serverless (Vercel default):** each instance has its own counters and they reset
  on cold start. Effective limits become `limit × instance count`. The per-account
  limit still applies per instance, so brute force is slowed and bounded but not
  hard-capped.
- **A single long-lived container:** the limiter behaves as specified.

Before relying on this for real abuse prevention at scale, move the counter to a
shared store (Redis, or a `rate_limit_buckets` Postgres table updated with
`INSERT ... ON CONFLICT DO UPDATE`). That is a deliberate non-goal of this correction
phase; it is recorded in `docs/PRODUCTION-READINESS.md` as G1.

Recommendation for launch on Vercel: enable the platform WAF/rate limiting at the
edge in front of `/api/auth/*`, so protection does not depend on process memory.

## 5. Verifying the configuration

`GET /api/health` (see `app/api/health/route.ts`) reports database and ledger state
without exposing balances. It does **not** report the trust configuration, because
that would tell an attacker how to structure a spoofing attempt. Verify by test
instead:

```
npm test                       # includes the client-IP and rate-limit regressions
```

Relevant suites:
- `tests/unit/client-ip.test.ts` — peer trust, spoofed headers, missing headers,
  too-few entries, malformed chains, port suffixes, IPv4/IPv6, dedicated-header
  mode, and the fail-closed default.
- `tests/unit/rate-limit-ip-spoofing.test.ts` — rotating forged headers cannot
  bypass the login limiter; legitimate clients behind a trusted proxy keep
  distinct buckets.
- `tests/unit/peer-address.test.ts` — the captured peer comes from the socket,
  not from `X-Forwarded-For`.
- `tests/unit/proxy-config.test.ts` — the committed example and this guide agree
  on the fail-closed default.
