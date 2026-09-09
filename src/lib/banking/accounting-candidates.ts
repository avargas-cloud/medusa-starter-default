import type { PoolClient } from "pg";

import type { SourceContext } from "./accounting-source";
import type { DuplicateCandidate, ExpenseDraft } from "./accounting-types";
import { reviewHash } from "./review-common";
import { reviewDate } from "./review-date";
import { BankingError } from "./security";

type CandidateRow = {
  kind: DuplicateCandidate["kind"];
  id: string;
  reference: string;
  amount_cents: string;
  day: string;
  state: string;
};

/** Suggestions never establish identity. Exact source IDs are explicit links; all other hints require a reason. */
export async function expenseCandidates(
  client: PoolClient,
  context: SourceContext,
  reference = ""
): Promise<DuplicateCandidate[]> {
  const { source } = context;
  // Invalid bank evidence is already blocked by accountingSource. Do not let a
  // malformed provider date make posted history (or its reversal) unreadable.
  if (!reviewDate.safeParse(source.day).success) return [];
  const rows = (
    await client.query<CandidateRow>(
      `WITH bills AS (
    SELECT vb.id,COALESCE(vb.number,vb.reference_id,vb.id) AS reference,
      COALESCE(vb.document_date,vb.created_at) AS dated,vb.status AS state,vb.vendor_id,vb.reference_id,
      COALESCE((SELECT SUM(COALESCE(l.amount_cents,ROUND(l.qty*l.unit_cost_cents)))
        FROM vendor_bill_line l WHERE l.vendor_bill_id=vb.id AND l.deleted_at IS NULL),0)::bigint AS cents
    FROM vendor_bill vb WHERE vb.deleted_at IS NULL AND vb.status IN ('draft','confirmed','synced')
  ), candidates AS (
    SELECT 'vendor_bill'::text AS kind,id,reference,cents AS amount_cents,
      (dated AT TIME ZONE 'America/New_York')::date::text AS day,state
      FROM bills WHERE ($4::text<>'' AND ($4=id OR $4='vendor_bill:'||id OR lower($4)=lower(reference) OR lower($4)=lower(reference_id)))
        OR (dated >= ($1::date-45)::timestamp AT TIME ZONE 'America/New_York'
          AND dated < ($1::date+46)::timestamp AT TIME ZONE 'America/New_York'
          AND (cents=$2::bigint OR ($3::text IS NOT NULL AND vendor_id=$3)))
    UNION ALL
    SELECT 'payroll',month,month,amount_cents::bigint,month||'-01','manual'
      FROM pos_monthly_payroll WHERE month=left($1::text,7)
         OR $4::text='payroll:'||month
    UNION ALL
    SELECT 'wire',id,id,wire_amount_cents::bigint,sent_date::text,status
      FROM china_wire_transfer WHERE ($4::text=id OR $4::text='wire:'||id)
        OR (wire_amount_cents=$2::bigint AND sent_date BETWEEN ($1::date-45) AND ($1::date+45))
  ) SELECT * FROM candidates ORDER BY kind,day,id LIMIT 201`,
      [
        source.day,
        source.amount_cents ?? 0,
        context.counterparty_type === "vendor" ? context.counterparty_id : null,
        reference,
      ]
    )
  ).rows;
  if (rows.length > 200)
    throw new BankingError("BANKING_EXPENSE_TOO_MANY_CANDIDATES", 409);
  return rows.map((row) => ({
    key: `${row.kind}:${row.id}`,
    kind: row.kind,
    id: row.id,
    reference: row.reference,
    amount_cents: Number(row.amount_cents),
    day: row.day,
    link_path:
      row.kind === "vendor_bill"
        ? `/vendor-bills/${row.id}`
        : row.kind === "wire"
          ? "/china-finance"
          : "/reports/profit-loss",
    definite:
      reference === `${row.kind}:${row.id}` ||
      (row.kind !== "payroll" && reference === row.id),
    fingerprint: reviewHash(row),
  }));
}

export function validateExpenseResolutions(
  draft: ExpenseDraft,
  candidates: DuplicateCandidate[]
): void {
  if (draft.nature !== "new_direct_expense" || !draft.attested)
    throw new BankingError("BANKING_EXPENSE_ATTESTATION_REQUIRED", 409);
  if (
    new Set(draft.dismissals.map((d) => d.key)).size !== draft.dismissals.length
  )
    throw new BankingError("BANKING_EXPENSE_DUPLICATE_RESOLUTION", 409);
  const keys = new Set(candidates.map((c) => c.key));
  if (draft.dismissals.some((d) => !keys.has(d.key)))
    throw new BankingError("BANKING_EXPENSE_CANDIDATES_CHANGED", 409);
  for (const candidate of candidates) {
    if (candidate.definite)
      throw new BankingError("BANKING_EXPENSE_ALREADY_RECOGNIZED", 409);
    if (
      !draft.dismissals.some(
        (d) => d.key === candidate.key && d.reason.trim().length >= 8
      )
    ) {
      throw new BankingError("BANKING_EXPENSE_UNRESOLVED_CANDIDATE", 409);
    }
  }
}
