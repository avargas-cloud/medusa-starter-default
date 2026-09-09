import type { PeriodCostLine } from "./period-costs";

type RawPg = { raw: (sql: string, bindings: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

function bankExpenseDocument(row: Record<string, unknown>): Pick<PeriodCostLine, "document_kind" | "link_path"> {
  const originId = encodeURIComponent(String(row.origin_id ?? ""));
  switch (row.origin_kind) {
    case "deposit": return { document_kind: "Bank deposit fee", link_path: `/accounting/banks/deposits?deposit_id=${originId}` };
    case "movement": return { document_kind: "Bank movement expense", link_path: `/accounting/banks/movements?movement_id=${originId}` };
    case "merchant_settlement": return { document_kind: "Merchant settlement fee", link_path: `/accounting/banks/settlements?settlement_id=${originId}` };
    default: return { document_kind: "Bank expense",
      link_path: `/accounting/banks/accounting?transaction_id=${encodeURIComponent(String(row.transaction_id ?? ""))}` };
  }
}

/** One immutable expense-side line per journal event. Reversals belong to their own accounting day. */
export async function fetchBankExpenseCostLines(pg: RawPg, from: string, to: string): Promise<PeriodCostLine[]> {
  // Banking is optional during rollout. Historical posted expenses still count when
  // the feed is temporarily disabled; disabling ingestion cannot restate a P&L.
  const schema = await pg.raw(`SELECT to_regclass('public.bank_journal_entry') IS NOT NULL
    AND to_regclass('public.bank_journal_line') IS NOT NULL AS ready`, []);
  if (schema.rows[0]?.ready !== true) return [];
  const rows = await pg.raw(`SELECT e.id,e.transaction_id,e.reference,e.description,e.kind,
    (e.day::date::timestamp AT TIME ZONE 'America/New_York') AS document_date,
    e.source_snapshot->'source'->>'name' AS counterparty,
    e.source_snapshot->'source'->>'kind' AS origin_kind,
    e.source_snapshot->'source'->>'id' AS origin_id,
    l.account_list_id,l.account_snapshot->>'name' AS account_name,
    l.account_snapshot->>'account_type' AS account_type,(l.debit_cents-l.credit_cents)::text AS amount_cents
    FROM bank_journal_entry e JOIN bank_journal_line l ON l.entry_id=e.id
      AND (l.role='expense' OR left(l.role,8)='expense_')
    WHERE (e.day::date::timestamp AT TIME ZONE 'America/New_York') >= ?::timestamptz
      AND (e.day::date::timestamp AT TIME ZONE 'America/New_York') < ?::timestamptz
    ORDER BY e.day,e.id`, [from, to]);
  return rows.rows.map(row => ({ source: "bank_expense", document_id: String(row.id),
    document_number: String(row.reference), ...bankExpenseDocument(row),
    document_date: row.document_date instanceof Date ? row.document_date.toISOString() : String(row.document_date),
    counterparty: row.counterparty == null ? null : String(row.counterparty),
    account_list_id: String(row.account_list_id), account_full_name: String(row.account_name),
    account_type: String(row.account_type), bucket: "cost", amount_cents: Number(row.amount_cents),
    description: String(row.description), document_status: row.kind === "reversal" ? "reversal" : "posted",
    qb_synced: false, qb_ref: null }));
}
