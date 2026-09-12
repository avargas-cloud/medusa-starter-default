/**
 * src/lib/qb-backfill/sales-derive.ts
 *
 * Derivaciones PURAS del backfill de ventas: método de pago de QB → método
 * del POS (`customer_payment.method` + `card_brand`, y el enum más chico de
 * `pos_invoice.payment_method`), status de factura y de pago, y
 * `refund_method` del credit memo. Sin I/O.
 *
 * El mapeo es la INVERSA de `lib/quickbooks/payment-method-sanitizer.ts`
 * (POS → QB): las tarjetas de crédito viajan a QB como su marca, así que una
 * marca en QB vuelve como `credit_card` + `card_brand`; "Debit Card" vuelve
 * como `debit_card` sin marca; "Checking Account"/"E-Check" como `ach`.
 * "Transfer"/"Wire Transfer" no tienen inversa unívoca (no es Zelle ni ACH
 * con certeza) → `other`, conservando el nombre de QB en metadata.
 */
import type { QbCreditMemo, QbInvoice, QbLinkedTxn, QbReceivePayment, QbReceivePaymentApplication } from "./sales-types";

export type PosPaymentMethod =
  | "credit_card"
  | "debit_card"
  | "cash"
  | "check"
  | "ach"
  | "zelle"
  | "credit_memo"
  | "other";

/** Subconjunto de `pos_invoice.payment_method` que este backfill escribe (`null` = sin equivalente). */
export type PosInvoicePaymentMethod = "credit_card" | "debit_card" | "cash" | "check" | "ach" | "zelle" | "credit";

export interface MappedPaymentMethod {
  method: PosPaymentMethod;
  card_brand: string | null;
  invoice_method: PosInvoicePaymentMethod | null;
}

const CARD_BRANDS: Array<[RegExp, string]> = [
  [/capital\s*[-_]?\s*one/i, "capital_one"],
  [/american\s*express|amex/i, "amex"],
  [/master\s*card/i, "mastercard"],
  [/\bvisa\b/i, "visa"],
  [/discover/i, "discover"],
];

export function mapQbPaymentMethod(fullName: string | null | undefined): MappedPaymentMethod {
  const name = (fullName ?? "").trim();
  if (!name) return { method: "other", card_brand: null, invoice_method: null };
  for (const [re, brand] of CARD_BRANDS) {
    if (re.test(name)) return { method: "credit_card", card_brand: brand, invoice_method: "credit_card" };
  }
  if (/debit/i.test(name)) return { method: "debit_card", card_brand: null, invoice_method: "debit_card" };
  if (/^cash$/i.test(name)) return { method: "cash", card_brand: null, invoice_method: "cash" };
  if (/^check$/i.test(name)) return { method: "check", card_brand: null, invoice_method: "check" };
  if (/checking\s*account|e-?check|\bach\b/i.test(name)) return { method: "ach", card_brand: null, invoice_method: "ach" };
  if (/zelle/i.test(name)) return { method: "zelle", card_brand: null, invoice_method: "zelle" };
  if (/credit\s*memo/i.test(name)) return { method: "credit_memo", card_brand: null, invoice_method: "credit" };
  return { method: "other", card_brand: null, invoice_method: null };
}

export type PosInvoiceStatus = "paid" | "partial" | "issued";

export interface InvoiceStatusDerivation {
  status: PosInvoiceStatus;
  amount_paid_cents: number;
  balance_due_cents: number;
}

/**
 * `IsPaid` manda. Para una factura abierta el pagado se deriva como
 * `total − BalanceRemaining` (QB devuelve `AppliedAmount` NEGATIVO cuando hay
 * pagos parciales — medido en enero 2026: 18943 trae −249,19 con saldo 174,05).
 */
export function deriveInvoiceStatus(inv: Pick<QbInvoice, "is_paid" | "balance_remaining_cents">, totalCents: number): InvoiceStatusDerivation {
  if (inv.is_paid) return { status: "paid", amount_paid_cents: totalCents, balance_due_cents: 0 };
  const balance = Math.max(0, Math.min(totalCents, inv.balance_remaining_cents));
  const paid = totalCents - balance;
  return { status: paid > 0 ? "partial" : "issued", amount_paid_cents: paid, balance_due_cents: balance };
}

export type PosPaymentStatus = "applied" | "partially_applied" | "available" | "refunded" | "partial_refunded";

/**
 * Un ReceivePayment puede estar aplicado a una DEVOLUCIÓN en vez de a una factura:
 * `ARRefundCreditCard` (reembolso a tarjeta) o `Check` (cheque de devolución). QB lo
 * cuenta como "usado" (`UnusedPayment` 0), pero para el POS esa plata volvió al cliente.
 * Mismos tipos que `deriveRefundMethod` mira en los enlaces de un credit memo.
 */
export const REFUND_APPLIED_TXN_TYPES: ReadonlySet<string> = new Set(["ARRefundCreditCard", "Check"]);

export interface PaymentRefundDerivation {
  refund_cents: number;
  /** TxnDate de la primera devolución (la fecha en que la plata salió), null si no hay. */
  refund_txn_date: string | null;
  refund_txn_ids: string[];
}

export function isRefundApplication(a: Pick<QbReceivePaymentApplication, "txn_type" | "amount_cents">): boolean {
  return REFUND_APPLIED_TXN_TYPES.has(a.txn_type) && a.amount_cents > 0;
}

export function derivePaymentRefund(rp: { applied?: readonly QbReceivePaymentApplication[] }): PaymentRefundDerivation {
  const refunds = (rp.applied ?? []).filter(isRefundApplication);
  return {
    refund_cents: refunds.reduce((s, a) => s + a.amount_cents, 0),
    refund_txn_date: refunds.find((a) => a.txn_date)?.txn_date ?? null,
    refund_txn_ids: refunds.map((a) => a.txn_id),
  };
}

type PaymentStatusInput = Pick<QbReceivePayment, "total_amount_cents" | "unused_payment_cents"> & { applied?: readonly QbReceivePaymentApplication[] };

/**
 * Con devolución: `refunded` si nada quedó aplicado a facturas, `partial_refunded` si algo sí
 * (medido: #4915, $411.45 devueltos a la Visa dos días después — nacía `applied` con 0
 * aplicaciones). Sin devolución, `UnusedPayment` de QB manda: 0 → todo aplicado; parte →
 * parcial; nada aplicado → disponible.
 */
export function derivePaymentStatus(rp: PaymentStatusInput): PosPaymentStatus {
  const { refund_cents } = derivePaymentRefund(rp);
  if (refund_cents > 0) {
    const appliedToInvoices = (rp.applied ?? []).some((a) => !isRefundApplication(a) && a.amount_cents > 0);
    return appliedToInvoices ? "partial_refunded" : "refunded";
  }
  if (rp.unused_payment_cents <= 0) return "applied";
  if (rp.unused_payment_cents >= rp.total_amount_cents) return "available";
  return "partially_applied";
}

export type CreditMemoRefundMethod = "refund" | "store_credit";

/** Un cheque o reembolso a tarjeta enlazado = el crédito se devolvió; si no, quedó como saldo a favor. */
export function deriveRefundMethod(linkedTxns: readonly QbLinkedTxn[]): CreditMemoRefundMethod {
  return linkedTxns.some((l) => l.txn_type === "Check" || l.txn_type === "ARRefundCreditCard") ? "refund" : "store_credit";
}

/** QB voidea un CM dejándolo en cero: total 0 y todas las líneas en 0. */
export function isVoidedCreditMemo(cm: Pick<QbCreditMemo, "total_amount_cents" | "lines">): boolean {
  return cm.total_amount_cents === 0 && cm.lines.every((l) => l.amount_cents === 0 && !(l.quantity && l.quantity > 0));
}

/** Total de una Invoice de QB: el normalizador no expone `TotalAmount`; es `Subtotal + SalesTaxTotal`. */
export function invoiceTotalCents(inv: Pick<QbInvoice, "subtotal_cents" | "sales_tax_total_cents">): number {
  return inv.subtotal_cents + inv.sales_tax_total_cents;
}
