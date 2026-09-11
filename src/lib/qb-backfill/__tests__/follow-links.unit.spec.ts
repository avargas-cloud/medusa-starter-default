import { collectMissingLinks, type KnownTxnIdCache, type LinkableBucket } from "../follow-links";
import type { QbBill, QbBillPayment, QbItemReceipt, QbLinkedTxn, QbPurchaseOrder, QbVendorCredit } from "../types";

function linked(overrides: Partial<QbLinkedTxn> = {}): QbLinkedTxn {
  return { txn_id: "T1", txn_type: "PurchaseOrder", txn_date: "2026-08-01", amount_cents: 100, ref_number: null, ...overrides };
}

function bill(overrides: Partial<QbBill> = {}): QbBill {
  return {
    txn_id: "B1",
    edit_sequence: "1",
    ref_number: null,
    vendor_ref: null,
    ap_account_ref: null,
    txn_date: "2026-08-01",
    due_date: null,
    amount_due_cents: 0,
    is_paid: false,
    memo: null,
    item_lines: [],
    expense_lines: [],
    linked_txns: [],
    ...overrides,
  };
}

function receipt(overrides: Partial<QbItemReceipt> = {}): QbItemReceipt {
  return {
    txn_id: "R1",
    edit_sequence: "1",
    ref_number: null,
    vendor_ref: null,
    txn_date: "2026-08-01",
    total_amount_cents: 0,
    memo: null,
    lines: [],
    linked_txns: [],
    ...overrides,
  };
}

function po(overrides: Partial<QbPurchaseOrder> = {}): QbPurchaseOrder {
  return {
    txn_id: "P1",
    edit_sequence: "1",
    txn_number: null,
    ref_number: null,
    vendor_ref: null,
    txn_date: "2026-08-01",
    due_date: null,
    expected_date: null,
    total_amount_cents: 0,
    is_manually_closed: false,
    is_fully_received: false,
    memo: null,
    lines: [],
    linked_txns: [],
    ...overrides,
  };
}

function payment(overrides: Partial<QbBillPayment> = {}): QbBillPayment {
  return {
    txn_id: "PAY1",
    edit_sequence: "1",
    payment_method: "check",
    payee_ref: null,
    ap_account_ref: null,
    bank_account_ref: null,
    credit_card_account_ref: null,
    txn_date: "2026-08-01",
    amount_cents: 0,
    applications: [],
    ...overrides,
  };
}

const emptyCache: KnownTxnIdCache = { bills: new Set(), purchase_orders: new Set(), item_receipts: new Set() };
const emptyBucket: LinkableBucket = { bills: [], item_receipts: [], purchase_orders: [], bill_payments: [] };

describe("qb-backfill/follow-links :: collectMissingLinks", () => {
  it("bucket vacío → sin faltantes de ningún tipo", () => {
    expect(collectMissingLinks(emptyBucket, emptyCache)).toEqual({ bills: [], purchase_orders: [], item_receipts: [], vendor_credits: [] });
  });

  it("bill_payments: AppliedToTxnRet tipo Bill ausente del cache → falta", () => {
    const bucket: LinkableBucket = {
      ...emptyBucket,
      bill_payments: [payment({ applications: [{ txn_id: "B2025", txn_type: "Bill", txn_date: null, amount_cents: 100, balance_remaining_cents: null }] })],
    };
    expect(collectMissingLinks(bucket, emptyCache).bills).toEqual(["B2025"]);
  });

  it("bill_payments: aplicación tipo Bill YA en cache → no falta", () => {
    const bucket: LinkableBucket = {
      ...emptyBucket,
      bill_payments: [payment({ applications: [{ txn_id: "B2025", txn_type: "Bill", txn_date: null, amount_cents: 100, balance_remaining_cents: null }] })],
    };
    const cache: KnownTxnIdCache = { ...emptyCache, bills: new Set(["B2025"]) };
    expect(collectMissingLinks(bucket, cache).bills).toEqual([]);
  });

  it("bill_payments: aplicación NO tipo Bill (discount/credit) se ignora", () => {
    const bucket: LinkableBucket = {
      ...emptyBucket,
      bill_payments: [payment({ applications: [{ txn_id: "X1", txn_type: "Discount", txn_date: null, amount_cents: 5, balance_remaining_cents: null }] })],
    };
    expect(collectMissingLinks(bucket, emptyCache).bills).toEqual([]);
  });

  it("bills+recibos: LinkedTxn tipo PurchaseOrder ausente del cache → falta (de ambos orígenes, deduplicado)", () => {
    const bucket: LinkableBucket = {
      ...emptyBucket,
      bills: [bill({ linked_txns: [linked({ txn_id: "PO2025", txn_type: "PurchaseOrder" })] })],
      item_receipts: [receipt({ linked_txns: [linked({ txn_id: "PO2025", txn_type: "PurchaseOrder" })] })],
    };
    expect(collectMissingLinks(bucket, emptyCache).purchase_orders).toEqual(["PO2025"]);
  });

  it("bills: LinkedTxn tipo ItemReceipt ausente del cache → falta", () => {
    const bucket: LinkableBucket = {
      ...emptyBucket,
      bills: [bill({ linked_txns: [linked({ txn_id: "R2025", txn_type: "ItemReceipt" })] })],
    };
    expect(collectMissingLinks(bucket, emptyCache).item_receipts).toEqual(["R2025"]);
  });

  it("recibos NO aportan a item_receipts faltantes (sólo los bills lo hacen)", () => {
    const bucket: LinkableBucket = {
      ...emptyBucket,
      item_receipts: [receipt({ linked_txns: [linked({ txn_id: "R9", txn_type: "ItemReceipt" })] })],
    };
    expect(collectMissingLinks(bucket, emptyCache).item_receipts).toEqual([]);
  });

  it("purchase_orders ya presentes en cache no vuelven a pedirse", () => {
    const bucket: LinkableBucket = {
      ...emptyBucket,
      bills: [bill({ linked_txns: [linked({ txn_id: "PO_KNOWN", txn_type: "PurchaseOrder" })] })],
    };
    const cache: KnownTxnIdCache = { ...emptyCache, purchase_orders: new Set(["PO_KNOWN"]) };
    expect(collectMissingLinks(bucket, cache).purchase_orders).toEqual([]);
  });

  it("vendor_credits: LinkedTxn tipo Bill ausente del cache → falta aunque sea anterior al piso (un crédito del rango lo cerró)", () => {
    const credit: QbVendorCredit = {
      txn_id: "VC1", edit_sequence: "1", ref_number: null, vendor_ref: null, txn_date: "2026-02-01", amount_cents: 100, memo: null,
      item_lines: [], expense_lines: [], linked_txns: [linked({ txn_id: "B2025", txn_type: "Bill", txn_date: "2025-11-20" })],
    };
    const bucket: LinkableBucket = { bills: [], item_receipts: [], purchase_orders: [], bill_payments: [], vendor_credits: [credit] };
    const cache: KnownTxnIdCache = { bills: new Set(), purchase_orders: new Set(), item_receipts: new Set() };
    expect(collectMissingLinks(bucket, cache, "2026-01-01").bills).toEqual(["B2025"]);
    expect(collectMissingLinks(bucket, { ...cache, bills: new Set(["B2025"]) }, "2026-01-01").bills).toEqual([]);
  });

  it("bills: LinkedTxn tipo VendorCredit ausente del cache de créditos → falta sin piso; sin cache de créditos no se sigue", () => {
    const b = bill({ linked_txns: [linked({ txn_id: "VC2025", txn_type: "VendorCredit", txn_date: "2025-10-01" })] });
    const bucket: LinkableBucket = { bills: [b], item_receipts: [], purchase_orders: [], bill_payments: [] };
    const base: KnownTxnIdCache = { bills: new Set(), purchase_orders: new Set(), item_receipts: new Set() };
    expect(collectMissingLinks(bucket, { ...base, vendor_credits: new Set() }, "2026-01-01").vendor_credits).toEqual(["VC2025"]);
    expect(collectMissingLinks(bucket, { ...base, vendor_credits: new Set(["VC2025"]) }, "2026-01-01").vendor_credits).toEqual([]);
    expect(collectMissingLinks(bucket, base, "2026-01-01").vendor_credits).toEqual([]);
  });

  it("combina los tres tipos de faltante en una sola llamada", () => {
    const bucket: LinkableBucket = {
      bill_payments: [payment({ applications: [{ txn_id: "B1", txn_type: "Bill", txn_date: null, amount_cents: 10, balance_remaining_cents: null }] })],
      bills: [bill({ txn_id: "B2", linked_txns: [linked({ txn_id: "PO1", txn_type: "PurchaseOrder" }), linked({ txn_id: "R1", txn_type: "ItemReceipt" })] })],
      item_receipts: [],
      purchase_orders: [],
    };
    expect(collectMissingLinks(bucket, emptyCache)).toEqual({
      bills: ["B1"],
      purchase_orders: ["PO1"],
      item_receipts: ["R1"],
      vendor_credits: [],
    });
  });
});
