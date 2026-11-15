/**
 * Pure decision logic for the PostgreSQL concurrency gate
 * (scripts/postgres-gate.ts). No I/O, no process.env access, no side effects
 * on import — the script wires this to real spawn/connect calls, and tests
 * exercise every branch directly.
 */

export const MIN_TESTS = 1;

/** The suite's describe blocks all carry PostgreSQL in their names. */
export const SUITE_MARKER = /PostgreSQL/;

export interface GateOutcome {
  ok: boolean;
  tests?: number;
  pass?: number;
  reason?: string;
}

export interface TestSummary {
  tests: number | null;
  pass: number | null;
  fail: number | null;
  skipped: number | null;
  cancelled: number | null;
}

/** Parse the trailing `node --test` spec-reporter summary into counts. */
export function parseTestSummary(output: string): TestSummary {
  const counts: Record<string, number> = {};
  const pattern = /(?:^|\n)[^\w\r\n]*(tests|pass|fail|skipped|cancelled|todo)\s+(\d+)\s*(?:\r?\n|$)/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    counts[match[1].toLowerCase()] = Number.parseInt(match[2], 10);
  }
  return {
    tests: counts.tests ?? null,
    pass: counts.pass ?? null,
    fail: counts.fail ?? null,
    skipped: counts.skipped ?? null,
    cancelled: counts.cancelled ?? null,
  };
}

/**
 * Verdict over a completed suite run. A pass requires ALL of:
 *   - the child exited 0;
 *   - a parseable node --test summary is present;
 *   - nothing was skipped or cancelled (a whole-suite skip is a failure);
 *   - no failing tests;
 *   - at least MIN_TESTS ran and every one passed (pass === tests);
 *   - the PostgreSQL suite marker appears in the output.
 */
export function evaluateGateOutcome(exitCode: number | null, output: string): GateOutcome {
  if (exitCode !== 0) {
    return { ok: false, reason: `concurrency suite exited with code ${exitCode ?? "unknown"}` };
  }
  const summary = parseTestSummary(output);
  if (summary.tests === null || summary.pass === null) {
    return {
      ok: false,
      reason: "could not find the node --test summary in the suite output; refusing to guess",
    };
  }
  const skipped = summary.skipped ?? 0;
  const cancelled = summary.cancelled ?? 0;
  if (skipped > 0 || cancelled > 0) {
    return {
      ok: false,
      reason: `the suite did not fully run (skipped=${skipped}, cancelled=${cancelled})`,
    };
  }
  if ((summary.fail ?? 0) > 0) {
    return { ok: false, reason: `the suite reported ${summary.fail} failing test(s)` };
  }
  if (summary.tests < MIN_TESTS) {
    return { ok: false, reason: `expected at least ${MIN_TESTS} test(s), observed ${summary.tests}` };
  }
  if (summary.pass !== summary.tests) {
    return {
      ok: false,
      reason: `passing tests (${summary.pass}) do not equal total tests (${summary.tests})`,
    };
  }
  if (!SUITE_MARKER.test(output)) {
    return {
      ok: false,
      reason: "suite marker missing from output; the PostgreSQL suite did not appear to run",
    };
  }
  return { ok: true, tests: summary.tests, pass: summary.pass };
}

/**
 * Environment for the nested suite process: identical to ours minus the
 * Node test-runner context. When this gate itself runs inside `node --test`
 * (nested in CI or in tests), the inherited NODE_TEST_CONTEXT/NODE_V8_COVERAGE
 * make the grandchild runner believe it is a coverage child of an outer
 * runner — it then prints nothing and reports success, producing exactly the
 * false green this gate exists to prevent. CI runs the suite from a clean
 * shell, so the gate strips those variables to reproduce that clean run while
 * preserving everything else (notably TEST_DATABASE_URL).
 */
export function nestedSuiteEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = { ...env };
  for (const key of Object.keys(scrubbed)) {
    if (key.startsWith("NODE_TEST_") || key.startsWith("NODE_V8_COVERAGE")) {
      delete scrubbed[key];
    }
  }
  return scrubbed;
}
