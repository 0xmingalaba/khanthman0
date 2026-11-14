import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  SHARED_SUBJECT,
  clientIpConfigFromEnv,
  pickForwardedAddress,
  resolveClientSubject,
  splitForwardedHeader,
} from "@/src/api/client-ip";

/**
 * These tests encode the security property that was missing before the correction:
 * a client cannot choose its own rate-limit bucket by writing X-Forwarded-For.
 */

describe("trusted-proxy client address resolution", () => {
  const header = (value: string | null) => (name: string) =>
    name.toLowerCase() === "x-forwarded-for" ? value : null;

  test("with zero trusted hops, every forwarding header is ignored", () => {
    // The attacker's dream payload: a fresh address per request.
    for (const spoof of ["1.1.1.1", "8.8.8.8", "203.0.113.5, 10.0.0.1"]) {
      const subject = resolveClientSubject(header(spoof), { trustedProxyHops: 0 });
      assert.equal(subject, SHARED_SUBJECT, `spoof ${spoof} must not be trusted`);
    }
  });

  test("rotation of a forged header cannot produce distinct buckets at hops=0", () => {
    const subjects = new Set<string>();
    for (let i = 1; i <= 200; i += 1) {
      subjects.add(
        resolveClientSubject(header(`10.0.${Math.floor(i / 256)}.${i % 256}`), {
          trustedProxyHops: 0,
        })
      );
    }
    assert.equal(subjects.size, 1, "all spoofed requests collapse into one bucket");
  });

  test("a client-supplied prefix is ignored; the last hop wins at hops=1", () => {
    // Client wrote "1.2.3.4"; the trusted proxy appended the real peer.
    const subject = resolveClientSubject(header("1.2.3.4, 203.0.113.9"), {
      trustedProxyHops: 1,
    });
    assert.equal(subject, "203.0.113.9");
  });

  test("many forged prefix entries still cannot change the result", () => {
    const forged = Array.from({ length: 50 }, (_unused, i) => `10.9.9.${i}`).join(", ");
    const subject = resolveClientSubject(header(`${forged}, 203.0.113.9`), {
      trustedProxyHops: 1,
    });
    assert.equal(subject, "203.0.113.9", "only the rightmost hop is trusted");
  });

  test("hops=2 reads two positions from the right (Cloudflare -> nginx -> app)", () => {
    // Client forged the first entry; Cloudflare appended the client; nginx appended CF.
    const subject = resolveClientSubject(header("9.9.9.9, 203.0.113.9, 172.16.0.1"), {
      trustedProxyHops: 2,
    });
    assert.equal(subject, "203.0.113.9");
  });

  test("a header shorter than the trusted chain fails closed", () => {
    // Claiming 2 hops but only one entry: this cannot be two genuine appends.
    const subject = resolveClientSubject(header("203.0.113.9"), { trustedProxyHops: 2 });
    assert.equal(subject, SHARED_SUBJECT);
  });

  test("a missing header fails closed, never throws", () => {
    assert.equal(resolveClientSubject(header(null), { trustedProxyHops: 1 }), SHARED_SUBJECT);
    assert.equal(resolveClientSubject(header("   "), { trustedProxyHops: 1 }), SHARED_SUBJECT);
  });

  test("non-IP garbage in the trusted position is refused", () => {
    for (const junk of ["not-an-ip", "<script>", "1.2.3.4.5", ":::", "0x7f.0.0.1"]) {
      assert.equal(
        resolveClientSubject(header(junk), { trustedProxyHops: 1 }),
        SHARED_SUBJECT,
        `${junk} must not be accepted as an address`
      );
    }
  });

  test("IPv4 with a port suffix is normalised", () => {
    assert.equal(
      resolveClientSubject(header("203.0.113.9:51234"), { trustedProxyHops: 1 }),
      "203.0.113.9"
    );
  });

  test("IPv6 literals are accepted", () => {
    assert.equal(
      resolveClientSubject(header("2001:db8::1"), { trustedProxyHops: 1 }),
      "2001:db8::1"
    );
  });

  test("oversized headers are discarded rather than parsed", () => {
    const huge = `${"1.1.1.1,".repeat(400)}203.0.113.9`;
    assert.equal(splitForwardedHeader(huge).length, 0);
    assert.equal(resolveClientSubject(header(huge), { trustedProxyHops: 1 }), SHARED_SUBJECT);
  });

  test("a dedicated edge header is authoritative when configured", () => {
    const request = (name: string) =>
      name.toLowerCase() === "cf-connecting-ip" ? "198.51.100.7" : "1.2.3.4, 5.6.7.8";
    const subject = resolveClientSubject(request, {
      trustedProxyHops: 0,
      dedicatedHeader: "cf-connecting-ip",
    });
    assert.equal(subject, "198.51.100.7", "dedicated header beats X-Forwarded-For");
  });

  test("a dedicated header that is absent fails closed", () => {
    const subject = resolveClientSubject(() => null, {
      trustedProxyHops: 5,
      dedicatedHeader: "cf-connecting-ip",
    });
    assert.equal(subject, SHARED_SUBJECT);
  });

  test("a dedicated header containing garbage fails closed", () => {
    const subject = resolveClientSubject(
      (name) => (name.toLowerCase() === "cf-connecting-ip" ? "evil.example.com" : null),
      { trustedProxyHops: 1, dedicatedHeader: "cf-connecting-ip" }
    );
    assert.equal(subject, SHARED_SUBJECT);
  });
});

describe("configuration parsing", () => {
  test("defaults to trusting nothing when unset", () => {
    assert.deepEqual(clientIpConfigFromEnv({}), { trustedProxyHops: 0, dedicatedHeader: null });
  });

  test("accepts a valid hop count", () => {
    assert.equal(clientIpConfigFromEnv({ TRUSTED_PROXY_HOPS: "2" }).trustedProxyHops, 2);
  });

  test("fails closed on invalid hop counts", () => {
    for (const bad of ["-1", "abc", "1.5", "999", "", " "]) {
      assert.equal(
        clientIpConfigFromEnv({ TRUSTED_PROXY_HOPS: bad }).trustedProxyHops,
        0,
        `${JSON.stringify(bad)} must fall back to 0`
      );
    }
  });

  test("refuses x-forwarded-for as a dedicated header", () => {
    assert.equal(
      clientIpConfigFromEnv({ TRUSTED_CLIENT_IP_HEADER: "x-forwarded-for" }).dedicatedHeader,
      null
    );
  });

  test("rejects a dedicated header name with unsafe characters", () => {
    assert.equal(
      clientIpConfigFromEnv({ TRUSTED_CLIENT_IP_HEADER: "x-fwd\r\nHost" }).dedicatedHeader,
      null
    );
  });

  test("accepts and lowercases a normal dedicated header name", () => {
    assert.equal(
      clientIpConfigFromEnv({ TRUSTED_CLIENT_IP_HEADER: "CF-Connecting-IP" }).dedicatedHeader,
      "cf-connecting-ip"
    );
  });
});

describe("pickForwardedAddress", () => {
  test("returns null for non-positive hops", () => {
    assert.equal(pickForwardedAddress(["1.2.3.4"], 0), null);
    assert.equal(pickForwardedAddress(["1.2.3.4"], -1), null);
  });

  test("rejects a non-integer hop count", () => {
    assert.equal(pickForwardedAddress(["1.2.3.4"], 1.5), null);
  });

  test("selects correctly from a longer chain", () => {
    assert.equal(pickForwardedAddress(["a", "1.2.3.4", "5.6.7.8"], 2), "1.2.3.4");
  });
});
