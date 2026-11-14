/**
 * Dialect-neutral SQL access.
 *
 * The domain layer speaks only to `SqlExecutor`. Production uses node-postgres
 * against real PostgreSQL; tests and local demos use PGlite (PostgreSQL compiled
 * to WASM) which provides the same SQL dialect and, importantly, the same
 * transactional semantics. That means the financial invariants are exercised by
 * real Postgres behaviour in every environment.
 */

export type SqlParam = string | number | boolean | null | Date | Uint8Array;

export type QueryResult<T> = { rows: T[]; rowCount: number };

export interface SqlExecutor {
  /** Run a statement (or several, separated by `;`) with no result. */
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<QueryResult<T>>;
}

/**
 * A transactional session. All domain operations receive this and never hold a
 * reference beyond the callback, which guarantees the connection is released.
 */
export interface Transaction extends SqlExecutor {
  /** Advisory lock scoped to the transaction; used to serialise book mutations. */
  lock(key: string): Promise<void>;
}

export interface Database extends SqlExecutor {
  /** Execute `fn` inside a transaction; commits on success, rolls back on throw. */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Convert `$1` placeholders to `?` for drivers that need them is unnecessary here (both use $n). */
export function toRows<T>(result: { rows: unknown[]; rowCount?: number | null }): QueryResult<T> {
  return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
}

/**
 * Stable 64-bit advisory lock key derived from a domain string.
 * Postgres takes bigint; we fold a FNV-1a 53-bit hash into the positive range.
 */
export function lockKeyFor(...parts: string[]): string {
  const input = parts.join("\u0000");
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  const signed = hash & 0x7fffffffffffffffn;
  return signed.toString();
}
