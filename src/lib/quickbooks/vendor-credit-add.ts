/**
 * vendor-credit-add.ts
 *
 * QBXML builder for `VendorCreditAddRq` (gl-purchases-v2 §4,
 * docs/GL_PURCHASES_PLAN.md). PURE — no IO, no bridge call. Element order is
 * exact and load-bearing: QuickBooks Desktop rejects the WHOLE request with
 * HRESULT 0x80040400 on a wrong order, before it even looks at the vendor or
 * the lines (same failure mode documented for `<LinkToTxn>` in
 * `.claude/rules/qb-pipeline.md` 2026-07-28).
 *
 * Order: VendorRef → APAccountRef → TxnDate → RefNumber → Memo →
 * ExpenseLineAdd* → ItemLineAdd*.
 *
 * DISPATCH CHOICE (documented for the R3 executor): the bridge
 * (`quickbooks-bridge`, a separate deploy) has NO typed builder for
 * VendorCreditAdd — only Bill, Check, and the sales-side documents do. Rather
 * than wait on a bridge deploy, this builder produces the FULL raw QBXML text
 * here, to be submitted through the existing raw passthrough
 * (`POST /api/sync/direct-query`, `{ qbxml }`) — the same path
 * `qb-terms-add.ts` already uses for `*TermsAdd`, and for the identical
 * reason: "no deploy to the remote Windows box is needed." See
 * `qb-vendor-credit-enqueue.ts` for how the payload carries this string.
 */

import { escapeXml, qbxmlEnvelope } from "./qbxml-escape";
import { centsToDollarsString } from "../ledger/money";

/** Every leaf value is routed through this — escapeXml on a digit string is a no-op. */
const tag = (name: string, value: string | null | undefined): string =>
  value == null ? "" : `<${name}>${escapeXml(value)}</${name}>`;

export interface VendorCreditExpenseLineInput {
  accountListId: string;
  amountCents: bigint | number;
  memo?: string | null;
}

export interface VendorCreditItemLineInput {
  itemListId: string;
  quantity: number;
  unitCostCents: bigint | number;
  amountCents: bigint | number;
}

export interface VendorCreditAddInput {
  vendorListId: string;
  apAccountListId: string;
  /** `YYYY-MM-DD` */
  txnDate: string;
  /** Already truncated to QB's 11-char RefNumber limit (`qb-ref-number.ts`). */
  refNumber: string | null;
  memo?: string | null;
  expenseLines: VendorCreditExpenseLineInput[];
  itemLines: VendorCreditItemLineInput[];
}

/**
 * Builds the full envelope-wrapped QBXML for a `VendorCreditAddRq`.
 *
 * Refuses (throws) rather than emit a document QuickBooks would reject or
 * that would silently miss money: no vendor/AP account, or zero lines.
 */
export function buildVendorCreditAddQbxml(input: VendorCreditAddInput): string {
  if (!input.vendorListId) {
    throw new Error("VendorCreditAdd requires a vendor ListID");
  }
  if (!input.apAccountListId) {
    throw new Error("VendorCreditAdd requires an APAccountRef ListID");
  }
  if (input.expenseLines.length === 0 && input.itemLines.length === 0) {
    throw new Error("VendorCreditAdd requires at least one line");
  }

  const expenseLinesXml = input.expenseLines
    .map((line) => {
      if (!line.accountListId) {
        throw new Error("VendorCredit expense line has no QB account");
      }
      const parts = [
        `<AccountRef>${tag("ListID", line.accountListId)}</AccountRef>`,
        tag("Amount", centsToDollarsString(line.amountCents)),
        tag("Memo", line.memo ?? null),
      ];
      return `<ExpenseLineAdd>${parts.join("")}</ExpenseLineAdd>`;
    })
    .join("");

  const itemLinesXml = input.itemLines
    .map((line) => {
      if (!line.itemListId) {
        throw new Error("VendorCredit item line has no QB item ListID");
      }
      const parts = [
        `<ItemRef>${tag("ListID", line.itemListId)}</ItemRef>`,
        tag("Quantity", String(line.quantity)),
        tag("Cost", centsToDollarsString(line.unitCostCents)),
        tag("Amount", centsToDollarsString(line.amountCents)),
      ];
      return `<ItemLineAdd>${parts.join("")}</ItemLineAdd>`;
    })
    .join("");

  const body =
    `<VendorRef>${tag("ListID", input.vendorListId)}</VendorRef>` +
    `<APAccountRef>${tag("ListID", input.apAccountListId)}</APAccountRef>` +
    tag("TxnDate", input.txnDate) +
    tag("RefNumber", input.refNumber) +
    tag("Memo", input.memo ?? null) +
    expenseLinesXml +
    itemLinesXml;

  return qbxmlEnvelope(
    `<VendorCreditAddRq><VendorCreditAdd>${body}</VendorCreditAdd></VendorCreditAddRq>`
  );
}
