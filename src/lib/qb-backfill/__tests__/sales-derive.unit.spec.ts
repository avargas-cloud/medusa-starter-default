import {
  deriveInvoiceStatus,
  derivePaymentRefund,
  derivePaymentStatus,
  deriveRefundMethod,
  invoiceTotalCents,
  isVoidedCreditMemo,
  mapQbPaymentMethod,
} from "../sales-derive";
import { newPaymentNotes, planPaymentApplications } from "../create-sales-payment";
import type { QbReceivePayment, QbReceivePaymentApplication } from "../sales-types";

describe("qb-backfill/sales-derive · mapQbPaymentMethod", () => {
  it.each([
    ["Cash", "cash", null, "cash"],
    ["Check", "check", null, "check"],
    ["Debit Card", "debit_card", null, "debit_card"],
    ["Visa", "credit_card", "visa", "credit_card"],
    ["MasterCard", "credit_card", "mastercard", "credit_card"],
    ["American Express", "credit_card", "amex", "credit_card"],
    ["Discover", "credit_card", "discover", "credit_card"],
    ["Capital One", "credit_card", "capital_one", "credit_card"],
    ["Checking Account", "ach", null, "ach"],
    ["E-Check", "ach", null, "ach"],
    ["Zelle", "zelle", null, "zelle"],
    ["Credit Memo", "credit_memo", null, "credit"],
    ["Transfer", "other", null, null],
    [null, "other", null, null],
  ])("%s → %s / %s / invoice %s", (qb, method, brand, invoiceMethod) => {
    expect(mapQbPaymentMethod(qb)).toEqual({ method, card_brand: brand, invoice_method: invoiceMethod });
  });
});

describe("qb-backfill/sales-derive · status de factura", () => {
  it("IsPaid manda: paid, todo pagado", () => {
    expect(deriveInvoiceStatus({ is_paid: true, balance_remaining_cents: 0 }, 4232)).toEqual({ status: "paid", amount_paid_cents: 4232, balance_due_cents: 0 });
  });
  it("abierta con pago parcial: partial, pagado = total − saldo (AppliedAmount negativo de QB no se usa)", () => {
    expect(deriveInvoiceStatus({ is_paid: false, balance_remaining_cents: 17405 }, 42324)).toEqual({ status: "partial", amount_paid_cents: 24919, balance_due_cents: 17405 });
  });
  it("abierta sin pagos: issued", () => {
    expect(deriveInvoiceStatus({ is_paid: false, balance_remaining_cents: 1496 }, 1496)).toEqual({ status: "issued", amount_paid_cents: 0, balance_due_cents: 1496 });
  });
  it("invoiceTotalCents = Subtotal + SalesTaxTotal", () => {
    expect(invoiceTotalCents({ subtotal_cents: 100, sales_tax_total_cents: 7 })).toBe(107);
  });
});

describe("qb-backfill/sales-derive · status de pago y refund_method", () => {
  it("derivePaymentStatus por UnusedPayment", () => {
    expect(derivePaymentStatus({ total_amount_cents: 100, unused_payment_cents: 0 })).toBe("applied");
    expect(derivePaymentStatus({ total_amount_cents: 100, unused_payment_cents: 40 })).toBe("partially_applied");
    expect(derivePaymentStatus({ total_amount_cents: 100, unused_payment_cents: 100 })).toBe("available");
  });
  // #4915 (prod 2026-09-12): ReceivePayment aplicado a un ARRefundCreditCard nacía `applied`
  // con 0 aplicaciones y $411.45 de saldo fantasma. Una aplicación a un refund ES la devolución.
  describe("derivePaymentRefund / derivePaymentStatus con devoluciones", () => {
    const applied = (txn_type: string, amount_cents: number, txn_id = txn_type, txn_date: string | null = "2026-04-13"): QbReceivePaymentApplication => ({
      txn_id, txn_type, txn_date, ref_number: "020074", balance_remaining_cents: 0, amount_cents,
      discount_amount_cents: null, discount_account_ref: null, set_credits: [],
    });
    it("refund total: ARRefundCreditCard por el monto entero → refunded", () => {
      const rp = { total_amount_cents: 41145, unused_payment_cents: 0, applied: [applied("ARRefundCreditCard", 41145, "1C06E8")] };
      expect(derivePaymentRefund(rp)).toEqual({ refund_cents: 41145, refund_txn_date: "2026-04-13", refund_txn_ids: ["1C06E8"] });
      expect(derivePaymentStatus(rp)).toBe("refunded");
    });
    it("refund parcial: parte a factura, parte devuelta por cheque → partial_refunded", () => {
      const rp = { total_amount_cents: 1000, unused_payment_cents: 0, applied: [applied("Invoice", 600, "INV1", null), applied("Check", 400, "CHK1")] };
      expect(derivePaymentRefund(rp)).toEqual({ refund_cents: 400, refund_txn_date: "2026-04-13", refund_txn_ids: ["CHK1"] });
      expect(derivePaymentStatus(rp)).toBe("partial_refunded");
    });
    it("sin devolución: sólo facturas → la regla de UnusedPayment manda", () => {
      const rp = { total_amount_cents: 1000, unused_payment_cents: 0, applied: [applied("Invoice", 1000, "INV1", null)] };
      expect(derivePaymentRefund(rp)).toEqual({ refund_cents: 0, refund_txn_date: null, refund_txn_ids: [] });
      expect(derivePaymentStatus(rp)).toBe("applied");
    });
    it("una devolución en 0 no cuenta", () => {
      const rp = { total_amount_cents: 1000, unused_payment_cents: 1000, applied: [applied("ARRefundCreditCard", 0)] };
      expect(derivePaymentStatus(rp)).toBe("available");
    });
  });
  it("deriveRefundMethod: cheque o reembolso a tarjeta = refund; si no, store_credit", () => {
    const inv = { txn_id: "i", txn_type: "Invoice", txn_date: null, amount_cents: -1, ref_number: null };
    expect(deriveRefundMethod([inv])).toBe("store_credit");
    expect(deriveRefundMethod([inv, { ...inv, txn_type: "Check" }])).toBe("refund");
    expect(deriveRefundMethod([{ ...inv, txn_type: "ARRefundCreditCard" }])).toBe("refund");
    expect(deriveRefundMethod([])).toBe("store_credit");
  });
  it("isVoidedCreditMemo: total 0 y líneas en 0", () => {
    const zero = { txn_line_id: "l", item_ref: null, description: null, quantity: 0, rate_cents: 0, amount_cents: 0, sales_tax_code_ref: null };
    expect(isVoidedCreditMemo({ total_amount_cents: 0, lines: [zero] })).toBe(true);
    expect(isVoidedCreditMemo({ total_amount_cents: 0, lines: [{ ...zero, quantity: 1 }] })).toBe(false);
    expect(isVoidedCreditMemo({ total_amount_cents: 500, lines: [zero] })).toBe(false);
  });
});

describe("qb-backfill/create-sales-payment · planPaymentApplications (puro)", () => {
  const app = (over: Partial<QbReceivePaymentApplication>): QbReceivePaymentApplication => ({
    txn_id: "INV1", txn_type: "Invoice", txn_date: null, ref_number: "18849", balance_remaining_cents: 0,
    amount_cents: 1000, discount_amount_cents: null, discount_account_ref: null, set_credits: [], ...over,
  });
  const rp = { txn_id: "PAY1" } as QbReceivePayment;
  const inv = { invoice_id: "inv_1", invoice_number: "00001", order_id: "order_1", customer_id: "cus_1" };

  it("linkea las que resuelven; reporta unlinked, discount y set_credit sin bloquear", () => {
    const notes = newPaymentNotes();
    const linked = planPaymentApplications(
      rp,
      [
        { application: app({}), invoice: inv },
        { application: app({ txn_id: "INV2", ref_number: "18850" }), invoice: null },
        { application: app({ txn_id: "INV3", discount_amount_cents: 50 }), invoice: inv },
        { application: app({ txn_id: "INV4", amount_cents: 0, set_credits: [{ credit_txn_id: "CM1", applied_amount_cents: 300 }] }), invoice: inv },
      ],
      notes
    );
    expect(linked.map((l) => l.application.txn_id)).toEqual(["INV1", "INV3"]);
    expect(notes.unlinked_application).toEqual([{ payment_txn_id: "PAY1", invoice_txn_id: "INV2", invoice_ref_number: "18850", amount_cents: 1000 }]);
    expect(notes.discount_ignored).toEqual([{ payment_txn_id: "PAY1", invoice_txn_id: "INV3", discount_cents: 50 }]);
    expect(notes.set_credit_ignored).toEqual([{ payment_txn_id: "PAY1", invoice_txn_id: "INV4", credit_txn_id: "CM1", amount_cents: 300 }]);
  });

  it("una aplicación a un refund NO es una factura desconocida: va a refund_application y no se linkea", () => {
    const notes = newPaymentNotes();
    const linked = planPaymentApplications(
      rp,
      [
        { application: app({ txn_id: "1C06E8", txn_type: "ARRefundCreditCard", ref_number: "020074", amount_cents: 41145 }), invoice: null },
        { application: app({}), invoice: inv },
      ],
      notes
    );
    expect(linked.map((l) => l.application.txn_id)).toEqual(["INV1"]);
    expect(notes.unlinked_application).toEqual([]);
    expect(notes.refund_application).toEqual([{ payment_txn_id: "PAY1", refund_txn_id: "1C06E8", refund_txn_type: "ARRefundCreditCard", refund_ref_number: "020074", amount_cents: 41145 }]);
  });
});
