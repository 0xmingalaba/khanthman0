/**
 * .env file loading for the plain-Node database CLI.
 *
 * Why this exists: Next.js loads `.env*` files into `process.env` for the app,
 * but `node --import tsx src/db/cli.ts` (the seed/migrate CLI) is a plain Node
 * process and sees only the real environment. Without this module the CLI and
 * `next dev` could resolve DIFFERENT PGlite directories — e.g. `.env.local`
 * pins `KHANTHMAN_PGLITE_DIR` for Next while the CLI discovers an existing
 * legacy `./.data/mingala` — so the seed writes to one database and the dev
 * server opens another, and existing data appears to have vanished.
 *
 * This module loads the same files Next.js loads for a given NODE_ENV, in the
 * same precedence (lowest to highest, later wins):
 *
 *   .env  <  .env.<NODE_ENV>  <  .env.local  <  .env.<NODE_ENV>.local
 *
 * …and never overrides a variable that is already set in the real environment
 * (shell exports always win, exactly like Next). Blank values (`KEY=`) are
 * preserved as empty strings and are treated as unset by `./config.ts`.
 *
 * Only environment-variable syntax `KEY=value` (optionally with surrounding
 * quotes, `export` prefix and `#` comments) is supported — the subset this
 * repository's env files use. A malformed line is a hard error rather than a
 * silently mis-seeded database. This module is imported ONLY by the CLI and
 * by tests; the Next.js app loads env files through Next itself.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type LoadEnvResult = {
  /** Env files that existed and were applied, in application order. */
  loaded: string[];
};

export type ParsedEnvLine = [key: string, value: string];

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse one env file. Throws with file and line number on malformed input. */
export function parseEnvFile(content: string, file = "<env>"): ParsedEnvLine[] {
  const result: ParsedEnvLine[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw || raw.startsWith("#")) continue;

    const eq = raw.indexOf("=");
    if (eq === -1) {
      throw new Error(`[env-file] ${file}:${index + 1} expected KEY=value, got: ${raw}`);
    }

    let key = raw.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (!KEY_PATTERN.test(key)) {
      throw new Error(`[env-file] ${file}:${index + 1} invalid variable name: ${key}`);
    }

    let value = raw.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if (first === '"' && last === '"') {
        value = value
          .slice(1, -1)
          .replace(/\\n/g, "\n")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      } else if (first === "'" && last === "'") {
        value = value.slice(1, -1);
      }
    }
    result.push([key, value]);
  }
  return result;
}

/**
 * Apply the env-file chain to `env` (defaults to `process.env`).
 *
 * `nodeEnv` selects the environment-specific files; when it is unset/empty
 * only `.env` and `.env.local` are considered, mirroring Next.js behaviour
 * for an unknown lifecycle. The variable that is already set in the real
 * environment is never overridden; file-vs-file precedence still applies.
 */
export function loadEnvFiles(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  nodeEnv: string | undefined = env.NODE_ENV
): LoadEnvResult {
  const environment = (nodeEnv ?? "").trim();
  const candidates = [".env"];
  if (environment) candidates.push(`.env.${environment}`);
  candidates.push(".env.local");
  if (environment) candidates.push(`.env.${environment}.local`);

  // Keys that exist before any file is applied come from the real shell and
  // are never overridden — same rule as Next.js.
  const realKeys = new Set(Object.keys(env));

  const loaded: string[] = [];
  for (const name of candidates) {
    const path = join(cwd, name);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`[env-file] cannot read ${path}: ${(error as Error).message}`);
    }
    for (const [key, value] of parseEnvFile(content, path)) {
      if (realKeys.has(key)) continue;
      env[key] = value;
    }
    loaded.push(name);
  }
  return { loaded };
}
