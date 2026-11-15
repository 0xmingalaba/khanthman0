import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { loadEnvFiles, parseEnvFile } from "@/src/db/env-file";
import { isPgliteMode, resolvePgliteDir } from "@/src/db/config";

/**
 * The seed CLI runs as plain Node and Next.js loads its own env files; the
 * two MUST resolve the same database. These tests pin the shared loading
 * semantics (.env < .env.<NODE_ENV> < .env.local < .env.<NODE_ENV>.local,
 * real shell environment always wins) and the composition with the database
 * resolver. Isolated temp directories only — never the repo root, never the
 * real development database.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "khanthman-envfile-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function freshEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "development", ...extra } as NodeJS.ProcessEnv;
}

describe("parseEnvFile", () => {
  test("parses comments, blank lines, quotes, export prefix and = in values", () => {
    const parsed = parseEnvFile(
      [
        "# comment",
        "",
        "KHANTHMAN_DB=pglite",
        "export MINGALA_DB=old # not stripped: inline comments are kept",
        'QUOTED="a=b"',
        "SINGLE='c d'",
        "EMPTY=",
      ].join("\n"),
      "test.env"
    );
    const map = new Map(parsed);
    assert.equal(map.get("KHANTHMAN_DB"), "pglite");
    assert.equal(map.get("QUOTED"), "a=b");
    assert.equal(map.get("SINGLE"), "c d");
    assert.equal(map.get("EMPTY"), "");
  });

  test("throws with file and line number on malformed input", () => {
    assert.throws(() => parseEnvFile("NOT_A_LINE", "bad.env"), /bad\.env:1/);
    assert.throws(() => parseEnvFile("1BAD=x", "bad.env"), /bad\.env:1/);
  });
});

describe("loadEnvFiles", () => {
  test("no-op when no env files exist", () => {
    const env = freshEnv();
    const { loaded } = loadEnvFiles(dir, env, "development");
    assert.deepEqual(loaded, []);
    assert.equal(env.KHANTHMAN_DB, undefined);
  });

  test(".env.local wins over .env for the same key", async () => {
    await writeFile(join(dir, ".env"), "SHARED=from-env\nONLY_ENV=yes\n", "utf8");
    await writeFile(join(dir, ".env.local"), "SHARED=from-local\n", "utf8");
    const env = freshEnv();
    const { loaded } = loadEnvFiles(dir, env, "development");
    assert.deepEqual(loaded, [".env", ".env.local"]);
    assert.equal(env.SHARED, "from-local");
    assert.equal(env.ONLY_ENV, "yes");
  });

  test(".env.development.local wins over .env.local, which wins over .env.development", async () => {
    await writeFile(join(dir, ".env"), "CHAIN=base\n", "utf8");
    await writeFile(join(dir, ".env.development"), "CHAIN=development\n", "utf8");
    await writeFile(join(dir, ".env.local"), "CHAIN=local\n", "utf8");
    await writeFile(join(dir, ".env.development.local"), "CHAIN=development-local\n", "utf8");
    const env = freshEnv();
    const { loaded } = loadEnvFiles(dir, env, "development");
    assert.deepEqual(loaded, [".env", ".env.development", ".env.local", ".env.development.local"]);
    assert.equal(env.CHAIN, "development-local");
  });

  test("real shell environment is never overridden by any file", async () => {
    await writeFile(
      join(dir, ".env.development.local"),
      "KHANTHMAN_PGLITE_DIR=/tmp/from-file\n",
      "utf8"
    );
    const env = freshEnv({ KHANTHMAN_PGLITE_DIR: "/tmp/from-shell" });
    loadEnvFiles(dir, env, "development");
    assert.equal(env.KHANTHMAN_PGLITE_DIR, "/tmp/from-shell");
  });

  test("blank values in files count as unset for the database resolver", async () => {
    await writeFile(join(dir, ".env.local"), "KHANTHMAN_DB=\n", "utf8");
    const env = freshEnv();
    loadEnvFiles(dir, env, "development");
    assert.equal(env.KHANTHMAN_DB, "");
    assert.equal(isPgliteMode(env), false);
  });

  test("malformed files abort loudly instead of seeding the wrong database", async () => {
    await writeFile(join(dir, ".env.local"), "THIS IS NOT A KEY VALUE PAIR", "utf8");
    assert.throws(() => loadEnvFiles(dir, freshEnv(), "development"), /\.env\.local:1/);
  });
});

describe("CLI and Next.js dev server resolve the same database", () => {
  test("legacy MINGALA_PGLITE_DIR pinned in .env.local is honored identically", async () => {
    // The pre-fix failure mode: the CLI ignored .env.local, discovered
    // ./.data/mingala on disk, while `next dev` read .env.local. Both sides
    // must now land on the SAME directory.
    await writeFile(
      join(dir, ".env.local"),
      "MINGALA_PGLITE_DIR=/data/legacy-pinned\n",
      "utf8"
    );
    const env = freshEnv();
    loadEnvFiles(dir, env, "development");
    assert.equal(resolvePgliteDir(env, dir), "/data/legacy-pinned");
  });

  test("KHANTHMAN_PGLITE_DIR in .env.local wins over legacy for both processes", async () => {
    await writeFile(
      join(dir, ".env.local"),
      [
        "KHANTHMAN_PGLITE_DIR=/data/new-pinned",
        "MINGALA_PGLITE_DIR=/data/legacy-pinned",
      ].join("\n"),
      "utf8"
    );
    const env = freshEnv();
    loadEnvFiles(dir, env, "development");
    assert.equal(resolvePgliteDir(env, dir), "/data/new-pinned");
  });

  test("copied .env.example (all blank) + existing legacy data discovers the same dir", async () => {
    const legacyDir = join(dir, ".data", "mingala");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "PG_VERSION"), "16", "utf8");
    await writeFile(
      join(dir, ".env.local"),
      ["KHANTHMAN_DB=", "KHANTHMAN_PGLITE_DIR=", "MINGALA_DB=", "MINGALA_PGLITE_DIR="].join("\n"),
      "utf8"
    );
    const env = freshEnv();
    loadEnvFiles(dir, env, "development");
    assert.equal(resolvePgliteDir(env, dir), legacyDir);
  });
});
