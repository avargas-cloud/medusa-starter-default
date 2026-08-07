/**
 * Unit coverage for the reverse void audit's pure pieces: QBXML parsing and
 * the candidate/scan comparison. Fixtures mirror the shapes probed LIVE
 * against the bridge on 2026-08-07 (TxnDeletedQueryRs carries no RefNumber;
 * voided invoices surface as Subtotal "0.00" with a "VOID:" memo).
 */
import {
  compareScanToCandidates,
  parseTxnDeleted,
  parseZeroScan,
  SCAN_MAX_RETURNED,
  type AliveCandidate,
} from "../../lib/quickbooks/reverse-void-sweep";

const wrap = (rsKey: string, rs: Record<string, unknown>) => ({
  operation: { result: { QBXML: { QBXMLMsgsRs: { [rsKey]: rs } } } },
});

const ok = { statusCode: "0", statusSeverity: "Info", statusMessage: "Status OK" };

describe("parseTxnDeleted", () => {
  it("parses the live response shape (array, no RefNumber)", () => {
    const polled = wrap("TxnDeletedQueryRs", {
      $: ok,
      TxnDeletedRet: [
        {
          TxnDelType: "ReceivePayment",
          TxnID: "1CC68E-1786037209",
          TimeCreated: "2026-08-06T13:26:49-05:00",
          TimeDeleted: "2026-08-06T15:38:08-05:00",
        },
        {
          TxnDelType: "Invoice",
          TxnID: "1C2375-1745000000",
          TimeCreated: "2026-04-18T10:00:00-05:00",
          TimeDeleted: "2026-08-01T09:00:00-05:00",
        },
      ],
    });
    const out = parseTxnDeleted(polled);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      qb_txn_id: "1CC68E-1786037209",
      qb_del_type: "ReceivePayment",
      time_deleted: "2026-08-06T15:38:08-05:00",
    });
  });

  it("normalizes a single deletion (dict, not array)", () => {
    const polled = wrap("TxnDeletedQueryRs", {
      $: ok,
      TxnDeletedRet: { TxnDelType: "CreditMemo", TxnID: "AA-1" },
    });
    expect(parseTxnDeleted(polled)).toHaveLength(1);
  });

  it("returns empty for a clean window (no TxnDeletedRet at all)", () => {
    expect(parseTxnDeleted(wrap("TxnDeletedQueryRs", { $: ok }))).toEqual([]);
  });

  it("throws on a QB rejection — completed bridge op is NOT QB success", () => {
    const polled = wrap("TxnDeletedQueryRs", {
      $: { statusCode: "3120", statusSeverity: "Error", statusMessage: "nope" },
    });
    expect(() => parseTxnDeleted(polled)).toThrow(/3120/);
  });
});

describe("parseZeroScan", () => {
  const invoiceRet = (txn: string, subtotal: string, memo = "") => ({
    TxnID: txn,
    RefNumber: `R-${txn}`,
    Subtotal: subtotal,
    Memo: memo,
    TimeModified: "2026-08-05T13:23:10-05:00",
  });

  it("keeps only zero-amount docs (live shape: 19659 VOID case)", () => {
    const polled = wrap("InvoiceQueryRs", {
      $: ok,
      InvoiceRet: [
        invoiceRet("1CBDFD-1785515477", "0.00", "VOID: POS Invoice 21281"),
        invoiceRet("1CC745-1786074261", "18917.94"),
      ],
    });
    const { zeroDocs, scanned, truncated } = parseZeroScan(polled, "Invoice");
    expect(scanned).toBe(2);
    expect(truncated).toBe(false);
    expect(zeroDocs).toHaveLength(1);
    expect(zeroDocs[0].qb_txn_id).toBe("1CBDFD-1785515477");
    expect(zeroDocs[0].memo).toContain("VOID:");
  });

  it("uses TotalAmount for credit memos", () => {
    const polled = wrap("CreditMemoQueryRs", {
      $: ok,
      CreditMemoRet: { TxnID: "CM-1", TotalAmount: "0.00", Memo: "VOID: CM" },
    });
    expect(parseZeroScan(polled, "CreditMemo").zeroDocs).toHaveLength(1);
  });

  it("flags truncation when the scan fills MaxReturned", () => {
    const rets = Array.from({ length: SCAN_MAX_RETURNED }, (_, i) =>
      invoiceRet(`T-${i}`, "10.00")
    );
    const polled = wrap("InvoiceQueryRs", { $: ok, InvoiceRet: rets });
    expect(parseZeroScan(polled, "Invoice").truncated).toBe(true);
  });
});

describe("compareScanToCandidates", () => {
  const candidate = (over: Partial<AliveCandidate> = {}): AliveCandidate => ({
    entity: "pos_invoice",
    reference_id: "posinv_1",
    order_id: "order_1",
    medusa_ref: "20215",
    qb_txn_id: "1C2375-1745000000",
    qb_ref_number: "19001",
    pos_total_cents: 123456,
    ...over,
  });
  const asMap = (...cs: AliveCandidate[]) =>
    new Map(cs.map((c) => [c.qb_txn_id, c]));

  it("flags a deletion that hits an alive candidate", () => {
    const out = compareScanToCandidates({
      candidates: asMap(candidate()),
      deleted: [
        {
          qb_txn_id: "1C2375-1745000000",
          qb_del_type: "Invoice",
          time_deleted: "2026-08-01T09:00:00-05:00",
        },
      ],
      zeroDocs: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "deleted", medusa_ref: "20215" });
  });

  it("ignores deletions of unreferenced TxnIDs (void+recreate churn, our own TxnDels)", () => {
    const out = compareScanToCandidates({
      candidates: asMap(candidate({ qb_txn_id: "NEW-DOC" })),
      deleted: [{ qb_txn_id: "OLD-DOC", qb_del_type: "Invoice", time_deleted: null }],
      zeroDocs: [],
    });
    expect(out).toEqual([]);
  });

  it("flags a zeroed QB doc whose POS side still expects money", () => {
    const out = compareScanToCandidates({
      candidates: asMap(candidate()),
      deleted: [],
      zeroDocs: [
        {
          qb_txn_id: "1C2375-1745000000",
          qb_ref_number: "19001",
          memo: "VOID: POS Invoice 20215",
          time_modified: "2026-08-05T13:23:10-05:00",
          scan_type: "Invoice",
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("voided");
  });

  it("never flags an honestly-$0 POS document", () => {
    const out = compareScanToCandidates({
      candidates: asMap(candidate({ pos_total_cents: 0 })),
      deleted: [],
      zeroDocs: [
        {
          qb_txn_id: "1C2375-1745000000",
          qb_ref_number: null,
          memo: null,
          time_modified: null,
          scan_type: "Invoice",
        },
      ],
    });
    expect(out).toEqual([]);
  });

  it("ignores zeroed docs no alive POS document references (probed: 19659 after 21281's recreate)", () => {
    const out = compareScanToCandidates({
      candidates: asMap(candidate({ qb_txn_id: "1CC745-1786074261" })),
      deleted: [],
      zeroDocs: [
        {
          qb_txn_id: "1CBDFD-1785515477",
          qb_ref_number: "19659",
          memo: "VOID: POS Invoice 21281",
          time_modified: "2026-08-05T13:23:10-05:00",
          scan_type: "Invoice",
        },
      ],
    });
    expect(out).toEqual([]);
  });
});
