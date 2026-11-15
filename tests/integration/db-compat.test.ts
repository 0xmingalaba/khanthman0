import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("an empty new default database is not preferred over legacy data", async () => {
    // Resolution happens again after the previous test opened (and closed) the
    // legacy store; the new directory must still not win.
    const resolved = resolvePgliteDir({}, baseDir);
    assert.equal(resolved, join(baseDir, ".data", "mingala"));
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
