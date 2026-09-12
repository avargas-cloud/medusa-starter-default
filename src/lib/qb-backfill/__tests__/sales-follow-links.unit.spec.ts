import { collectMissingSalesLinks, type KnownSalesTxnIdCache, type SalesLinkableBucket } from "../sales-follow-links";
import type { QbCreditMemo, QbInvoice, QbLinkedTxn, QbReceivePayment, QbReceivePaymentApplication } from "../sales-types";

function linked(overrides: Partial<QbLinkedTxn> = {}): QbLinkedTxn {
  return { txn_id: "INV1", txn_type: "Invoice", txn_date: "2025-06-01", amount_cents: 100, ref_number: null, ...overrides };
}

function application(overrides: Partial<QbReceivePaymentApplication> = {}): QbReceivePaymentApplication {
  return {
    txn_id: "INV1",
    txn_type: "Invoice",
    txn_date: "2025-06-01",
    ref_number: null,
    balance_remaining_cents: 0,
    amount_cents: 100,
    discount_amount_cents: null,
    discount_account_ref: null,
    set_credits: [],
    ...overrides,
  };
}

function payment(overrides: Partial<QbReceivePayment> = {}): QbReceivePayment {
  return {
    txn_id: "PAY1",
    edit_sequence: "1",
    customer_ref: null,
    ar_account_ref: null,
    txn_date: "2026-01-15",
    ref_number: null,
    total_amount_cents: 100,
    payment_method_ref: null,
    deposit_to_account_ref: null,
    memo: null,
    unused_payment_cents: 0,
    unused_credits_cents: 0,
    applied: [],
    ...overrides,
  };
}

function creditMemo(overrides: Partial<QbCreditMemo> = {}): QbCreditMemo {
  return {
    txn_id: "CM1",
    edit_sequence: "1",
    customer_ref: null,
    txn_date: "2026-01-15",
    ref_number: null,
    is_pending: false,
    subtotal_cents: 0,
    sales_tax_total_cents: 0,
    total_amount_cents: 0,
    credit_remaining_cents: 0,
    memo: null,
    linked_txns: [],
    lines: [],
    ...overrides,
  };
}

const emptyCache: KnownSalesTxnIdCache = { invoices: new Set(), credit_memos: new Set() };

describe("qb-backfill/sales-follow-links::collectMissingSalesLinks", () => {
  it("(a) invoice aplicado por un pago del rango, fecha bajo el piso y no conocido → missing.invoices", () => {
    const bucket: SalesLinkableBucket = {
      invoices: [],
      credit_memos: [],
      receive_payments: [payment({ applied: [application({ txn_id: "INV1", txn_date: "2025-06-01" })] })],
    };
    const missing = collectMissingSalesLinks(bucket, emptyCache, "2026-01-01");
    expect(missing.invoices).toEqual(["INV1"]);
  });

  it("invoice aplicado pero YA sobre/después del piso → no se sigue (la ventana mensual ya lo trae)", () => {
    const bucket: SalesLinkableBucket = {
      invoices: [],
      credit_memos: [],
      receive_payments: [payment({ applied: [application({ txn_id: "INV1", txn_date: "2026-02-01" })] })],
    };
    const missing = collectMissingSalesLinks(bucket, emptyCache, "2026-01-01");
    expect(missing.invoices).toEqual([]);
  });

  it("invoice ya conocido (cache) → no se re-pide", () => {
    const bucket: SalesLinkableBucket = {
      invoices: [],
      credit_memos: [],
      receive_payments: [payment({ applied: [application({ txn_id: "INV1", txn_date: "2025-06-01" })] })],
    };
    const cache: KnownSalesTxnIdCache = { invoices: new Set(["INV1"]), credit_memos: new Set() };
    expect(collectMissingSalesLinks(bucket, cache, "2026-01-01").invoices).toEqual([]);
  });

  it("(b) credit memo con LinkedTxn Invoice bajo el piso → missing.invoices", () => {
    const bucket: SalesLinkableBucket = {
      invoices: [],
      credit_memos: [creditMemo({ linked_txns: [linked({ txn_id: "INV2", txn_type: "Invoice", txn_date: "2025-09-01" })] })],
      receive_payments: [],
    };
    const missing = collectMissingSalesLinks(bucket, emptyCache, "2026-01-01");
    expect(missing.invoices).toEqual(["INV2"]);
  });

  it("credit memo LinkedTxn de otro tipo (no Invoice) → ignorado", () => {
    const bucket: SalesLinkableBucket = {
      invoices: [],
      credit_memos: [creditMemo({ linked_txns: [linked({ txn_id: "X1", txn_type: "SalesReceipt", txn_date: "2025-09-01" })] })],
      receive_payments: [],
    };
    expect(collectMissingSalesLinks(bucket, emptyCache, "2026-01-01").invoices).toEqual([]);
  });

  it("(c) set_credits del pago aplicado → missing.credit_memos SIN piso de fecha", () => {
    const bucket: SalesLinkableBucket = {
      invoices: [],
      credit_memos: [],
      receive_payments: [
        payment({
          applied: [application({ set_credits: [{ credit_txn_id: "CM9", applied_amount_cents: 50 }] })],
        }),
      ],
    };
    const missing = collectMissingSalesLinks(bucket, emptyCache, "2026-01-01");
    expect(missing.credit_memos).toEqual(["CM9"]);
  });

  it("set_credits ya conocido → no se re-pide", () => {
    const bucket: SalesLinkableBucket = {
      invoices: [],
      credit_memos: [],
      receive_payments: [
        payment({ applied: [application({ set_credits: [{ credit_txn_id: "CM9", applied_amount_cents: 50 }] })] }),
      ],
    };
    const cache: KnownSalesTxnIdCache = { invoices: new Set(), credit_memos: new Set(["CM9"]) };
    expect(collectMissingSalesLinks(bucket, cache, "2026-01-01").credit_memos).toEqual([]);
  });

  it("bucket vacío → sin faltantes", () => {
    const bucket: SalesLinkableBucket = { invoices: [], credit_memos: [], receive_payments: [] };
    expect(collectMissingSalesLinks(bucket, emptyCache, "2026-01-01")).toEqual({ invoices: [], credit_memos: [] });
  });
});
