import { enqueueVendorCreditAdd, enqueueVendorCreditVoid, loadVendorCreditAddFacts } from "../qb-vendor-credit-enqueue";

function fakeKnex(overrides: {
  credit?: Record<string, unknown> | null;
  lines?: Array<Record<string, unknown>>;
  apAccount?: string | null;
  vendor?: Record<string, unknown> | null;
  /** `stock_location.metadata.qb_inventory_site_list_id` of the credit's PO; undefined = PO/location not found. */
  locationSite?: string | null;
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
      if (/FROM purchase_order\b/.test(sql)) {
        return {
          rows:
            overrides.locationSite === undefined
              ? []
              : [{ qb_inventory_site_list_id: overrides.locationSite }],
        };
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

describe("loadVendorCreditAddFacts — InventorySiteRef (2026-09-18)", () => {
  const poCredit = {
    id: "vcr_1",
    number: "VC-1002",
    status: "posted",
    vendor_id: "qbven_1",
    vendor_qb_list_id_snapshot: "80000001-VENDOR",
    vendor_name_snapshot: "Luxury LED LLC",
    credit_date: "2026-09-11",
    reason: "RMA#",
    memo: null,
    qb_txn_id: null,
    purchase_order_id: "po_1",
  };
  const inventoryLine = {
    id: "vcl_1",
    line_type: "product",
    variant_id: "variant_1",
    qty: 6,
    unit_cost_cents: 8800,
    qb_account_list_id: null,
    amount_cents: 52800,
    qb_txn_line_id: null,
    variant_qb_item_list_id: "80001C6D-1787938038",
    qb_item_type: "Inventory",
  };

  it("an inventory line carries the PO location's site — Principal Warehouse when the location has no override", async () => {
    const facts = await loadVendorCreditAddFacts(
      fakeKnex({ credit: poCredit, lines: [inventoryLine], locationSite: null }) as never,
      "vcr_1"
    );
    expect(facts.ready).toBe(true);
    if (!facts.ready) return;
    expect(facts.qbxml).toContain(
      "<ItemRef><ListID>80001C6D-1787938038</ListID></ItemRef><InventorySiteRef><ListID>80000001-1331053531</ListID></InventorySiteRef><Quantity>6</Quantity>"
    );
  });

  it("honours stock_location.metadata.qb_inventory_site_list_id when set", async () => {
    const facts = await loadVendorCreditAddFacts(
      fakeKnex({ credit: poCredit, lines: [inventoryLine], locationSite: "8000000C-1381786310" }) as never,
      "vcr_1"
    );
    expect(facts.ready && facts.qbxml.includes("<InventorySiteRef><ListID>8000000C-1381786310</ListID></InventorySiteRef>")).toBe(true);
  });

  it("a service line gets NO InventorySiteRef (QB 3140), even on a PO credit", async () => {
    const facts = await loadVendorCreditAddFacts(
      fakeKnex({ credit: poCredit, lines: [{ ...inventoryLine, qb_item_type: "Service" }], locationSite: null }) as never,
      "vcr_1"
    );
    expect(facts.ready).toBe(true);
    if (!facts.ready) return;
    expect(facts.qbxml).not.toContain("InventorySiteRef");
  });

  it("a credit without PO never queries the location and still defaults inventory lines to Principal Warehouse", async () => {
    const knex = fakeKnex({ credit: { ...poCredit, purchase_order_id: null }, lines: [inventoryLine] });
    const facts = await loadVendorCreditAddFacts(knex as never, "vcr_1");
    expect(facts.ready && facts.qbxml.includes("<InventorySiteRef><ListID>80000001-1331053531</ListID></InventorySiteRef>")).toBe(true);
  });
});
