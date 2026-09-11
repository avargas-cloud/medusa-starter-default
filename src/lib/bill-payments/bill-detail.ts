import { computeBillBalance, type PgQueryClient } from "../finance/recompute-bill-finance";

export interface BillPaymentSummary {
  id: string;
  number: string | null;
  payment_date: string;
  method: string;
  reference: string | null;
  amount_cents: number;
  bank_account_list_id: string;
}

export interface BillCreditApplicationSummary {
  id: string;
  credit_number: string | null;
  applied_at: string;
  amount_cents: number;
}

/**
 * Everything `GET /admin/vendor-bills/:id` needs to show a bill's AP state:
 * the balance (plan §3) plus the active payments/credits that make it up.
 * Only active rows (`p.status = 'posted'`, `voided_at IS NULL`) — the same
 * filters `computeBillBalance` sums.
 */
export async function loadVendorBillPayablesDetail(
  client: PgQueryClient,
  vendorBillId: string
): Promise<{
  balance: Awaited<ReturnType<typeof computeBillBalance>>;
  payments: BillPaymentSummary[];
  credit_applications: BillCreditApplicationSummary[];
}> {
  const [balance, paymentsResult, applicationsResult] = await Promise.all([
    computeBillBalance(client, vendorBillId),
    client.query(
      `SELECT p.id, p.number, p.payment_date, p.method, p.reference, a.amount_cents, p.bank_account_list_id
         FROM vendor_bill_payment_allocation a
         JOIN vendor_bill_payment p ON p.id = a.payment_id
        WHERE a.vendor_bill_id = $1 AND p.status = 'posted'
        ORDER BY p.posted_at DESC`,
      [vendorBillId]
    ),
    client.query(
      `SELECT ca.id, vc.number AS credit_number, ca.applied_at, ca.amount_cents
         FROM vendor_credit_application ca
         JOIN vendor_credit vc ON vc.id = ca.credit_id
        WHERE ca.vendor_bill_id = $1 AND ca.voided_at IS NULL
        ORDER BY ca.applied_at DESC`,
      [vendorBillId]
    ),
  ]);

  return {
    balance,
    payments: paymentsResult.rows as BillPaymentSummary[],
    credit_applications: applicationsResult.rows as BillCreditApplicationSummary[],
  };
}
