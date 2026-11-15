import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  LEGACY_PGLITE_DIR_ENV,
  LEGACY_DB_ENV,
  LEGACY_PGLITE_DIR,
  NEW_DB_ENV,
  NEW_PGLITE_DIR_ENV,
  DEFAULT_PGLITE_DIR,
  isPgliteMode,
  resolvePgliteDir,
} from "@/src/db/config";

/**
 * Backward-compatibility contract for the Khant Hman rebrand.
 *
 * Existing local development databases created under the legacy `MINGALA_DB` /
 * `MINGALA_PGLITE_DIR` / `.data/mingala` identifiers must keep working, and the
 * new `KHANTHMAN_*` variables must win when both are set. Isolated temporary
 * directories only — the real development database is never touched.
 */

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "khanthman-config-"));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("isPgliteMode", () => {
  test("new KHANTHMAN_DB selects pglite mode", () => {
    assert.equal(isPgliteMode({ [NEW_DB_ENV]: "pglite" }), true);
  });

  test("legacy MINGALA_DB still selects pglite mode", () => {
    assert.equal(isPgliteMode({ [LEGACY_DB_ENV]: "pglite" }), true);
  });

  test("new variable takes precedence when both are set", () => {
    assert.equal(
      isPgliteMode({ [NEW_DB_ENV]: "production", [LEGACY_DB_ENV]: "pglite" }),
      false
    );
    assert.equal(
      isPgliteMode({ [NEW_DB_ENV]: "pglite", [LEGACY_DB_ENV]: "production" }),
      true
    );
  });

  test("empty strings count as unset", () => {
    assert.equal(isPgliteMode({ [NEW_DB_ENV]: "", [LEGACY_DB_ENV]: "pglite" }), true);
    assert.equal(isPgliteMode({ [NEW_DB_ENV]: "   " }), false);
    assert.equal(isPgliteMode({}), false);
  });
});

describe("resolvePgliteDir", () => {
  test("explicit KHANTHMAN_PGLITE_DIR wins over everything", async () => {
    await mkdir(join(baseDir, ".data", "mingala"), { recursive: true });
    await writeFile(join(baseDir, ".data", "mingala", "marker"), "data");
    const env = {
      [NEW_PGLITE_DIR_ENV]: "/tmp/custom-khanthman",
      [LEGACY_PGLITE_DIR_ENV]: "/tmp/custom-mingala",
    };
    assert.equal(resolvePgliteDir(env, baseDir), "/tmp/custom-khanthman");
  });

  test("explicit legacy MINGALA_PGLITE_DIR is honored when new var is unset", () => {
    assert.equal(
      resolvePgliteDir({ [LEGACY_PGLITE_DIR_ENV]: "/tmp/custom-mingala" }, baseDir),
      "/tmp/custom-mingala"
    );
  });

  test("existing legacy .data/mingala is discovered instead of starting an empty new database", async () => {
    const legacyDir = join(baseDir, ".data", "mingala");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "PG_VERSION"), "16");
    const resolved = resolvePgliteDir({}, baseDir);
    assert.equal(resolved, legacyDir);
    // Resolution must never delete or move legacy data.
    assert.ok(existsSync(join(legacyDir, "PG_VERSION")));
  });

  test("new .data/khanthman is preferred when it already holds data", async () => {
    await mkdir(join(baseDir, ".data", "khanthman"), { recursive: true });
    await writeFile(join(baseDir, ".data", "khanthman", "PG_VERSION"), "16");
    await mkdir(join(baseDir, ".data", "mingala"), { recursive: true });
    await writeFile(join(baseDir, ".data", "mingala", "PG_VERSION"), "16");
    assert.equal(resolvePgliteDir({}, baseDir), join(baseDir, ".data", "khanthman"));
  });

  test("a copied .env.example (all-blank variables) still discovers legacy data", async () => {
    // Regression: .env.example previously shipped a *populated*
    // KHANTHMAN_PGLITE_DIR=./.data/khanthman, which took precedence over legacy
    // discovery and silently shadowed an existing .data/mingala database.
    // The template now ships the variable blank, and blank counts as unset.
    const legacyDir = join(baseDir, ".data", "mingala");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "PG_VERSION"), "16");
    const copiedEnvExample = {
      KHANTHMAN_DB: "",
      KHANTHMAN_PGLITE_DIR: "",
      MINGALA_DB: "",
      MINGALA_PGLITE_DIR: "",
    };
    assert.equal(isPgliteMode(copiedEnvExample), false);
    assert.equal(resolvePgliteDir(copiedEnvExample, baseDir), legacyDir);
  });

  test("an explicitly populated KHANTHMAN_PGLITE_DIR shadows legacy data (documented opt-in)", async () => {
    // This is the escape hatch the .env.example comment describes: setting the
    // new variable selects that directory explicitly and does NOT migrate or
    // copy legacy data.
    const legacyDir = join(baseDir, ".data", "mingala");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "PG_VERSION"), "16");
    const explicit = join(baseDir, ".data", "khanthman");
    assert.equal(
      resolvePgliteDir({ KHANTHMAN_PGLITE_DIR: explicit }, baseDir),
      explicit
    );
    // Legacy data is left untouched on disk.
    assert.ok(existsSync(join(legacyDir, "PG_VERSION")));
  });

  test("empty legacy directory does not trigger legacy discovery", async () => {
    await mkdir(join(baseDir, ".data", "mingala"), { recursive: true });
    assert.equal(resolvePgliteDir({}, baseDir), join(baseDir, ".data", "khanthman"));
  });

  test("fresh installs default to ./.data/khanthman", () => {
    assert.equal(resolvePgliteDir({}, baseDir), join(baseDir, ".data", "khanthman"));
    assert.equal(DEFAULT_PGLITE_DIR, "./.data/khanthman");
    assert.equal(LEGACY_PGLITE_DIR, "./.data/mingala");
  });

  test("legacy discovery warns loudly but does not move data", async () => {
    const legacyDir = join(baseDir, ".data", "mingala");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "marker"), "keep-me");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      resolvePgliteDir({}, baseDir);
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(
      warnings.some((line) => line.includes("./.data/mingala")),
      "expected a deprecation warning naming the legacy directory"
    );
    assert.equal(
      await (await import("node:fs/promises")).readFile(join(legacyDir, "marker"), "utf8"),
      "keep-me"
    );
  });
});
