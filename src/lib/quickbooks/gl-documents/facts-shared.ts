import type { GlQbTxnType } from "./qbxml-builders";

/**
 * facts-shared.ts — tipos y helpers que comparten `facts.ts` (check, transfer,
 * journal, deposit) y `facts-sales-tax.ts` (Pay Sales Tax / Adjust Sales Tax
 * Due). Extraídos para que los dos módulos no se importen en círculo.
 */

/** knex-style `?` placeholders — corre igual con knex real y con `poolAsRawKnex`. */
export interface GlDocumentDb {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}

export type GlDocumentAddFacts =
  | { ready: true; qbxml: string; qbTxnType: GlQbTxnType; blockingReferenceIds: [] }
  | { ready: false; skip: true; reason: string; blockingReferenceIds: [] }
  | { ready: false; skip?: false; reason: string; blockingReferenceIds: string[] };

export const structural = (reason: string): GlDocumentAddFacts => ({
  ready: false,
  reason,
  blockingReferenceIds: [],
});
export const transient = (reason: string, ids: string[]): GlDocumentAddFacts => ({
  ready: false,
  reason,
  blockingReferenceIds: ids,
});
export const skip = (reason: string): GlDocumentAddFacts => ({
  ready: false,
  skip: true,
  reason,
  blockingReferenceIds: [],
});

export const one = <T>(r: { rows: unknown[] }): T | null => (r.rows[0] as T | undefined) ?? null;

/** "123.45" → 12345n sin pasar por float (los montos de `bank_deposit` son texto). */
export function majorToCents(text: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) throw new Error(`amount '${text}' is not a 2-decimal money string`);
  const cents = BigInt(m[2]!) * 100n + BigInt((m[3] ?? "").padEnd(2, "0"));
  return m[1] === "-" ? -cents : cents;
}

// ── cuentas ─────────────────────────────────────────────────────────────────

interface AccountRow {
  qb_list_id: string;
  account_type: string;
}

/**
 * Todas las cuentas del documento tienen que existir en el espejo de QuickBooks.
 * `pos_` es la marca de cuenta creada en el POS (gl-reports E2) — no viaja.
 */
export async function resolveAccounts(
  db: GlDocumentDb,
  listIds: string[]
): Promise<{ ok: true; accounts: Map<string, AccountRow> } | { ok: false; reason: string }> {
  const unique = [...new Set(listIds.filter((id): id is string => !!id))];
  const local = unique.filter((id) => id.startsWith("pos_"));
  if (local.length > 0) {
    return { ok: false, reason: `account_not_in_quickbooks: ${local.join(", ")} (created in the POS)` };
  }
  if (unique.length === 0) return { ok: true, accounts: new Map() };
  const result = await db.raw(
    `SELECT qb_list_id, account_type FROM qb_account WHERE qb_list_id = ANY(?::text[])`,
    [unique]
  );
  const accounts = new Map((result.rows as AccountRow[]).map((r) => [r.qb_list_id, r]));
  const missing = unique.filter((id) => !accounts.has(id));
  if (missing.length > 0) {
    return { ok: false, reason: `account_not_in_quickbooks: ${missing.join(", ")}` };
  }
  return { ok: true, accounts };
}
