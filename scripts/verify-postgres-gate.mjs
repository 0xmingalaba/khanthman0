#!/usr/bin/env node
/**
 * Meta-verification for scripts/postgres-gate.ts — proves the gate refuses
 * false greens instead of trusting that it works.
 *
 * Cases:
 *   1. Gate without TEST_DATABASE_URL      -> must exit non-zero, explaining why.
 *   2. Gate against an unreachable server  -> must exit non-zero.
 *   3. Gate against the configured server  -> must exit zero (full suite pass).
 *
 * Case 3 requires TEST_DATABASE_URL to point at a scratch PostgreSQL server.
 * If it is not set, case 3 is reported and this script exits 1: an
 * unverifiable gate is not a verified gate (this script exists to catch
 * exactly that class of false confidence). CI does not run this script.
 *
 * Exit code: 0 only when every case passes.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GATE_ARGS = ["--import", "tsx", "scripts/postgres-gate.ts"];
const UNREACHABLE_URL = "postgresql://127.0.0.1:1/postgres"; // nothing listens on port 1

function runGate(env) {
  const result = spawnSync(process.execPath, GATE_ARGS, {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
  if (result.error) {
    return { code: 1, output: String(result.error) };
  }
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const cases = [];

// Case 1 — no server configured: the gate must refuse.
const envWithoutServer = { ...process.env };
delete envWithoutServer.TEST_DATABASE_URL;
const noServer = runGate(envWithoutServer);
cases.push({
  name: "gate without TEST_DATABASE_URL fails loudly",
  ok: noServer.code !== 0 && /TEST_DATABASE_URL/.test(noServer.output),
  detail: `exit=${noServer.code}`,
});

// Case 2 — server unreachable: the gate must refuse.
const unreachable = runGate({ ...process.env, TEST_DATABASE_URL: UNREACHABLE_URL });
cases.push({
  name: "gate against an unreachable server fails",
  ok: unreachable.code !== 0,
  detail: `exit=${unreachable.code}`,
});

// Case 3 — live server: the gate must pass, proving it is not vacuous.
const configuredUrl = process.env.TEST_DATABASE_URL?.trim();
if (configuredUrl) {
  const live = runGate({ ...process.env, TEST_DATABASE_URL: configuredUrl });
  cases.push({
    name: "gate against the configured server passes",
    ok: live.code === 0,
    detail: `exit=${live.code}`,
  });
} else {
  cases.push({
    name: "gate against the configured server passes",
    ok: false,
    detail: "SKIPPED — TEST_DATABASE_URL is not set; the positive path cannot be verified",
  });
}

let failures = 0;
console.log("[verify-postgres-gate] results:");
for (const testCase of cases) {
  console.log(`  ${testCase.ok ? "PASS" : "FAIL"}  ${testCase.name} (${testCase.detail})`);
  if (!testCase.ok) failures += 1;
}

if (failures > 0) {
  console.error(`[verify-postgres-gate] FAIL: ${failures}/${cases.length} case(s) failed`);
  process.exit(1);
}
console.log("[verify-postgres-gate] OK: the gate fails when it must and passes when it should");
