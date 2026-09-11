/**
 * src/lib/qb-backfill/types.ts
 *
 * Formas NORMALIZADAS de los 5 tipos de documento de compras que trae este
 * backfill (6 requests QBXML: BillPaymentCheck y BillPaymentCreditCard
 * colapsan a un solo `QbBillPayment[]`, con `payment_method` distinguiendo).
 *
 * Convención de dinero: TODOS los montos son CENTS enteros (number, no
 * bigint — los importes de compras del POS caben sobradamente en un
 * `number` seguro; `Number.isSafeInteger` se usa como guard en
 * `normalize.ts`). Nunca `parseFloat(x) * 100`: un string como "380.64" se
 * parte en parte entera/decimal ANTES de convertir a evitar el float
 * binario de 0.1+0.2 (`normalize.ts::moneyToCents`).
 */

export interface QbRef {
  list_id: string;
  full_name: string;
}

export interface QbLinkedTxn {
  txn_id: string;
  txn_type: string;
  txn_date: string | null;
  amount_cents: number | null;
  ref_number: string | null;
}

export interface QbPurchaseOrderLine {
  txn_line_id: string;
  item_ref: QbRef | null;
  manufacturer_part_number: string | null;
  description: string | null;
  quantity: number;
  rate_cents: number;
  amount_cents: number;
  received_quantity: number;
  is_manually_closed: boolean;
}

export interface QbPurchaseOrder {
  txn_id: string;
  edit_sequence: string;
  txn_number: string | null;
  ref_number: string | null;
  vendor_ref: QbRef | null;
  txn_date: string;
  due_date: string | null;
  expected_date: string | null;
  total_amount_cents: number;
  is_manually_closed: boolean;
  is_fully_received: boolean;
  memo: string | null;
  lines: QbPurchaseOrderLine[];
  linked_txns: QbLinkedTxn[];
  /** `true` cuando este documento entró al bucket por `follow-links.ts` (fuera del rango descargado). `undefined`/`false` = descargado por ventana mensual normal. */
  via_link?: boolean;
}

export interface QbItemReceiptLine {
  txn_line_id: string;
  item_ref: QbRef | null;
  description: string | null;
  quantity: number;
  rate_cents: number;
  amount_cents: number;
  linked_po_txn_id: string | null;
}

export interface QbItemReceipt {
  txn_id: string;
  edit_sequence: string;
  ref_number: string | null;
  vendor_ref: QbRef | null;
  txn_date: string;
  total_amount_cents: number;
  memo: string | null;
  lines: QbItemReceiptLine[];
  linked_txns: QbLinkedTxn[];
  /** ídem `QbPurchaseOrder.via_link`. */
  via_link?: boolean;
}

export interface QbBillLine {
  txn_line_id: string;
  item_ref: QbRef | null;
  /**
   * `AccountRef` de un `ExpenseLineRet` (fase 3/4) — `null` en toda línea de
   * ítem (`ItemLineRet`), que no lo trae. Sin esto no hay forma de resolver
   * `vendor_bill_line.qb_account_list_id`/`qb_account_full_name` para una
   * línea de gasto del backfill.
   */
  account_ref: QbRef | null;
  description: string | null;
  quantity: number | null;
  rate_cents: number | null;
  amount_cents: number;
}

export interface QbBill {
  txn_id: string;
  edit_sequence: string;
  ref_number: string | null;
  vendor_ref: QbRef | null;
  ap_account_ref: QbRef | null;
  txn_date: string;
  due_date: string | null;
  amount_due_cents: number;
  is_paid: boolean;
  memo: string | null;
  /** Item lines (ItemLineRet) — vacío si el bill es sólo gasto (ExpenseLineRet). */
  item_lines: QbBillLine[];
  /** Expense lines (ExpenseLineRet) — comisiones, flete, etc. sin ítem. */
  expense_lines: QbBillLine[];
  linked_txns: QbLinkedTxn[];
  /** ídem `QbPurchaseOrder.via_link`. */
  via_link?: boolean;
}

export interface QbVendorCredit {
  txn_id: string;
  edit_sequence: string;
  ref_number: string | null;
  vendor_ref: QbRef | null;
  txn_date: string;
  amount_cents: number;
  memo: string | null;
  item_lines: QbBillLine[];
  expense_lines: QbBillLine[];
  linked_txns: QbLinkedTxn[];
}

export interface QbBillPaymentApplication {
  txn_id: string;
  txn_type: string;
  txn_date: string | null;
  amount_cents: number;
  balance_remaining_cents: number | null;
}

export interface QbBillPayment {
  txn_id: string;
  edit_sequence: string;
  payment_method: "check" | "credit_card";
  payee_ref: QbRef | null;
  ap_account_ref: QbRef | null;
  bank_account_ref: QbRef | null;
  credit_card_account_ref: QbRef | null;
  txn_date: string;
  amount_cents: number;
  applications: QbBillPaymentApplication[];
}

export type QbDocType = "po" | "receipt" | "bill" | "credit" | "payment";

export const ALL_QB_DOC_TYPES: readonly QbDocType[] = [
  "po",
  "receipt",
  "bill",
  "credit",
  "payment",
] as const;

export interface MonthlyWindow {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}
