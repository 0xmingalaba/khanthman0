# Deployment Configuration — client address trust and rate limiting

This document exists because of a security defect found in independent review: the
application trusted the **leftmost** `X-Forwarded-For` entry as the client address.
That value is client-controlled, so an attacker could rotate a forged header per
request and land in a fresh rate-limit bucket every time, turning login into an
unlimited password-guessing channel.

The fix has two halves, and **both** must be understood before deploying:

1. **Infrastructure** — declare how many proxies you actually operate, so the
   address is read from the trustworthy (right-hand) end of the header chain.
2. **Application** — auth endpoints are limited on *two* dimensions, so even a
   working IP rotation cannot reset the per-account counter.

---

## 1. `TRUSTED_PROXY_HOPS`

A Next.js route handler cannot see the TCP peer address. It only sees headers, and
any client can send those. Therefore the app must be *told* the topology.

| Value | Meaning | Effect |
| --- | --- | --- |
| `0` (default) | No proxy you control | Forwarding headers are ignored. **All callers share one bucket.** Safe but coarse: a busy NAT shares a limit. |
| `1` | One proxy in front (Vercel, nginx, ALB, Cloudflare with a single hop) | Client address read **1 position from the right** of `X-Forwarded-For`. |
| `n` | `n` trusted proxies | Client address read `n` positions from the right. |

### Why "from the right" matters

Every proxy *appends* the address it saw. A client may send:

```
X-Forwarded-For: 1.2.3.4, 5.6.7.8        ← attacker wrote both entries
```

Your single proxy then appends the real peer:

```
X-Forwarded-For: 1.2.3.4, 5.6.7.8, 203.0.113.9
```

With `TRUSTED_PROXY_HOPS=1` the app reads `203.0.113.9` — the real address. The
attacker can prepend unlimited junk and it is ignored, because the right-hand
position is written by infrastructure they do not control.

With the old code (`split(",")[0]`) the app read `1.2.3.4` — the attacker's fiction.

### Choosing a value

| Your setup | Set |
| --- | --- |
| `next start` directly exposed, no proxy | `0` |
| Vercel | `1`, and consider `TRUSTED_CLIENT_IP_HEADER=x-vercel-forwarded-for` |
| nginx / Caddy / Traefik reverse proxy | `1` |
| Cloudflare → nginx → app | `2` (or set `cf-connecting-ip` as the dedicated header) |
| ALB → nginx → app | `2` |

An unparsable value fails closed to `0`. A value larger than the number of entries
actually present also fails closed: the request is bucketed as `untrusted` rather
than trusting a header that cannot be the product of that many appends.

## 2. `TRUSTED_CLIENT_IP_HEADER` (optional)

Some platforms expose a single header the edge overwrites wholesale rather than
appending to. When it is correct, it is stronger than hop counting.

```bash
TRUSTED_CLIENT_IP_HEADER=x-vercel-forwarded-for   # Vercel
TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip         # Cloudflare
```

Rules:
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
npm test                       # includes tests/unit/client-ip.test.ts
```

`tests/unit/client-ip.test.ts` covers spoofed headers, missing headers, too-few
entries, port suffixes, dedicated-header mode, and the fail-closed default.
