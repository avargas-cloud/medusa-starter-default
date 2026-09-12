import { planBillRelinks, type BillRelinkRow } from "../relink-bills";
import type { PoIndexEntry } from "../apply-purchases";
import type { QbBill, QbLinkedTxn } from "../types";

function linked(overrides: Partial<QbLinkedTxn> = {}): QbLinkedTxn {
  return { txn_id: "PO1", txn_type: "PurchaseOrder", txn_date: "2025-01-01", amount_cents: 100, ref_number: null, ...overrides };
}

function bill(overrides: Partial<QbBill> = {}): QbBill {
  return {
    txn_id: "BILL1",
    edit_sequence: "1",
    ref_number: "INV-1",
    vendor_ref: { list_id: "v1", full_name: "VENDOR1" },
    ap_account_ref: null,
    txn_date: "2025-08-15",
    due_date: null,
    amount_due_cents: 1000,
    is_paid: false,
    memo: null,
    item_lines: [],
    expense_lines: [],
    linked_txns: [linked()],
    ...overrides,
  };
}

function row(overrides: Partial<BillRelinkRow> = {}): BillRelinkRow {
  return { id: "vb_1", qb_txn_id: "BILL1", purchase_order_id: null, ...overrides };
}

const poEntry: PoIndexEntry = { id: "po_1", lines: [] };

describe("qb-backfill/relink-bills", () => {
  describe("planBillRelinks", () => {
    it("purchase_order_id NULL + LinkedTxn PurchaseOrder conocido → relinkeado", () => {
      const poIndex = new Map([["PO1", poEntry]]);
      const poNumberById = new Map([["po_1", "PO-0001"]]);
      const plan = planBillRelinks([bill()], [row()], poIndex, poNumberById);
      expect(plan).toEqual([{ vendor_bill_id: "vb_1", qb_txn_id: "BILL1", po_id: "po_1", po_number: "PO-0001" }]);
    });

    it("purchase_order_id ya seteado → saltado (no lo toca)", () => {
      const poIndex = new Map([["PO1", poEntry]]);
      const poNumberById = new Map([["po_1", "PO-0001"]]);
      const plan = planBillRelinks([bill()], [row({ purchase_order_id: "po_already" })], poIndex, poNumberById);
      expect(plan).toEqual([]);
    });

    it("el PO enlazado no existe (aún) en el índice → saltado", () => {
      const poIndex = new Map<string, PoIndexEntry>(); // vacío: PO1 no resuelve
      const poNumberById = new Map<string, string>();
      const plan = planBillRelinks([bill()], [row()], poIndex, poNumberById);
      expect(plan).toEqual([]);
    });

    it("bill sin LinkedTxn tipo PurchaseOrder → saltado", () => {
      const poIndex = new Map([["PO1", poEntry]]);
      const poNumberById = new Map([["po_1", "PO-0001"]]);
      const billWithoutPoLink = bill({ linked_txns: [linked({ txn_id: "B2", txn_type: "Bill" })] });
      const plan = planBillRelinks([billWithoutPoLink], [row()], poIndex, poNumberById);
      expect(plan).toEqual([]);
    });

    it("bill sin caché QB para su TxnID → saltado (no revienta)", () => {
      const poIndex = new Map([["PO1", poEntry]]);
      const poNumberById = new Map([["po_1", "PO-0001"]]);
      const plan = planBillRelinks([], [row({ qb_txn_id: "NOT_IN_CACHE" })], poIndex, poNumberById);
      expect(plan).toEqual([]);
    });

    it("po_number cae al po_id si el índice de números no lo tiene (defensivo, no debería pasar en producción)", () => {
      const poIndex = new Map([["PO1", poEntry]]);
      const poNumberById = new Map<string, string>(); // sin 'po_1'
      const plan = planBillRelinks([bill()], [row()], poIndex, poNumberById);
      expect(plan).toEqual([{ vendor_bill_id: "vb_1", qb_txn_id: "BILL1", po_id: "po_1", po_number: "po_1" }]);
    });
  });
});
