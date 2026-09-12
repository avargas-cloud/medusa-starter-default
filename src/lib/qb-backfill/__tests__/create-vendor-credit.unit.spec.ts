import { decideCreditCreation, deriveAppliedCents } from "../create-vendor-credit";
import type { QbVendorCredit } from "../types";

function credit(overrides: Partial<QbVendorCredit> = {}): QbVendorCredit {
  return {
    txn_id: "VC1",
    edit_sequence: "1",
    ref_number: null,
    vendor_ref: { list_id: "v1", full_name: "VENDOR1" },
    txn_date: "2026-08-15",
    amount_cents: 500,
    memo: null,
    item_lines: [],
    expense_lines: [],
    linked_txns: [],
    ...overrides,
  };
}

describe("qb-backfill/create-vendor-credit", () => {
  describe("decideCreditCreation", () => {
    it("ya conocido → skip 'already'", () => {
      expect(decideCreditCreation(credit(), new Set(["VC1"]))).toEqual({ create: false, reason: "already" });
    });
    it("desconocido → 'create'", () => {
      expect(decideCreditCreation(credit(), new Set())).toEqual({ create: true, reason: "create" });
    });
  });

  describe("deriveAppliedCents", () => {
    it("QB no expone CreditRemaining en VendorCreditQueryRq → siempre 0 (todo disponible)", () => {
      expect(deriveAppliedCents()).toBe(0);
    });
  });
});
