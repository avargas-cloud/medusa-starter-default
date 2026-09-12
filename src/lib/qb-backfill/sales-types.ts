/**
 * src/lib/qb-backfill/sales-types.ts
 *
 * Formas NORMALIZADAS de los 4 tipos de documento de VENTAS que trae este
 * backfill (Invoice, SalesReceipt, ReceivePayment, CreditMemo) — mismas
 * convenciones que `types.ts` (compras): montos en CENTS enteros vía
 * `moneyToCents` (nunca `parseFloat(x) * 100`), `QbRef`/`QbLinkedTxn`
 * compartidos, y `via_link?` para documentos que entraron por
 * `follow-links.ts` en vez de la ventana mensual normal.
 */

import type { QbLinkedTxn, QbRef } from "./types";

// Re-exportados: varios consumidores (`sales-derive.ts`, `sales-report.ts`) importan
// `QbRef`/`QbLinkedTxn` desde acá en vez de `./types` — se agregan como export puro,
// sin tocar ninguna forma existente de este archivo.
export type { QbLinkedTxn, QbRef };

export interface QbSalesLine {
  txn_line_id: string;
  item_ref: QbRef | null;
  description: string | null;
  quantity: number | null;
  rate_cents: number | null;
  amount_cents: number;
  sales_tax_code_ref: QbRef | null;
  /** `true` cuando esta línea vino aplanada de un `*LineGroupRet` (fase creador la reclasifica). */
  is_group_child?: boolean;
}

export interface QbInvoice {
  txn_id: string;
  txn_number: string | null;
  edit_sequence: string;
  time_created: string | null;
  time_modified: string | null;
  customer_ref: QbRef | null;
  txn_date: string;
  ref_number: string | null;
  due_date: string | null;
  is_pending: boolean;
  is_paid: boolean;
  subtotal_cents: number;
  sales_tax_total_cents: number;
  sales_tax_percentage: number | null;
  item_sales_tax_ref: QbRef | null;
  applied_amount_cents: number;
  balance_remaining_cents: number;
  memo: string | null;
  po_number: string | null;
  terms_ref: QbRef | null;
  sales_rep_ref: QbRef | null;
  class_ref: QbRef | null;
  linked_txns: QbLinkedTxn[];
  lines: QbSalesLine[];
  /** ídem `QbPurchaseOrder.via_link` en `types.ts`. */
  via_link?: boolean;
}

export interface QbSalesReceipt {
  txn_id: string;
  txn_number: string | null;
  edit_sequence: string;
  time_created: string | null;
  time_modified: string | null;
  customer_ref: QbRef | null;
  txn_date: string;
  ref_number: string | null;
  subtotal_cents: number;
  sales_tax_total_cents: number;
  sales_tax_percentage: number | null;
  item_sales_tax_ref: QbRef | null;
  total_amount_cents: number;
  payment_method_ref: QbRef | null;
  deposit_to_account_ref: QbRef | null;
  check_number: string | null;
  memo: string | null;
  class_ref: QbRef | null;
  linked_txns: QbLinkedTxn[];
  lines: QbSalesLine[];
  via_link?: boolean;
}

export interface QbReceivePaymentSetCredit {
  credit_txn_id: string;
  applied_amount_cents: number;
}

export interface QbReceivePaymentApplication {
  txn_id: string;
  txn_type: string;
  txn_date: string | null;
  ref_number: string | null;
  balance_remaining_cents: number | null;
  amount_cents: number;
  discount_amount_cents: number | null;
  discount_account_ref: QbRef | null;
  set_credits: QbReceivePaymentSetCredit[];
}

export interface QbReceivePayment {
  txn_id: string;
  edit_sequence: string;
  customer_ref: QbRef | null;
  ar_account_ref: QbRef | null;
  txn_date: string;
  ref_number: string | null;
  total_amount_cents: number;
  payment_method_ref: QbRef | null;
  deposit_to_account_ref: QbRef | null;
  memo: string | null;
  unused_payment_cents: number;
  unused_credits_cents: number;
  applied: QbReceivePaymentApplication[];
  via_link?: boolean;
}

export interface QbCreditMemo {
  txn_id: string;
  edit_sequence: string;
  customer_ref: QbRef | null;
  txn_date: string;
  ref_number: string | null;
  is_pending: boolean;
  subtotal_cents: number;
  sales_tax_total_cents: number;
  total_amount_cents: number;
  credit_remaining_cents: number;
  memo: string | null;
  linked_txns: QbLinkedTxn[];
  lines: QbSalesLine[];
  via_link?: boolean;
}

export type QbSalesDocType = "invoice" | "sales_receipt" | "receive_payment" | "credit_memo";

export const ALL_QB_SALES_DOC_TYPES: readonly QbSalesDocType[] = [
  "invoice",
  "sales_receipt",
  "receive_payment",
  "credit_memo",
] as const;

export interface QbSalesBucket {
  invoices: QbInvoice[];
  sales_receipts: QbSalesReceipt[];
  receive_payments: QbReceivePayment[];
  credit_memos: QbCreditMemo[];
}
