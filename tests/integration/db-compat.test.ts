import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";
import { resolvePgliteDir } from "@/src/db/config";
import { createPgliteDatabase } from "@/src/db/pglite";

/**
 * Pre-rebrand local databases were created at `./.data/mingala`. The rebrand
 * must discover and open that directory in place — never silently replace it
 * with an empty `./.data/khanthman` database. This test builds a real PGlite
 * database under a legacy-shaped path inside an isolated temporary directory
 * and then exercises full resolution + open + read. The real development
 * database is never touched.
 */

let baseDir: string;

before(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "khanthman-compat-"));
  const legacyDir = join(baseDir, ".data", "mingala");
  const seed = await createPgliteDatabase(legacyDir);
  try {
    await seed.exec(
      "CREATE TABLE rebrand_probe (id integer PRIMARY KEY, note text NOT NULL)"
    );
    await seed.query("INSERT INTO rebrand_probe (id, note) VALUES ($1, $2)", [
      1,
      "pre-rebrand data",
    ]);
  } finally {
    await seed.close();
  }
});

after(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("legacy .data/mingala compatibility (isolated temp dir)", () => {
  test("existing legacy database is discovered and opened with data intact", async () => {
    const resolved = resolvePgliteDir({}, baseDir);
    assert.equal(resolved, join(baseDir, ".data", "mingala"));

    const db = await createPgliteDatabase(resolved);
    try {
      const result = await db.query<{ id: number; note: string }>(
        "SELECT id, note FROM rebrand_probe"
      );
      assert.deepEqual(result.rows, [{ id: 1, note: "pre-rebrand data" }]);
    } finally {
      await db.close();
    }

    // The legacy directory still exists with its contents afterwards.
    const stats = await stat(join(baseDir, ".data", "mingala"));
    assert.ok(stats.isDirectory());
  });

  test("a copied .env.example (blank variables) discovers and opens the legacy database intact", async () => {
    // Regression for the .env.example defect: the template previously shipped
    // KHANTHMAN_PGLITE_DIR=./.data/khanthman populated, so copying it to
    // .env.local silently shadowed an existing .data/mingala database. The
    // template now ships the variable blank (blank counts as unset), and this
    // test replays exactly that configuration end to end.
    const copiedTemplate = {
      KHANTHMAN_DB: "",
      KHANTHMAN_PGLITE_DIR: "",
      MINGALA_DB: "",
      MINGALA_PGLITE_DIR: "",
    };

    const resolved = resolvePgliteDir(copiedTemplate, baseDir);
    assert.equal(resolved, join(baseDir, ".data", "mingala"));

    const db = await createPgliteDatabase(resolved);
    try {
      const result = await db.query<{ id: number; note: string }>(
        "SELECT id, note FROM rebrand_probe"
      );
      assert.deepEqual(result.rows, [{ id: 1, note: "pre-rebrand data" }]);
    } finally {
      await db.close();
    }

    // And it still prefers legacy data even when an empty ./.data/khanthman
    // exists, exactly the pre-fix failure mode, now covered against PGlite.
    await mkdir(join(baseDir, ".data", "khanthman"), { recursive: true });
    assert.equal(
      resolvePgliteDir(copiedTemplate, baseDir),
      join(baseDir, ".data", "mingala")
    );
  });

  test("an empty new default database is not preferred over legacy data", async () => {
    // Resolution happens again after the previous test opened (and closed) the
    // legacy store; the new directory must still not win.
    const resolved = resolvePgliteDir({}, baseDir);
    assert.equal(resolved, join(baseDir, ".data", "mingala"));
  });

  test("seed CLI and dev server resolve identically when .env.local pins the legacy dir", async () => {
    // The Codex review finding on PR #8: the CLI ignored .env.local, so with a
    // legacy KHANTHMAN_PGLITE_DIR/MINGALA_PGLITE_DIR pinned there, `next dev`
    // and the seed could open different databases. Now both sides load the
    // same env files; replay that exact configuration end to end.
    const projectDir = join(baseDir, "project");
    await mkdir(projectDir, { recursive: true });
    const legacyDir = join(baseDir, ".data", "mingala"); // the shared before() fixture
    await writeFile(
      join(projectDir, ".env.local"),
      ["KHANTHMAN_DB=pglite", `MINGALA_PGLITE_DIR=${legacyDir}`].join("\n"),
      "utf8"
    );

    // @next/env mutates process.env and caches per process, so the probe runs
    // in a fresh child process — replaying exactly what both the CLI and
    // `next dev` do at startup (see tests/unit/env-file.test.ts).
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    // Absolute paths are not valid ESM specifiers on Windows ("D:\\dir\\file.ts"
    // has the scheme "d:"); use file:/// URLs there.
    const moduleSpecifier = (segments: string[]): string =>
      pathToFileURL(join(repoRoot, ...segments)).href;
    const probeSource = `
import { loadEnvFiles } from ${JSON.stringify(moduleSpecifier(["src", "db", "env-file.ts"]))};
import { resolvePgliteDir } from ${JSON.stringify(moduleSpecifier(["src", "db", "config.ts"]))};
loadEnvFiles(process.argv[1]);
console.log("DIR=" + resolvePgliteDir(process.env, process.argv[1]));
`;
    const runSide = () => {
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", probeSource, projectDir],
        {
          cwd: repoRoot,
          env: { PATH: process.env.PATH, NODE_ENV: "development" },
          encoding: "utf8",
          timeout: 120_000,
        }
      );
      const match = /^DIR=(.*)$/m.exec(`${child.stdout}${child.stderr}`);
      assert.ok(match, `probe failed: ${child.stdout}${child.stderr}`);
      return match[1];
    };
    const cliDir = runSide();
    const nextDir = runSide();
    assert.equal(cliDir, nextDir);
    assert.equal(cliDir, legacyDir);

    const db = await createPgliteDatabase(cliDir);
    try {
      const result = await db.query<{ note: string }>(
        "SELECT note FROM rebrand_probe WHERE id = 1"
      );
      assert.deepEqual(result.rows, [{ note: "pre-rebrand data" }]);
    } finally {
      await db.close();
    }
  });

  test("explicit new KHANTHMAN_PGLITE_DIR is opened instead when configured", async () => {
    const explicitDir = join(baseDir, ".data", "khanthman");
    const resolved = resolvePgliteDir({ KHANTHMAN_PGLITE_DIR: explicitDir }, baseDir);
    assert.equal(resolved, explicitDir);

    const db = await createPgliteDatabase(resolved);
    try {
      // A fresh store at the explicit path is empty of legacy rows, which is
      // the correct behaviour when the operator opts in explicitly.
      await db.exec(
        "CREATE TABLE khanthman_probe (id integer PRIMARY KEY)"
      );
      const second = await db.query<{ c: number }>(
        "SELECT count(*)::int AS c FROM khanthman_probe"
      );
      assert.equal(second.rows[0].c, 0);
    } finally {
      await db.close();
    }

    // Legacy data must remain untouched by all of this.
    const legacy = await createPgliteDatabase(join(baseDir, ".data", "mingala"));
    try {
      const result = await legacy.query<{ note: string }>(
        "SELECT note FROM rebrand_probe WHERE id = 1"
      );
      assert.deepEqual(result.rows, [{ note: "pre-rebrand data" }]);
    } finally {
      await legacy.close();
    }
  });
});
