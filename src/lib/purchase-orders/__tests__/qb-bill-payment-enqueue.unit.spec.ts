import { loadBillPaymentAddFacts } from "../qb-bill-payment-enqueue";

/**
 * Minimal SQL-shape-aware fake: routes each `knex.raw` call to canned rows
 * by sniffing the leading SQL keyword/table, same technique this codebase's
 * other purchase-lane specs use to avoid a full DB in a unit test.
 */
function fakeKnex(overrides: {
  payment?: Record<string, unknown> | null;
  vendor?: Record<string, unknown> | null;
  apAccount?: string | null;
  allocations?: Array<Record<string, unknown>>;
  accountType?: string | null;
}) {
  const payment = overrides.payment ?? {
    id: "vbp_1",
    number: "BP-1001",
    status: "posted",
    vendor_id: "qbven_1",
    vendor_qb_list_id_snapshot: "80000001-VENDOR",
    vendor_name_snapshot: "Acme",
    bank_account_list_id: "80000005-BANK",
    payment_date: "2026-09-10",
    method: "check",
    reference: "1234",
    amount_cents: 10000,
    memo: "pay",
    qb_txn_id: null,
  };
  return {
    raw: async (sql: string, _bindings?: unknown[]) => {
      if (/FROM vendor_bill_payment\b/.test(sql) && !/allocation/.test(sql)) {
        return { rows: payment ? [payment] : [] };
      }
      if (/FROM gl_account_map/.test(sql)) {
        return {
          rows:
            overrides.apAccount === null
              ? []
              : [{ qb_list_id: overrides.apAccount ?? "80000002-AP" }],
        };
      }
      if (/FROM vendor_bill_payment_allocation/.test(sql)) {
        return { rows: overrides.allocations ?? [] };
      }
      if (/FROM qb_account/.test(sql)) {
        return {
          rows:
            overrides.accountType === null
              ? []
              : [{ account_type: overrides.accountType ?? "Bank" }],
        };
      }
      if (/FROM qb_vendor\b/.test(sql)) {
        return { rows: overrides.vendor ? [overrides.vendor] : [] };
      }
      throw new Error(`fakeKnex: unhandled SQL: ${sql}`);
    },
  };
}

describe("loadBillPaymentAddFacts", () => {
  it("is NOT ready while a referenced bill has no qb_txn_id yet", async () => {
    const knex = fakeKnex({
      allocations: [
        {
          id: "alloc_1",
          vendor_bill_id: "vb_1",
          amount_cents: 10000,
          credit_application_id: null,
          bill_qb_txn_id: null,
          credit_id: null,
          credit_qb_txn_id: null,
        },
      ],
    });
    const facts = await loadBillPaymentAddFacts(knex, "vbp_1");
    expect(facts.ready).toBe(false);
    if (!facts.ready) {
      expect(facts.blockingReferenceIds).toEqual(["vb_1"]);
    }
  });

  it("is NOT ready while the referenced credit has no qb_txn_id yet", async () => {
    const knex = fakeKnex({
      allocations: [
        {
          id: "alloc_1",
          vendor_bill_id: "vb_1",
          amount_cents: 8000,
          credit_application_id: "vca_1",
          bill_qb_txn_id: "9000BILL",
          credit_id: "vcr_1",
          credit_qb_txn_id: null,
        },
      ],
    });
    const facts = await loadBillPaymentAddFacts(knex, "vbp_1");
    expect(facts.ready).toBe(false);
    if (!facts.ready) {
      expect(facts.blockingReferenceIds).toEqual(["vcr_1"]);
    }
  });

  it("is ready and builds QBXML once every referenced bill and credit has a qb_txn_id", async () => {
    const knex = fakeKnex({
      allocations: [
        {
          id: "alloc_1",
          vendor_bill_id: "vb_1",
          amount_cents: 8000,
          credit_application_id: "vca_1",
          bill_qb_txn_id: "9000BILL",
          credit_id: "vcr_1",
          credit_qb_txn_id: "9000CREDIT",
        },
        {
          id: "alloc_2",
          vendor_bill_id: "vb_1",
          amount_cents: 2000,
          credit_application_id: null,
          bill_qb_txn_id: "9000BILL",
          credit_id: null,
          credit_qb_txn_id: null,
        },
      ],
    });
    const facts = await loadBillPaymentAddFacts(knex, "vbp_1");
    expect(facts.ready).toBe(true);
    if (facts.ready) {
      expect(facts.qbxml).toContain("<BillPaymentCheckAddRq>");
      // Both allocations against the same bill fold into ONE AppliedToTxnAdd,
      // amount = their sum (100.00), with the credit's SetCredit inside it.
      expect(facts.qbxml.match(/<AppliedToTxnAdd>/g)?.length).toBe(1);
      expect(facts.qbxml).toContain("<PaymentAmount>100.00</PaymentAmount>");
      expect(facts.qbxml).toContain("<CreditTxnID>9000CREDIT</CreditTxnID>");
      expect(facts.isCreditCard).toBe(false);
    }
  });

  it("picks the CreditCard builder when the bank_account_list_id is a QB CreditCard account", async () => {
    const knex = fakeKnex({
      accountType: "CreditCard",
      allocations: [
        {
          id: "alloc_1",
          vendor_bill_id: "vb_1",
          amount_cents: 5000,
          credit_application_id: null,
          bill_qb_txn_id: "9000BILL",
          credit_id: null,
          credit_qb_txn_id: null,
        },
      ],
    });
    const facts = await loadBillPaymentAddFacts(knex, "vbp_1");
    expect(facts.ready).toBe(true);
    if (facts.ready) {
      expect(facts.isCreditCard).toBe(true);
      expect(facts.qbxml).toContain("<BillPaymentCreditCardAddRq>");
    }
  });

  it("refuses (not just 'waiting') when there are no allocations at all", async () => {
    const knex = fakeKnex({ allocations: [] });
    const facts = await loadBillPaymentAddFacts(knex, "vbp_1");
    expect(facts.ready).toBe(false);
    if (!facts.ready) {
      expect(facts.blockingReferenceIds).toEqual([]);
      expect(facts.reason).toMatch(/no allocations/);
    }
  });

  it("refuses when the payment is not in 'posted' status", async () => {
    const knex = fakeKnex({
      payment: {
        id: "vbp_1",
        status: "voided",
        vendor_id: "qbven_1",
        vendor_qb_list_id_snapshot: "80000001-VENDOR",
        vendor_name_snapshot: "Acme",
        bank_account_list_id: "80000005-BANK",
        payment_date: "2026-09-10",
        method: "check",
        reference: "1234",
        amount_cents: 10000,
        memo: "pay",
        qb_txn_id: null,
      },
    });
    const facts = await loadBillPaymentAddFacts(knex, "vbp_1");
    expect(facts.ready).toBe(false);
    if (!facts.ready) expect(facts.reason).toMatch(/status is 'voided'/);
  });

  it("refuses when the vendor identity has not synced (pending_ snapshot)", async () => {
    const knex = fakeKnex({
      payment: {
        id: "vbp_1",
        status: "posted",
        vendor_id: "qbven_1",
        vendor_qb_list_id_snapshot: "pending_123_abc",
        vendor_name_snapshot: "Acme",
        bank_account_list_id: "80000005-BANK",
        payment_date: "2026-09-10",
        method: "check",
        reference: "1234",
        amount_cents: 10000,
        memo: "pay",
        qb_txn_id: null,
      },
      vendor: { qb_list_id: null, full_name: null },
    });
    const facts = await loadBillPaymentAddFacts(knex, "vbp_1");
    expect(facts.ready).toBe(false);
    if (!facts.ready) expect(facts.reason).toMatch(/not synced/);
  });
});
