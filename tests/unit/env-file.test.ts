import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { effectiveNodeEnv } from "@/src/db/env-file";

/**
 * The CLI loads env files through @next/env (Next.js's official loader), which
 * keeps module-level state and mutates process.env — so every scenario here
 * runs in a fresh child process, exactly how the CLI runs. This also tests the
 * real code path end to end: wrapper + @next/env + dotenv-expand.
 *
 * Isolated temp directories only — never the repo root, never the real
 * development database.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
// ESM import specifiers cannot be raw absolute paths ("D:\\dir\\file.ts" is not
// a valid URL — es2021/ts loaders reject it as ERR_UNSUPPORTED_ESM_URL_SCHEME
// on Windows). Convert to file:/// URLs, which are valid on every platform.
const moduleSpecifier = (relativePath: string): string =>
  pathToFileURL(join(REPO_ROOT, relativePath)).href;
const CLI_PROBE = `
import { loadEnvFiles } from ${JSON.stringify(moduleSpecifier("src/db/env-file.ts"))};
import { resolvePgliteDir, isPgliteMode } from ${JSON.stringify(moduleSpecifier("src/db/config.ts"))};
const cwd = process.argv[1];
try {
  const { loaded, nodeEnv } = loadEnvFiles(cwd);
  const print = (key) => console.log("KEY:" + key + "=" + (process.env[key] ?? "<unset>"));
  console.log("NODE_ENV=" + nodeEnv);
  console.log("LOADED=" + loaded.join(","));
  for (const key of ["KHANTHMAN_DB","NODE_ENV","DATA_DIR","KHANTHMAN_PGLITE_DIR","MINGALA_PGLITE_DIR","EXPANDED","ESCAPED","DEFAULT_REF","SHARED"]) print(key);
  console.log("PGLITE_MODE=" + isPgliteMode());
  console.log("RESOLVED_DIR=" + resolvePgliteDir(process.env, cwd));
} catch (error) {
  console.error("PROBE_ERROR: " + (error instanceof Error ? error.message : String(error)));
  process.exit(3);
}
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "khanthman-envfile-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run the probe in a fresh child process against `cwd` with a scrubbed env. */
function probe(cwd: string, env: Record<string, string | undefined>) {
  // Deliberately minimal env (no KHANTHMAN_*/MINGALA_* inherited from the
  // outer shell) — `unknown` indirection because this repo's augmented
  // ProcessEnv requires NODE_ENV.
  const childEnv = { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", CLI_PROBE, cwd],
    { cwd: REPO_ROOT, env: childEnv, encoding: "utf8", timeout: 120_000 }
  );
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const get = (label: string): string | undefined => {
    const match = new RegExp(`^${label}=(.*)$`, "m").exec(out);
    return match?.[1];
  };
  const keys: Record<string, string | undefined> = {};
  for (const line of out.split("\n")) {
    const match = /^KEY:([A-Z_]+)=(.*)$/.exec(line);
    if (match) keys[match[1]] = match[2];
  }
  return { code: result.status ?? 1, out, get, keys };
}

const UNSET = "<unset>";

describe("effectiveNodeEnv", () => {
  test("explicit value wins; blank/unset default to development", () => {
    assert.equal(effectiveNodeEnv({}), "development");
    assert.equal(effectiveNodeEnv({ NODE_ENV: "" }), "development");
    assert.equal(effectiveNodeEnv({ NODE_ENV: "   " }), "development");
    assert.equal(effectiveNodeEnv({ NODE_ENV: "production" }), "production");
    assert.equal(effectiveNodeEnv({ NODE_ENV: "test" }), "test");
  });
});

describe("loadEnvFiles (child process, @next/env)", () => {
  test("no env files: nothing loaded, defaults to development, resolves fresh default", () => {
    const result = probe(dir, {});
    assert.equal(result.code, 0, result.out);
    assert.equal(result.get("NODE_ENV"), "development");
    assert.equal(result.get("LOADED") ?? "", "");
    assert.equal(result.keys.KHANTHMAN_DB, UNSET);
    assert.match(result.get("RESOLVED_DIR") ?? "", /\.data\/khanthman$/);
  });

  test("unset NODE_ENV defaults to the development environment and loads .env.development.local", async () => {
    await writeFile(join(dir, ".env.development.local"), "KHANTHMAN_DB=pglite\n", "utf8");
    const result = probe(dir, {});
    assert.equal(result.code, 0, result.out);
    assert.equal(result.get("NODE_ENV"), "development");
    assert.equal(result.get("LOADED"), ".env.development.local");
    assert.equal(result.keys.KHANTHMAN_DB, "pglite");
    assert.equal(result.get("PGLITE_MODE"), "true");
  });

  test("full precedence chain: .env < .env.development < .env.local < .env.development.local", async () => {
    await writeFile(join(dir, ".env"), "SHARED=base\n", "utf8");
    await writeFile(join(dir, ".env.development"), "SHARED=development\n", "utf8");
    await writeFile(join(dir, ".env.local"), "SHARED=local\n", "utf8");
    await writeFile(join(dir, ".env.development.local"), "SHARED=development-local\n", "utf8");
    const result = probe(dir, {});
    assert.equal(result.code, 0, result.out);
    assert.equal(result.keys.SHARED, "development-local");
  });

  test("explicit NODE_ENV=production selects production files, not development", async () => {
    await writeFile(join(dir, ".env.development"), "KHANTHMAN_DB=pglite\n", "utf8");
    await writeFile(join(dir, ".env.production"), "KHANTHMAN_DB=production-marker\n", "utf8");
    await writeFile(join(dir, ".env.production.local"), "PROD_PROBE=production-local\n", "utf8");
    const result = probe(dir, { NODE_ENV: "production" });
    assert.equal(result.code, 0, result.out);
    assert.equal(result.keys.KHANTHMAN_DB, "production-marker");
    assert.equal(result.keys.NODE_ENV, "production");
    assert.match(result.get("LOADED") ?? "", /\.env\.production\.local/);
    assert.doesNotMatch(result.get("LOADED") ?? "", /development/);
  });

  test("expands $VAR and ${VAR}, including file-defined values", async () => {
    await writeFile(
      join(dir, ".env.local"),
      ["DATA_DIR=/data/khant", "KHANTHMAN_PGLITE_DIR=$DATA_DIR/db", "EXPANDED=${DATA_DIR}/exp"].join("\n"),
      "utf8"
    );
    const result = probe(dir, {});
    assert.equal(result.code, 0, result.out);
    assert.equal(result.keys.KHANTHMAN_PGLITE_DIR, "/data/khant/db");
    assert.equal(result.keys.EXPANDED, "/data/khant/exp");
  });

  test("expansion can reference the real shell environment", async () => {
    await writeFile(join(dir, ".env.local"), "KHANTHMAN_PGLITE_DIR=$SHELL_DATA_DIR/db\n", "utf8");
    const result = probe(dir, { SHELL_DATA_DIR: "/shell/path" });
    assert.equal(result.code, 0, result.out);
    assert.equal(result.keys.KHANTHMAN_PGLITE_DIR, "/shell/path/db");
  });

  test("escaped \\$ produces a literal dollar and is not expanded", async () => {
    await writeFile(join(dir, ".env.local"), ["DATA_DIR=/data", "ESCAPED=\\$DATA_DIR"].join("\n"), "utf8");
    const result = probe(dir, {});
    assert.equal(result.code, 0, result.out);
    assert.equal(result.keys.ESCAPED, "$DATA_DIR");
  });

  test("${VAR:-default} falls back when unset, uses value when set", async () => {
    await writeFile(join(dir, ".env.local"), "DEFAULT_REF=${MISSING_VAR:-fallback-used}\n", "utf8");
    const result = probe(dir, {});
    assert.equal(result.code, 0, result.out);
    assert.equal(result.keys.DEFAULT_REF, "fallback-used");
  });

  test("real shell environment wins over every file", async () => {
    await writeFile(join(dir, ".env.development.local"), "KHANTHMAN_PGLITE_DIR=/from-file\n", "utf8");
    const result = probe(dir, { KHANTHMAN_PGLITE_DIR: "/from-shell" });
    assert.equal(result.code, 0, result.out);
    assert.equal(result.keys.KHANTHMAN_PGLITE_DIR, "/from-shell");
    assert.equal(result.get("RESOLVED_DIR"), "/from-shell");
  });

  test("blank values in files count as unset for the database resolver", async () => {
    await writeFile(join(dir, ".env.local"), "KHANTHMAN_DB=\n", "utf8");
    const result = probe(dir, {});
    assert.equal(result.code, 0, result.out);
    assert.equal(result.keys.KHANTHMAN_DB, "");
    assert.equal(result.get("PGLITE_MODE"), "false");
  });

  test("CLI and Next resolve the same directory: legacy MINGALA_PGLITE_DIR pinned in .env.local", async () => {
    await mkdir(join(dir, ".data", "mingala"), { recursive: true });
    await writeFile(join(dir, ".data", "mingala", "PG_VERSION"), "16", "utf8");
    await writeFile(join(dir, ".env.local"), "MINGALA_PGLITE_DIR=/data/legacy-pinned\n", "utf8");
    const result = probe(dir, {});
    assert.equal(result.code, 0, result.out);
    assert.equal(result.get("RESOLVED_DIR"), "/data/legacy-pinned");
  });

  test("CLI and Next resolve the same directory: KHANTHMAN_PGLITE_DIR wins over legacy", async () => {
    await writeFile(
      join(dir, ".env.local"),
      "KHANTHMAN_PGLITE_DIR=/data/new-pinned\nMINGALA_PGLITE_DIR=/data/legacy-pinned\n",
      "utf8"
    );
    const result = probe(dir, {});
    assert.equal(result.code, 0, result.out);
    assert.equal(result.get("RESOLVED_DIR"), "/data/new-pinned");
  });

  test("CLI and Next resolve the same directory: all-blank template + legacy data on disk", async () => {
    await mkdir(join(dir, ".data", "mingala"), { recursive: true });
    await writeFile(join(dir, ".data", "mingala", "PG_VERSION"), "16", "utf8");
    await writeFile(
      join(dir, ".env.local"),
      ["KHANTHMAN_DB=", "KHANTHMAN_PGLITE_DIR=", "MINGALA_DB=", "MINGALA_PGLITE_DIR="].join("\n"),
      "utf8"
    );
    const result = probe(dir, {});
    assert.equal(result.code, 0, result.out);
    assert.match(result.get("RESOLVED_DIR") ?? "", /\.data\/mingala$/);
  });
});
