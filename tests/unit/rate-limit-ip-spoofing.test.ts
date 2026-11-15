import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  SHARED_SUBJECT,
  resolveClientSubject,
  type ClientIpConfig,
} from "@/src/api/client-ip";
import { DomainError } from "@/src/lib/errors";
import { LIMITS, checkRateLimit, resetRateLimits } from "@/src/lib/rate-limit";

/**
 * Regression tests for the rate-limit bypass: rotating a forged forwarding header
 * must not create a fresh bucket. These exercise the same subject resolution and
 * limiter used by the API boundary, without redesigning either component.
 */

const PROXY = "10.0.0.1";
const UPSTREAM = "10.0.0.2";

function config(overrides: Partial<ClientIpConfig> = {}): ClientIpConfig {
  return {
    trustedProxyHops: 1,
    dedicatedHeader: null,
    trustedProxyCidrs: [PROXY],
    ...overrides,
  };
}

function subject(
  headers: Record<string, string>,
  cfg: ClientIpConfig,
  peer: string | null
): string {
  return resolveClientSubject(
    (name) => headers[name.toLowerCase()] ?? null,
    cfg,
    peer
  );
}

async function exhaust(rule: typeof LIMITS.login, key: string): Promise<void> {
  for (let i = 0; i < rule.max; i += 1) {
    await checkRateLimit(rule, key);
  }
  await assert.rejects(
    () => checkRateLimit(rule, key),
    (error: unknown) => error instanceof DomainError && error.code === "rate_limited"
  );
}

beforeEach(() => {
  resetRateLimits();
});

describe("forged forwarding headers cannot bypass rate limits", () => {
  test("direct untrusted peer: rotating X-Forwarded-For stays in one bucket", async () => {
    const cfg = config();
    const peer = "203.0.113.9";
    const keys = new Set<string>();
    for (let i = 1; i <= LIMITS.login.max + 1; i += 1) {
      const ip = subject({ "x-forwarded-for": `198.51.100.${i}` }, cfg, peer);
      keys.add(`${LIMITS.login.key}:${ip}`);
      if (i <= LIMITS.login.max) await checkRateLimit(LIMITS.login, `${LIMITS.login.key}:${ip}`);
      else {
        await assert.rejects(
          () => checkRateLimit(LIMITS.login, `${LIMITS.login.key}:${ip}`),
          (error: unknown) => error instanceof DomainError && error.code === "rate_limited"
        );
      }
    }
    assert.equal(keys.size, 1);
    assert.equal([...keys][0], `${LIMITS.login.key}:${peer}`);
  });

  test("direct untrusted peer: rotating a dedicated header is also ignored", async () => {
    const cfg = config({ dedicatedHeader: "cf-connecting-ip" });
    const peer = "203.0.113.9";
    const keys = new Set<string>();
    for (let i = 1; i <= LIMITS.login.max + 1; i += 1) {
      const ip = subject({ "cf-connecting-ip": `198.51.100.${i}` }, cfg, peer);
      keys.add(`${LIMITS.login.key}:${ip}`);
      if (i <= LIMITS.login.max) await checkRateLimit(LIMITS.login, `${LIMITS.login.key}:${ip}`);
      else {
        await assert.rejects(
          () => checkRateLimit(LIMITS.login, `${LIMITS.login.key}:${ip}`),
          (error: unknown) => error instanceof DomainError && error.code === "rate_limited"
        );
      }
    }
    assert.equal(keys.size, 1);
    assert.equal([...keys][0], `${LIMITS.login.key}:${peer}`);
  });

  test("missing peer capture fails closed to one shared bucket", async () => {
    const cfg = config();
    const keys = new Set<string>();
    for (let i = 1; i <= LIMITS.login.max + 1; i += 1) {
      const ip = subject({ "x-forwarded-for": `198.51.100.${i}` }, cfg, null);
      keys.add(`${LIMITS.login.key}:${ip}`);
      if (i <= LIMITS.login.max) await checkRateLimit(LIMITS.login, `${LIMITS.login.key}:${ip}`);
      else {
        await assert.rejects(
          () => checkRateLimit(LIMITS.login, `${LIMITS.login.key}:${ip}`),
          (error: unknown) => error instanceof DomainError && error.code === "rate_limited"
        );
      }
    }
    assert.equal(keys.size, 1);
    assert.equal([...keys][0], `${LIMITS.login.key}:${SHARED_SUBJECT}`);
  });

  test("trusted proxy: forged left entries cannot rotate the real client bucket", async () => {
    const cfg = config();
    const realClient = "198.51.100.7";
    const keys = new Set<string>();
    for (let i = 1; i <= LIMITS.login.max + 1; i += 1) {
      const ip = subject(
        { "x-forwarded-for": `203.0.113.${i}, ${realClient}` },
        cfg,
        PROXY
      );
      keys.add(`${LIMITS.login.key}:${ip}`);
      if (i <= LIMITS.login.max) await checkRateLimit(LIMITS.login, `${LIMITS.login.key}:${ip}`);
      else {
        await assert.rejects(
          () => checkRateLimit(LIMITS.login, `${LIMITS.login.key}:${ip}`),
          (error: unknown) => error instanceof DomainError && error.code === "rate_limited"
        );
      }
    }
    assert.equal(keys.size, 1);
    assert.equal([...keys][0], `${LIMITS.login.key}:${realClient}`);
  });

  test("trusted proxy: distinct legitimate clients keep distinct buckets", async () => {
    const cfg = config();
    const clientA = "198.51.100.7";
    const clientB = "198.51.100.8";
    await exhaust(LIMITS.login, `${LIMITS.login.key}:${subject({ "x-forwarded-for": clientA }, cfg, PROXY)}`);
    await checkRateLimit(
      LIMITS.login,
      `${LIMITS.login.key}:${subject({ "x-forwarded-for": clientB }, cfg, PROXY)}`
    );
  });

  test("trusted multi-hop chain: forged prefixes cannot rotate the client bucket", async () => {
    const cfg = config({ trustedProxyHops: 2, trustedProxyCidrs: [PROXY, UPSTREAM] });
    const realClient = "198.51.100.7";
    const keys = new Set<string>();
    for (let i = 1; i <= LIMITS.login.max + 1; i += 1) {
      const ip = subject(
        { "x-forwarded-for": `203.0.113.${i}, ${realClient}, ${UPSTREAM}` },
        cfg,
        PROXY
      );
      keys.add(`${LIMITS.login.key}:${ip}`);
      if (i <= LIMITS.login.max) await checkRateLimit(LIMITS.login, `${LIMITS.login.key}:${ip}`);
      else {
        await assert.rejects(
          () => checkRateLimit(LIMITS.login, `${LIMITS.login.key}:${ip}`),
          (error: unknown) => error instanceof DomainError && error.code === "rate_limited"
        );
      }
    }
    assert.equal(keys.size, 1);
    assert.equal([...keys][0], `${LIMITS.login.key}:${realClient}`);
  });

  test("IPv6 trusted proxy and client are rate-limited normally", async () => {
    const cfg = config({ trustedProxyCidrs: ["2001:db8::1/128"] });
    const peer = "2001:db8::1";
    const realClient = "2001:db8::2";
    const keys = new Set<string>();
    for (let i = 1; i <= LIMITS.login.max + 1; i += 1) {
      const ip = subject(
        { "x-forwarded-for": `2001:db8::${i + 10}, ${realClient}` },
        cfg,
        peer
      );
      keys.add(`${LIMITS.login.key}:${ip}`);
      if (i <= LIMITS.login.max) await checkRateLimit(LIMITS.login, `${LIMITS.login.key}:${ip}`);
      else {
        await assert.rejects(
          () => checkRateLimit(LIMITS.login, `${LIMITS.login.key}:${ip}`),
          (error: unknown) => error instanceof DomainError && error.code === "rate_limited"
        );
      }
    }
    assert.equal(keys.size, 1);
    assert.equal([...keys][0], `${LIMITS.login.key}:${realClient}`);
  });
});
