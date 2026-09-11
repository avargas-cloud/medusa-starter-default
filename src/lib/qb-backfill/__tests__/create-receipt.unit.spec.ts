import { decideReceiptCreation } from "../create-receipt";
import type { QbItemReceipt, QbItemReceiptLine } from "../types";

function line(overrides: Partial<QbItemReceiptLine> = {}): QbItemReceiptLine {
  return {
    txn_line_id: "L1",
    item_ref: { list_id: "i1", full_name: "ITEM1" },
    description: "desc",
    quantity: 5,
    rate_cents: 100,
    amount_cents: 500,
    linked_po_txn_id: "PO1",
    ...overrides,
  };
}

function receipt(overrides: Partial<QbItemReceipt> = {}): QbItemReceipt {
  return {
    txn_id: "RCPT1",
    edit_sequence: "1",
    ref_number: null,
    vendor_ref: { list_id: "v1", full_name: "VENDOR1" },
    txn_date: "2026-08-15",
    total_amount_cents: 500,
    memo: null,
    lines: [line()],
    linked_txns: [],
    ...overrides,
  };
}

describe("qb-backfill/create-receipt", () => {
  describe("decideReceiptCreation", () => {
    it("ya conocido → skip 'already'", () => {
      expect(decideReceiptCreation(receipt(), new Set(["RCPT1"]))).toEqual({ create: false, reason: "already" });
    });
    it("desconocido → 'create'", () => {
      expect(decideReceiptCreation(receipt(), new Set())).toEqual({ create: true, reason: "create" });
    });
    it("negativo: un TxnID PARECIDO pero distinto no cuenta como conocido", () => {
      expect(decideReceiptCreation(receipt({ txn_id: "RCPT1X" }), new Set(["RCPT1"]))).toEqual({
        create: true,
        reason: "create",
      });
    });
  });
});
