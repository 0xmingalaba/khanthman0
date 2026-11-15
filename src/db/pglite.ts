/**
 * PGlite adapter — PostgreSQL in WASM.
 *
 * Used by tests and by the optional local demo server. It executes the same
 * migration SQL and the same domain queries as production, so an integration
 * test here is a genuine Postgres transaction test.
 */

import { mkdir } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import {
  type Database,
  type SqlParam,
  type Transaction,
  lockKeyFor,
} from "./executor";

type Raw = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec: (sql: string) => Promise<unknown>;
};

export async function createPgliteDatabase(dataDir?: string): Promise<Database> {
  // PGlite creates its data directory but not missing PARENTS, so a fresh checkout
  // without `.data/` failed with ENOENT before it could do anything. Creating the path
  // recursively here fixes every caller at once, including `npm run dev:pglite` and the
  // CI smoke test, which resolve through ./config.ts (default ./.data/khanthman,
  // with existing ./.data/mingala data discovered for backward compatibility).
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const instance = dataDir ? new PGlite(dataDir) : new PGlite();
  await instance.waitReady;
  const raw = instance as unknown as Raw;

  const scoped = (runner: Raw) => ({
    async exec(sql: string) {
      await runner.exec(sql);
    },
    async query<T>(sql: string, params: SqlParam[] = []) {
      const result = await runner.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.affectedRows ?? result.rows.length };
    },
  });

  const base = scoped(raw);
  // PGlite runs a single logical connection, so transactions are serialised.
  let queue: Promise<unknown> = Promise.resolve();

  const txApi: Transaction = {
    exec: base.exec,
    query: base.query,
    async lock(key: string) {
      // PGlite serialises transactions already; keep the advisory lock for parity
      // with production so the same code path is exercised.
      await raw.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockKeyFor(key)]);
    },
  };

  return {
    exec: base.exec,
    query: base.query,
    async close() {
      await instance.close();
    },
    transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        await raw.exec("BEGIN");
        try {
          const result = await fn(txApi);
          await raw.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            await raw.exec("ROLLBACK");
          } catch {
            /* ignore: surface the original error */
          }
          throw error;
        }
      };
      const next = queue.then(run, run);
      queue = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    },
  };
}
