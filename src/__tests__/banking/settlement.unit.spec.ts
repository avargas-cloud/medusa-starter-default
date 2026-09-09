import { buildSettlementLines, settlementStructuralBlockers, settlementTotals } from "../../lib/banking/settlement-rules";
import type { SettlementLine } from "../../lib/banking/settlement-types";
import type { AccountingAccount } from "../../lib/banking/accounting-types";

const account = (id: string, account_type: string): AccountingAccount => ({ id, name: id, account_type, currency: "USD" });
const bank = account("bank", "Bank");
const accounts = new Map([account("clearing", "OtherCurrentAsset"), account("reserve", "OtherCurrentAsset"),
  account("refunds", "OtherCurrentLiability"), account("fees", "Expense")].map(a => [a.id, a]));
const line = (kind: SettlementLine["kind"], amount_cents: number, account_list_id: string): SettlementLine => ({
  kind, amount_cents, account_list_id, source_id: kind, reference: kind, evidence_id: "evidence",
  documented_capacity_cents: amount_cents, documented_as_of: "2026-09-01", surcharge_cents: 0,
  recognition_owner: ["fee", "reserve_hold"].includes(kind) ? "new" : "existing",
});

describe("documented merchant settlements", () => {
  it("never subtracts a surcharge already absent from the base receipt", () => {
    const receipts = [{ ...line("receipt", 10000, "clearing"), surcharge_cents: 300 }];
    expect(settlementTotals(receipts)).toMatchObject({ net_cents: 10000, fees_cents: 0, surcharge_audit_cents: 300 });
    expect(buildSettlementLines(receipts, bank, accounts)).toEqual([
      expect.objectContaining({ role: "bank", debit_cents: 10000, credit_cents: 0 }),
      expect.objectContaining({ account_list_id: "clearing", debit_cents: 0, credit_cents: 10000 }),
    ]);
  });
  it("settles1000 receipts minus100 existing refund,25 fee,50 reserve as825 bank and25 new expense", () => {
    const lines = [line("receipt", 100000, "clearing"), line("refund", 10000, "refunds"),
      line("fee", 2500, "fees"), line("reserve_hold", 5000, "reserve")];
    const journal = buildSettlementLines(lines, bank, accounts);
    expect(settlementStructuralBlockers(lines)).toEqual([]);
    expect(journal.find(l => l.role === "bank")?.debit_cents).toBe(82500);
    expect(journal.filter(l => l.account_snapshot.account_type === "Expense").reduce((n,l) => n+l.debit_cents-l.credit_cents,0)).toBe(2500);
    expect(journal.find(l => l.account_list_id === "reserve")?.debit_cents).toBe(5000);
    expect(journal.reduce((n,l) => n+l.debit_cents-l.credit_cents,0)).toBe(0);
  });
  it("records zero payout without a fabricated bank line", () => {
    const lines = [line("reserve_release", 5000, "reserve"), line("fee", 5000, "fees")];
    expect(settlementTotals(lines).net_cents).toBe(0);
    expect(buildSettlementLines(lines, bank, accounts).map(l => l.account_list_id)).toEqual(["reserve", "fees"]);
  });
  it("represents negative payout105 as a bank credit, retaining the existing refund ownership", () => {
    const journal = buildSettlementLines([line("refund", 10000, "refunds"), line("fee", 500, "fees")], bank, accounts);
    expect(journal.find(l => l.role === "bank")).toMatchObject({ debit_cents: 0, credit_cents: 10500 });
    expect(journal.find(l => l.account_list_id === "refunds")).toMatchObject({ debit_cents: 10000, credit_cents: 0 });
  });
  it("rejects a reserve disguised as a new expense", () => {
    expect(() => buildSettlementLines([line("receipt", 10000, "clearing"), line("reserve_hold", 5000, "fees")], bank, accounts))
      .toThrow("BANKING_COUNTERPART_ACCOUNT_INVALID");
  });
  it("blocks unknown capacity, duplicate sources, and a second recognition of an existing refund", () => {
    expect(settlementStructuralBlockers([{ ...line("refund",100,"refunds"), documented_capacity_cents:null }]))
      .toContain("BANKING_DOCUMENTED_CAPACITY_REQUIRED");
    expect(settlementStructuralBlockers([line("receipt",100,"clearing"),line("receipt",100,"clearing")]))
      .toContain("BANKING_SOURCE_DUPLICATED");
    expect(settlementStructuralBlockers([{ ...line("refund",100,"refunds"), recognition_owner:"new" }]))
      .toContain("BANKING_RECOGNITION_OWNERSHIP_INVALID");
  });
});
