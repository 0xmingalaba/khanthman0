import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import {
  SHARED_SUBJECT,
  clientIpConfigFromEnv,
  resolveClientSubject,
} from "@/src/api/client-ip";

const example = readFileSync(resolve(process.cwd(), ".env.example"), "utf8");
const deployment = readFileSync(resolve(process.cwd(), "docs/DEPLOYMENT.md"), "utf8");

/** Read active assignments only; commented-out examples must not enable trust. */
function activeValues(source: string, key: string): string[] {
  return source.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    return match?.[1] === key ? [match[2].trim()] : [];
  });
}

describe("committed trusted-proxy configuration", () => {
  test("the example and deployment guide agree on the runtime fail-closed default", () => {
    const hops = activeValues(example, "TRUSTED_PROXY_HOPS");
    assert.deepEqual(hops, ["0"], "commit exactly one fail-closed proxy-hop assignment");
    assert.deepEqual(
      activeValues(example, "TRUSTED_CLIENT_IP_HEADER"),
      [],
      "the optional dedicated header must remain commented out"
    );
    assert.deepEqual(
      activeValues(example, "TRUSTED_PROXY_CIDRS"),
      [""],
      "the committed proxy allowlist must be empty"
    );

    const config = clientIpConfigFromEnv({ TRUSTED_PROXY_HOPS: hops[0] });
    assert.deepEqual(config, clientIpConfigFromEnv({}));
    assert.equal(config.trustedProxyHops, 0);
    assert.deepEqual(config.trustedProxyCidrs, []);
    assert.match(deployment, /\|\s*`0`\s*\(default\)\s*\|/);

    const documentedExample = /\.env\.example`[^\n]*`TRUSTED_PROXY_HOPS=(\d+)`/.exec(
      deployment
    );
    assert.ok(documentedExample, "document the value committed in .env.example");
    assert.equal(documentedExample[1], hops[0]);
  });

  test("copying the example does not trust forwarded client identities", () => {
    const config = clientIpConfigFromEnv({
      TRUSTED_PROXY_HOPS: activeValues(example, "TRUSTED_PROXY_HOPS")[0],
      TRUSTED_PROXY_CIDRS: activeValues(example, "TRUSTED_PROXY_CIDRS")[0],
    });
    for (const forwarded of ["198.51.100.7", "198.51.100.7, 203.0.113.9"]) {
      assert.equal(
        resolveClientSubject(() => forwarded, config),
        SHARED_SUBJECT,
        "the committed example must ignore client-supplied forwarding headers"
      );
      assert.equal(
        resolveClientSubject(() => forwarded, config, "203.0.113.9"),
        "203.0.113.9",
        "an untrusted direct peer must not enable forwarding-header trust"
      );
    }
  });
});
