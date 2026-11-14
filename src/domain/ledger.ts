/**
 * Double-entry ledger.
 *
 * Rules (docs/FINANCIAL-SPEC.md):
 *  - Journals are append-only. There is no update or delete path in this module.
 *  - Every journal balances per asset; the database enforces this again with a
 *    deferred constraint trigger, so a bug in this file cannot corrupt history.
 *  - Balances are derived, never assigned. `account_balances` is maintained by a
 *    database trigger from entries, and `balanceOf` reads it.
 *  - The ledger is the single source of truth for cash *and* share ownership.
 *
 * Sign convention: positive = debit. User assets are debit balances.
 * `system_equity` is a credit account and is therefore negative once credits are
 * issued, which keeps every asset's total exactly zero.
 */

import type { Transaction } from "@/src/db/executor";
import { DomainError } from "@/src/lib/errors";

export type Asset = "PYA" | `SHARE:${string}:${"YES" | "NO"}`;

export type AccountKind =
  | "cash_available"
  | "cash_reserved"
  | "shares_available"
  | "shares_reserved"
  | "escrow_shares"
  | "escrow_payout"
  | "system_issued"
  | "system_equity";

export type AccountOwner =
  | { type: "user"; id: string }
  | { type: "market"; id: string }
  | { type: "system"; id: null };

export type JournalKind =
  | "grant"
  | "order_reserve"
  | "order_release"
  | "trade_settlement"
  | "resolution_payout"
  | "void_refund"
  | "correction";

export type EntryInput = {
  accountId: string;
  /** Signed integer Pyas (for PYA) or share units (for SHARE: assets). */
  delta: number;
  asset: Asset;
};

export type PostJournalInput = {
  kind: JournalKind;
  entries: EntryInput[];
  actorId?: string | null;
  refType?: string;
  refId?: string;
  memo?: string;
};

export type AccountRow = {
  id: string;
  owner_type: "user" | "market" | "system";
  owner_id: string | null;
  asset: string;
  kind: AccountKind;
};

export type Balances = { available: number; reserved: number; total: number };

export const PYA: Asset = "PYA";

export function shareAsset(marketId: string, side: "YES" | "NO"): Asset {
  return `SHARE:${marketId}:${side}`;
}

/**
 * Find or create an account. Uses an upsert on the identity index so concurrent
 * callers cannot create duplicates or deadlock on check-then-insert.
 */
export async function ensureAccount(
  tx: Transaction,
  owner: AccountOwner,
  asset: Asset,
  kind: AccountKind
): Promise<string> {
  const ownerId = owner.type === "system" ? null : owner.id;
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO ledger_accounts (owner_type, owner_id, asset, kind)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [owner.type, ownerId, asset, kind]
  );

  if (inserted.rows.length > 0) {
    // Create the derived balance row in the same transaction.
    await tx.query(
      "INSERT INTO account_balances (account_id, kind, asset, balance) VALUES ($1, $2, $3, 0)",
      [inserted.rows[0].id, kind, asset]
    );
    return inserted.rows[0].id;
  }

  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM ledger_accounts
      WHERE owner_type = $1
        AND COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid) =
            COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND asset = $3
        AND kind = $4`,
    [owner.type, ownerId === null ? null : String(ownerId), asset, kind]
  );

  if (existing.rows.length === 0) {
    throw new DomainError("internal_error", { message: "Ledger account could not be created." });
  }
  return existing.rows[0].id;
}

/** Validate that a set of entries forms a balanced journal, per asset. */
export function assertBalanced(entries: EntryInput[]): void {
  if (entries.length < 2) {
    throw new DomainError("internal_error", { message: "A journal needs at least two entries." });
  }
  const totals = new Map<string, number>();
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.delta)) {
      throw new DomainError("internal_error", { message: "Ledger entry delta must be an integer." });
    }
    if (entry.delta === 0) {
      throw new DomainError("internal_error", { message: "Ledger entry delta must be non-zero." });
    }
    totals.set(entry.asset, (totals.get(entry.asset) ?? 0) + entry.delta);
  }
  for (const [asset, total] of totals) {
    if (total !== 0) {
      throw new DomainError("internal_error", {
        message: `Journal does not balance for asset ${asset}: ${total}.`,
      });
    }
  }
}

/**
 * Post a journal. Entries are written in one statement, so the deferred balance
 * trigger sees the complete journal at COMMIT.
 */
export async function postJournal(
  tx: Transaction,
  input: PostJournalInput
): Promise<{ journalId: string }> {
  assertBalanced(input.entries);

  const journal = await tx.query<{ id: string }>(
    `INSERT INTO ledger_journals (kind, actor_id, ref_type, ref_id, memo)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.kind, input.actorId ?? null, input.refType ?? null, input.refId ?? null, input.memo ?? null]
  );
  const journalId = journal.rows[0].id;

  const params: unknown[] = [];
  const values: string[] = [];
  input.entries.forEach((entry, index) => {
    const base = index * 3;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    params.push(journalId, entry.accountId, entry.delta);
  });

  await tx.query(
    `INSERT INTO ledger_entries (journal_id, account_id, delta) VALUES ${values.join(", ")}`,
    params as never[]
  );

  return { journalId };
}

/** Read a single account balance. Returns 0 for a missing account. */
export async function balanceOf(tx: Transaction, accountId: string): Promise<number> {
  const result = await tx.query<{ balance: number | string }>(
    "SELECT balance FROM account_balances WHERE account_id = $1",
    [accountId]
  );
  if (result.rows.length === 0) return 0;
  return Number(result.rows[0].balance);
}

/** Available and reserved balances for a user's cash. */
export async function cashBalances(tx: Transaction, userId: string): Promise<Balances> {
  const result = await tx.query<{ kind: AccountKind; balance: number | string }>(
    `SELECT ab.kind, ab.balance
       FROM account_balances ab
       JOIN ledger_accounts la ON la.id = ab.account_id
      WHERE la.owner_type = 'user' AND la.owner_id = $1 AND la.asset = 'PYA'`,
    [userId]
  );
  let available = 0;
  let reserved = 0;
  for (const row of result.rows) {
    if (row.kind === "cash_available") available = Number(row.balance);
    if (row.kind === "cash_reserved") reserved = Number(row.balance);
  }
  return { available, reserved, total: available + reserved };
}

/** Share balance (available / reserved) for one outcome of one market. */
export async function shareBalances(
  tx: Transaction,
  userId: string,
  marketId: string,
  side: "YES" | "NO"
): Promise<Balances> {
  const asset = shareAsset(marketId, side);
  const result = await tx.query<{ kind: AccountKind; balance: number | string }>(
    `SELECT ab.kind, ab.balance
       FROM account_balances ab
       JOIN ledger_accounts la ON la.id = ab.account_id
      WHERE la.owner_type = 'user' AND la.owner_id = $1 AND la.asset = $2`,
    [userId, asset]
  );
  let available = 0;
  let reserved = 0;
  for (const row of result.rows) {
    if (row.kind === "shares_available") available = Number(row.balance);
    if (row.kind === "shares_reserved") reserved = Number(row.balance);
  }
  return { available, reserved, total: available + reserved };
}

/**
 * Lock an account's balance row and return the locked value.
 *
 * This is the single gate against double spending. The balance is written only by
 * the ledger entry trigger, so a plain conditional UPDATE would race with that
 * trigger; instead we take a row lock, decide against a stable value, and let the
 * journal trigger apply the change. A concurrent transaction blocks on the lock
 * until we commit or roll back, then re-reads the updated balance.
 */
export async function lockBalance(tx: Transaction, accountId: string): Promise<number> {
  const result = await tx.query<{ balance: number | string }>(
    "SELECT balance FROM account_balances WHERE account_id = $1 FOR UPDATE",
    [accountId]
  );
  if (result.rows.length === 0) {
    throw new DomainError("internal_error", { message: "Ledger balance row is missing." });
  }
  return Number(result.rows[0].balance);
}

/** Lock several balances in a deterministic order to avoid deadlocks. */
export async function lockBalances(
  tx: Transaction,
  accountIds: string[]
): Promise<Map<string, number>> {
  const balances = new Map<string, number>();
  for (const id of [...new Set(accountIds)].sort()) {
    balances.set(id, await lockBalance(tx, id));
  }
  return balances;
}

/**
 * Require a locked balance to cover `amount`, throwing the supplied domain error
 * otherwise. Callers must have locked the account first.
 */
export function requireCovered(lockedBalance: number, amount: number, error: DomainError): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new DomainError("internal_error", {
      message: "Amount to debit must be a positive integer.",
    });
  }
  if (lockedBalance < amount) throw error;
}

/**
 * Require a share escrow to hold at least `amount` units.
 *
 * Escrow is a debit balance holding real shares, so coverage is a plain
 * comparison. This wrapper exists so escrow coverage can never be confused with
 * cash coverage if the sign model changes again.
 */
export function requireEscrowed(lockedEscrowBalance: number, amount: number, error: DomainError): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new DomainError("internal_error", {
      message: "Escrow amount must be a positive integer.",
    });
  }
  if (lockedEscrowBalance < amount) throw error;
}

/**
 * Reconciliation: the sum of all balances per asset must be zero.
 * Used by tests and by an admin health check.
 */
export async function reconcile(tx: Transaction): Promise<
  { asset: string; total: number }[]
> {
  const result = await tx.query<{ asset: string; total: number | string }>(
    `SELECT asset, COALESCE(sum(balance), 0) AS total
       FROM account_balances
      GROUP BY asset
      ORDER BY asset`
  );
  return result.rows.map((row) => ({ asset: row.asset, total: Number(row.total) }));
}

/** Assert full-system reconciliation; throws with diagnostics when it fails. */
export async function assertReconciled(tx: Transaction): Promise<void> {
  const rows = await reconcile(tx);
  const broken = rows.filter((row) => row.total !== 0);
  if (broken.length > 0) {
    throw new DomainError("internal_error", {
      message: `Ledger is out of balance: ${broken
        .map((row) => `${row.asset}=${row.total}`)
        .join(", ")}`,
    });
  }
}

/** Full statement of one account for auditing. */
export async function accountStatement(
  tx: Transaction,
  accountId: string
): Promise<
  {
    journalId: string;
    kind: string;
    delta: number;
    createdAt: Date | string;
    memo: string | null;
  }[]
> {
  const result = await tx.query<{
    journal_id: string;
    kind: string;
    delta: number | string;
    created_at: Date | string;
    memo: string | null;
  }>(
    `SELECT e.journal_id, j.kind, e.delta, e.created_at, j.memo
       FROM ledger_entries e
       JOIN ledger_journals j ON j.id = e.journal_id
      WHERE e.account_id = $1
      ORDER BY e.id`,
    [accountId]
  );
  return result.rows.map((row) => ({
    journalId: row.journal_id,
    kind: row.kind,
    delta: Number(row.delta),
    createdAt: row.created_at,
    memo: row.memo,
  }));
}
