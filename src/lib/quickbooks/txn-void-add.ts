/**
 * txn-void-add.ts
 *
 * Shared `TxnVoidRq` builder for the two document types this phase owns
 * (VendorCredit, BillPaymentCheck/BillPaymentCreditCard — gl-purchases-v2
 * §4). No existing builder in this repo produces a hand-built TxnVoidRq: the
 * vendor-bill lane sends `{ TxnVoidType: "Bill", TxnID }` as a JSON payload
 * to the bridge's typed `/api/sync/enqueue` endpoint
 * (`resubmit-by-step.ts` case `vendor_bill_void`), because the bridge already
 * has a typed Bill void handler. VendorCredit/BillPaymentCheck void have no
 * such handler yet, so — same reasoning as `vendor-credit-add.ts` — this
 * builds the raw QBXML for the raw passthrough instead of waiting on a
 * bridge deploy.
 */

import { qbxmlEnvelope } from "./qbxml-escape";
import { escapeXml } from "./qbxml-escape";

export type VoidableTxnType =
  | "VendorCredit"
  | "BillPaymentCheck"
  | "BillPaymentCreditCard"
  // gl-docs-to-qb-20260914: los documentos GL bancarios del POS. Cada valor
  // es el `TxnVoidType` exacto del tipo que el ADD creó (`qb_txn_type` del
  // documento) — sondeado read-only con TxnID inexistente el 2026-09-14.
  | "Check"
  | "CreditCardCharge"
  // qb-import-void-ui-20260915: los docs importados de QB incluyen "Credit
  // Card Credit" (reembolso en la tarjeta); su TxnVoidType es este.
  | "CreditCardCredit"
  | "Deposit"
  | "JournalEntry"
  // sales-tax-center-20260917: Pay Sales Tax del POS (gl_sales_tax_payment).
  | "SalesTaxPaymentCheck";

/**
 * Tipos que `TxnVoidRq` NO acepta en qbXML ≤ 11.0 (el techo de este company
 * file): QuickBooks contesta 3110 "enumerated value … unknown or invalid for
 * the qbXML version in use". El SDK sólo los admite en `TxnDelRq` — igual que
 * ReceivePayment. Medido el 09/17/2026 con la sonda del Sales Tax Center.
 */
const DELETE_ONLY_TYPES: ReadonlySet<VoidableTxnType> = new Set(["SalesTaxPaymentCheck"]);

export function isDeleteOnlyTxnType(txnVoidType: VoidableTxnType): boolean {
  return DELETE_ONLY_TYPES.has(txnVoidType);
}

/** `TxnVoidRq`, o `TxnDelRq` cuando el tipo no se puede anular en esta versión de qbXML. */
export function buildTxnVoidQbxml(
  txnVoidType: VoidableTxnType,
  txnId: string
): string {
  if (!txnId) {
    throw new Error(`TxnVoidRq (${txnVoidType}) requires a TxnID`);
  }
  if (isDeleteOnlyTxnType(txnVoidType)) {
    const body =
      `<TxnDelType>${escapeXml(txnVoidType)}</TxnDelType>` +
      `<TxnID>${escapeXml(txnId)}</TxnID>`;
    return qbxmlEnvelope(`<TxnDelRq>${body}</TxnDelRq>`);
  }
  const body =
    `<TxnVoidType>${escapeXml(txnVoidType)}</TxnVoidType>` +
    `<TxnID>${escapeXml(txnId)}</TxnID>`;
  return qbxmlEnvelope(`<TxnVoidRq>${body}</TxnVoidRq>`);
}
