import type { PoolClient } from "pg";
import { depositReceiptSource } from "../../lib/banking/receipts-transfer";
import { loadBankDeposit } from "../../lib/banking/deposit-read";
import { receiptAccounts, receiptSetup } from "../../lib/banking/receipts-setup";
import { paymentReceiptSource } from "../../lib/banking/receipts-source";
import { validateOpeningFunding } from "../../lib/banking/opening-funding";
import { reviewHash } from "../../lib/banking/review-common";
import { BankingError } from "../../lib/banking/security";
import type { BankDeposit } from "../../lib/banking/deposit-types";
import type { OpeningItem } from "../../lib/banking/opening-types";

jest.mock("../../lib/banking/deposit-read", () => ({ loadBankDeposit: jest.fn() }));
jest.mock("../../lib/banking/receipts-setup", () => ({ receiptAccounts: jest.fn(), receiptSetup: jest.fn(), receiptMapping: jest.requireActual("../../lib/banking/receipts-setup").receiptMapping }));
jest.mock("../../lib/banking/receipts-source", () => ({ ...jest.requireActual("../../lib/banking/receipts-source"), paymentReceiptSource: jest.fn() }));
jest.mock("../../lib/banking/opening-funding", () => ({ validateOpeningFunding: jest.fn() }));

const bank = { id: "bank-qb", name: "Bank", account_type: "Bank", currency: "USD" };
const uf = { id: "uf", name: "UF", account_type: "OtherCurrentAsset", currency: "USD" };
const ar = { id: "ar", name: "AR", account_type: "AccountsReceivable", currency: "USD" };
const fee = { id: "fees", name: "New bank fees", account_type: "Expense", currency: null };
const setup = { id: "local-usd", revision: 1, currency: "USD" as const, cut_date: "2000-01-01",
  ar_account: ar, clearing_account: uf, attested: true as const, frozen: true };
const normalLine = { id: "line-payment", payment_id: "cpay", payment_display_id: 1, customer_id: "customer",
  customer_name: "Customer", method: "check", payment_amount: "50.00", amount: "50.00", source_hash: "b".repeat(32) };
const openingLine = { id: "line-opening", payment_id: null, opening_item_id: "lot", source_type: "opening_item" as const,
  payment_display_id: null, customer_id: "", customer_name: "Legacy remainder", method: "opening_uf",
  payment_amount: "200.00", amount: "200.00", source_hash: "a".repeat(64), reference: "CHECK-7" };
const deposit: BankDeposit = { id: "deposit", revision: 2, status: "ready", account_id: "bank", currency: "USD",
  date: "2000-01-02", reference: "Deposit", memo: "", gross_amount: "250.00", fee_amount: "2.00",
  fee_account_list_id: "fees", fee_reference: "New processing fee", fee_account_snapshot: null, net_amount: "248.00",
  source_hash: "c".repeat(32), stale: false, accounting_posted: false, lines: [normalLine, openingLine] };
function reader(mapping = "uf") {
  return { query: async (sql: string) => {
    if (sql.includes("SELECT id FROM bank_deposit")) return { rows: [] };
    if (sql.includes("FROM bank_account a JOIN")) return { rows: [{ qb_list_id: "bank-qb", valid: true }] };
    if (sql.includes("SELECT setup_id,account_list_id")) return { rows: [{ setup_id: "local-usd", account_list_id: mapping, cut_date: "2000-01-01", currency: "USD" }] };
    if (sql.includes("a.id AS receipt_id")) return { rows: [{ receipt_id: "receipt-anchor", source_hash: "receipt-hash", amount_cents: "5000" }] };
    if (sql.includes("FROM customer_payment mp")) return { rows: [{ cents: "0" }] };
    if (sql.includes("UNION ALL SELECT id FROM vendor_bill")) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected transfer query ${sql}`);
  } } as unknown as PoolClient;
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadBankDeposit).mockResolvedValue(deposit);
  jest.mocked(receiptSetup).mockResolvedValue(setup);
  jest.mocked(receiptAccounts).mockImplementation(async (_client, ids) => [bank, uf, ar, fee].filter(account => ids.includes(account.id)));
  jest.mocked(paymentReceiptSource).mockResolvedValue({ source: { day: "2000-01-01" }, blockers: [], source_hash: "receipt-hash" } as Awaited<ReturnType<typeof paymentReceiptSource>>);
  jest.mocked(validateOpeningFunding).mockResolvedValue({ id: "lot", opening_id: "opening", original_day: "1999-12-31",
    source_hash: openingLine.source_hash, amount_cents: 20000, external_key: "CHECK-7", reference: "CHECK-7",
    evidence_id: "pdf", source_snapshot: { original_amount_cents: 50000 } } as OpeningItem);
});

describe("mixed opening and post-cut deposit accounting", () => {
  it("transfers gross UF once to net Bank plus new fee, without AR/revenue recognition", async () => {
    const evidence = await depositReceiptSource(reader(), "deposit");
    expect(evidence.blockers).toEqual([]);
    expect(evidence.lines.map(line => [line.role, line.debit_cents, line.credit_cents])).toEqual([
      ["bank", 24800, 0], ["clearing", 0, 25000], ["expense", 200, 0],
    ]);
    expect(evidence.allocations).toEqual([
      { opening_item_id: "lot", payment_id: null, receipt_id: null, amount_cents: 20000 },
      { payment_id: "cpay", receipt_id: "receipt-anchor", amount_cents: 5000 },
    ]);
    expect(evidence.source.payment_ids).toEqual(["cpay"]);
    expect(jest.mocked(paymentReceiptSource)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(paymentReceiptSource).mock.calls[0]?.[1]).toBe("cpay");
  });
  it("passes only the selected lot cents and excludes the current deposit intent", async () => {
    await depositReceiptSource(reader(), "deposit");
    expect(jest.mocked(validateOpeningFunding).mock.calls[0]?.slice(1)).toEqual(["lot", "deposit", 20000n, "2000-01-02"]);
  });
  it("blocks an opening whose account differs from the receipt clearing mapping", async () => {
    expect((await depositReceiptSource(reader("another-uf"), "deposit")).blockers).toContain("BANKING_RECEIPT_MAPPING_STALE");
  });
  it("retains the deposit identity and its normal allocations when opening evidence drifts", async () => {
    jest.mocked(validateOpeningFunding).mockRejectedValue(new BankingError("BANKING_OPENING_SOURCE_DRIFT", 409));
    const evidence = await depositReceiptSource(reader(), "deposit");
    expect(evidence.source.id).toBe("deposit");
    expect(evidence.blockers).toContain("BANKING_OPENING_SOURCE_DRIFT");
    expect(evidence.allocations).toEqual([{ payment_id: "cpay", receipt_id: "receipt-anchor", amount_cents: 5000 }]);
  });
  it("preserves the exact v9 snapshot shape/hash for an ordinary deposit", async () => {
    const normal: BankDeposit = { ...deposit, gross_amount: "50.00", net_amount: "50.00", fee_amount: "0.00",
      fee_account_list_id: null, fee_reference: null, lines: [normalLine] };
    jest.mocked(loadBankDeposit).mockResolvedValue(normal);
    const evidence = await depositReceiptSource(reader(), "deposit");
    const expected = { source: { id: "deposit", kind: "deposit", day: "2000-01-02", name: "Deposit", reference: "Deposit",
      amount_cents: 5000, net_cents: 5000, fee_cents: 0, currency: "USD", fee_reference: null,
      payment_ids: ["cpay"], account_id: "bank" }, deposit: { ...normal, accounting_posted: undefined },
    payments: [{ id: "cpay", hash: "receipt-hash", posting_hash: "receipt-hash", cents: 5000 }],
    bank: { ...bank, qb_currency_ref: "USD" }, expense: null, setup: { ...setup, frozen: undefined } };
    expect(evidence.snapshot).toEqual(expected);
    expect(evidence.source_hash).toBe(reviewHash(expected));
    expect(jest.mocked(validateOpeningFunding)).not.toHaveBeenCalled();
  });
});
