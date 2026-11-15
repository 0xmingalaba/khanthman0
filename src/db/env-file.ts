/**
 * .env loading for the plain-Node database CLI — delegates to Next.js's
 * official loader (`@next/env`), the exact implementation `next dev` uses,
 * instead of maintaining a partial custom parser.
 *
 * Why this exists: the seed/migrate CLI runs as a plain Node process and sees
 * only the real environment, while `next dev` loads `.env*` files. Without
 * this module the two could resolve DIFFERENT PGlite directories (e.g.
 * `.env.local` pins `KHANTHMAN_PGLITE_DIR` for Next while the CLI discovers a
 * legacy `./.data/mingala`) — the seed would write to one database and the
 * dev server open another, and existing data would appear to be gone.
 *
 * Semantics are @next/env's, i.e. exactly Next.js's:
 *   - file selection follows NODE_ENV: `.env.<env>.local` > `.env.local` >
 *     `.env.<env>` > `.env` for development/production, and `.env.test.local`
 *     > `.env.test` > `.env` for test (test skips `.env.local`, like Next);
 *   - when NODE_ENV is unset or blank the CLI defaults to the DEVELOPMENT
 *     environment — matching `next dev`, which always forces development;
 *     set NODE_ENV=production explicitly for production file selection;
 *   - the real shell environment wins over every file;
 *   - `$VAR` / `${VAR}` references expand (with `\$` for a literal dollar),
 *     and `${VAR:-default}` provides a fallback.
 *
 * Read failures are fail-loud rather than Next's log-and-continue: the error
 * is rethrown, so the CLI never proceeds against a silently mis-resolved
 * configuration. (Missing files are not errors, exactly as in Next.)
 *
 * This module is imported ONLY by the CLI and by tests; the Next.js app loads
 * env files through Next itself. Note: @next/env caches per process, so this
 * is intended for a single call at process startup.
 */

import { loadEnvConfig } from "@next/env";

export type LoadEnvResult = {
  /** NODE_ENV actually applied (defaults to "development" when unset/blank). */
  nodeEnv: string;
  /** Env files that existed and were applied, in Next's load order. */
  loaded: string[];
};

/** The effective NODE_ENV: an explicit value wins; otherwise "development". */
export function effectiveNodeEnv(env: Record<string, string | undefined> = process.env): string {
  return (env.NODE_ENV ?? "").trim() || "development";
}

export function loadEnvFiles(cwd: string = process.cwd()): LoadEnvResult {
  const nodeEnv = effectiveNodeEnv();
  if (!process.env.NODE_ENV?.trim()) {
    // Normalize so downstream code sees the same effective environment the
    // loader used (mirrors `next dev` forcing NODE_ENV=development).
    // Object.assign bypasses the augmented read-only NODE_ENV typing.
    Object.assign(process.env, { NODE_ENV: nodeEnv });
  }

  const loadErrors: string[] = [];
  const logger = {
    info: () => undefined,
    error: (...args: unknown[]) => {
      loadErrors.push(args.map(String).join(" "));
    },
  };

  const dev = nodeEnv === "development";
  const { loadedEnvFiles } = loadEnvConfig(cwd, dev, logger);

  if (loadErrors.length > 0) {
    throw new Error(
      `[env-file] failed to load environment files in ${cwd}: ${loadErrors.join("; ")}`
    );
  }

  return { nodeEnv, loaded: loadedEnvFiles.map((file) => file.path) };
}
