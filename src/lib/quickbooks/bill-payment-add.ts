/**
 * bill-payment-add.ts
 *
 * QBXML builders for `BillPaymentCheckAddRq` / `BillPaymentCreditCardAddRq`
 * (gl-purchases-v2 §4, docs/GL_PURCHASES_PLAN.md). PURE — no IO. Element
 * order is exact per the plan's sample:
 *
 *   Check:       PayeeEntityRef → APAccountRef → TxnDate → BankAccountRef →
 *                IsToBePrinted → RefNumber → Memo → AppliedToTxnAdd*
 *   CreditCard:  PayeeEntityRef → APAccountRef → TxnDate →
 *                CreditCardAccountRef → RefNumber → Memo → AppliedToTxnAdd*
 *                (no IsToBePrinted — QuickBooks' CreditCard txn type has no
 *                 such field; the plan's own sample omits it)
 *   AppliedToTxnAdd: TxnID → PaymentAmount → SetCredit*
 *   SetCredit:       CreditTxnID → AppliedAmount
 *
 * DISPATCH CHOICE: same as `vendor-credit-add.ts` — the bridge has no typed
 * builder for either Bill Payment type, so this produces the full raw QBXML
 * for the `/api/sync/direct-query` passthrough rather than waiting on a
 * bridge deploy (R3 decides whether to keep it there or port it into a
 * bridge-side typed builder later; nothing here assumes either).
 *
 * "Apply a credit with no payment" (plan §3, `PaymentAmount 0.00` +
 * `SetCredit`, marked "verify on first real dispatch (R3)") is not a special
 * case for this builder — `buildBillPaymentCheckAddQbxml` accepts
 * `paymentAmountCents: 0n` like any other amount; the $0-check quirk is a
 * QuickBooks acceptance behavior to confirm at dispatch time, not a shape
 * this builder needs to branch on.
 */

import { escapeXml, qbxmlEnvelope } from "./qbxml-escape";
import { centsToDollarsString } from "../ledger/money";

const tag = (name: string, value: string | null | undefined): string =>
  value == null ? "" : `<${name}>${escapeXml(value)}</${name}>`;

export interface SetCreditInput {
  creditTxnId: string;
  appliedAmountCents: bigint | number;
}

export interface AppliedToTxnInput {
  billTxnId: string;
  paymentAmountCents: bigint | number;
  setCredits?: SetCreditInput[];
}

export interface BillPaymentAddInputBase {
  payeeListId: string;
  apAccountListId: string;
  /** `YYYY-MM-DD` */
  txnDate: string;
  refNumber: string | null;
  memo?: string | null;
  appliedToTxns: AppliedToTxnInput[];
}

export interface BillPaymentCheckAddInput extends BillPaymentAddInputBase {
  bankAccountListId: string;
}

export interface BillPaymentCreditCardAddInput extends BillPaymentAddInputBase {
  creditCardAccountListId: string;
}

function assertBase(input: BillPaymentAddInputBase, rqName: string): void {
  if (!input.payeeListId) {
    throw new Error(`${rqName} requires a PayeeEntityRef ListID`);
  }
  if (!input.apAccountListId) {
    throw new Error(`${rqName} requires an APAccountRef ListID`);
  }
  if (input.appliedToTxns.length === 0) {
    throw new Error(`${rqName} requires at least one AppliedToTxnAdd`);
  }
}

function buildAppliedToTxnXml(applied: AppliedToTxnInput): string {
  if (!applied.billTxnId) {
    throw new Error("AppliedToTxnAdd requires the bill's qb_txn_id");
  }
  const setCreditsXml = (applied.setCredits ?? [])
    .map((sc) => {
      if (!sc.creditTxnId) {
        throw new Error("SetCredit requires the vendor credit's qb_txn_id");
      }
      return (
        `<SetCredit>` +
        tag("CreditTxnID", sc.creditTxnId) +
        tag("AppliedAmount", centsToDollarsString(sc.appliedAmountCents)) +
        `</SetCredit>`
      );
    })
    .join("");
  return (
    `<AppliedToTxnAdd>` +
    tag("TxnID", applied.billTxnId) +
    tag("PaymentAmount", centsToDollarsString(applied.paymentAmountCents)) +
    setCreditsXml +
    `</AppliedToTxnAdd>`
  );
}

export function buildBillPaymentCheckAddQbxml(
  input: BillPaymentCheckAddInput
): string {
  assertBase(input, "BillPaymentCheckAddRq");
  if (!input.bankAccountListId) {
    throw new Error("BillPaymentCheckAddRq requires a BankAccountRef ListID");
  }
  const body =
    `<PayeeEntityRef>${tag("ListID", input.payeeListId)}</PayeeEntityRef>` +
    `<APAccountRef>${tag("ListID", input.apAccountListId)}</APAccountRef>` +
    tag("TxnDate", input.txnDate) +
    `<BankAccountRef>${tag("ListID", input.bankAccountListId)}</BankAccountRef>` +
    `<IsToBePrinted>false</IsToBePrinted>` +
    tag("RefNumber", input.refNumber) +
    tag("Memo", input.memo ?? null) +
    input.appliedToTxns.map(buildAppliedToTxnXml).join("");

  return qbxmlEnvelope(
    `<BillPaymentCheckAddRq><BillPaymentCheckAdd>${body}</BillPaymentCheckAdd></BillPaymentCheckAddRq>`
  );
}

export function buildBillPaymentCreditCardAddQbxml(
  input: BillPaymentCreditCardAddInput
): string {
  assertBase(input, "BillPaymentCreditCardAddRq");
  if (!input.creditCardAccountListId) {
    throw new Error(
      "BillPaymentCreditCardAddRq requires a CreditCardAccountRef ListID"
    );
  }
  const body =
    `<PayeeEntityRef>${tag("ListID", input.payeeListId)}</PayeeEntityRef>` +
    `<APAccountRef>${tag("ListID", input.apAccountListId)}</APAccountRef>` +
    tag("TxnDate", input.txnDate) +
    `<CreditCardAccountRef>${tag("ListID", input.creditCardAccountListId)}</CreditCardAccountRef>` +
    tag("RefNumber", input.refNumber) +
    tag("Memo", input.memo ?? null) +
    input.appliedToTxns.map(buildAppliedToTxnXml).join("");

  return qbxmlEnvelope(
    `<BillPaymentCreditCardAddRq><BillPaymentCreditCardAdd>${body}</BillPaymentCreditCardAdd></BillPaymentCreditCardAddRq>`
  );
}
