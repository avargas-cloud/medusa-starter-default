import {
  creditMemoForQb,
  enqueueVendorCreditMod,
  loadVendorCreditModFacts,
} from "../qb-vendor-credit-enqueue";

function fakeKnex(overrides: {
  credit?: Record<string, unknown> | null;
  lines?: Array<Record<string, unknown>>;
  apAccount?: string | null;
}) {
  return {
    raw: async (sql: string) => {
      if (/FROM vendor_credit\b/.test(sql)) {
        return { rows: overrides.credit ? [overrides.credit] : [] };
      }
      if (/FROM gl_account_map/.test(sql)) {
        return {
          rows: overrides.apAccount === null ? [] : [{ qb_list_id: overrides.apAccount ?? "80000002-AP" }],
        };
      }
      if (/FROM vendor_credit_line/.test(sql)) {
        return { rows: overrides.lines ?? [] };
      }
      throw new Error(`fakeKnex: unhandled SQL: ${sql}`);
    },
    transaction: async <T,>(fn: (trx: unknown) => Promise<T>) => fn(undefined as never),
  };
}

const posted = {
  id: "vcr_1",
  number: "VC-1002",
  status: "posted",
  vendor_id: "qbven_1",
  vendor_qb_list_id_snapshot: "80000001-VENDOR",
  vendor_name_snapshot: "Acme",
  credit_date: "2026-09-11",
  reason: "RMA#",
  memo: null,
  qb_txn_id: "1D0AFD-1789143761",
  qb_edit_sequence: "1789143761",
};
const lines = [
  {
    id: "vcrl_1",
    line_type: "product",
    variant_id: "variant_1",
    qty: 4,
    unit_cost_cents: 8800,
    qb_account_list_id: null,
    amount_cents: 35200,
    description: "J-Box",
    qb_txn_line_id: "1D0AFF-1789143761",
    variant_qb_item_list_id: "80000ABC-1",
  },
];

describe("creditMemoForQb", () => {
  it("sends the Vendor Ref/Reason first, then Notes joined by an ASCII dash; blanks dropped; null when both empty", () => {
    expect(creditMemoForQb("RMA#", "restock")).toBe("RMA# - restock");
    expect(creditMemoForQb("RMA#", null)).toBe("RMA#");
    expect(creditMemoForQb("  ", "notes")).toBe("notes");
    expect(creditMemoForQb(null, "")).toBeNull();
  });
});

describe("loadVendorCreditModFacts", () => {
  it("builds a Mod addressed by TxnID + the FRESH EditSequence, the line's TxnLineID, and the reason as memo", async () => {
    const facts = await loadVendorCreditModFacts(fakeKnex({ credit: posted, lines }) as never, "vcr_1", "1789999999");
    expect(facts.ready).toBe(true);
    if (!facts.ready) return;
    expect(facts.txnId).toBe("1D0AFD-1789143761");
    expect(facts.qbxml).toContain("<TxnID>1D0AFD-1789143761</TxnID><EditSequence>1789999999</EditSequence>");
    expect(facts.qbxml).toContain("<VendorRef><ListID>80000001-VENDOR</ListID></VendorRef>");
    expect(facts.qbxml).toContain("<Memo>RMA#</Memo>");
    expect(facts.qbxml).toContain("<TxnLineID>1D0AFF-1789143761</TxnLineID>");
    expect(facts.qbxml).toContain("<Quantity>4</Quantity><Cost>88.00</Cost><Amount>352.00</Amount>");
  });

  it("falls back to the stored EditSequence at enqueue time and refuses without a TxnID", async () => {
    const stored = await loadVendorCreditModFacts(fakeKnex({ credit: posted, lines }) as never, "vcr_1", null);
    expect(stored.ready && stored.qbxml.includes("<EditSequence>1789143761</EditSequence>")).toBe(true);
    const noTxn = await loadVendorCreditModFacts(
      fakeKnex({ credit: { ...posted, qb_txn_id: null }, lines }) as never,
      "vcr_1",
      null
    );
    expect(noTxn).toEqual({ ready: false, reason: expect.stringMatching(/no qb_txn_id/) });
  });

  it("a NEW line (no qb_txn_line_id) is sent as -1", async () => {
    const facts = await loadVendorCreditModFacts(
      fakeKnex({ credit: posted, lines: [{ ...lines[0], qb_txn_line_id: null }] }) as never,
      "vcr_1",
      "1"
    );
    expect(facts.ready && facts.qbxml.includes("<ItemLineMod><TxnLineID>-1</TxnLineID>")).toBe(true);
  });
});

describe("enqueueVendorCreditMod", () => {
  const original = process.env.QB_VENDOR_BILL_MODE;
  afterEach(() => {
    if (original === undefined) delete process.env.QB_VENDOR_BILL_MODE;
    else process.env.QB_VENDOR_BILL_MODE = original;
  });

  it("flag off → not queued; no TxnID → not queued (the add rebuilds from live rows)", async () => {
    delete process.env.QB_VENDOR_BILL_MODE;
    expect(await enqueueVendorCreditMod(fakeKnex({ credit: posted, lines }) as never, "vcr_1")).toEqual({
      queued: false,
      reason: expect.stringMatching(/flag off/),
    });
    process.env.QB_VENDOR_BILL_MODE = "bill";
    expect(
      await enqueueVendorCreditMod(fakeKnex({ credit: { ...posted, qb_txn_id: null }, lines }) as never, "vcr_1")
    ).toEqual({ queued: false, reason: expect.stringMatching(/no qb_txn_id/) });
  });
});
