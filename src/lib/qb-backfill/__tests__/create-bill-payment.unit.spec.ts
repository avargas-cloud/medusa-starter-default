import {
  decidePaymentCreation,
  mapPaymentMethod,
  resolveApplications,
} from "../create-bill-payment";
import type { QbBillPayment, QbBillPaymentApplication } from "../types";

function application(overrides: Partial<QbBillPaymentApplication> = {}): QbBillPaymentApplication {
  return {
    txn_id: "BILL1",
    txn_type: "Bill",
    txn_date: "2026-08-15",
    amount_cents: 500,
    balance_remaining_cents: 0,
    ...overrides,
  };
}

function payment(overrides: Partial<QbBillPayment> = {}): QbBillPayment {
  return {
    txn_id: "PAY1",
    edit_sequence: "1",
    payment_method: "check",
    payee_ref: { list_id: "v1", full_name: "VENDOR1" },
    ap_account_ref: null,
    bank_account_ref: { list_id: "b1", full_name: "Checking" },
    credit_card_account_ref: null,
    txn_date: "2026-08-16",
    amount_cents: 500,
    applications: [application()],
    ...overrides,
  };
}

describe("qb-backfill/create-bill-payment", () => {
  describe("decidePaymentCreation", () => {
    it("ya conocido → skip 'already'", () => {
      expect(decidePaymentCreation(payment(), new Set(["PAY1"]))).toEqual({ create: false, reason: "already" });
    });
    it("desconocido → 'create'", () => {
      expect(decidePaymentCreation(payment(), new Set())).toEqual({ create: true, reason: "create" });
    });
  });

  describe("mapPaymentMethod", () => {
    it("check → check", () => {
      expect(mapPaymentMethod("check")).toBe("check");
    });
    it("credit_card → card (enum de vendor_bill_payment.method)", () => {
      expect(mapPaymentMethod("credit_card")).toBe("card");
    });
  });

  describe("resolveApplications", () => {
    it("resuelve cada aplicación contra el índice de bills conocidos", () => {
      const r = resolveApplications([application()], 500, new Map([["BILL1", "vb_1"]]));
      expect(r).toEqual({ ok: true, allocations: [{ vendor_bill_id: "vb_1", amount_cents: 500 }] });
    });
    it("bill no encontrado → bloquea con 'bill_not_found' y el TxnID exacto (negativo: no cuenta como éxito parcial)", () => {
      const r = resolveApplications([application({ txn_id: "MISSING1" })], 500, new Map([["BILL1", "vb_1"]]));
      expect(r).toEqual({ ok: false, reason: "bill_not_found", missing_txn_id: "MISSING1" });
    });
    it("suma de aplicaciones ≠ header → 'amount_mismatch'", () => {
      const r = resolveApplications([application({ amount_cents: 400 })], 500, new Map([["BILL1", "vb_1"]]));
      expect(r).toEqual({ ok: false, reason: "amount_mismatch", sum_cents: 400, header_cents: 500 });
    });
    it("diferencia de 1¢ por redondeo se tolera", () => {
      const r = resolveApplications([application({ amount_cents: 499 })], 500, new Map([["BILL1", "vb_1"]]));
      expect(r.ok).toBe(true);
    });
    it("sin aplicaciones → 'no_applications'", () => {
      expect(resolveApplications([], 0, new Map())).toEqual({ ok: false, reason: "no_applications" });
    });
    it("filas de aplicación que no son 'Bill' (descuento/crédito) se ignoran, no generan allocation", () => {
      const r = resolveApplications(
        [application({ txn_type: "Discount", amount_cents: 500 })],
        500,
        new Map([["BILL1", "vb_1"]])
      );
      expect(r).toEqual({ ok: false, reason: "no_applications" });
    });
  });
});
