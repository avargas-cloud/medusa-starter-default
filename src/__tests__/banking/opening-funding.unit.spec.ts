import type { PoolClient } from "pg";
import { openingReadItem, validateOpeningFunding } from "../../lib/banking/opening-funding";
import { validateDepositFunding } from "../../lib/banking/deposit-validation";
import * as receiptSource from "../../lib/banking/receipts-source";
import type { OpeningItem } from "../../lib/banking/opening-types";

jest.mock("../../lib/banking/receipts-source", () => ({
  ...jest.requireActual("../../lib/banking/receipts-source"), paymentReceiptSource: jest.fn(),
}));

type Row = OpeningItem & { opening_status: string; cut_date: string; reserved: string };
const hash = "a".repeat(64);
const item: Row = { id: "lot", opening_id: "baseline", kind: "uf_receipt", original_day: "1999-12-31",
  amount_cents: 20000, external_key: "CHECK-7", reference: "CHECK-7 residual", description: "Legacy cash",
  payment_id: null, evidence_id: "pdf", source_snapshot: { original_amount_cents: 50000 }, source_hash: hash,
  available_cents: 0, consumed_cents: 7500, clear_id: null, transaction_id: null, stale: false, blockers: [],
  opening_status: "adopted", cut_date: "2000-01-01", reserved: "7500.00" };

function reader(changes: Partial<Row> = {}, absent = false, missingPayment = false) {
  const row = { ...item, ...changes };
  const query = jest.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes("FROM bank_opening_item oi JOIN")) return { rows: absent ? [] : [row] };
    if (sql.includes("SELECT cut_date FROM bank_opening_balance")) return { rows: [{ cut_date: row.cut_date }] };
    if (sql === "SELECT id FROM customer_payment WHERE id=$1") return { rows: missingPayment ? [] : [{ id: "cpay" }], rowCount: missingPayment ? 0 : 1 };
    if (sql.includes("AS hash") && sql.includes("FROM customer_payment mp")) return { rows: [{ hash: "fingerprint" }] };
    throw new Error(`Unexpected funding query ${sql}`);
  });
  return { client: { query } as unknown as PoolClient, query };
}
afterEach(() => jest.clearAllMocks());

describe("opening residual capacity is independent from AR and original receipt face value", () => {
  it("uses the attested 200 remainder, less 75 already reserved, instead of original 500", async () => {
    const current = await openingReadItem(reader().client, "lot");
    expect(current.available_cents).toBe(12500);
    expect(current.consumed_cents).toBe(7500);
    expect(current.source_snapshot.original_amount_cents).toBe(50000);
  });
  it("allows exactly 125 remaining, then rejects the next cent", async () => {
    await expect(validateOpeningFunding(reader().client, "lot", "deposit", 12500n, "2000-01-01")).resolves.toMatchObject({ available_cents: 12500 });
    await expect(validateOpeningFunding(reader().client, "lot", "deposit", 12501n, "2000-01-01")).rejects.toThrow("BANKING_DEPOSIT_OVER_RESERVED");
  });
  it("forwards the same deposit exclusion to the one reservation query", async () => {
    const fixture = reader({ reserved: "0" });
    await validateOpeningFunding(fixture.client, "lot", "own_deposit", 20000n, "2000-01-01");
    expect(fixture.query.mock.calls[0]?.[1]).toEqual(["lot", "own_deposit"]);
  });
  it("clamps an over-reserved source to zero while retaining consumption evidence", async () => {
    const current = await openingReadItem(reader({ reserved: "20001", consumed_cents: 20000 }).client, "lot");
    expect(current.available_cents).toBe(0);
    expect(current.consumed_cents).toBe(20000);
  });
  it.each(["draft", "revoked"])("does not fund from a %s baseline", async opening_status => {
    await expect(validateOpeningFunding(reader({ opening_status }).client, "lot", null, 1n, "2000-01-01"))
      .rejects.toThrow("BANKING_OPENING_NOT_ADOPTED");
  });
  it.each<OpeningItem["kind"]>(["outstanding_check", "deposit_in_transit"])("never turns old %s bank movement into new UF money", async kind => {
    await expect(validateOpeningFunding(reader({ kind }).client, "lot", null, 1n, "2000-01-01"))
      .rejects.toThrow("BANKING_OPENING_FUNDING_INVALID");
  });
  it("blocks stale/missing sources and dates before the cut", async () => {
    await expect(validateOpeningFunding(reader({ stale: true }).client, "lot", null, 1n, "2000-01-01"))
      .rejects.toThrow("BANKING_OPENING_SOURCE_DRIFT");
    await expect(validateOpeningFunding(reader({}, true).client, "lot", null, 1n, "2000-01-01"))
      .rejects.toThrow("BANKING_OPENING_ITEM_NOT_FOUND");
    await expect(validateOpeningFunding(reader().client, "lot", null, 1n, "1999-12-31"))
      .rejects.toThrow("BANKING_OPENING_FUNDING_DATE_INVALID");
  });
  it("linked cpay evidence never substitutes its full amount for the attested residual", async () => {
    jest.mocked(receiptSource.paymentReceiptSource).mockResolvedValue({
      blockers: ["BANKING_RECEIPT_BEFORE_CUT"], source: { day: "1999-12-31", amount_cents: 50000 }, snapshot: {},
    } as receiptSource.ReceiptEvidence);
    const current = await openingReadItem(reader({ payment_id: "cpay", source_snapshot: { payment_fingerprint: "fingerprint", original_amount_cents: 50000 } }).client, "lot");
    expect(current.available_cents).toBe(12500);
    expect(current.blockers).toEqual([]);
  });
  it("a later refund stops linked funding while keeping immutable consumed amount", async () => {
    jest.mocked(receiptSource.paymentReceiptSource).mockResolvedValue({
      blockers: ["BANKING_RECEIPT_BEFORE_CUT", "BANKING_RECEIPT_PROVENANCE_UNSUPPORTED"],
      source: { day: "1999-12-31", amount_cents: 50000 }, snapshot: {},
    } as receiptSource.ReceiptEvidence);
    const current = await openingReadItem(reader({ payment_id: "cpay", source_snapshot: { payment_fingerprint: "fingerprint" } }).client, "lot");
    expect(current.available_cents).toBe(0);
    expect(current.consumed_cents).toBe(7500);
    expect(current.blockers).toContain("BANKING_RECEIPT_PROVENANCE_UNSUPPORTED");
  });
  it("hard-deleted linked payment leaves its opening history visible with zero usable capacity", async () => {
    const current = await openingReadItem(reader({ payment_id: "cpay", source_snapshot: { payment_fingerprint: "fingerprint" } }, false, true).client, "lot");
    expect(current.id).toBe("lot");
    expect(current.available_cents).toBe(0);
    expect(current.consumed_cents).toBe(7500);
    expect(current.stale).toBe(true);
    expect(jest.mocked(receiptSource.paymentReceiptSource)).not.toHaveBeenCalled();
  });
});

describe("Record Deposit opening funding validates the actual helper", () => {
  const line = { opening_item_id: "lot", amount: "125.00" };
  it("returns a typed source using residual dollars and no manufactured payment identity", async () => {
    const candidate = await validateDepositFunding(reader().client, line, "deposit", "USD", "2000-01-01", "2000-01-01", hash);
    expect(candidate).toMatchObject({ id: "lot", opening_item_id: "lot", payment_id: null,
      source_type: "opening_item", amount: "200.00", available_amount: "125.00", source_hash: hash });
    expect(candidate.fingerprint_version).toBeUndefined();
  });
  it("rejects a stale expected hash and an extra cent through the real validation chain", async () => {
    await expect(validateDepositFunding(reader().client, line, "deposit", "USD", "2000-01-01", "2000-01-01", "b".repeat(64)))
      .rejects.toThrow("BANKING_DEPOSIT_SOURCE_STALE");
    await expect(validateDepositFunding(reader().client, { ...line, amount: "125.01" }, "deposit", "USD", "2000-01-01", "2000-01-01", hash))
      .rejects.toThrow("BANKING_DEPOSIT_OVER_RESERVED");
  });
  it("rejects foreign bank currency before reading the USD opening lot", async () => {
    const fixture = reader();
    await expect(validateDepositFunding(fixture.client, line, "deposit", "CAD", "2000-01-01", "2000-01-01", hash))
      .rejects.toThrow("BANKING_DEPOSIT_SOURCE_STALE");
    expect(fixture.query).not.toHaveBeenCalled();
  });
});
