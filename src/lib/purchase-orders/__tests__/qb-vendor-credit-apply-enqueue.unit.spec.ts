import {
  enqueueVendorCreditApply,
  loadVendorCreditApplyFacts,
} from "../qb-vendor-credit-apply-enqueue";

/** Fake knex — routes each `.raw()` call by SQL substring, first match wins. */
function fakeKnex(overrides: {
  app?: Record<string, unknown> | null;
  credit?: Record<string, unknown> | null;
  bill?: Record<string, unknown> | null;
  liveRows?: Array<{ reference_id: string }>;
  apAccount?: string | null;
  creditCardLine?: string | null;
  creditCardFallback?: string | null;
  applicationIds?: Record<string, unknown> | null;
}) {
  return {
    raw: async (sql: string) => {
      if (/FROM vendor_credit_application a/.test(sql)) {
        return { rows: overrides.app ? [overrides.app] : [] };
      }
      if (/SELECT credit_id, vendor_bill_id FROM vendor_credit_application/.test(sql)) {
        return {
          rows:
            overrides.applicationIds !== undefined
              ? overrides.applicationIds
                ? [overrides.applicationIds]
                : []
              : overrides.app
                ? [{ credit_id: overrides.app.credit_id, vendor_bill_id: overrides.app.vendor_bill_id }]
                : [],
        };
      }
      if (/FROM vendor_credit vc/.test(sql)) {
        return { rows: overrides.credit ? [overrides.credit] : [] };
      }
      if (/FROM vendor_bill vb/.test(sql)) {
        return { rows: overrides.bill ? [overrides.bill] : [] };
      }
      if (/FROM qb_order_pipeline\s+WHERE reference_id IN/.test(sql)) {
        return { rows: overrides.liveRows ?? [] };
      }
      if (/FROM gl_account_map/.test(sql)) {
        return {
          rows: overrides.apAccount === null ? [] : [{ qb_list_id: overrides.apAccount ?? "80000002-AP" }],
        };
      }
      if (/FROM vendor_credit_line vcl/.test(sql)) {
        return {
          rows: overrides.creditCardLine ? [{ qb_list_id: overrides.creditCardLine }] : [],
        };
      }
      if (/FROM qb_account\s+WHERE account_type = 'CreditCard'/.test(sql)) {
        return {
          rows: overrides.creditCardFallback ? [{ qb_list_id: overrides.creditCardFallback }] : [],
        };
      }
      if (/^SELECT id FROM qb_order_pipeline/.test(sql)) {
        return { rows: [] };
      }
      throw new Error(`fakeKnex: unhandled SQL: ${sql}`);
    },
    transaction: async <T,>(fn: (trx: unknown) => Promise<T>) => fn(undefined as never),
  };
}

const APP = {
  id: "vcap_1",
  credit_id: "vcr_1",
  vendor_bill_id: "vb_1",
  amount_cents: 5_000,
  applied_at: "2026-09-15T12:00:00Z",
  voided_at: null,
};
const CREDIT = {
  id: "vcr_1",
  number: "VC-1002",
  qb_txn_id: "1D0AFD-1789143761",
  vendor_qb_list_id_snapshot: "80000001-VENDOR",
};
const BILL = { id: "vb_1", number: "VB-0099", qb_txn_id: "1D0BFE-1789143761" };

describe("loadVendorCreditApplyFacts", () => {
  it("builds a $0 BillPaymentCreditCardAdd with SetCredit when everything is ready", async () => {
    const facts = await loadVendorCreditApplyFacts(
      fakeKnex({ app: APP, credit: CREDIT, bill: BILL, creditCardLine: "80000CC1-1" }) as never,
      "vcap_1"
    );
    expect(facts.ready).toBe(true);
    if (!facts.ready) return;
    expect(facts.billTxnId).toBe("1D0BFE-1789143761");
    expect(facts.creditTxnId).toBe("1D0AFD-1789143761");
    expect(facts.amountCents).toBe(5_000n);
    expect(facts.qbxml).toContain("<PaymentAmount>0.00</PaymentAmount>");
    expect(facts.qbxml).toContain("<SetCredit><CreditTxnID>1D0AFD-1789143761</CreditTxnID>");
    expect(facts.qbxml).toContain("<CreditCardAccountRef><ListID>80000CC1-1</ListID></CreditCardAccountRef>");
  });

  it("blocks with the bill's id when the bill has no qb_txn_id yet", async () => {
    const facts = await loadVendorCreditApplyFacts(
      fakeKnex({ app: APP, credit: CREDIT, bill: { ...BILL, qb_txn_id: null } }) as never,
      "vcap_1"
    );
    expect(facts).toEqual({
      ready: false,
      reason: expect.stringContaining("vb_1"),
      blockingReferenceIds: ["vb_1"],
    });
  });

  it("blocks when the credit has a live vendor_credit_mod row", async () => {
    const facts = await loadVendorCreditApplyFacts(
      fakeKnex({
        app: APP,
        credit: CREDIT,
        bill: BILL,
        liveRows: [{ reference_id: "vcr_1" }],
      }) as never,
      "vcap_1"
    );
    expect(facts.ready).toBe(false);
    if (facts.ready) return;
    expect(facts.blockingReferenceIds).toEqual(["vcr_1"]);
  });

  it("is structurally not-ready (no blockers) when there is no CreditCard account anywhere", async () => {
    const facts = await loadVendorCreditApplyFacts(
      fakeKnex({ app: APP, credit: CREDIT, bill: BILL }) as never,
      "vcap_1"
    );
    expect(facts).toEqual({
      ready: false,
      reason: "no CreditCard account available",
      blockingReferenceIds: [],
    });
  });

  it("refuses a voided application", async () => {
    const facts = await loadVendorCreditApplyFacts(
      fakeKnex({ app: { ...APP, voided_at: "2026-09-15T13:00:00Z" } }) as never,
      "vcap_1"
    );
    expect(facts).toEqual({
      ready: false,
      reason: "application voided",
      blockingReferenceIds: [],
    });
  });
});

describe("enqueueVendorCreditApply", () => {
  const original = process.env.QB_SYNC_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.QB_SYNC_ENABLED;
    else process.env.QB_SYNC_ENABLED = original;
  });

  it("is not queued when QB sync is off", async () => {
    process.env.QB_SYNC_ENABLED = "false";
    const result = await enqueueVendorCreditApply(
      fakeKnex({ app: APP, credit: CREDIT, bill: BILL, creditCardLine: "80000CC1-1" }) as never,
      "vcap_1"
    );
    expect(result).toEqual({ queued: false, reason: "QB_SYNC_ENABLED=false" });
  });

  it("fails closed (not queued, no waiting row) when structurally impossible", async () => {
    process.env.QB_SYNC_ENABLED = "true";
    const result = await enqueueVendorCreditApply(
      fakeKnex({ app: APP, credit: CREDIT, bill: BILL }) as never,
      "vcap_1"
    );
    expect(result).toEqual({ queued: false, reason: "no CreditCard account available" });
  });
});
