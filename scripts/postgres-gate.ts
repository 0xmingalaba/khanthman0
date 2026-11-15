/**
 * PostgreSQL concurrency gate.
 *
 * `npm run test:postgres` runs the real-server suite in
 * tests/integration/postgres-concurrency.test.ts, which is the only place
 * row-lock semantics (`FOR UPDATE`, lock waiters, settlement ordering) can
 * actually be proven: PGlite serialises transactions on a single connection.
 * This gate hardens that suite against false greens so a "pass"
 * only ever means the concurrency proof really happened:
 *
 *   1. TEST_DATABASE_URL must be set and point to a reachable, real PostgreSQL
 *      server (verified with `SELECT version()` before the suite runs).
 *   2. The suite runs as a child process with the same server, in an
 *      environment free of the outer Node test-runner context (see
 *      nestedSuiteEnv in ./postgres-gate-logic).
 *   3. The child's exit code must be 0 AND its node --test summary must show
 *      every test passing with nothing skipped — otherwise this gate fails,
 *      loudly, with the reason.
 *
 * The gate is intentionally NOT wired into CI in this change (the CI baseline
 * runs `npm run test:postgres` directly); see the NOTE step in
 * .github/workflows/ci.yml. Wiring it in is an owner decision.
 *
 * Meta-verification that this gate fails when it should:
 * `npm run verify:postgres-gate` (scripts/verify-postgres-gate.mjs).
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { evaluateGateOutcome, nestedSuiteEnv } from "./postgres-gate-logic";

const SUITE_PATH = "tests/integration/postgres-concurrency.test.ts";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONNECT_TIMEOUT_MS = 5000;

function fail(message: string): never {
  console.error(`[postgres-gate] FAIL: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    fail(
      "TEST_DATABASE_URL is not set. The concurrency proof requires a real PostgreSQL " +
        "server; PGlite cannot prove row-lock semantics. Point TEST_DATABASE_URL at a " +
        "scratch server the suite may create and drop databases on."
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`TEST_DATABASE_URL is not a valid URL: ${JSON.stringify(url)}`);
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    fail(`TEST_DATABASE_URL must use postgres:// or postgresql:// (got ${parsed.protocol})`);
  }

  // Step 1 — the server must actually be there and be PostgreSQL.
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const result = await client.query<{ version: string }>("SELECT version() AS version");
    const version = result.rows[0]?.version ?? "";
    if (!/PostgreSQL/i.test(version)) {
      fail(`server did not identify as PostgreSQL (got: ${version || "empty version"})`);
    }
    console.log(`[postgres-gate] connected: ${version}`);
  } catch (error) {
    fail(`cannot reach TEST_DATABASE_URL (${(error as Error).message})`);
  } finally {
    await client.end().catch(() => undefined);
  }

  // Step 2 — run the suite against that same server. The nested env is
  // scrubbed of the outer Node test-runner context; everything else,
  // including TEST_DATABASE_URL, is preserved.
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-reporter=spec",
      "--test-concurrency=1",
      SUITE_PATH,
    ],
    { cwd: REPO_ROOT, env: nestedSuiteEnv(process.env) }
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    output += chunk.toString();
  });
  const exitCode: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

  // Step 3 — trust only a verified, complete run.
  const outcome = evaluateGateOutcome(exitCode, output);
  if (!outcome.ok) {
    fail(outcome.reason ?? "unknown gate failure");
  }
  console.log(
    `[postgres-gate] PASS: ${outcome.pass}/${outcome.tests} concurrency tests passed on the real server`
  );
}

// This file is a script, not a module for import: it always executes.
main().catch((error: unknown) => {
  console.error(`[postgres-gate] FAIL: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
