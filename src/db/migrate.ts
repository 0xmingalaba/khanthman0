/**
 * Versioned migration runner.
 *
 * Migrations are plain SQL files in ./migrations, applied in filename order, each
 * inside its own transaction, recorded in schema_migrations. They are idempotent
 * by presence: an already-applied version is skipped. Never edit an applied file
 * — add the next numbered file instead.
 *
 * TRANSACTION OWNERSHIP (single owner: this runner)
 *
 * Earlier versions wrapped `tx.exec(sql)` in `db.transaction(...)` while the SQL
 * file itself began with `BEGIN` and ended with `COMMIT`. Nested BEGIN is only a
 * warning in PostgreSQL, and the inner COMMIT ends the *outer* transaction, so the
 * `schema_migrations` insert that followed ran in autocommit. A failure mid-file
 * therefore left committed DDL behind — verified against PostgreSQL 16.2, where a
 * table created before a simulated failure survived the rollback.
 *
 * The invariant now enforced here is:
 *
 *   exactly one transaction per migration file, owned by this runner, containing
 *   both the DDL and the schema_migrations row.
 *
 * Two mechanisms protect it:
 *   1. `assertNoTransactionControl` refuses to run a file containing BEGIN, COMMIT,
 *      ROLLBACK, START TRANSACTION or END, so the bug cannot be reintroduced by
 *      editing a .sql file.
 *   2. `runInTransaction` supplies the only transaction, and the version row is
 *      written inside it.
 *
 * CHECKSUM PROTECTION
 *
 * Each applied version records a SHA-256 digest of the file. A later run whose file
 * content does not match is refused, so an applied migration can never be silently
 * altered. (Earlier versions used a 32-bit FNV hash; with two independent 32-bit
 * collisions a silent skip becomes plausible, which is not acceptable for schema
 * control.)
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database, Transaction } from "./executor";

export type MigrationReport = {
  applied: string[];
  skipped: string[];
};

/** A migration that failed; the transaction was rolled back entirely. */
export class MigrationError extends Error {
  readonly version: string;
  constructor(version: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "MigrationError";
    this.version = version;
  }
}

const MIGRATIONS_DIR = join(process.cwd(), "src", "db", "migrations");

/**
 * Transaction-control keywords that must never appear in a migration file.
 *
 * Matched case-insensitively at the start of a statement (after `;` or on its own
 * line) so the words may still be used inside string literals or comments without
 * a false positive in the common case.
 */
const FORBIDDEN_TRANSACTION_CONTROL =
  /(^|;)\s*(BEGIN\b|START\s+TRANSACTION\b|COMMIT\b|ROLLBACK\b|END\s*;)/i;

export async function migrationFiles(): Promise<{ version: string; path: string }[]> {
  const names = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
  return names.map((name) => ({
    version: name.replace(/\.sql$/, ""),
    path: join(MIGRATIONS_DIR, name),
  }));
}

/**
 * Refuse a file that tries to manage its own transaction.
 *
 * Three kinds of content must be neutralised first, or the check produces false
 * positives that would block every legitimate migration:
 *
 *   1. Block comments   -- the header of each migration explains the rule.
 *   2. Line comments    -- same reason.
 *   3. Dollar-quoted bodies (`$$ ... $$`) -- a plpgsql function legitimately ends
 *      with `END;`, which would otherwise look like transaction control.
 *
 * What remains is real top-level SQL, where a BEGIN/COMMIT is always a defect.
 */
export function assertNoTransactionControl(version: string, sql: string): void {
  const withoutBlockComments = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  const withoutLineComments = withoutBlockComments.replace(/--[^\n]*/g, " ");
  const withoutDollarQuotes = withoutLineComments.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " ");
  if (FORBIDDEN_TRANSACTION_CONTROL.test(withoutDollarQuotes)) {
    throw new MigrationError(
      version,
      `Migration ${version} contains its own transaction control. ` +
        "The migration runner owns the only transaction; remove BEGIN/COMMIT so a " +
        "failure rolls back the whole file."
    );
  }
}

/** SHA-256 of the file contents, hex encoded. */
export function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** schema_migrations is created outside any migration, so it must be idempotent. */
async function ensureMigrationsTable(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum    TEXT NOT NULL
    );
  `);
}

export type MigrationDependencies = {
  /** Read the directory listing; injectable for tests. */
  files?: () => Promise<{ version: string; path: string }[]>;
  /** Read a file; injectable for tests. */
  read?: (path: string) => Promise<string>;
};

/**
 * Apply pending migrations.
 *
 * Every file runs in exactly one runner-owned transaction containing the DDL and
 * the schema_migrations row. If anything throws, the transaction rolls back and no
 * version is recorded, so a retry starts from a clean state.
 */
export async function migrate(
  db: Database,
  deps: MigrationDependencies = {}
): Promise<MigrationReport> {
  const listFiles = deps.files ?? migrationFiles;
  const readSql = deps.read ?? ((path: string) => readFile(path, "utf8"));

  await ensureMigrationsTable(db);
  const report: MigrationReport = { applied: [], skipped: [] };

  for (const file of await listFiles()) {
    const sql = await readSql(file.path);

    // Fail before touching the database if the file would break atomicity.
    assertNoTransactionControl(file.version, sql);
    const digest = checksum(sql);

    const existing = await db.query<{ checksum: string }>(
      "SELECT checksum FROM schema_migrations WHERE version = $1",
      [file.version]
    );

    if (existing.rows.length > 0) {
      if (existing.rows[0].checksum !== digest) {
        throw new MigrationError(
          file.version,
          `Migration ${file.version} was modified after being applied. ` +
            "Restore the original file and add a new migration instead."
        );
      }
      report.skipped.push(file.version);
      continue;
    }

    try {
      await db.transaction(async (tx: Transaction) => {
        await tx.exec(sql);
        await tx.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
          file.version,
          digest,
        ]);
      });
    } catch (error) {
      // The transaction is already rolled back by the executor. Re-throw with the
      // version attached so the operator knows which file failed and that nothing
      // from it was recorded.
      throw new MigrationError(
        file.version,
        `Migration ${file.version} failed and was rolled back; it was not recorded as applied.`,
        error
      );
    }

    report.applied.push(file.version);
  }

  return report;
}
