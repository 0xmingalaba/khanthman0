import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  evaluateGateOutcome,
  nestedSuiteEnv,
  parseTestSummary,
} from "@/scripts/postgres-gate-logic";

/** Fixture resembling real `node --test` spec-reporter output. */
function fixtureOutput({ tests = 18, pass = 18, fail = 0, skipped = 0, cancelled = 0 } = {}) {
  return [
    "✔ PostgreSQL row-lock contention (real server, multiple connections)",
    "✔ PostgreSQL concurrent settlement never deadlocks",
    "ℹ tests " + tests,
    "ℹ suites 5",
    "ℹ pass " + pass,
    "ℹ fail " + fail,
    "ℹ cancelled " + cancelled,
    "ℹ skipped " + skipped,
    "ℹ duration_ms 9000",
  ].join("\n");
}

describe("parseTestSummary", () => {
  test("parses the standard summary block", () => {
    const summary = parseTestSummary(fixtureOutput());
    assert.deepEqual(summary, { tests: 18, pass: 18, fail: 0, skipped: 0, cancelled: 0 });
  });

  test("returns nulls when no summary is present", () => {
    const summary = parseTestSummary("no tests ran, nothing to see\n");
    assert.deepEqual(summary, { tests: null, pass: null, fail: null, skipped: null, cancelled: null });
  });

  test("tolerates U+FFFD corruption of the info glyph from chunked decoding", () => {
    const corrupted = fixtureOutput().replaceAll("ℹ", "\uFFFD");
    const summary = parseTestSummary(corrupted);
    assert.equal(summary.tests, 18);
    assert.equal(summary.pass, 18);
  });
});

describe("evaluateGateOutcome", () => {
  test("passes when the suite ran fully and everything passed", () => {
    const outcome = evaluateGateOutcome(0, fixtureOutput());
    assert.deepEqual(outcome, { ok: true, tests: 18, pass: 18 });
  });

  test("fails on non-zero exit code", () => {
    const outcome = evaluateGateOutcome(1, fixtureOutput());
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /exited with code 1/);
  });

  test("fails when the summary is missing (e.g. grandchild swallowed output)", () => {
    const outcome = evaluateGateOutcome(0, "PostgreSQL something happened\n");
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /summary/);
  });

  test("fails when any test was skipped (whole-suite skip recreates false confidence)", () => {
    const outcome = evaluateGateOutcome(0, fixtureOutput({ tests: 18, pass: 16, skipped: 2 }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /skipped=2/);
  });

  test("fails when any test was cancelled", () => {
    const outcome = evaluateGateOutcome(0, fixtureOutput({ tests: 18, pass: 17, cancelled: 1 }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /cancelled=1/);
  });

  test("fails when the suite reports failures", () => {
    const outcome = evaluateGateOutcome(0, fixtureOutput({ fail: 1, pass: 17 }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /1 failing/);
  });

  test("fails when pass count does not equal total tests", () => {
    const outcome = evaluateGateOutcome(0, fixtureOutput({ tests: 18, pass: 17 }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /do not equal/);
  });

  test("fails when zero tests ran", () => {
    const outcome = evaluateGateOutcome(0, fixtureOutput({ tests: 0, pass: 0 }));
    assert.equal(outcome.ok, false);
  });

  test("fails when the PostgreSQL marker is missing despite a clean summary", () => {
    const generic = ["ℹ tests 1", "ℹ pass 1", "ℹ fail 0", "ℹ skipped 0"].join("\n");
    const outcome = evaluateGateOutcome(0, generic);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /marker/);
  });
});

describe("nestedSuiteEnv", () => {
  test("strips the outer Node test-runner context, preserving everything else", () => {
    const env = {
      PATH: "/usr/bin",
      NODE_ENV: "development",
      TEST_DATABASE_URL: "postgresql://127.0.0.1:5432/postgres",
      NODE_TEST_CONTEXT: "child-v8",
      NODE_TEST_COVERAGE: "1",
      NODE_V8_COVERAGE: "/tmp/coverage",
      KHANTHMAN_DB: "pglite",
    } as NodeJS.ProcessEnv;
    const scrubbed = nestedSuiteEnv(env);
    assert.equal(scrubbed.NODE_TEST_CONTEXT, undefined);
    assert.equal(scrubbed.NODE_TEST_COVERAGE, undefined);
    assert.equal(scrubbed.NODE_V8_COVERAGE, undefined);
    assert.equal(scrubbed.TEST_DATABASE_URL, "postgresql://127.0.0.1:5432/postgres");
    assert.equal(scrubbed.PATH, "/usr/bin");
    assert.equal(scrubbed.KHANTHMAN_DB, "pglite");
    // Input is not mutated.
    assert.equal(env.NODE_TEST_CONTEXT, "child-v8");
  });
});
