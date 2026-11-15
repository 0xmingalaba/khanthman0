/**
 * Real-PostgreSQL test harness.
 *
 * WHY THIS EXISTS SEPARATELY FROM tests/helpers/db.ts
 *
 * The PGlite harness is a single in-process connection that serialises every
 * transaction through a promise queue (see src/db/pglite.ts). That makes it a
 * faithful test of *SQL semantics* but a useless test of *concurrency*: two
 * "simultaneous" transactions there never overlap, so no row lock is ever contended
 * and no deadlock or lost update can occur.
 *
 * Row-lock correctness can only be demonstrated on a server with several real
 * connections. This helper connects the unchanged production adapter
 * (`createPgDatabase`, node-postgres) to a real PostgreSQL instance and gives each
 * test a **swept database**, so tests can run in one process without interfering.
 *
 * The environment variable `TEST_DATABASE_URL` must point at a PostgreSQL server
 * the test run is allowed to create and drop databases on, e.g.
 *
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres
 *
 * When it is unset, the suite skips loudly rather than pretending to pass. Skipping
 * is deliberate: a green run that silently omitted the concurrency proof would
 * recreate exactly the false confidence this correction phase exists to remove.
 */

import { Client } from "pg";
import type { Database } from "@/src/db/executor";
import { createPgDatabase } from "@/src/db/pg-runtime";
import { migrate } from "@/src/db/migrate";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

/** True when a real server is available; suites use this to skip honestly. */
export const hasRealPostgres = TEST_DATABASE_URL.length > 0;

/** URL of the server itself (not a specific database), used for CREATE/DROP. */
function adminUrl(): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = "/postgres";
  return url.toString();
}

/** Build a URL for one specific database on the same server. */
function withDatabase(name: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

let counter = 0;

/** Globally unique, lowercase, valid identifier. */
export function uniqueDatabaseName(prefix = "khanthman_test"): string {
  counter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${process.pid}_${counter}_${random}`.toLowerCase();
}

async function adminQuery(sql: string, params: unknown[] = []): Promise<void> {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}

/** Backends currently attached to one database (excluding the caller). */
async function backendCount(databaseName: string): Promise<number> {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    const result = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName]
    );
    return result.rows[0].n;
  } finally {
    await client.end();
  }
}

/**
 * Drop a test database safely.
 *
 * `pool.end()` resolves once idle clients are closed, but a client that is still
 * checked out can remain connected for a moment longer. Dropping (or FORCE-dropping)
 * while such a backend lives makes its in-flight query fail with "terminating
 * connection due to administrator command", which node:test reports as asynchronous
 * activity *after* the test ended — an intermittent, misleading failure.
 *
 * So: wait for the backend count to reach zero, then drop. FORCE remains as a last
 * resort for a genuinely wedged connection, after which failure is not fatal to the
 * run because the schema is already disposable.
 */
async function dropDatabaseWithRetry(name: string): Promise<void> {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      if ((await backendCount(name)) === 0) {
        await adminQuery(`DROP DATABASE IF EXISTS ${name}`);
        return;
      }
    } catch {
      // The database may already be gone, or the server briefly unavailable.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // Last resort: force it. Cleanup must never turn a passing suite into a failure,
  // so a genuinely wedged backend is logged and ignored rather than thrown.
  try {
    await adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } catch {
    /* server unavailable; the database is disposable by construction */
  }
}

export type PgTestContext = {
  /** App-level database handle backed by one pg Pool. */
  db: Database;
  /** Connection string for this test's database, for creating more handles. */
  url: string;
  /** Close this handle and drop the database. */
  close: () => Promise<void>;
};

/**
 * Create a fresh database, migrate it with the real runner, and return a handle.
 *
 * A new database per test (rather than a schema or a transaction) means a test can
 * open as many independent pools as it likes and still observe real commit
 * visibility between them.
 */
export async function createPgTestDb(): Promise<PgTestContext> {
  if (!hasRealPostgres) {
    throw new Error("TEST_DATABASE_URL is not set; real-Postgres tests cannot run.");
  }

  const name = uniqueDatabaseName();
  await adminQuery(`CREATE DATABASE ${name}`);

  const url = withDatabase(name);
  // The production adapter reads DATABASE_URL lazily but only once per process, so
  // a per-test URL is passed explicitly instead of mutating shared state.
  const db = createPgDatabase({ connectionString: url });
  await migrate(db);

  let closed = false;
  return {
    db,
    url,
    async close() {
      if (closed) return;
      closed = true;
      // Order matters: end this handle's pool FIRST, then drop. Dropping first makes
      // any still-pooled connection fail with "terminating connection due to
      // administrator command", which surfaces as asynchronous noise in the test
      // runner (and once caused a spurious failure).
      await db.close();
      await dropDatabaseWithRetry(name);
    },
  };
}

/**
 * Terminate every backend connected to `url`'s database except the caller's own.
 * Used by tests that prove a waiter is genuinely blocked on a row lock.
 */
export async function activeBackendsFor(url: string): Promise<number> {
  const name = new URL(url).pathname.replace(/^\//, "");
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name]
    );
    return result.rows[0].n;
  } finally {
    await client.end();
  }
}

/** Sleep helper for lock-contention timing assertions. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
