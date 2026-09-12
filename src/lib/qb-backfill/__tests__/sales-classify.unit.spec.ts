import { classifySalesBucket } from "../sales-classify";
import type { KnownSalesTxnIds } from "../sales-resolve";
import type { QbCreditMemo, QbInvoice, QbReceivePayment, QbSalesReceipt } from "../sales-types";

function invoice(overrides: Partial<QbInvoice> = {}): QbInvoice {
  return {
    txn_id: "INV1",
    txn_number: null,
    edit_sequence: "1",
    time_created: null,
    time_modified: null,
    customer_ref: null,
    txn_date: "2026-03-01",
    ref_number: "19999",
    due_date: null,
    is_pending: false,
    is_paid: false,
    subtotal_cents: 1000,
    sales_tax_total_cents: 0,
    sales_tax_percentage: null,
    item_sales_tax_ref: null,
    applied_amount_cents: 0,
    balance_remaining_cents: 1000,
    memo: null,
    po_number: null,
    terms_ref: null,
    sales_rep_ref: null,
    class_ref: null,
    linked_txns: [],
    lines: [{ txn_line_id: "L1", item_ref: null, description: null, quantity: 1, rate_cents: 1000, amount_cents: 1000, sales_tax_code_ref: null }],
    ...overrides,
  };
}

function salesReceipt(overrides: Partial<QbSalesReceipt> = {}): QbSalesReceipt {
  return {
    txn_id: "SR1",
    txn_number: null,
    edit_sequence: "1",
    time_created: null,
    time_modified: null,
    customer_ref: null,
    txn_date: "2026-03-01",
    ref_number: "19999",
    subtotal_cents: 1000,
    sales_tax_total_cents: 0,
    sales_tax_percentage: null,
    item_sales_tax_ref: null,
    total_amount_cents: 1000,
    payment_method_ref: null,
    deposit_to_account_ref: null,
    check_number: null,
    memo: null,
    class_ref: null,
    linked_txns: [],
    lines: [{ txn_line_id: "L1", item_ref: null, description: null, quantity: 1, rate_cents: 1000, amount_cents: 1000, sales_tax_code_ref: null }],
    ...overrides,
  };
}

function payment(overrides: Partial<QbReceivePayment> = {}): QbReceivePayment {
  return {
    txn_id: "PAY1",
    edit_sequence: "1",
    customer_ref: null,
    ar_account_ref: null,
    txn_date: "2026-03-01",
    ref_number: "19999",
    total_amount_cents: 1000,
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
    txn_date: "2026-03-01",
    ref_number: "19999",
    is_pending: false,
    subtotal_cents: 100,
    sales_tax_total_cents: 0,
    total_amount_cents: 100,
    credit_remaining_cents: 100,
    memo: null,
    linked_txns: [],
    lines: [],
    ...overrides,
  };
}

const emptyKnown: KnownSalesTxnIds = {
  invoices: new Set(),
  sales_receipts: new Set(),
  payments: new Set(),
  credit_memos: new Set(),
};

const baseOpts = { toDate: "2026-09-08", unpaidInvoiceTxnIds: new Set<string>() };
const emptyBucket = { invoices: [] as QbInvoice[], sales_receipts: [] as QbSalesReceipt[], payments: [] as QbReceivePayment[], credit_memos: [] as QbCreditMemo[] };

describe("qb-backfill/sales-classify::classifySalesBucket", () => {
  it("known_txn_id → already, no crea ni bloquea", () => {
    const doc = invoice();
    const known: KnownSalesTxnIds = { ...emptyKnown, invoices: new Set(["INV1"]) };
    const result = classifySalesBucket({ ...emptyBucket, invoices: [doc] }, known, baseOpts);
    expect(result.invoices).toEqual({ already: 1, create: [], blocked: [] });
  });

  it("invoice sano dentro de rango → create", () => {
    const doc = invoice();
    const result = classifySalesBucket({ ...emptyBucket, invoices: [doc] }, emptyKnown, baseOpts);
    expect(result.invoices.create).toEqual([doc]);
    expect(result.invoices.blocked).toEqual([]);
  });

  it("after_clone_pos_memo: txn_date posterior al --to", () => {
    const doc = invoice({ txn_date: "2026-09-09" });
    const result = classifySalesBucket({ ...emptyBucket, invoices: [doc] }, emptyKnown, baseOpts);
    expect(result.invoices.blocked).toEqual([{ txn_id: "INV1", reason: "after_clone_pos_memo" }]);
  });

  it("after_clone_pos_memo: memo 'Medusa Invoice …'", () => {
    const doc = invoice({ memo: "Medusa Invoice S11234" });
    const result = classifySalesBucket({ ...emptyBucket, invoices: [doc] }, emptyKnown, baseOpts);
    expect(result.invoices.blocked).toEqual([{ txn_id: "INV1", reason: "after_clone_pos_memo" }]);
  });

  it("after_clone_pos_memo: ref_number con forma POS y fecha >= 2026-04-14", () => {
    const doc = invoice({ ref_number: "20001", txn_date: "2026-04-20" });
    const result = classifySalesBucket({ ...emptyBucket, invoices: [doc] }, emptyKnown, baseOpts);
    expect(result.invoices.blocked).toEqual([{ txn_id: "INV1", reason: "after_clone_pos_memo" }]);
  });

  it("ref_number con forma POS pero ANTES del 2026-04-14 → no bloquea por eso", () => {
    const doc = invoice({ ref_number: "20001", txn_date: "2026-03-01" });
    const result = classifySalesBucket({ ...emptyBucket, invoices: [doc] }, emptyKnown, baseOpts);
    expect(result.invoices.create).toEqual([doc]);
  });

  it("voided_zero_total: invoice en 0, líneas en 0 y memo VOID:", () => {
    const doc = invoice({
      subtotal_cents: 0,
      sales_tax_total_cents: 0,
      memo: "VOID: customer cancelled",
      lines: [{ txn_line_id: "L1", item_ref: null, description: null, quantity: null, rate_cents: null, amount_cents: 0, sales_tax_code_ref: null }],
    });
    const result = classifySalesBucket({ ...emptyBucket, invoices: [doc] }, emptyKnown, baseOpts);
    expect(result.invoices.blocked).toEqual([{ txn_id: "INV1", reason: "voided_zero_total" }]);
  });

  it("un $0 SIN memo VOID (garantía/cortesía) es un documento real → create", () => {
    const doc = invoice({
      subtotal_cents: 0,
      sales_tax_total_cents: 0,
      memo: "Warranty replacement",
      lines: [{ txn_line_id: "L1", item_ref: null, description: null, quantity: 1, rate_cents: 0, amount_cents: 0, sales_tax_code_ref: null }],
    });
    const result = classifySalesBucket({ ...emptyBucket, invoices: [doc] }, emptyKnown, baseOpts);
    expect(result.invoices.blocked).toEqual([]);
    expect(result.invoices.create.map((d) => d.txn_id)).toEqual(["INV1"]);
  });

  it("closed_2025: invoice de 2025, no via_link y no en el set de impagos → blocked", () => {
    const doc = invoice({ txn_id: "INV2025", txn_date: "2025-11-01" });
    const result = classifySalesBucket({ ...emptyBucket, invoices: [doc] }, emptyKnown, baseOpts);
    expect(result.invoices.blocked).toEqual([{ txn_id: "INV2025", reason: "closed_2025" }]);
  });

  it("closed_2025 exento: invoice de 2025 via_link", () => {
    const doc = invoice({ txn_id: "INV2025", txn_date: "2025-11-01", via_link: true });
    const result = classifySalesBucket({ ...emptyBucket, invoices: [doc] }, emptyKnown, baseOpts);
    expect(result.invoices.create).toEqual([doc]);
  });

  it("closed_2025 exento: invoice de 2025 en el set de impagos hoy", () => {
    const doc = invoice({ txn_id: "INV2025", txn_date: "2025-11-01" });
    const result = classifySalesBucket({ ...emptyBucket, invoices: [doc] }, emptyKnown, {
      ...baseOpts,
      unpaidInvoiceTxnIds: new Set(["INV2025"]),
    });
    expect(result.invoices.create).toEqual([doc]);
  });

  it("sales_receipt_2025: SR de 2025 SIEMPRE bloqueado (nace pagado, nunca se sigue)", () => {
    const doc = salesReceipt({ txn_id: "SR2025", txn_date: "2025-11-01" });
    const result = classifySalesBucket({ ...emptyBucket, sales_receipts: [doc] }, emptyKnown, baseOpts);
    expect(result.sales_receipts.blocked).toEqual([{ txn_id: "SR2025", reason: "sales_receipt_2025" }]);
  });

  it("sales receipt sano dentro de rango → create", () => {
    const doc = salesReceipt();
    const result = classifySalesBucket({ ...emptyBucket, sales_receipts: [doc] }, emptyKnown, baseOpts);
    expect(result.sales_receipts.create).toEqual([doc]);
  });

  it("payment: after_clone_pos_memo aplica igual que invoice", () => {
    const doc = payment({ memo: "Medusa Order S11234" });
    const result = classifySalesBucket({ ...emptyBucket, payments: [doc] }, emptyKnown, baseOpts);
    expect(result.payments.blocked).toEqual([{ txn_id: "PAY1", reason: "after_clone_pos_memo" }]);
  });

  it("payment sano → create", () => {
    const doc = payment();
    const result = classifySalesBucket({ ...emptyBucket, payments: [doc] }, emptyKnown, baseOpts);
    expect(result.payments.create).toEqual([doc]);
  });

  it("credit_memo: after_clone_pos_memo aplica igual", () => {
    const doc = creditMemo({ memo: "Medusa SR S11234" });
    const result = classifySalesBucket({ ...emptyBucket, credit_memos: [doc] }, emptyKnown, baseOpts);
    expect(result.credit_memos.blocked).toEqual([{ txn_id: "CM1", reason: "after_clone_pos_memo" }]);
  });

  it("credit_memo sano → create", () => {
    const doc = creditMemo();
    const result = classifySalesBucket({ ...emptyBucket, credit_memos: [doc] }, emptyKnown, baseOpts);
    expect(result.credit_memos.create).toEqual([doc]);
  });
});
