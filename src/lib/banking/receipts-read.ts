import type { PoolClient } from "pg";
import { paymentReceiptSource, type ReceiptEvidence } from "./receipts-source";
import { depositReceiptSource, matchReceiptSource } from "./receipts-transfer";
import { receiptRead } from "./receipts-setup";
import { paymentReservedCentsSql } from "./payment-evidence";
import type { ReceiptContext, ReceiptJournal, ReceiptOrigin } from "./receipts-types";

export const receiptEvidence = (client: PoolClient, kind: ReceiptOrigin, id: string): Promise<ReceiptEvidence> =>
  kind === "receipt" ? paymentReceiptSource(client, id) : kind === "deposit" ? depositReceiptSource(client, id) : matchReceiptSource(client, id);
export async function receiptHistory(client: PoolClient, kind: ReceiptOrigin, id: string, hash: string): Promise<ReceiptJournal[]> {
  return (await client.query<ReceiptJournal>(`SELECT e.id,e.kind,e.day,e.amount_cents::float8 AS amount_cents,e.reference,
    e.description,e.source_hash,e.reverses_entry_id,e.reason,e.created_at,
    (SELECT id FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id) AS reversed_by,(e.source_hash<>$3) AS stale,
    (SELECT jsonb_agg(jsonb_build_object('role',l.role,'account_list_id',l.account_list_id,'account_snapshot',l.account_snapshot,
      'account_name',l.account_snapshot->>'name','account_type',l.account_snapshot->>'account_type',
      'debit_cents',l.debit_cents,'credit_cents',l.credit_cents) ORDER BY l.role)
      FROM bank_journal_line l WHERE l.entry_id=e.id) AS lines
    FROM bank_journal_entry e LEFT JOIN bank_receipt_accounting a ON a.id=e.receipt_id
    WHERE ($1='receipt' AND a.payment_id=$2) OR ($1='deposit' AND e.deposit_id=$2)
      OR ($1='payment_match' AND e.transaction_id=$2 AND (e.kind='payment_match' OR
        EXISTS(SELECT 1 FROM bank_journal_entry o WHERE o.id=e.reverses_entry_id AND o.kind='payment_match')))
    ORDER BY e.created_at,e.id`, [kind, id, hash])).rows;
}
export async function receiptContext(client: PoolClient, kind: ReceiptOrigin, id: string): Promise<ReceiptContext> {
  const evidence = await receiptEvidence(client, kind, id);
  const history = await receiptHistory(client, kind, id, evidence.source_hash);
  const posting = history.filter(e => e.kind === kind).at(-1) ?? null;
  let consumed = 0, available = 0;
  if (kind === "receipt") {
    const capacity = (await client.query<{ consumed: string; reserved: string }>(`SELECT
      (SELECT COALESCE(SUM(c.amount_cents),0) FROM bank_receipt_consumption c WHERE c.payment_id=$1
        AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=c.entry_id)) AS consumed,
      COALESCE((SELECT ${paymentReservedCentsSql()} FROM customer_payment mp WHERE mp.id=$1),0) AS reserved`, [id])).rows[0];
    consumed = Number(capacity?.consumed ?? 0);
    available = posting && !posting.reversed_by && !posting.stale && !evidence.blockers.length
      ? Math.max(0, posting.amount_cents - Number(capacity?.reserved ?? 0)) : 0;
  }
  if (posting?.stale && !posting.reversed_by) evidence.blockers.push("BANKING_RECEIPT_SOURCE_DRIFT");
  return { source: evidence.source, source_hash: evidence.source_hash, eligible: evidence.blockers.length === 0,
    blockers: [...new Set(evidence.blockers)], posting, history, consumed_cents: consumed, available_cents: available,
    opening_pending: true, coverage: "partial" };
}
export const readReceiptAccounting = (kind: ReceiptOrigin, id: string) => receiptRead(client => receiptContext(client, kind, id));
export type ReceiptFilters = { offset: number; limit: number; from?: string; to?: string };
export const listReceiptAccounting = (kind: ReceiptOrigin, filters: ReceiptFilters) => receiptRead(async client => {
  // Posted identities drive exception coverage even after sources are deleted or refunded.
  const query = kind === "receipt" ? `SELECT COALESCE(a.payment_id,mp.id) AS id,COALESCE(posted.day,mp.batch_day,'') AS day
    FROM customer_payment mp FULL JOIN bank_receipt_accounting a ON a.payment_id=mp.id
    LEFT JOIN LATERAL(SELECT MIN(e.day) AS day FROM bank_journal_entry e WHERE e.receipt_id=a.id AND e.kind='receipt') posted ON true
    WHERE a.id IS NOT NULL OR (mp.source='pos' AND mp.type='payment' AND mp.method IN ('cash','check','ach','zelle'))`
    : kind === "deposit" ? `SELECT id,deposit_date AS day FROM bank_deposit WHERE deleted_at IS NULL
      UNION SELECT d.id,d.deposit_date AS day FROM bank_deposit d JOIN bank_journal_entry e ON e.deposit_id=d.id`
      : `SELECT t.id,t.transaction_date AS day FROM bank_transaction t JOIN bank_transaction_review r ON r.transaction_id=t.id
        WHERE r.matched_payment_id IS NOT NULL AND r.deleted_at IS NULL
        UNION SELECT t.id,t.transaction_date AS day FROM bank_journal_entry e JOIN bank_transaction t ON t.id=e.transaction_id WHERE e.kind='payment_match'`;
  const result = (await client.query<{ count: number; items: Array<{ id: string }> }>(`WITH sources AS (${query}),
    matching AS (SELECT * FROM sources WHERE ($1::text IS NULL OR day>=$1) AND ($2::text IS NULL OR day<=$2)),
    page AS (SELECT * FROM matching ORDER BY day DESC,id DESC LIMIT $3 OFFSET $4)
    SELECT (SELECT COUNT(*)::int FROM matching) AS count,
      COALESCE((SELECT jsonb_agg(page ORDER BY day DESC,id DESC) FROM page),'[]'::jsonb) AS items`,
  [filters.from ?? null, filters.to ?? null, filters.limit, filters.offset])).rows[0]!;
  const items: ReceiptContext[] = [];
  for (const row of result.items) items.push(await receiptContext(client, kind, row.id));
  return { items, count: result.count };
});
