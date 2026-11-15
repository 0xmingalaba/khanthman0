/**
 * Database CLI.
 *
 *   node --import tsx src/db/cli.ts migrate             # apply pending migrations
 *   node --import tsx src/db/cli.ts seed                # insert development sample markets
 *   node --import tsx src/db/cli.ts cleanup-idempotency # prune expired idempotency keys
 *   node --import tsx src/db/cli.ts reconcile           # verify the ledger sums to zero
 *
 * Requires DATABASE_URL (PostgreSQL) or KHANTHMAN_DB=pglite (embedded, dev
 * only). The legacy MINGALA_DB=pglite is still accepted (see ./config.ts).
 *
 * Like `next dev`, this process loads `.env` / `.env.local` / `.env.<NODE_ENV>*`
 * (see ./env-file.ts) before resolving the database, so the seed CLI and the
 * dev server can never end up opening different PGlite directories.
 *
 * `cleanup-idempotency` is intended for a scheduled job (cron / platform scheduler).
 * It is safe to run repeatedly and concurrently.
 */
import { loadEnvFiles } from "./env-file";
import { createPgliteDatabase } from "./pglite";
import { migrate } from "./migrate";
import type { Database } from "./executor";
import { seedDevelopmentData } from "./seed";
import { cleanupIdempotencyKeys } from "./idempotency-retention";
import { isPgliteMode, resolvePgliteDir } from "./config";

async function open(): Promise<Database> {
  if (process.env.DATABASE_URL) {
    // Imported lazily: the pg adapter carries a Next.js server-only guard that
    // throws outside the bundler, and the CLI is a plain Node process.
    const { createPgDatabase } = await import("./pg-runtime");
    return createPgDatabase();
  }
  if (isPgliteMode()) {
    // Same resolution as the app (src/db/index.ts): new env vars win, legacy
    // vars still work, and existing ./.data/mingala data is discovered rather
    // than silently replaced by an empty ./.data/khanthman database.
    return createPgliteDatabase(resolvePgliteDir());
  }
  throw new Error(
    "Set DATABASE_URL or KHANTHMAN_DB=pglite (legacy MINGALA_DB=pglite is still accepted)."
  );
}

async function main() {
  const command = process.argv[2];
  // Load the same .env files Next.js would, so this CLI and the dev server
  // resolve identical database configuration. Malformed files abort loudly.
  const { loaded } = loadEnvFiles();
  if (loaded.length > 0) {
    console.error(`[db-cli] loaded environment from ${loaded.join(", ")}`);
  }
  const db = await open();
  try {
    if (command === "migrate") {
      const report = await migrate(db);
      console.log(`applied: ${report.applied.join(", ") || "none"}`);
      console.log(`already applied: ${report.skipped.join(", ") || "none"}`);
    } else if (command === "seed") {
      await migrate(db);
      const result = await seedDevelopmentData(db);
      console.log(`seeded ${result.markets} markets, ${result.users} accounts`);
    } else if (command === "cleanup-idempotency") {
      const result = await cleanupIdempotencyKeys(db);
      console.log(
        `removed ${result.expired} expired keys and ${result.staleClaims} stale claims`
      );
    } else if (command === "reconcile") {
      // Prints only whether each asset balances, never the totals themselves.
      const { reconcile } = await import("@/src/domain/ledger");
      const rows = await db.transaction((tx) => reconcile(tx));
      const broken = rows.filter((row) => row.total !== 0);
      console.log(`assets checked: ${rows.length}`);
      if (broken.length === 0) {
        console.log("ledger balanced: yes");
      } else {
        console.log(`ledger balanced: NO (${broken.length} asset(s) out of balance)`);
        process.exitCode = 1;
      }
    } else {
      console.error("usage: cli.ts <migrate|seed|cleanup-idempotency|reconcile>");
      process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
