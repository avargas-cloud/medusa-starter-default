import { receiptRead } from "./receipts-setup";

export type SettlementLookupKind =
  | "card_payment"
  | "receipt"
  | "refund"
  | "reserve_release";
export function listSettlementSources(
  kind: SettlementLookupKind,
  q: string
): Promise<{
  sources: Array<
    Record<string, unknown> & {
      kind: SettlementLookupKind;
      amount_cents: number;
      available_cents: number | null;
    }
  >;
  more: boolean;
}> {
  return receiptRead(async (client) => {
    const search = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    let rows: Array<Record<string, unknown>>;
    if (kind === "refund") {
      rows = (
        await client.query(
          `SELECT p.id,COALESCE(p.reference,p.display_id::text,p.id) AS reference,
        COALESCE(p.metadata->>'refund_txn_date',p.batch_day) AS day,
        CASE WHEN p.type='refund' THEN p.amount ELSE (p.metadata->>'refund_amount')::numeric END::text AS amount_cents,
        NULL::text AS available_cents FROM customer_payment p
        WHERE p.deleted_at IS NULL AND p.status<>'voided' AND upper(p.currency)='USD' AND p.method IN ('credit_card','debit_card','card')
          AND (p.type='refund' OR (p.status IN ('refunded','partial_refunded') AND p.metadata->>'refund_amount' ~ '^[0-9]+$'))
          AND (p.id ILIKE $1 OR p.reference ILIKE $1 OR p.display_id::text ILIKE $1)
        ORDER BY p.batch_day DESC NULLS LAST,p.id LIMIT 101`,
          [search]
        )
      ).rows;
    } else if (kind === "reserve_release") {
      rows = (
        await client.query(
          `SELECT e.id||':'||l.role AS id,e.reference||' / '||l.role AS reference,e.day,
        l.debit_cents::text AS amount_cents,l.account_list_id,l.account_snapshot->>'name' AS account_name,
        (l.debit_cents-bank_completion_active_claims('reserve_lot',e.id||':'||l.role))::text AS available_cents
        FROM bank_journal_entry e JOIN bank_journal_line l ON l.entry_id=e.id
        WHERE e.kind='merchant_settlement' AND l.role ~ '^counterpart_[0-9]+$'
          AND e.source_snapshot->'settlement'->'lines'->(substring(l.role FROM '^counterpart_([0-9]+)$')::int)->>'kind'='reserve_hold'
          AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)
          AND (e.id ILIKE $1 OR e.reference ILIKE $1)
        ORDER BY e.day DESC,e.id,l.role LIMIT 101`,
          [search]
        )
      ).rows;
    } else {
      rows = (
        await client.query(
          `SELECT p.id,COALESCE(p.reference,p.display_id::text,p.id) AS reference,p.batch_day AS day,
        p.amount::numeric::text AS amount_cents,l.account_list_id,l.account_snapshot->>'name' AS account_name,
        (p.amount::numeric-bank_completion_active_claims('payment_funding',p.id)-bank_completion_legacy_reserved('payment_funding',p.id))::text AS available_cents
        FROM customer_payment p LEFT JOIN bank_journal_entry e ON e.completion_id=p.id AND e.kind='merchant_receipt'
          AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)
        LEFT JOIN bank_journal_line l ON l.entry_id=e.id AND l.role='clearing'
        WHERE p.deleted_at IS NULL AND p.source='pos' AND p.type='payment' AND upper(p.currency)='USD'
          AND p.method IN ('credit_card','debit_card','card') AND p.status IN ('available','partially_applied','applied')
          AND ($2::boolean=false OR e.id IS NOT NULL)
          AND (p.id ILIKE $1 OR p.reference ILIKE $1 OR p.display_id::text ILIKE $1)
        ORDER BY p.batch_day DESC NULLS LAST,p.id LIMIT 101`,
          [search, kind === "receipt"]
        )
      ).rows;
    }
    return {
      sources: rows.slice(0, 100).map((row) => ({
        ...row,
        kind,
        amount_cents: Number(row.amount_cents),
        available_cents:
          row.available_cents == null ? null : Number(row.available_cents),
      })),
      more: rows.length > 100,
    };
  });
}
