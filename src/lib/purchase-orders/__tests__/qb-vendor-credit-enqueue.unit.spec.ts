import { enqueueVendorCreditAdd, enqueueVendorCreditVoid } from "../qb-vendor-credit-enqueue";

function fakeKnex(overrides: {
  credit?: Record<string, unknown> | null;
  lines?: Array<Record<string, unknown>>;
  apAccount?: string | null;
  vendor?: Record<string, unknown> | null;
}) {
  const credit = overrides.credit ?? {
    id: "vcr_1",
    number: "VC-1001",
    status: "posted",
    vendor_id: "qbven_1",
    vendor_qb_list_id_snapshot: "80000001-VENDOR",
    vendor_name_snapshot: "Acme",
    credit_date: "2026-09-10",
    memo: "return",
    qb_txn_id: null,
  };
  return {
    raw: async (sql: string) => {
      if (/FROM vendor_credit\b/.test(sql)) {
        return { rows: credit ? [credit] : [] };
      }
      if (/FROM gl_account_map/.test(sql)) {
        return {
          rows:
            overrides.apAccount === null
              ? []
              : [{ qb_list_id: overrides.apAccount ?? "80000002-AP" }],
        };
      }
      if (/FROM vendor_credit_line/.test(sql)) {
        return { rows: overrides.lines ?? [] };
      }
      if (/FROM qb_vendor\b/.test(sql)) {
        return { rows: overrides.vendor ? [overrides.vendor] : [] };
      }
      throw new Error(`fakeKnex: unhandled SQL: ${sql}`);
    },
    transaction: async <T,>(fn: (trx: unknown) => Promise<T>) => fn(undefined as never),
  };
}

const ENV_KEY = "QB_VENDOR_BILL_MODE";

describe("enqueueVendorCreditAdd", () => {
  const original = process.env[ENV_KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("refuses to queue while the flag is off", async () => {
    delete process.env[ENV_KEY];
    const knex = fakeKnex({});
    const result = await enqueueVendorCreditAdd(knex as never, "vcr_1");
    expect(result).toEqual({ queued: false, reason: expect.stringMatching(/flag off/) });
  });

  it("refuses to queue a credit that already has a qb_txn_id — never re-mints an ADD", async () => {
    process.env[ENV_KEY] = "bill";
    const knex = fakeKnex({
      credit: {
        id: "vcr_1",
        number: "VC-1001",
        status: "posted",
        vendor_id: "qbven_1",
        vendor_qb_list_id_snapshot: "80000001-VENDOR",
        vendor_name_snapshot: "Acme",
        credit_date: "2026-09-10",
        memo: "return",
        qb_txn_id: "9000ALREADYADDED",
      },
    });
    const result = await enqueueVendorCreditAdd(knex as never, "vcr_1");
    expect(result).toEqual({
      queued: false,
      reason: "vendor credit already has a qb_txn_id",
    });
  });

  it("fails closed when the vendor's ListID is still a 'pending_' placeholder (VB-1148 rule)", async () => {
    process.env[ENV_KEY] = "bill";
    const knex = fakeKnex({
      vendor: { qb_list_id: null, full_name: null },
      credit: {
        id: "vcr_1",
        number: "VC-1001",
        status: "posted",
        vendor_id: "qbven_1",
        vendor_qb_list_id_snapshot: "pending_123_abc",
        vendor_name_snapshot: "Acme",
        credit_date: "2026-09-10",
        memo: "return",
        qb_txn_id: null,
      },
    });
    const result = await enqueueVendorCreditAdd(knex as never, "vcr_1");
    expect(result.queued).toBe(false);
    if (!result.queued) expect(result.reason).toMatch(/not synced/);
  });

  it("refuses when a product line has no QB item ListID", async () => {
    process.env[ENV_KEY] = "bill";
    const knex = fakeKnex({
      lines: [
        {
          id: "vcl_1",
          line_type: "product",
          variant_id: "variant_1",
          qty: 1,
          unit_cost_cents: 500,
          qb_account_list_id: null,
          amount_cents: 500,
          variant_qb_item_list_id: null,
        },
      ],
    });
    const result = await enqueueVendorCreditAdd(knex as never, "vcr_1");
    expect(result.queued).toBe(false);
    if (!result.queued) expect(result.reason).toMatch(/no QB item ListID/);
  });

  it("refuses when there is no 'accounts_payable' account mapped", async () => {
    process.env[ENV_KEY] = "bill";
    const knex = fakeKnex({ apAccount: null });
    const result = await enqueueVendorCreditAdd(knex as never, "vcr_1");
    expect(result.queued).toBe(false);
    if (!result.queued) expect(result.reason).toMatch(/accounts_payable/);
  });
});

describe("enqueueVendorCreditVoid", () => {
  const original = process.env[ENV_KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("refuses to void a credit whose add has not confirmed yet", async () => {
    process.env[ENV_KEY] = "bill";
    const knex = fakeKnex({
      credit: {
        id: "vcr_1",
        number: "VC-1001",
        status: "posted",
        vendor_id: "qbven_1",
        vendor_qb_list_id_snapshot: "80000001-VENDOR",
        vendor_name_snapshot: "Acme",
        credit_date: "2026-09-10",
        memo: "return",
        qb_txn_id: null,
      },
    });
    const result = await enqueueVendorCreditVoid(knex as never, "vcr_1");
    expect(result.queued).toBe(false);
    if (!result.queued) expect(result.reason).toMatch(/has not confirmed/);
  });
});
