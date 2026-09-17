import { BillSettlementError, type PgClient } from "./types";

export interface PrepaymentRow {
  gl_check_id: string;
  doc_number: string;
  number: string | null;
  day: string; // YYYY-MM-DD
  bank_account_name: string | null;
  memo: string | null;
  gl_check_line_id: string;
  account_list_id: string;
  account_name: string;
  line_amount_cents: number;
  consumed_cents: number;
  remaining_cents: number;
}

/**
 * Every posted check/expense line of `vendorId` against its
 * OtherCurrentAsset (prepayment) account, net of what has already been
 * consumed (live `vendor_prepayment_consumption`), that still has money
 * left to settle a bill with.
 */
export async function listVendorPrepayments(client: PgClient, vendorId: string): Promise<PrepaymentRow[]> {
  const { rows } = await client.query(
    `SELECT
       c.id AS gl_check_id,
       c.doc_number,
       c.number,
       c.day::text AS day,
       c.bank_account_snapshot->>'name' AS bank_account_name,
       c.memo,
       l.id AS gl_check_line_id,
       l.account_list_id,
       a.full_name AS account_name,
       l.amount_cents AS line_amount_cents,
       COALESCE(v.consumed_cents, 0) AS consumed_cents,
       l.amount_cents - COALESCE(v.consumed_cents, 0) AS remaining_cents
     FROM gl_check c
     JOIN gl_check_line l ON l.check_id = c.id
     JOIN qb_account a ON a.qb_list_id = l.account_list_id AND a.account_type = 'OtherCurrentAsset'
     LEFT JOIN (
       SELECT gl_check_line_id, SUM(consumed_cents) AS consumed_cents
         FROM vendor_prepayment_consumption
        WHERE voided_at IS NULL
        GROUP BY gl_check_line_id
     ) v ON v.gl_check_line_id = l.id
    WHERE c.status = 'posted'
      AND c.deleted_at IS NULL
      AND c.payee_type = 'vendor'
      AND c.payee_id = $1
      AND l.amount_cents - COALESCE(v.consumed_cents, 0) > 0
    ORDER BY c.day DESC, c.doc_number`,
    [vendorId]
  );
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    gl_check_id: r.gl_check_id as string,
    doc_number: r.doc_number as string,
    number: (r.number as string | null) ?? null,
    day: r.day as string,
    bank_account_name: (r.bank_account_name as string | null) ?? null,
    memo: (r.memo as string | null) ?? null,
    gl_check_line_id: r.gl_check_line_id as string,
    account_list_id: r.account_list_id as string,
    account_name: r.account_name as string,
    line_amount_cents: Number(r.line_amount_cents),
    consumed_cents: Number(r.consumed_cents),
    remaining_cents: Number(r.remaining_cents),
  }));
}

/**
 * Row-locks a check line and validates it is eligible to fund a settlement:
 * posted, non-void, payee = `vendorId`, and its account is OtherCurrentAsset.
 * Called INSIDE a transaction the caller (settle.ts) already opened — this
 * is the early, readable message; the DEFINITIVE capacity re-check (against
 * the race with a concurrent settlement) lives in
 * `vendor-credits/create.ts`, under its own `FOR UPDATE OF l` at insert time.
 */
export async function lockPrepaymentLine(
  client: PgClient,
  glCheckLineId: string,
  vendorId: string
): Promise<{ check_id: string; account_list_id: string; account_name: string; remaining_cents: number }> {
  const { rows } = await client.query(
    `SELECT c.id AS check_id, c.status, c.deleted_at, c.voided_at, c.payee_type, c.payee_id,
            l.amount_cents, l.account_list_id
       FROM gl_check_line l
       JOIN gl_check c ON c.id = l.check_id
      WHERE l.id = $1 FOR UPDATE OF l`,
    [glCheckLineId]
  );
  const row = rows[0] as
    | {
        check_id: string;
        status: string;
        deleted_at: string | null;
        voided_at: string | null;
        payee_type: string;
        payee_id: string | null;
        amount_cents: number;
        account_list_id: string;
      }
    | undefined;
  if (
    !row ||
    row.deleted_at ||
    row.voided_at ||
    row.status !== "posted" ||
    row.payee_type !== "vendor" ||
    row.payee_id !== vendorId
  ) {
    throw new BillSettlementError(
      "prepayment_not_eligible",
      "This check line is not a posted, non-void check to this vendor.",
      409
    );
  }

  const { rows: accountRows } = await client.query(
    `SELECT qb_list_id, full_name FROM qb_account WHERE qb_list_id = $1 AND account_type = 'OtherCurrentAsset'`,
    [row.account_list_id]
  );
  const account = accountRows[0] as { qb_list_id: string; full_name: string } | undefined;
  if (!account) {
    throw new BillSettlementError(
      "prepayment_account_not_eligible",
      "This check line's account is not a vendor prepayment (OtherCurrentAsset) account.",
      409
    );
  }

  const { rows: consumedRows } = await client.query(
    `SELECT COALESCE(SUM(consumed_cents), 0)::bigint AS consumed
       FROM vendor_prepayment_consumption WHERE gl_check_line_id = $1 AND voided_at IS NULL`,
    [glCheckLineId]
  );
  const consumed = Number((consumedRows[0] as { consumed: number }).consumed);
  const remaining = Number(row.amount_cents) - consumed;

  return {
    check_id: row.check_id,
    account_list_id: account.qb_list_id,
    account_name: account.full_name,
    remaining_cents: remaining,
  };
}
