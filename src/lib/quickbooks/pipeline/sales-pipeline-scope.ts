/**
 * Single source of truth for "which steps belong to the Sales Pipeline tab".
 *
 * The QB pipeline UI splits `qb_order_pipeline` across several tabs. The Sales
 * Pipeline tab shows everything EXCEPT the steps that own a dedicated tab of
 * their own. Both the row listing and the header status badges must apply the
 * exact same scope — when they drift, the badge reports failures the user cannot
 * find in the list ("Failed 5" above a single row, caused by four failed
 * `vendor_bill_add` rows belonging to the Purchase Pipeline tab).
 *
 * Import from here in BOTH call sites rather than re-typing the list.
 */

/** Steps surfaced by the Purchase Pipeline tab. */
export const PURCHASE_PIPELINE_STEPS = [
  "purchase_order_mod",
  "item_receipt_add",
  "item_receipt_mod",
  "vendor_bill_add",
  "vendor_bill_mod",
  "vendor_bill_rebuild_preflight",
  "vendor_bill_rebuild_delete",
  // gl-purchases-v2 §4: vendor credits + pay bills are Purchase-side
  // documents, same tab as vendor_bill_add/void — no dedicated tab this
  // phase (dispatch is R3; adding UI for a lane the bridge never contacts
  // yet is out of scope).
  "vendor_credit_add",
  "vendor_credit_void",
  "bill_payment_add",
  "bill_payment_void",
  // vc-apply-qb-20260915: mismo cuadro de compras que vendor_credit_add/void.
  "vendor_credit_apply",
  // gl-docs-to-qb-20260914: documentos GL bancarios — se ven en la misma
  // pestaña de compras (feed-sql.ts), fuera del Sales Pipeline.
  "gl_document_add",
  "gl_document_void",
  "gl_document_mod",
  // qb-import-void-ui-20260915: TxnVoid de un doc importado — misma pestaña.
  "qb_import_void",
] as const;

/** Steps surfaced by the Inventory Adjustments tab. */
export const INVENTORY_ADJUSTMENT_STEPS = [
  "inventory_adjustment",
  "void_inventory_adjustment",
] as const;

/** Steps surfaced by the Customer Sync tab. */
export const CUSTOMER_SYNC_STEPS = ["customer_data_ext"] as const;

/**
 * Steps surfaced by the Bill Payments tab.
 *
 * `vendor_bill_payment_check` is a read-only BillQuery the hourly monitor emits
 * for every linked unpaid Vendor Bill, so it is by far the highest-volume step in
 * the shared table — 165 of the 241 rows created in the 24 h before this tab
 * existed, against 76 for every other step combined. Left in the Sales Pipeline
 * it buried the sales documents it was supposed to sit beside.
 */
export const BILL_PAYMENT_STEPS = ["vendor_bill_payment_check"] as const;

/**
 * Steps surfaced by the "Ledger → QuickBooks" tab (09/16/2026): every document
 * that leaves the POS ledger for QuickBooks — bank documents (checks/expenses,
 * transfers, journal entries, deposits), bill payments, vendor-credit
 * applications and voids of imported documents. They used to be buried in the
 * Purchase tab; the Bill Payments tab they replace was the retired hourly
 * BillQuery monitor.
 */
export const LEDGER_PIPELINE_STEPS = [
  "gl_document_add",
  "gl_document_void",
  // check-revise-20260918: CheckMod / CreditCardChargeMod de un cheque corregido.
  "gl_document_mod",
  "bill_payment_add",
  "bill_payment_void",
  "vendor_credit_apply",
  "qb_import_void",
] as const;

/**
 * Steps surfaced by the Commissions Pipeline tab (delta v2 del plan de
 * comisiones): el check contable desde la clearing y el ReceivePayment sin
 * aplicar que materializa el crédito del beneficiario.
 */
export const COMMISSION_PIPELINE_STEPS = [
  "commission_check",
  "commission_payment",
] as const;

/**
 * Every step that has its own tab — and therefore must be excluded from both the
 * Sales Pipeline listing and its status badges.
 */
export const SALES_PIPELINE_EXCLUDED_STEPS: string[] = [
  ...CUSTOMER_SYNC_STEPS,
  ...INVENTORY_ADJUSTMENT_STEPS,
  ...PURCHASE_PIPELINE_STEPS,
  ...BILL_PAYMENT_STEPS,
  ...COMMISSION_PIPELINE_STEPS,
];

/**
 * Builds the SQL predicate restricting a query to Sales Pipeline steps.
 *
 * Pass `SALES_PIPELINE_EXCLUDED_STEPS` as the value for `paramIndex`.
 *
 * @param paramIndex 1-based placeholder position of the excluded-steps array.
 * @param alias Optional table alias (the listing query aliases the table `p`).
 */
export function salesPipelineStepScopeSql(
  paramIndex: number,
  alias?: string
): string {
  const prefix = alias ? `${alias}.` : "";
  return `${prefix}step <> ALL($${paramIndex}::text[])`;
}
