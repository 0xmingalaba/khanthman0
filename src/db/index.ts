/**
 * Database bootstrap.
 *
 * `getDatabase()` is the only way application code obtains a Database. It is
 * cached per process. Two drivers exist:
 *
 *   DATABASE_URL set            -> node-postgres (production / staging)
 *   KHANTHMAN_DB=pglite (dev)   -> PGlite, an embedded PostgreSQL, for local
 *                                  demo use and tests. Same SQL, same
 *                                  transactions, no external service.
 *
 * The legacy `MINGALA_DB=pglite` is still accepted (see ./config.ts) so
 * existing local development setups keep working.
 *
 * Anything else is a configuration error and fails fast rather than silently
 * falling back to an in-memory database in production.
 */

import "server-only";
import type { Database } from "./executor";
import { isPgliteMode, resolvePgliteDir } from "./config";

let cached: Promise<Database> | null = null;

async function create(): Promise<Database> {
  if (process.env.DATABASE_URL) {
    const { createPgDatabase } = await import("./pg");
    return createPgDatabase();
  }

  if (isPgliteMode()) {
    const { createPgliteDatabase } = await import("./pglite");
    // MUST match the CLI default in cli.ts. Both sides resolve through
    // ./config.ts so the CLI seed and the dev server always open the same
    // file-backed directory (an earlier split seeded one store and served
    // from an empty other one, which also broke the CI smoke test).
    // resolvePgliteDir() prefers KHANTHMAN_PGLITE_DIR, falls back to the
    // legacy MINGALA_PGLITE_DIR, and discovers existing ./.data/mingala data
    // instead of silently starting an empty ./.data/khanthman database.
    return createPgliteDatabase(resolvePgliteDir());
  }

  throw new Error(
    "No database configured. Set DATABASE_URL for PostgreSQL, or KHANTHMAN_DB=pglite for local demo mode (legacy MINGALA_DB=pglite is still accepted)."
  );
}

export function getDatabase(): Promise<Database> {
  if (!cached) {
    cached = create().catch((error) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

export async function resetDatabaseCache(): Promise<void> {
  if (cached) {
    try {
      await (await cached).close();
    } catch {
      /* ignore shutdown errors */
    }
  }
  cached = null;
}
