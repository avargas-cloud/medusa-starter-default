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
  | "Deposit"
  | "JournalEntry";

export function buildTxnVoidQbxml(
  txnVoidType: VoidableTxnType,
  txnId: string
): string {
  if (!txnId) {
    throw new Error(`TxnVoidRq (${txnVoidType}) requires a TxnID`);
  }
  const body =
    `<TxnVoidType>${escapeXml(txnVoidType)}</TxnVoidType>` +
    `<TxnID>${escapeXml(txnId)}</TxnID>`;
  return qbxmlEnvelope(`<TxnVoidRq>${body}</TxnVoidRq>`);
}
