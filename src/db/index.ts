/**
 * Database bootstrap.
 *
 * `getDatabase()` is the only way application code obtains a Database. It is
 * cached per process. Two drivers exist:
 *
 *   DATABASE_URL set          -> node-postgres (production / staging)
 *   MINGALA_DB=pglite (dev)   -> PGlite, an embedded PostgreSQL, for local demo
 *                                use and tests. Same SQL, same transactions,
 *                                no external service.
 *
 * Anything else is a configuration error and fails fast rather than silently
 * falling back to an in-memory database in production.
 */

import "server-only";
import type { Database } from "./executor";

let cached: Promise<Database> | null = null;

async function create(): Promise<Database> {
  if (process.env.DATABASE_URL) {
    const { createPgDatabase } = await import("./pg");
    return createPgDatabase();
  }

  if (process.env.MINGALA_DB === "pglite") {
    const { createPgliteDatabase } = await import("./pglite");
    // MUST match the CLI default in cli.ts. The CLI seeds a FILE-BACKED database at
    // ./.data/mingala, while this defaulted to an in-memory instance, so `npm run
    // dev:pglite` (seed, then dev) seeded one store and served from an empty other one.
    // The same split broke the CI smoke test. .env.example documents ./.data/mingala as
    // the default, which is what both sides now use.
    return createPgliteDatabase(process.env.MINGALA_PGLITE_DIR || "./.data/mingala");
  }

  throw new Error(
    "No database configured. Set DATABASE_URL for PostgreSQL, or MINGALA_DB=pglite for local demo mode."
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
