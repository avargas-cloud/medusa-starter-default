import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { BUSINESS_TIMEZONE } from "../../../../../lib/date/et";
import { activeEntryPredicate } from "../../../../../lib/ledger/reports";
import {
  dbFrom,
  invalidRange,
  isDay,
  queryString,
  requireAccountingOr403,
} from "../../../../../lib/ledger/reports/route-common";

interface MonthRow {
  month: string;
  taxable_sales_cents: string;
  exempt_sales_cents: string;
  tax_collected_cents: string;
  payments_cents: string;
}

interface CustomerRow {
  customer_id: string;
  name: string | null;
  exempt_sales_cents: string;
}

interface PayableRow {
  payable_opening_cents: string;
  payable_closing_cents: string;
}

/**
 * Sources that CREATE the liability (invoices / credit memos, POS or the QB
 * import of the same families). Everything else that debits the payable in
 * range — sales tax payments, adjusting journals — counts as a payment.
 */
const LIABILITY_SOURCE_SQL = `(
  e.source_kind IN ('pos_invoice', 'pos_credit_memo')
  OR (e.source_kind = 'qb_import' AND e.source_snapshot->>'txn_type'
        IN ('Invoice', 'Sales Receipt', 'Credit Memo', 'Credit Card Refund'))
)`;

/**
 * Sales tax report over `[from, to]` (business dates in `BUSINESS_TIMEZONE`).
 * Sales come from the documents — `pos_invoice` issued in range (voided
 * excluded) minus `pos_credit_memo` completed in range — split taxable /
 * exempt by `pos_invoice_item.taxable` × line net (`net_total_cents`, else
 * `total`). The payable's opening/closing and the payments come from the
 * journal on the `sales_tax_payable` account of `gl_account_map`.
 * `tax_rate_pct` is the EFFECTIVE rate (collected ÷ taxable), null when
 * nothing taxable was sold.
 */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  if (!(await requireAccountingOr403(req, res))) return;

  const from = queryString(req, "from");
  const to = queryString(req, "to");
  if (!isDay(from) || !isDay(to) || from > to) return invalidRange(res);

  const db = dbFrom(req);
  const tz = BUSINESS_TIMEZONE;

  const mapResult = await db.raw(
    `SELECT qb_list_id FROM gl_account_map WHERE key = 'sales_tax_payable'`
  );
  const payableListId =
    (mapResult.rows as Array<{ qb_list_id: string }>)[0]?.qb_list_id ?? null;
  if (!payableListId) {
    return res.status(409).json({
      error: "gl_account_map has no sales_tax_payable account",
      code: "GL_ACCOUNT_MAP_MISSING",
    });
  }

  const salesSql = `
    WITH inv AS (
      SELECT v.id, v.customer_id, ROUND(v.tax)::bigint AS tax,
             to_char((v.issued_at AT TIME ZONE ?)::date, 'YYYY-MM') AS month
        FROM pos_invoice v
       WHERE v.deleted_at IS NULL AND v.voided_at IS NULL AND v.status <> 'voided'
         AND v.issued_at IS NOT NULL
         AND (v.issued_at AT TIME ZONE ?)::date BETWEEN ?::date AND ?::date
    ),
    inv_lines AS (
      SELECT inv.month, inv.customer_id,
             SUM(CASE WHEN i.taxable THEN ROUND(COALESCE(i.net_total_cents, i.total)) ELSE 0 END)::bigint AS taxable,
             SUM(CASE WHEN i.taxable THEN 0 ELSE ROUND(COALESCE(i.net_total_cents, i.total)) END)::bigint AS exempt
        FROM pos_invoice_item i
        JOIN inv ON inv.id = i.invoice_id
       WHERE i.deleted_at IS NULL
       GROUP BY inv.month, inv.customer_id
    ),
    cm AS (
      SELECT c.id, c.customer_id, ROUND(c.tax)::bigint AS tax,
             to_char((c.completed_at AT TIME ZONE ?)::date, 'YYYY-MM') AS month
        FROM pos_credit_memo c
       WHERE c.deleted_at IS NULL AND c.voided_at IS NULL AND c.status = 'completed'
         AND c.completed_at IS NOT NULL
         AND (c.completed_at AT TIME ZONE ?)::date BETWEEN ?::date AND ?::date
    ),
    cm_lines AS (
      SELECT cm.month, cm.customer_id,
             SUM(CASE WHEN i.taxable THEN ROUND(i.line_total) ELSE 0 END)::bigint AS taxable,
             SUM(CASE WHEN i.taxable THEN 0 ELSE ROUND(i.line_total) END)::bigint AS exempt
        FROM pos_credit_memo_item i
        JOIN cm ON cm.id = i.credit_memo_id
       WHERE i.deleted_at IS NULL
       GROUP BY cm.month, cm.customer_id
    ),
    sales AS (
      SELECT month, customer_id, taxable, exempt, 0::bigint AS tax FROM inv_lines
      UNION ALL SELECT month, customer_id, 0, 0, tax FROM inv
      UNION ALL SELECT month, customer_id, -taxable, -exempt, 0 FROM cm_lines
      UNION ALL SELECT month, customer_id, 0, 0, -tax FROM cm
    ),
    payments AS (
      SELECT to_char(e.day::date, 'YYYY-MM') AS month,
             COALESCE(SUM(l.debit_cents), 0)::bigint AS cents
        FROM bank_journal_line l
        JOIN bank_journal_entry e ON e.id = l.entry_id
       WHERE l.deleted_at IS NULL AND ${activeEntryPredicate("e")}
         AND l.account_list_id = ? AND e.day >= ? AND e.day <= ?
         AND NOT ${LIABILITY_SOURCE_SQL}
       GROUP BY 1
    )`;
  const salesBindings = [
    tz,
    tz,
    from,
    to,
    tz,
    tz,
    from,
    to,
    payableListId,
    from,
    to,
  ];

  const [monthsResult, customersResult, payableResult] = await Promise.all([
    db.raw(
      `${salesSql}
       SELECT m.month,
              COALESCE(s.taxable, 0)::text AS taxable_sales_cents,
              COALESCE(s.exempt, 0)::text AS exempt_sales_cents,
              COALESCE(s.tax, 0)::text AS tax_collected_cents,
              COALESCE(p.cents, 0)::text AS payments_cents
         FROM (SELECT month FROM sales UNION SELECT month FROM payments) m
         LEFT JOIN (SELECT month, SUM(taxable) taxable, SUM(exempt) exempt, SUM(tax) tax
                      FROM sales GROUP BY month) s ON s.month = m.month
         LEFT JOIN payments p ON p.month = m.month
        ORDER BY m.month`,
      salesBindings
    ),
    db.raw(
      `${salesSql}
       SELECT s.customer_id,
              COALESCE(NULLIF(TRIM(cu.company_name), ''),
                       NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), ''),
                       cu.email) AS name,
              SUM(s.exempt)::text AS exempt_sales_cents
         FROM sales s
         LEFT JOIN customer cu ON cu.id = s.customer_id
        WHERE s.customer_id IS NOT NULL
        GROUP BY s.customer_id, cu.company_name, cu.first_name, cu.last_name, cu.email
       HAVING SUM(s.exempt) <> 0
        ORDER BY SUM(s.exempt) DESC
        LIMIT 10`,
      salesBindings
    ),
    db.raw(
      `SELECT (-COALESCE(SUM(CASE WHEN e.day < ? THEN l.debit_cents - l.credit_cents ELSE 0 END), 0))::text AS payable_opening_cents,
              (-COALESCE(SUM(l.debit_cents - l.credit_cents), 0))::text AS payable_closing_cents
         FROM bank_journal_line l
         JOIN bank_journal_entry e ON e.id = l.entry_id
        WHERE l.deleted_at IS NULL AND ${activeEntryPredicate("e")}
          AND l.account_list_id = ? AND e.day <= ?`,
      [from, payableListId, to]
    ),
  ]);

  const months = monthsResult.rows as unknown as MonthRow[];
  const customers = customersResult.rows as unknown as CustomerRow[];
  const payable: PayableRow = (
    payableResult.rows as unknown as PayableRow[]
  )[0] ?? {
    payable_opening_cents: "0",
    payable_closing_cents: "0",
  };

  const sum = (pick: (m: MonthRow) => string) =>
    months.reduce((acc, m) => acc + BigInt(pick(m)), 0n);
  const taxable = sum((m) => m.taxable_sales_cents);
  const exempt = sum((m) => m.exempt_sales_cents);
  const collected = sum((m) => m.tax_collected_cents);
  const payments = sum((m) => m.payments_cents);
  const ratePct =
    taxable > 0n
      ? Math.round((Number(collected) / Number(taxable)) * 10000) / 100
      : null;

  return res.json({
    from,
    to,
    sales_tax_payable_list_id: payableListId,
    taxable_sales_cents: taxable.toString(),
    exempt_sales_cents: exempt.toString(),
    tax_collected_cents: collected.toString(),
    tax_rate_pct: ratePct,
    payable_opening_cents: payable.payable_opening_cents,
    payable_closing_cents: payable.payable_closing_cents,
    payments_cents: payments.toString(),
    by_month: months.map((m) => ({
      month: m.month,
      taxable_sales_cents: m.taxable_sales_cents,
      exempt_sales_cents: m.exempt_sales_cents,
      tax_collected_cents: m.tax_collected_cents,
      payments_cents: m.payments_cents,
    })),
    top_exempt_customers: customers.map((c) => ({
      customer_id: c.customer_id,
      name: c.name,
      exempt_sales_cents: c.exempt_sales_cents,
    })),
  });
}
