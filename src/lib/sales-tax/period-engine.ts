import type { PoolClient } from "pg";

import { BUSINESS_TIMEZONE, getBusinessDateString } from "../date/et";
import { activeEntryPredicate } from "../ledger/reports/active-entries";

import { filingDueDates, filingUrgency, nextPeriod, periodBounds, type FilingDueDates, type FilingUrgency } from "./due-dates";
import { collectionAllowanceCents, remittance, signedAdjustment, splitStateSurtax, type AdjustmentType, type RemittanceBreakdown } from "./remittance";
import type { SalesTaxSettings } from "./settings";

/**
 * Motor de períodos del Sales Tax Center (sales-tax-center-20260917).
 *
 * TRES cifras separadas, nunca una sola "deuda":
 *   1. la declaración, derivada de las FACTURAS (`pos_invoice` emitidas menos
 *      `pos_credit_memo` completados) — es lo que va al DR-15;
 *   2. el LIBRO: lo que el payable acumuló en el mes calendario por las
 *      fuentes que crean la deuda (facturas/CM del POS y las importadas de QB);
 *   3. la REMESA: tax due ± los ajustes STA del período.
 *   La diferencia 1 vs 2 es la `variance` y se muestra con nombre.
 *
 * Exentos (corrige el reporte de Reports → Sales Tax): una factura con
 * `tax = 0` que tiene ítems gravables es una venta a cliente exento (resale) y
 * va ENTERA a la línea B — antes contaba como gravable, y en agosto 2026 eran
 * $19.7k de 50 facturas.
 */

export interface SalesFigures {
  invoices: number;
  credit_memos: number;
  gross_cents: bigint;
  exempt_items_cents: bigint;
  exempt_customer_cents: bigint;
  exempt_cents: bigint;
  taxable_cents: bigint;
  tax_collected_cents: bigint;
  /** Líneas gravables con neto > $5,000 (tope del surtax por ítem: se avisa, no se modela). */
  over_surtax_cap_lines: number;
}

export interface GlFigures {
  liability_cents: bigint;
  payments_cents: bigint;
  adjustments_cents: bigint;
  other_cents: bigint;
  closing_balance_cents: bigint;
}

export interface PeriodAdjustmentSummary {
  id: string;
  doc_number: string;
  type: AdjustmentType;
  direction: "decrease" | "increase";
  amount_cents: string;
  signed_cents: string;
  applied_payment_id: string | null;
  qb_txn_id: string | null;
  qb_source: "adopted" | null;
}

export interface PeriodPaymentSummary {
  id: string;
  doc_number: string;
  day: string;
  total_cents: string;
  tax_cents: string;
  status: "draft" | "posted" | "voided";
  qb_txn_id: string | null;
  qb_source: "adopted" | null;
  reference: string | null;
  bank_account_name: string;
}

export type ReturnStatus = "open" | "ready" | "filed";
export type PaymentStatus = "unpaid" | "pending_qb" | "paid";

export interface PeriodSummary {
  period: string;
  sales: Record<keyof SalesFigures, string | number>;
  gl: Record<keyof GlFigures, string>;
  variance_cents: string;
  state_tax_cents: string;
  surtax_cents: string;
  allowance_suggested_cents: string;
  remittance: Record<keyof RemittanceBreakdown, string>;
  adjustments: PeriodAdjustmentSummary[];
  payments: PeriodPaymentSummary[];
  paid_cents: string;
  return_status: ReturnStatus;
  payment_status: PaymentStatus;
  due: FilingDueDates;
  urgency: FilingUrgency;
  return: { id: string; status: "ready" | "filed"; prepared_at: string; filed_at: string | null; confirmation_number: string | null; filed_amount_cents: string | null } | null;
}

const LIABILITY_SOURCE_SQL = `(e.source_kind IN ('pos_invoice','pos_credit_memo')
  OR (e.source_kind = 'qb_import' AND e.source_snapshot->>'txn_type' IN ('Invoice','Sales Receipt','Credit Memo','Credit Card Refund')))`;
const PAYMENT_SOURCE_SQL = `(e.source_kind = 'sales_tax_payment'
  OR (e.source_kind = 'qb_import' AND e.source_snapshot->>'txn_type' = 'Sales Tax Payment'))`;
const ADJUSTMENT_SOURCE_SQL = `(e.source_kind IN ('sales_tax_adjustment','journal_entry')
  OR (e.source_kind = 'qb_import' AND e.source_snapshot->>'txn_type' = 'General Journal'))`;

const SALES_SQL = `
  WITH inv AS (
    SELECT v.id, ROUND(v.tax)::bigint AS tax, to_char((v.issued_at AT TIME ZONE $1)::date, 'YYYY-MM') AS month
      FROM pos_invoice v
     WHERE v.deleted_at IS NULL AND v.voided_at IS NULL AND v.status <> 'voided' AND v.issued_at IS NOT NULL
       AND to_char((v.issued_at AT TIME ZONE $1)::date, 'YYYY-MM') BETWEEN $2 AND $3
  ),
  inv_lines AS (
    SELECT inv.id, inv.month, inv.tax,
           COALESCE(SUM(CASE WHEN i.taxable THEN ROUND(COALESCE(i.net_total_cents, i.total)) ELSE 0 END), 0)::bigint AS taxable_items,
           COALESCE(SUM(CASE WHEN i.taxable THEN 0 ELSE ROUND(COALESCE(i.net_total_cents, i.total)) END), 0)::bigint AS exempt_items,
           COUNT(*) FILTER (WHERE i.taxable AND ROUND(COALESCE(i.net_total_cents, i.total)) > 500000) AS over_cap
      FROM inv LEFT JOIN pos_invoice_item i ON i.invoice_id = inv.id AND i.deleted_at IS NULL
     GROUP BY inv.id, inv.month, inv.tax
  ),
  cm AS (
    SELECT c.id, ROUND(c.tax)::bigint AS tax, to_char((c.completed_at AT TIME ZONE $1)::date, 'YYYY-MM') AS month
      FROM pos_credit_memo c
     WHERE c.deleted_at IS NULL AND c.voided_at IS NULL AND c.status = 'completed' AND c.completed_at IS NOT NULL
       AND to_char((c.completed_at AT TIME ZONE $1)::date, 'YYYY-MM') BETWEEN $2 AND $3
  ),
  cm_lines AS (
    SELECT cm.id, cm.month, cm.tax,
           COALESCE(SUM(CASE WHEN i.taxable THEN ROUND(i.line_total) ELSE 0 END), 0)::bigint AS taxable_items,
           COALESCE(SUM(CASE WHEN i.taxable THEN 0 ELSE ROUND(i.line_total) END), 0)::bigint AS exempt_items
      FROM cm LEFT JOIN pos_credit_memo_item i ON i.credit_memo_id = cm.id AND i.deleted_at IS NULL
     GROUP BY cm.id, cm.month, cm.tax
  ),
  docs AS (
    SELECT month, 1 AS inv_n, 0 AS cm_n, tax,
           CASE WHEN tax = 0 AND taxable_items > 0 THEN 0 ELSE taxable_items END AS taxable,
           exempt_items AS exempt_items,
           CASE WHEN tax = 0 AND taxable_items > 0 THEN taxable_items ELSE 0 END AS exempt_customer,
           over_cap
      FROM inv_lines
    UNION ALL
    SELECT month, 0, 1, -tax,
           CASE WHEN tax = 0 AND taxable_items > 0 THEN 0 ELSE -taxable_items END,
           -exempt_items,
           CASE WHEN tax = 0 AND taxable_items > 0 THEN -taxable_items ELSE 0 END,
           0
      FROM cm_lines
  )
  SELECT month, SUM(inv_n)::int AS invoices, SUM(cm_n)::int AS credit_memos,
         SUM(taxable)::text AS taxable_cents, SUM(exempt_items)::text AS exempt_items_cents,
         SUM(exempt_customer)::text AS exempt_customer_cents, SUM(tax)::text AS tax_collected_cents,
         SUM(over_cap)::int AS over_surtax_cap_lines
    FROM docs GROUP BY month`;

interface SalesRow {
  month: string;
  invoices: number;
  credit_memos: number;
  taxable_cents: string;
  exempt_items_cents: string;
  exempt_customer_cents: string;
  tax_collected_cents: string;
  over_surtax_cap_lines: number;
}

export async function loadSalesFigures(client: PoolClient, fromPeriod: string, toPeriod: string): Promise<Map<string, SalesFigures>> {
  const { rows } = await client.query<SalesRow>(SALES_SQL, [BUSINESS_TIMEZONE, fromPeriod, toPeriod]);
  const out = new Map<string, SalesFigures>();
  for (const r of rows) {
    const taxable = BigInt(r.taxable_cents);
    const exemptItems = BigInt(r.exempt_items_cents);
    const exemptCustomer = BigInt(r.exempt_customer_cents);
    out.set(r.month, {
      invoices: r.invoices,
      credit_memos: r.credit_memos,
      gross_cents: taxable + exemptItems + exemptCustomer,
      exempt_items_cents: exemptItems,
      exempt_customer_cents: exemptCustomer,
      exempt_cents: exemptItems + exemptCustomer,
      taxable_cents: taxable,
      tax_collected_cents: BigInt(r.tax_collected_cents),
      over_surtax_cap_lines: r.over_surtax_cap_lines,
    });
  }
  return out;
}

const emptySales = (): SalesFigures => ({
  invoices: 0, credit_memos: 0, gross_cents: 0n, exempt_items_cents: 0n, exempt_customer_cents: 0n,
  exempt_cents: 0n, taxable_cents: 0n, tax_collected_cents: 0n, over_surtax_cap_lines: 0,
});

interface GlRow {
  month: string;
  liability_cents: string;
  payments_cents: string;
  adjustments_cents: string;
  other_cents: string;
}

/** Movimientos del payable por mes calendario + saldo de cierre acumulado (toda la cuenta hasta fin de mes). */
export async function loadGlFigures(
  client: PoolClient,
  payableListId: string,
  fromPeriod: string,
  toPeriod: string
): Promise<Map<string, GlFigures>> {
  const { rows } = await client.query<GlRow>(
    `SELECT substr(e.day::text, 1, 7) AS month,
            COALESCE(SUM(CASE WHEN ${LIABILITY_SOURCE_SQL} THEN l.credit_cents - l.debit_cents ELSE 0 END), 0)::text AS liability_cents,
            COALESCE(SUM(CASE WHEN ${PAYMENT_SOURCE_SQL} THEN l.debit_cents - l.credit_cents ELSE 0 END), 0)::text AS payments_cents,
            COALESCE(SUM(CASE WHEN ${ADJUSTMENT_SOURCE_SQL} THEN l.debit_cents - l.credit_cents ELSE 0 END), 0)::text AS adjustments_cents,
            COALESCE(SUM(CASE WHEN NOT ${LIABILITY_SOURCE_SQL} AND NOT ${PAYMENT_SOURCE_SQL} AND NOT ${ADJUSTMENT_SOURCE_SQL}
                          THEN l.credit_cents - l.debit_cents ELSE 0 END), 0)::text AS other_cents
       FROM bank_journal_line l JOIN bank_journal_entry e ON e.id = l.entry_id
      WHERE l.deleted_at IS NULL AND ${activeEntryPredicate("e")} AND l.account_list_id = $1
        AND substr(e.day::text, 1, 7) <= $2
      GROUP BY 1 ORDER BY 1`,
    [payableListId, toPeriod]
  );
  const out = new Map<string, GlFigures>();
  let balance = 0n;
  for (const r of rows) {
    const liability = BigInt(r.liability_cents);
    const payments = BigInt(r.payments_cents);
    const adjustments = BigInt(r.adjustments_cents);
    const other = BigInt(r.other_cents);
    balance += liability - payments - adjustments + other;
    if (r.month >= fromPeriod) out.set(r.month, { liability_cents: liability, payments_cents: payments, adjustments_cents: adjustments, other_cents: other, closing_balance_cents: balance });
  }
  // meses sin movimiento heredan el saldo del anterior
  let carry = 0n;
  for (let p = fromPeriod; p <= toPeriod; p = nextPeriod(p)) {
    const g = out.get(p);
    if (g) carry = g.closing_balance_cents;
    else out.set(p, { liability_cents: 0n, payments_cents: 0n, adjustments_cents: 0n, other_cents: 0n, closing_balance_cents: carry });
  }
  return out;
}

interface AdjRow extends Omit<PeriodAdjustmentSummary, "signed_cents"> { period: string }
interface PayRow extends PeriodPaymentSummary { period: string }
interface ReturnRow { id: string; period: string; status: "ready" | "filed"; prepared_at: string; filed_at: string | null; confirmation_number: string | null; filed_amount_cents: string | null }

async function loadDocs(client: PoolClient, fromPeriod: string, toPeriod: string) {
  const [adj, pay, ret] = await Promise.all([
    client.query<AdjRow>(
      `SELECT id, doc_number, period, type, direction, amount_cents::text AS amount_cents, applied_payment_id, qb_txn_id, qb_source
         FROM gl_sales_tax_adjustment WHERE deleted_at IS NULL AND status = 'posted' AND period BETWEEN $1 AND $2
        ORDER BY day, doc_number`,
      [fromPeriod, toPeriod]
    ),
    client.query<PayRow>(
      `SELECT id, doc_number, period, day::text AS day, total_cents::text AS total_cents, tax_cents::text AS tax_cents, status,
              qb_txn_id, qb_source, reference, bank_account_snapshot->>'name' AS bank_account_name
         FROM gl_sales_tax_payment WHERE deleted_at IS NULL AND period BETWEEN $1 AND $2 ORDER BY day, doc_number`,
      [fromPeriod, toPeriod]
    ),
    client.query<ReturnRow>(
      `SELECT id, period, status, prepared_at::text AS prepared_at, filed_at::text AS filed_at, confirmation_number,
              filed_amount_cents::text AS filed_amount_cents
         FROM sales_tax_return WHERE period BETWEEN $1 AND $2`,
      [fromPeriod, toPeriod]
    ),
  ]);
  return { adjustments: adj.rows, payments: pay.rows, returns: ret.rows };
}

const s = (v: bigint | number): string => v.toString();

export async function listPeriods(
  client: PoolClient,
  settings: SalesTaxSettings,
  fromPeriod: string,
  toPeriod: string,
  today = getBusinessDateString()
): Promise<PeriodSummary[]> {
  const [sales, gl, docs] = await Promise.all([
    loadSalesFigures(client, fromPeriod, toPeriod),
    loadGlFigures(client, settings.accounts.payable_list_id, fromPeriod, toPeriod),
    loadDocs(client, fromPeriod, toPeriod),
  ]);
  const out: PeriodSummary[] = [];
  for (let p = fromPeriod; p <= toPeriod; p = nextPeriod(p)) {
    const sf = sales.get(p) ?? emptySales();
    const gf = gl.get(p)!;
    const adjustments = docs.adjustments.filter((a) => a.period === p).map((a) => ({
      ...a,
      signed_cents: s(signedAdjustment(a.direction, BigInt(a.amount_cents))),
    }));
    const payments = docs.payments.filter((x) => x.period === p);
    const live = payments.filter((x) => x.status === "posted");
    const paid = live.reduce((acc, x) => acc + BigInt(x.total_cents), 0n);
    const ret = docs.returns.find((r) => r.period === p) ?? null;
    const split = splitStateSurtax(sf.tax_collected_cents, settings.state_rate_bp, settings.surtax_rate_bp);
    const rem = remittance({
      tax_due_cents: sf.tax_collected_cents,
      adjustments: adjustments.map((a) => ({ type: a.type, signed_cents: BigInt(a.signed_cents) })),
    });
    const due = filingDueDates(p);
    out.push({
      period: p,
      sales: {
        invoices: sf.invoices, credit_memos: sf.credit_memos, gross_cents: s(sf.gross_cents),
        exempt_items_cents: s(sf.exempt_items_cents), exempt_customer_cents: s(sf.exempt_customer_cents),
        exempt_cents: s(sf.exempt_cents), taxable_cents: s(sf.taxable_cents), tax_collected_cents: s(sf.tax_collected_cents),
        over_surtax_cap_lines: sf.over_surtax_cap_lines,
      },
      gl: {
        liability_cents: s(gf.liability_cents), payments_cents: s(gf.payments_cents), adjustments_cents: s(gf.adjustments_cents),
        other_cents: s(gf.other_cents), closing_balance_cents: s(gf.closing_balance_cents),
      },
      variance_cents: s(gf.liability_cents - sf.tax_collected_cents),
      state_tax_cents: s(split.state_cents),
      surtax_cents: s(split.surtax_cents),
      allowance_suggested_cents: s(collectionAllowanceCents(sf.tax_collected_cents, true)),
      remittance: {
        tax_due_cents: s(rem.tax_due_cents), penalty_cents: s(rem.penalty_cents), interest_cents: s(rem.interest_cents),
        allowance_cents: s(rem.allowance_cents), prior_credit_cents: s(rem.prior_credit_cents), other_cents: s(rem.other_cents),
        remittance_cents: s(rem.remittance_cents),
      },
      adjustments,
      payments,
      paid_cents: s(paid),
      return_status: ret ? ret.status : "open",
      payment_status: live.length === 0 ? "unpaid" : live.every((x) => x.qb_txn_id) ? "paid" : "pending_qb",
      due,
      urgency: filingUrgency(due, today),
      return: ret ? { id: ret.id, status: ret.status, prepared_at: ret.prepared_at, filed_at: ret.filed_at, confirmation_number: ret.confirmation_number, filed_amount_cents: ret.filed_amount_cents } : null,
    });
  }
  return out;
}

/** Clientes con ventas exentas en el período (línea B por cliente, con su certificado). */
export interface ExemptCustomerRow {
  customer_id: string;
  name: string | null;
  is_tax_exempt: string | null;
  resale_number: string | null;
  exempt_reason: string | null;
  invoices: number;
  exempt_cents: string;
}

export async function loadExemptCustomers(client: PoolClient, period: string): Promise<ExemptCustomerRow[]> {
  const { from, to } = periodBounds(period);
  const { rows } = await client.query<ExemptCustomerRow>(
    `WITH inv AS (
       SELECT v.id, v.customer_id, ROUND(v.tax)::bigint AS tax FROM pos_invoice v
        WHERE v.deleted_at IS NULL AND v.voided_at IS NULL AND v.status <> 'voided' AND v.issued_at IS NOT NULL
          AND (v.issued_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
     ), per_inv AS (
       SELECT inv.id, inv.customer_id, inv.tax,
              COALESCE(SUM(CASE WHEN i.taxable THEN ROUND(COALESCE(i.net_total_cents, i.total)) ELSE 0 END), 0)::bigint AS taxable_items,
              COALESCE(SUM(CASE WHEN i.taxable THEN 0 ELSE ROUND(COALESCE(i.net_total_cents, i.total)) END), 0)::bigint AS exempt_items
         FROM inv LEFT JOIN pos_invoice_item i ON i.invoice_id = inv.id AND i.deleted_at IS NULL
        GROUP BY inv.id, inv.customer_id, inv.tax
     )
     SELECT p.customer_id,
            COALESCE(NULLIF(TRIM(cu.company_name), ''), NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), ''), cu.email) AS name,
            cu.metadata->>'is_tax_exempt' AS is_tax_exempt,
            cu.metadata->>'tax_exempt_resale_num' AS resale_number,
            cu.metadata->>'tax_exempt_reason' AS exempt_reason,
            COUNT(*)::int AS invoices,
            SUM(p.exempt_items + CASE WHEN p.tax = 0 THEN p.taxable_items ELSE 0 END)::text AS exempt_cents
       FROM per_inv p LEFT JOIN customer cu ON cu.id = p.customer_id
      WHERE p.customer_id IS NOT NULL AND (p.exempt_items > 0 OR (p.tax = 0 AND p.taxable_items > 0))
      GROUP BY p.customer_id, cu.company_name, cu.first_name, cu.last_name, cu.email, cu.metadata
      ORDER BY SUM(p.exempt_items + CASE WHEN p.tax = 0 THEN p.taxable_items ELSE 0 END) DESC`,
    [BUSINESS_TIMEZONE, from, to]
  );
  return rows;
}
