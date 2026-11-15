/**
 * Production PostgreSQL adapter (node-postgres).
 *
 * The connection string is read from the environment; nothing here ever logs the
 * value. TLS is required unless the host is explicitly a local address.
 */

import { Pool, type PoolClient } from "pg";
import {
  type Database,
  type SqlParam,
  type Transaction,
  lockKeyFor,
} from "./executor";

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and provide a PostgreSQL URL."
    );
  }
  return url;
}

function makeClient(exec: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}): {
  exec: (sql: string) => Promise<void>;
  query: <T>(sql: string, params?: SqlParam[]) => Promise<{ rows: T[]; rowCount: number }>;
  tx: () => Transaction;
} {
  return {
    async exec(sql) {
      await exec.query(sql);
    },
    async query<T>(sql: string, params: SqlParam[] = []) {
      const result = await exec.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
    },
    tx() {
      return {
        exec: async (sql) => {
          await exec.query(sql);
        },
        query: async <T>(sql: string, params: SqlParam[] = []) => {
          const result = await exec.query(sql, params);
          return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
        },
        lock: async (key: string) => {
          await exec.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockKeyFor(key)]);
        },
      };
    },
  };
}

/**
 * The process-wide pool.
 *
 * One pooled instance is correct for the application, but it makes the adapter
 * untestable in isolation and prevents a test suite from opening several
 * *independent* pools against different databases. `createPgDatabase` therefore
 * accepts an explicit connection string and an optional pool, while the default
 * (no arguments) keeps the production behaviour exactly as before.
 */
let pool: Pool | null = null;

export type PgDatabaseOptions = {
  /** Overrides DATABASE_URL for this handle only. */
  connectionString?: string;
  /** Maximum pooled connections; defaults to DATABASE_POOL_MAX or 10. */
  max?: number;
};

function makePool(options: PgDatabaseOptions = {}): Pool {
  return new Pool({
    connectionString: options.connectionString ?? connectionString(),
    max: options.max ?? Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "khanthman",
  });
}

function getPool(options?: PgDatabaseOptions): Pool {
  if (options?.connectionString) {
    // Caller-scoped pools are never cached: they belong to that handle alone.
    return makePool(options);
  }
  if (!pool) pool = makePool(options);
  return pool;
}

export function createPgDatabase(options: PgDatabaseOptions = {}): Database {
  // A caller-scoped pool is owned by this handle and closed with it, so tests can
  // create and dispose many handles in one process.
  const ownedPool: Pool | null = options.connectionString ? makePool(options) : null;
  const poolFor = (): Pool => ownedPool ?? getPool();

  const db = makeClient({
    query: async (sql, params) => {
      const result = await poolFor().query(sql, params as never[]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  });

  return {
    exec: db.exec,
    query: db.query,
    async close() {
      if (ownedPool) {
        await ownedPool.end();
        return;
      }
      if (pool) {
        await pool.end();
        pool = null;
      }
    },
    async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
      const client: PoolClient = await poolFor().connect();
      const scoped = makeClient({
        query: async (sql, params) => {
          const result = await client.query(sql, params as never[]);
          return { rows: result.rows, rowCount: result.rowCount };
        },
      });
      try {
        await client.query("BEGIN");
        const result = await fn(scoped.tx());
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* connection already broken; surface the original error */
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
