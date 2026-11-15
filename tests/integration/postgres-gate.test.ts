import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { TEST_DATABASE_URL, hasRealPostgres } from "../helpers/pg-db";

/**
 * The PostgreSQL gate (scripts/postgres-gate.ts) is the false-green guard for
 * the real-server concurrency suite. These tests pin BOTH directions:
 *
 *   - the gate refuses to pass when the proof cannot happen (no server,
 *     unreachable server, invalid URL) — these always run, even without a
 *     database, by scrubbing TEST_DATABASE_URL from the child's environment;
 *   - against a configured server the gate exits 0 — this runs only when
 *     TEST_DATABASE_URL is set (CI provides it) and skips loudly otherwise.
 *
 * Nested-execution regression: this file runs under `node --test`, so the
 * gate is always launched from inside a Node test runner with
 * NODE_TEST_CONTEXT set. Before the gate scrubbed that context from the
 * nested suite, the Grandchild runner printed no summary and exited 0,
 * producing a false green. The live case reproduces that exact environment.
 */

const ROOT = process.cwd();
const GATE_ARGS = ["--import", "tsx", "scripts/postgres-gate.ts"];
const SPAWN_TIMEOUT_MS = 300_000;

function runGate(env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, GATE_ARGS, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: SPAWN_TIMEOUT_MS,
  });
  return {
    code: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function envWithoutServer(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TEST_DATABASE_URL;
  return env;
}

test("gate without TEST_DATABASE_URL fails loudly and names the variable", () => {
  const result = runGate(envWithoutServer());
  assert.notEqual(result.code, 0);
  assert.match(result.output, /TEST_DATABASE_URL/);
});

test("gate with an invalid TEST_DATABASE_URL fails", () => {
  const result = runGate({ ...process.env, TEST_DATABASE_URL: "not-a-url" });
  assert.notEqual(result.code, 0);
});

test("gate against an unreachable server fails", () => {
  const result = runGate({
    ...process.env,
    TEST_DATABASE_URL: "postgresql://127.0.0.1:1/postgres",
  });
  assert.notEqual(result.code, 0);
});

const live = hasRealPostgres ? describe : describe.skip;
live("gate against the configured TEST_DATABASE_URL (nested execution)", () => {
  test("launched from inside node --test, executes the nested suite and passes", () => {
    // Pin the reproduction condition: without this the test could silently
    // become vacuous if the runner stops setting the variable.
    assert.ok(
      process.env.NODE_TEST_CONTEXT,
      "expected node --test to set NODE_TEST_CONTEXT (nested execution repro)"
    );
    const result = runGate({ ...process.env, TEST_DATABASE_URL: TEST_DATABASE_URL });
    assert.equal(result.code, 0, result.output);
    // The grandchild suite really executed: its summary is in the output and
    // the gate verdict line reports a full pass.
    assert.match(result.output, /ℹ pass [1-9]\d*/);
    assert.match(result.output, /\[postgres-gate\] PASS/);
  });
});
