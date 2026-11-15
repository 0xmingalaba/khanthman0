import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  MigrationError,
  assertNoTransactionControl,
  checksum,
  migrate,
} from "@/src/db/migrate";
import { createPgliteDatabase } from "@/src/db/pglite";
import type { Database } from "@/src/db/executor";

/**
 * Migration atomicity.
 *
 * The defect being guarded against: the runner wrapped each file in
 * `db.transaction(...)` while the file itself contained BEGIN/COMMIT. The inner
 * COMMIT ended the runner's transaction, so a failure mid-file left committed DDL
 * behind and the schema_migrations row was written outside the atomic unit.
 *
 * These tests assert the post-fix invariant: exactly one transaction per file, and
 * a failure records nothing.
 */

let db: Database;
let dir: string;

before(async () => {
  db = await createPgliteDatabase();
  dir = await mkdtemp(join(tmpdir(), "khanthman-migrations-"));
});

after(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

/** Build an injectable file list + reader over a temp directory. */
async function withFiles(files: Record<string, string>) {
  const entries: { version: string; path: string }[] = [];
  for (const [name, sql] of Object.entries(files)) {
    const path = join(dir, `${name}.sql`);
    await writeFile(path, sql, "utf8");
    entries.push({ version: name, path });
  }
  return {
    files: async () => entries.sort((a, b) => (a.version < b.version ? -1 : 1)),
    read: async (path: string) => {
      const found = entries.find((entry) => entry.path === path);
      if (!found) throw new Error(`unknown path ${path}`);
      return files[found.version];
    },
  };
}

async function tableExists(name: string): Promise<boolean> {
  const result = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = $1",
    [name]
  );
  return result.rows[0].n > 0;
}

async function recordedVersions(): Promise<string[]> {
  const result = await db.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version"
  );
  return result.rows.map((row) => row.version);
}

describe("migration transaction ownership", () => {
  test("a migration file may not contain its own transaction control", () => {
    for (const sql of [
      "BEGIN; CREATE TABLE a (id int); COMMIT;",
      "COMMIT;",
      "START TRANSACTION; SELECT 1;",
      "ROLLBACK;",
    ]) {
      assert.throws(
        () => assertNoTransactionControl("9999_bad", sql),
        (error: unknown) => error instanceof MigrationError,
        `expected rejection of: ${sql}`
      );
    }
  });

  test("transaction keywords inside comments and function bodies are allowed", () => {
    const safe = `
-- this comment mentions BEGIN and COMMIT harmlessly
/* block comment: COMMIT; */
CREATE FUNCTION f() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RETURN NEW;
END;
$$;
    `;
    assert.doesNotThrow(() => assertNoTransactionControl("9999_ok", safe));
  });

  test("a failing migration rolls back completely and is not recorded", async () => {
    const deps = await withFiles({
      "9001_partial": `
        CREATE TABLE mig_atomicity_probe (id int);
        INSERT INTO mig_atomicity_probe VALUES (1);
        SELECT * FROM table_that_does_not_exist;
      `,
    });

    await assert.rejects(
      () => migrate(db, deps),
      (error: unknown) =>
        error instanceof MigrationError &&
        error.version === "9001_partial" &&
        /rolled back/.test(error.message)
    );

    assert.equal(
      await tableExists("mig_atomicity_probe"),
      false,
      "the table created before the failure must not exist after rollback"
    );
    assert.ok(
      !(await recordedVersions()).includes("9001_partial"),
      "a failed migration must not be recorded as applied"
    );
  });

  test("a migration that manages its own transaction is refused before any DDL runs", async () => {
    const deps = await withFiles({
      "9002_sneaky": "BEGIN; CREATE TABLE mig_sneaky_probe (id int); COMMIT;",
    });

    await assert.rejects(
      () => migrate(db, deps),
      (error: unknown) =>
        error instanceof MigrationError && error.version === "9002_sneaky"
    );

    assert.equal(
      await tableExists("mig_sneaky_probe"),
      false,
      "no part of a refused migration may be applied"
    );
    assert.ok(!(await recordedVersions()).includes("9002_sneaky"));
  });

  test("a successful migration is applied exactly once and then skipped", async () => {
    const deps = await withFiles({
      "9003_good": "CREATE TABLE mig_good_probe (id int);",
    });

    const first = await migrate(db, deps);
    assert.ok(first.applied.includes("9003_good"));
    assert.equal(await tableExists("mig_good_probe"), true);

    const second = await migrate(db, deps);
    assert.deepEqual(second.applied, [], "nothing reapplied");
    assert.ok(second.skipped.includes("9003_good"));
  });

  test("editing an applied migration is refused by the checksum guard", async () => {
    const original = "CREATE TABLE mig_checksum_probe (id int);";
    const first = await withFiles({ "9004_checksum": original });
    await migrate(db, first);

    const tampered = await withFiles({
      "9004_checksum": "CREATE TABLE mig_checksum_probe (id int, extra text);",
    });
    await assert.rejects(
      () => migrate(db, tampered),
      (error: unknown) =>
        error instanceof MigrationError && /modified after being applied/.test(error.message)
    );
  });
});

describe("migration checksum", () => {
  test("is SHA-256, 64 hex characters, and content sensitive", () => {
    const a = checksum("SELECT 1;");
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, checksum("SELECT 2;"));
    assert.equal(a, checksum("SELECT 1;"), "stable for identical content");
  });

  test("distinguishes a single-character edit", () => {
    assert.notEqual(checksum("CREATE TABLE t (id int);"), checksum("CREATE TABLE t (id int) ;"));
  });
});
