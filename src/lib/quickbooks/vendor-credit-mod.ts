/**
 * vendor-credit-mod.ts
 *
 * QBXML builder for `VendorCreditModRq` (plan `vc-edit-mod-20260911`). PURE —
 * no IO. Sibling of `vendor-credit-add.ts`, same raw-passthrough dispatch
 * (`POST /api/sync/direct-query`) because the bridge has no typed builder for
 * vendor credits.
 *
 * Probed against QuickBooks Desktop on 2026-09-11 (nonexistent TxnID, with a
 * negative control): the request parses, QB calls the object "BillCredit" and
 * refuses a Mod without `VendorRef` ("Transaction must have a name") — so the
 * vendor is always sent. Element order is load-bearing (0x80040400 on a wrong
 * order): TxnID → EditSequence → VendorRef → APAccountRef → TxnDate →
 * RefNumber → Memo → ExpenseLineMod* → ItemLineMod*.
 *
 * Lines: qbXML Mod semantics — a line with its existing `TxnLineID` is
 * updated, a line with `TxnLineID = -1` is added, and any existing line NOT
 * mentioned is deleted. The caller therefore always sends the FULL current
 * line set. The first real Mod with line changes is read back from QB
 * (`VendorCreditQueryRq`) before that shape is trusted for lines.
 */

import { escapeXml, qbxmlEnvelope } from "./qbxml-escape";
import { centsToDollarsString } from "../ledger/money";

const tag = (name: string, value: string | null | undefined): string =>
  value == null ? "" : `<${name}>${escapeXml(value)}</${name}>`;

export interface VendorCreditModExpenseLine {
  /** Existing QB line id; null = new line (`-1`). */
  txnLineId: string | null;
  accountListId: string;
  amountCents: bigint | number;
  memo?: string | null;
}

export interface VendorCreditModItemLine {
  txnLineId: string | null;
  itemListId: string;
  quantity: number;
  unitCostCents: bigint | number;
  amountCents: bigint | number;
}

export interface VendorCreditModInput {
  txnId: string;
  editSequence: string;
  vendorListId: string;
  apAccountListId: string;
  /** `YYYY-MM-DD` */
  txnDate: string;
  refNumber: string | null;
  memo?: string | null;
  expenseLines: VendorCreditModExpenseLine[];
  itemLines: VendorCreditModItemLine[];
}

export function buildVendorCreditModQbxml(input: VendorCreditModInput): string {
  if (!input.txnId) throw new Error("VendorCreditMod requires a TxnID");
  if (!input.editSequence) throw new Error("VendorCreditMod requires an EditSequence");
  if (!input.vendorListId) throw new Error("VendorCreditMod requires a vendor ListID");
  if (!input.apAccountListId) throw new Error("VendorCreditMod requires an APAccountRef ListID");
  if (input.expenseLines.length === 0 && input.itemLines.length === 0) {
    throw new Error("VendorCreditMod requires at least one line");
  }

  const expenseXml = input.expenseLines
    .map((line) => {
      if (!line.accountListId) throw new Error("VendorCredit expense line has no QB account");
      return (
        `<ExpenseLineMod>` +
        tag("TxnLineID", line.txnLineId ?? "-1") +
        `<AccountRef>${tag("ListID", line.accountListId)}</AccountRef>` +
        tag("Amount", centsToDollarsString(line.amountCents)) +
        tag("Memo", line.memo ?? null) +
        `</ExpenseLineMod>`
      );
    })
    .join("");

  const itemXml = input.itemLines
    .map((line) => {
      if (!line.itemListId) throw new Error("VendorCredit item line has no QB item ListID");
      return (
        `<ItemLineMod>` +
        tag("TxnLineID", line.txnLineId ?? "-1") +
        `<ItemRef>${tag("ListID", line.itemListId)}</ItemRef>` +
        tag("Quantity", String(line.quantity)) +
        tag("Cost", centsToDollarsString(line.unitCostCents)) +
        tag("Amount", centsToDollarsString(line.amountCents)) +
        `</ItemLineMod>`
      );
    })
    .join("");

  const body =
    tag("TxnID", input.txnId) +
    tag("EditSequence", input.editSequence) +
    `<VendorRef>${tag("ListID", input.vendorListId)}</VendorRef>` +
    `<APAccountRef>${tag("ListID", input.apAccountListId)}</APAccountRef>` +
    tag("TxnDate", input.txnDate) +
    tag("RefNumber", input.refNumber) +
    tag("Memo", input.memo ?? null) +
    expenseXml +
    itemXml;

  return qbxmlEnvelope(
    `<VendorCreditModRq><VendorCreditMod>${body}</VendorCreditMod></VendorCreditModRq>`
  );
}
