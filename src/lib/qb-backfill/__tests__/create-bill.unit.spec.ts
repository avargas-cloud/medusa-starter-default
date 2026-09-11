import { decideBillCreation, deriveBillType } from "../create-bill";
import type { QbBill } from "../types";

function bill(overrides: Partial<QbBill> = {}): QbBill {
  return {
    txn_id: "BILL1",
    edit_sequence: "1",
    ref_number: "INV-1",
    vendor_ref: { list_id: "v1", full_name: "VENDOR1" },
    ap_account_ref: null,
    txn_date: "2026-08-15",
    due_date: null,
    amount_due_cents: 1000,
    is_paid: false,
    memo: null,
    item_lines: [],
    expense_lines: [],
    linked_txns: [],
    ...overrides,
  };
}

describe("qb-backfill/create-bill", () => {
  describe("decideBillCreation", () => {
    it("ya conocido → skip 'already'", () => {
      expect(decideBillCreation(bill(), new Set(["BILL1"]))).toEqual({ create: false, reason: "already" });
    });
    it("desconocido → 'create'", () => {
      expect(decideBillCreation(bill(), new Set())).toEqual({ create: true, reason: "create" });
    });
  });

  describe("deriveBillType", () => {
    it("con PO resuelto → 'regular'", () => {
      expect(deriveBillType("po_123")).toBe("regular");
    });
    it("sin PO (gasto suelto) → 'expense'", () => {
      expect(deriveBillType(null)).toBe("expense");
    });
  });
});
