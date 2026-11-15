/**
 * Database configuration resolution with backward compatibility.
 *
 * The product was previously branded "Mingala" and used the environment
 * variables `MINGALA_DB` / `MINGALA_PGLITE_DIR` with a default PGlite data
 * directory of `./.data/mingala`. Those names are deprecated but MUST keep
 * working so existing local development data is never abandoned:
 *
 *   1. `KHANTHMAN_DB` takes precedence over `MINGALA_DB`.
 *   2. `KHANTHMAN_PGLITE_DIR` takes precedence over `MINGALA_PGLITE_DIR`.
 *   3. When the new variables are unset, the legacy variables apply.
 *   4. When no directory variable is set, an existing `./.data/mingala`
 *      directory that already holds data is discovered and used instead of
 *      silently starting an empty `./.data/khanthman` database.
 *   5. Existing data is never moved, copied, or deleted by this module; the
 *      resolved directory is opened in place.
 *
 * This module intentionally does NOT import `server-only` so the plain-Node
 * database CLI (`src/db/cli.ts`) can use the same resolution as the app.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Current environment variables. */
export const NEW_DB_ENV = "KHANTHMAN_DB";
export const NEW_PGLITE_DIR_ENV = "KHANTHMAN_PGLITE_DIR";

/**
 * Deprecated legacy environment variables. Still honoured when the new
 * variables are unset. Do not remove until all deployments have migrated.
 */
export const LEGACY_DB_ENV = "MINGALA_DB";
export const LEGACY_PGLITE_DIR_ENV = "MINGALA_PGLITE_DIR";

/** Default PGlite data directory for fresh installs. */
export const DEFAULT_PGLITE_DIR = "./.data/khanthman";
/** Legacy default PGlite data directory. Discovered when it holds data. */
export const LEGACY_PGLITE_DIR = "./.data/mingala";

type Env = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/**
 * True when PGlite (embedded, dev-only) mode is selected.
 *
 * `KHANTHMAN_DB` wins when set; otherwise the deprecated `MINGALA_DB`
 * applies. Empty strings count as unset (`.env.example` ships them blank).
 */
export function isPgliteMode(env: Env = process.env): boolean {
  const mode = nonEmpty(env[NEW_DB_ENV]) ?? nonEmpty(env[LEGACY_DB_ENV]);
  return mode === "pglite";
}

function dirHasEntries(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the PGlite data directory.
 *
 * Precedence:
 *   1. `KHANTHMAN_PGLITE_DIR` (explicit, returned as-is)
 *   2. `MINGALA_PGLITE_DIR` (deprecated legacy, returned as-is)
 *   3. `./.data/khanthman` when it already holds data
 *   4. `./.data/mingala` when it holds data and the new directory does not
 *      (existing local data is never silently abandoned for an empty DB)
 *   5. `./.data/khanthman` for fresh installs
 *
 * `baseDir` exists for tests so they can point discovery at an isolated
 * temporary directory instead of the real development database.
 */
export function resolvePgliteDir(
  env: Env = process.env,
  baseDir: string = process.cwd()
): string {
  const explicit =
    nonEmpty(env[NEW_PGLITE_DIR_ENV]) ?? nonEmpty(env[LEGACY_PGLITE_DIR_ENV]);
  if (explicit) return explicit;

  const newDir = join(baseDir, ".data", "khanthman");
  const legacyDir = join(baseDir, ".data", "mingala");
  const newHasData = dirHasEntries(newDir);
  const legacyHasData = dirHasEntries(legacyDir);

  if (newHasData) {
    if (legacyHasData) {
      console.warn(
        "[db-config] Both ./.data/khanthman and ./.data/mingala hold data; " +
          "using ./.data/khanthman. Set KHANTHMAN_PGLITE_DIR to choose explicitly."
      );
    }
    return newDir;
  }

  if (legacyHasData) {
    console.warn(
      "[db-config] Using legacy PGlite data directory ./.data/mingala. " +
        "Set KHANTHMAN_PGLITE_DIR to migrate to ./.data/khanthman."
    );
    return legacyDir;
  }

  return newDir;
}
