/**
 * src/lib/qb-backfill/sales-normalize.ts
 *
 * `Ret` crudo del bridge (dict/array sin normalizar, montos en string
 * decimal) → formas tipadas de `sales-types.ts` con montos en CENTS enteros.
 * Mismas convenciones que `normalize.ts` (compras): `moneyToCents` nunca
 * `parseFloat(x) * 100`, `asList` normaliza dict-único → array.
 *
 * Líneas de grupo (`InvoiceLineGroupRet`/`SalesReceiptLineGroupRet`/
 * `CreditMemoLineGroupRet`): se APLANAN a sus líneas hijas
 * (`is_group_child: true`) y el monto del GRUPO en sí queda AFUERA — sumarlo
 * duplicaría el total (el grupo ya es la suma de sus hijas).
 *
 * Pseudo-líneas de Subtotal/Discount/SalesTax: QB las manda como líneas
 * normales cuyo `ItemRef` apunta a un ítem de ese tipo — se conservan tal
 * cual (el creador, en otra fase, las reclasifica por tipo de ítem); esta
 * capa no las descarta ni las trata distinto.
 */
import { asList } from "./qb-client";
import { moneyToCents, normalizeLinkedTxns, normalizeRef } from "./normalize";
import type {
  QbCreditMemo,
  QbInvoice,
  QbReceivePayment,
  QbReceivePaymentApplication,
  QbReceivePaymentSetCredit,
  QbSalesLine,
  QbSalesReceipt,
} from "./sales-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

function toBool(v: unknown): boolean {
  return v === true || v === "true";
}

function toNum(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function moneyOrNull(v: unknown): number | null {
  return v === undefined || v === null || v === "" ? null : moneyToCents(v as string);
}

/**
 * Aplana `<Prefix>LineRet` + `<Prefix>LineGroupRet` (el grupo aporta sus
 * hijas con `is_group_child=true`; su propio Amount queda afuera).
 */
function flattenSalesLines(r: Raw, prefix: string): QbSalesLine[] {
  const plain = asList<Raw>(r[`${prefix}LineRet`]).map((l) => normalizeSalesLine(l, false));
  const groups = asList<Raw>(r[`${prefix}LineGroupRet`]).flatMap((g) =>
    asList<Raw>(g[`${prefix}LineRet`]).map((l) => normalizeSalesLine(l, true))
  );
  return [...plain, ...groups];
}

function normalizeSalesLine(l: Raw, isGroupChild: boolean): QbSalesLine {
  return {
    txn_line_id: l.TxnLineID,
    item_ref: normalizeRef(l.ItemRef),
    description: l.Desc ?? null,
    quantity: toNum(l.Quantity),
    rate_cents: moneyOrNull(l.Rate),
    amount_cents: moneyToCents(l.Amount),
    sales_tax_code_ref: normalizeRef(l.SalesTaxCodeRef),
    ...(isGroupChild ? { is_group_child: true as const } : {}),
  };
}

// ── Invoice ───────────────────────────────────────────────────────────────

export function normalizeInvoices(rs: Raw | null): QbInvoice[] {
  if (!rs) return [];
  return asList<Raw>(rs.InvoiceRet).map((r) => ({
    txn_id: r.TxnID,
    txn_number: r.TxnNumber ?? null,
    edit_sequence: r.EditSequence,
    time_created: r.TimeCreated ?? null,
    time_modified: r.TimeModified ?? null,
    customer_ref: normalizeRef(r.CustomerRef),
    txn_date: r.TxnDate,
    ref_number: r.RefNumber ?? null,
    due_date: r.DueDate ?? null,
    is_pending: toBool(r.IsPending),
    is_paid: toBool(r.IsPaid),
    subtotal_cents: moneyToCents(r.Subtotal),
    sales_tax_total_cents: moneyToCents(r.SalesTaxTotal),
    sales_tax_percentage: toNum(r.SalesTaxPercentage),
    item_sales_tax_ref: normalizeRef(r.ItemSalesTaxRef),
    applied_amount_cents: moneyToCents(r.AppliedAmount),
    balance_remaining_cents: moneyToCents(r.BalanceRemaining),
    memo: r.Memo ?? null,
    po_number: r.PONumber ?? null,
    terms_ref: normalizeRef(r.TermsRef),
    sales_rep_ref: normalizeRef(r.SalesRepRef),
    class_ref: normalizeRef(r.ClassRef),
    linked_txns: normalizeLinkedTxns(r),
    lines: flattenSalesLines(r, "Invoice"),
  }));
}

// ── Sales Receipt ─────────────────────────────────────────────────────────

export function normalizeSalesReceipts(rs: Raw | null): QbSalesReceipt[] {
  if (!rs) return [];
  return asList<Raw>(rs.SalesReceiptRet).map((r) => ({
    txn_id: r.TxnID,
    txn_number: r.TxnNumber ?? null,
    edit_sequence: r.EditSequence,
    time_created: r.TimeCreated ?? null,
    time_modified: r.TimeModified ?? null,
    customer_ref: normalizeRef(r.CustomerRef),
    txn_date: r.TxnDate,
    ref_number: r.RefNumber ?? null,
    subtotal_cents: moneyToCents(r.Subtotal),
    sales_tax_total_cents: moneyToCents(r.SalesTaxTotal),
    sales_tax_percentage: toNum(r.SalesTaxPercentage),
    item_sales_tax_ref: normalizeRef(r.ItemSalesTaxRef),
    total_amount_cents: moneyToCents(r.TotalAmount),
    payment_method_ref: normalizeRef(r.PaymentMethodRef),
    deposit_to_account_ref: normalizeRef(r.DepositToAccountRef),
    check_number: r.CheckNumber ?? null,
    memo: r.Memo ?? null,
    class_ref: normalizeRef(r.ClassRef),
    linked_txns: normalizeLinkedTxns(r),
    lines: flattenSalesLines(r, "SalesReceipt"),
  }));
}

// ── Receive Payment ───────────────────────────────────────────────────────

function normalizeSetCredit(s: Raw): QbReceivePaymentSetCredit {
  return {
    credit_txn_id: s.CreditTxnID,
    applied_amount_cents: moneyToCents(s.AppliedAmount),
  };
}

function normalizeAppliedToTxn(a: Raw): QbReceivePaymentApplication {
  return {
    txn_id: a.TxnID,
    txn_type: a.TxnType,
    txn_date: a.TxnDate ?? null,
    ref_number: a.RefNumber ?? null,
    balance_remaining_cents: moneyOrNull(a.BalanceRemaining),
    amount_cents: moneyToCents(a.Amount),
    discount_amount_cents: moneyOrNull(a.DiscountAmount),
    discount_account_ref: normalizeRef(a.DiscountAccountRef),
    set_credits: asList<Raw>(a.SetCredit).map(normalizeSetCredit),
  };
}

export function normalizeReceivePayments(rs: Raw | null): QbReceivePayment[] {
  if (!rs) return [];
  return asList<Raw>(rs.ReceivePaymentRet).map((r) => ({
    txn_id: r.TxnID,
    edit_sequence: r.EditSequence,
    customer_ref: normalizeRef(r.CustomerRef),
    ar_account_ref: normalizeRef(r.ARAccountRef),
    txn_date: r.TxnDate,
    ref_number: r.RefNumber ?? null,
    total_amount_cents: moneyToCents(r.TotalAmount),
    payment_method_ref: normalizeRef(r.PaymentMethodRef),
    deposit_to_account_ref: normalizeRef(r.DepositToAccountRef),
    memo: r.Memo ?? null,
    unused_payment_cents: moneyToCents(r.UnusedPayment),
    unused_credits_cents: moneyToCents(r.UnusedCredits),
    applied: asList<Raw>(r.AppliedToTxnRet).map(normalizeAppliedToTxn),
  }));
}

// ── Credit Memo ───────────────────────────────────────────────────────────

export function normalizeCreditMemos(rs: Raw | null): QbCreditMemo[] {
  if (!rs) return [];
  return asList<Raw>(rs.CreditMemoRet).map((r) => ({
    txn_id: r.TxnID,
    edit_sequence: r.EditSequence,
    customer_ref: normalizeRef(r.CustomerRef),
    txn_date: r.TxnDate,
    ref_number: r.RefNumber ?? null,
    is_pending: toBool(r.IsPending),
    subtotal_cents: moneyToCents(r.Subtotal),
    sales_tax_total_cents: moneyToCents(r.SalesTaxTotal),
    total_amount_cents: moneyToCents(r.TotalAmount),
    credit_remaining_cents: moneyToCents(r.CreditRemaining),
    memo: r.Memo ?? null,
    linked_txns: normalizeLinkedTxns(r),
    lines: flattenSalesLines(r, "CreditMemo"),
  }));
}
