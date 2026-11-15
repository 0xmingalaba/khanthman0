import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  SHARED_SUBJECT,
  clientIpConfigFromEnv,
  isTrustedProxyAddress,
  parseTrustedProxyCidrs,
  pickForwardedAddress,
  resolveClientSubject,
  splitForwardedHeader,
  type ClientIpConfig,
} from "@/src/api/client-ip";

/**
 * These tests encode the security property that was missing before the correction:
 * a client cannot choose its own rate-limit bucket by writing forwarding headers.
 * Forwarded headers are consulted only when the captured TCP peer is explicitly
 * trusted; otherwise the socket address (or a shared fail-closed bucket) is used.
 */

const PROXY = "10.0.0.1";
const UPSTREAM = "10.0.0.2";

function config(overrides: Partial<ClientIpConfig> = {}): ClientIpConfig {
  return {
    trustedProxyHops: 0,
    dedicatedHeader: null,
    trustedProxyCidrs: [PROXY],
    ...overrides,
  };
}

const header = (value: string | null) => (name: string) =>
  name.toLowerCase() === "x-forwarded-for" ? value : null;

describe("trusted-proxy client address resolution", () => {
  test("without a captured peer, forwarding headers are never trusted", () => {
    for (const spoof of ["1.1.1.1", "8.8.8.8", "203.0.113.5, 10.0.0.1"]) {
      assert.equal(
        resolveClientSubject(header(spoof), config({ trustedProxyHops: 1 })),
        SHARED_SUBJECT,
        `spoof ${spoof} must not be trusted without a peer`
      );
    }
    assert.equal(
      resolveClientSubject(header("203.0.113.5"), config({ trustedProxyHops: 0 })),
      SHARED_SUBJECT
    );
  });

  test("an untrusted direct peer is bucketed by its socket address, not headers", () => {
    const direct = "203.0.113.9";
    const subjects = new Set<string>();
    for (let i = 1; i <= 200; i += 1) {
      subjects.add(
        resolveClientSubject(
          header(`10.0.${Math.floor(i / 256)}.${i % 256}`),
          config({ trustedProxyHops: 1 }),
          direct
        )
      );
    }
    assert.equal(subjects.size, 1, "all spoofed requests collapse into the socket bucket");
    assert.equal([...subjects][0], direct);
  });

  test("a peer outside the allowlist cannot enable dedicated-header trust", () => {
    const subject = resolveClientSubject(
      (name) => (name.toLowerCase() === "cf-connecting-ip" ? "198.51.100.7" : null),
      config({ trustedProxyHops: 1, dedicatedHeader: "cf-connecting-ip" }),
      "203.0.113.9"
    );
    assert.equal(subject, "203.0.113.9");
  });

  test("a client-supplied prefix is ignored; the last hop wins at hops=1", () => {
    const subject = resolveClientSubject(
      header("1.2.3.4, 203.0.113.9"),
      config({ trustedProxyHops: 1 }),
      PROXY
    );
    assert.equal(subject, "203.0.113.9");
  });

  test("many forged prefix entries still cannot change the result", () => {
    const forged = Array.from({ length: 50 }, (_unused, i) => `10.9.9.${i}`).join(", ");
    const subject = resolveClientSubject(
      header(`${forged}, 203.0.113.9`),
      config({ trustedProxyHops: 1 }),
      PROXY
    );
    assert.equal(subject, "203.0.113.9", "only the rightmost hop is trusted");
  });

  test("hops=2 reads two positions from the right and validates the upstream proxy", () => {
    const subject = resolveClientSubject(
      header("9.9.9.9, 203.0.113.9, 10.0.0.2"),
      config({ trustedProxyHops: 2, trustedProxyCidrs: [PROXY, UPSTREAM] }),
      PROXY
    );
    assert.equal(subject, "203.0.113.9");
  });

  test("an untrusted upstream proxy in the chain fails closed", () => {
    const subject = resolveClientSubject(
      header("9.9.9.9, 203.0.113.9, 203.0.113.99"),
      config({ trustedProxyHops: 2, trustedProxyCidrs: [PROXY, UPSTREAM] }),
      PROXY
    );
    assert.equal(subject, SHARED_SUBJECT);
  });

  test("a header shorter than the trusted chain fails closed", () => {
    assert.equal(
      resolveClientSubject(header("203.0.113.9"), config({ trustedProxyHops: 2 }), PROXY),
      SHARED_SUBJECT
    );
  });

  test("a missing header fails closed, never throws", () => {
    assert.equal(
      resolveClientSubject(header(null), config({ trustedProxyHops: 1 }), PROXY),
      SHARED_SUBJECT
    );
    assert.equal(
      resolveClientSubject(header("   "), config({ trustedProxyHops: 1 }), PROXY),
      SHARED_SUBJECT
    );
  });

  test("non-IP garbage in the trusted position is refused", () => {
    for (const junk of ["not-an-ip", "<script>", "1.2.3.4.5", ":::", "0x7f.0.0.1"]) {
      assert.equal(
        resolveClientSubject(header(junk), config({ trustedProxyHops: 1 }), PROXY),
        SHARED_SUBJECT,
        `${junk} must not be accepted as an address`
      );
    }
  });

  test("IPv4 with a port suffix is normalised", () => {
    assert.equal(
      resolveClientSubject(header("203.0.113.9:51234"), config({ trustedProxyHops: 1 }), PROXY),
      "203.0.113.9"
    );
    assert.equal(
      resolveClientSubject(header("203.0.113.9:70000"), config({ trustedProxyHops: 1 }), PROXY),
      SHARED_SUBJECT,
      "an invalid port is malformed"
    );
  });

  test("IPv6 literals and bracketed ports are accepted", () => {
    assert.equal(
      resolveClientSubject(header("2001:db8::1"), config({ trustedProxyHops: 1 }), PROXY),
      "2001:db8::1"
    );
    assert.equal(
      resolveClientSubject(header("[2001:db8::1]:51234"), config({ trustedProxyHops: 1 }), PROXY),
      "2001:db8::1"
    );
  });

  test("IPv4-mapped IPv6 peers and headers normalise to IPv4", () => {
    assert.equal(
      resolveClientSubject(header("::ffff:203.0.113.9"), config({ trustedProxyHops: 1 }), PROXY),
      "203.0.113.9"
    );
    assert.equal(
      resolveClientSubject(header("203.0.113.9"), config({ trustedProxyHops: 1 }), "::ffff:10.0.0.1"),
      "203.0.113.9"
    );
  });

  test("oversized headers are discarded rather than parsed", () => {
    const huge = `${"1.1.1.1,".repeat(400)}203.0.113.9`;
    assert.equal(splitForwardedHeader(huge).length, 0);
    assert.equal(
      resolveClientSubject(header(huge), config({ trustedProxyHops: 1 }), PROXY),
      SHARED_SUBJECT
    );
  });

  test("a dedicated edge header is authoritative only from a trusted peer", () => {
    const request = (name: string) =>
      name.toLowerCase() === "cf-connecting-ip" ? "198.51.100.7" : "1.2.3.4, 5.6.7.8";
    assert.equal(
      resolveClientSubject(request, config({ dedicatedHeader: "cf-connecting-ip" }), PROXY),
      "198.51.100.7",
      "dedicated header beats X-Forwarded-For"
    );
    assert.equal(
      resolveClientSubject(request, config({ dedicatedHeader: "cf-connecting-ip" }), "203.0.113.9"),
      "203.0.113.9",
      "the same header from an untrusted peer is ignored"
    );
  });

  test("a dedicated header that is absent or malformed fails closed", () => {
    assert.equal(
      resolveClientSubject(() => null, config({ trustedProxyHops: 5, dedicatedHeader: "cf-connecting-ip" }), PROXY),
      SHARED_SUBJECT
    );
    assert.equal(
      resolveClientSubject(
        (name) => (name.toLowerCase() === "cf-connecting-ip" ? "evil.example.com" : null),
        config({ trustedProxyHops: 1, dedicatedHeader: "cf-connecting-ip" }),
        PROXY
      ),
      SHARED_SUBJECT
    );
  });
});

describe("configuration parsing", () => {
  test("defaults to trusting nothing when unset", () => {
    assert.deepEqual(clientIpConfigFromEnv({}), {
      trustedProxyHops: 0,
      dedicatedHeader: null,
      trustedProxyCidrs: [],
    });
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

  test("parses an explicit proxy allowlist", () => {
    assert.deepEqual(
      clientIpConfigFromEnv({
        TRUSTED_PROXY_CIDRS: "10.0.0.1, 192.168.0.0/16, 2001:DB8::1, 2001:db8::/32",
      }).trustedProxyCidrs,
      ["10.0.0.1", "192.168.0.0/16", "2001:db8::1", "2001:db8::/32"]
    );
  });

  test("a malformed allowlist fails closed to empty", () => {
    for (const bad of [
      "bad",
      "10.0.0.0/33",
      "2001:db8::/129",
      "0.0.0.0/0",
      "::/0",
      "10.0.0.1, bad",
      "10.0.0.1/8/8",
    ]) {
      assert.deepEqual(parseTrustedProxyCidrs(bad), [], `${bad} must not partially trust`);
    }
  });
});

describe("trusted proxy matching", () => {
  test("matches exact addresses, CIDRs, IPv6, and IPv4-mapped peers", () => {
    const cidrs = ["10.0.0.1", "192.168.0.0/16", "2001:db8::1", "2001:db8::/32"];
    assert.equal(isTrustedProxyAddress("10.0.0.1", cidrs), true);
    assert.equal(isTrustedProxyAddress("192.168.5.5", cidrs), true);
    assert.equal(isTrustedProxyAddress("2001:db8::1", cidrs), true);
    assert.equal(isTrustedProxyAddress("2001:db8::abcd", cidrs), true);
    assert.equal(isTrustedProxyAddress("::ffff:10.0.0.1", cidrs), true);
    assert.equal(isTrustedProxyAddress("203.0.113.9", cidrs), false);
    assert.equal(isTrustedProxyAddress("2001:db9::1", cidrs), false);
    assert.equal(isTrustedProxyAddress(null, cidrs), false);
    assert.equal(isTrustedProxyAddress("10.0.0.1", []), false);
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
