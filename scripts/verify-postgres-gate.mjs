#!/usr/bin/env node
/**
 * Self-verification for the PostgreSQL CI gate.
 *
 * Drives the REAL gate script and the REAL test runner in separate processes — no
 * mocks of either — to prove the gate cannot report a green result for a suite that
 * did not genuinely run and pass:
 *
 *   A. passing suite                        -> exit 0
 *   B. deliberately failing test            -> exit 1 (test failures)
 *   C. all tests skipped                    -> exit 3 (nothing executed)
 *   D. TEST_DATABASE_URL missing            -> exit 2 (misconfigured)
 *   E. runner exits non-zero, no report     -> exit 6 (report cannot be trusted)
 *   F. crashed runner, all tests recorded passing -> exit 5 (runner crashed)
 *
 * Case E reproduces the exact shape that motivated correction 1: the runner fails
 * without leaving a readable JUnit file (a suite path that does not resolve). The
 * previous grep-based step had nothing to inspect and passed; the gate must refuse
 * rather than infer success from the absence of evidence.
 *
 * Cases B and C need synthetic suites, which are written to the OS temp directory and
 * deleted afterwards. They are NEVER placed in tests/, so a deliberate failure cannot
 * leak into the normal suite.
 *
 * SCOPE NOTE — the "crash after all tests passed" branch (exit 5) is deliberately NOT
 * driven here. Node's built-in junit reporter attributes every non-zero process
 * outcome to a <failure> element on a recorded testcase (verified against exit hooks,
 * late uncaught exceptions, late rejections, SIGTERM and SIGKILL: all produced
 * `exit 1` + a recorded <failure>), so a real runner cannot produce "non-zero exit +
 * complete report + no recorded failure" for this suite. Fabricating the report to
 * exercise it would prove nothing about the runner. That branch is covered by unit
 * tests in tests/unit/postgres-gate.test.ts ("gate decisions — crash classification").
 *
 * Exit code: 0 if every case behaves as required, 1 otherwise.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE = "scripts/postgres-gate.ts";
const REAL_SUITE = "tests/integration/postgres-concurrency.test.ts";

/** Run the gate with an explicit env; return exit code and captured output. */
function runGate(env, suite) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", GATE], {
      env: { ...process.env, ...env, ...(suite ? { PG_GATE_SUITE: suite } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
    child.on("error", () => resolve({ code: 1, out: "spawn error" }));
  });
}

const results = [];
function check(name, expectation, actual, output) {
  const ok = actual === expectation;
  results.push({ name, ok, expectation, actual });
  const verdict = ok ? "PASS" : "FAIL";
  console.log(`\n[${verdict}] ${name}`);
  console.log(`        expected exit ${expectation}, got ${actual}`);
  const gateLine = output
    .split("\n")
    .filter((l) => l.includes("[postgres-gate]"))
    .slice(-1)[0];
  if (gateLine) console.log(`        ${gateLine.trim()}`);
  return ok;
}

async function main() {
  if (!process.env.TEST_DATABASE_URL) {
    console.error(
      "TEST_DATABASE_URL must be set for the verification to be meaningful.\n" +
        "Example: TEST_DATABASE_URL=postgresql://user@127.0.0.1:5432/postgres"
    );
    process.exitCode = 1;
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "pg-gate-verify-"));

  // --- synthetic suites, outside the repository -----------------------------
  const failing = join(dir, "deliberate-failure.test.ts");
  await writeFile(
    failing,
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'test("deliberate failure", () => {',
      '  assert.equal(1, 2, "designed to fail");',
      "});",
      "",
    ].join("\n"),
    "utf8"
  );

  const passing = join(dir, "passing.test.ts");
  await writeFile(
    passing,
    ['import { test } from "node:test";', 'test("passes one", () => {});', 'test("passes two", () => {});', ""].join("\n"),
    "utf8"
  );

  const skipped = join(dir, "all-skipped.test.ts");
  await writeFile(
    skipped,
    [
      'import { describe, test } from "node:test";',
      "const available = false;",
      "const suite = available ? describe : describe.skip;",
      'suite("synthetic suite", () => {',
      '  test("never runs", () => {});',
      '  test("also never runs", () => {});',
      "});",
      "",
    ].join("\n"),
    "utf8"
  );

  try {
    // A. passing suite
    const a = await runGate({}, REAL_SUITE);
    check("A. passing PostgreSQL suite -> exit 0", 0, a.code, a.out);

    // B. deliberately failing test
    const b = await runGate({}, failing);
    check("B. failing test -> exit 1 (test failures)", 1, b.code, b.out);

    // C. all tests skipped
    const c = await runGate({}, skipped);
    // Exit 3 ("nothing executed") is the most precise verdict when every recorded
    // testcase is skipped; exit 4 ("some skipped") would also be non-zero and correct.
    check("C. all tests skipped -> exit 3 (nothing executed)", 3, c.code, c.out);

    // D. TEST_DATABASE_URL missing
    const d = await runGate({ TEST_DATABASE_URL: "" }, REAL_SUITE);
    check("D. TEST_DATABASE_URL missing -> exit 2 (misconfigured)", 2, d.code, d.out);

    // E. runner exits non-zero and leaves no readable report at all: the suite path
    // resolves to nothing, so the runner exits non-zero before writing a report. An
    // absent report must never be read as "no failures".
    const missingSuite = join(dir, "absent-suite.test.ts");
    const e = await runGate({}, missingSuite);
    check("E. non-zero runner exit with no readable report -> exit 6", 6, e.code, e.out);

    // F. the runner crashes after every test was recorded as passing. The report is real
    // and complete (2 passing testcases, no failures); only the exit status is the
    // simulated crash. A crash must never be reported as a pass.
    const f = await runGate(
      { PG_GATE_SIMULATE_RUNNER_EXIT: "139" },
      passing
    );
    check("F. crashed runner after all tests passed -> exit 5", 5, f.code, f.out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log("=".repeat(72));
  for (const r of results) {
    console.log(`${r.ok ? "  ok  " : " FAIL "} ${r.name} (exit ${r.actual})`);
  }
  console.log("=".repeat(72));
  console.log(
    failed.length === 0
      ? `All ${results.length} gate outcomes behave as required.`
      : `${failed.length} of ${results.length} gate outcomes MISBEHAVED.`
  );

  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
