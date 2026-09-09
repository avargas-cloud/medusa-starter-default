import { accountingDraftSchema, bankAccountingCurrency, bankExpenseCents, expenseLines, type AccountingSource,
  type DuplicateCandidate, type ExpenseDraft } from "../../lib/banking/accounting-types";
import { validateExpenseResolutions } from "../../lib/banking/accounting-candidates";

describe("bank expense exact amounts", () => {
  it("normalizes only evidenced currency representations without guessing an unknown bank", () => {
    expect(bankAccountingCurrency("Bank", "US Dollar")).toBe("USD");
    expect(bankAccountingCurrency("Expense", null)).toBe("USD");
    expect(bankAccountingCurrency("OtherExpense", null)).toBe("USD");
    expect(bankAccountingCurrency("Bank", null)).toBeNull();
    expect(bankAccountingCurrency("Bank", "CAD")).toBeNull();
    expect(bankAccountingCurrency("Expense", "Canadian Dollar")).toBeNull();
  });
  it.each([["120.01",12001],["0.01",1],["9999999999.99",999999999999],["1.1",110]])("%s => %s cents", (value, expected) => {
    expect(bankExpenseCents(value as string)).toBe(expected);
  });
  it.each(["0","-12.00","1.001","1.000","1e3","NaN","+1","01","10000000000.00"," 1.00"])("rejects %s without rounding", value => {
    expect(() => bankExpenseCents(value)).toThrow("BANKING_EXPENSE_AMOUNT_INVALID");
  });
  it("creates equal debit Expense and credit Bank with exact pennies", () => {
    const source: AccountingSource = { id: "t", account_id: "a", account_name: "Checking", day: "2026-09-01",
      name: "Utilities", amount_cents: 12001, currency: "USD", review_status: "confirmed", source_version: 1, review_revision: 1,
      category: { id: "q-exp", name: "Utilities", account_type: "Expense", currency: "USD" },
      bank_account: { id: "q-bank", name: "Checking", account_type: "Bank", currency: "USD" } };
    const lines = expenseLines(source);
    expect(lines).toHaveLength(2);
    expect(lines.find(l => l.role === "expense")).toMatchObject({ account_list_id: "q-exp", debit_cents: 12001, credit_cents: 0 });
    expect(lines.find(l => l.role === "bank")).toMatchObject({ account_list_id: "q-bank", debit_cents: 0, credit_cents: 12001 });
    expect(lines.reduce((sum,line) => sum+line.debit_cents-line.credit_cents,0)).toBe(0);
  });
});

describe("expense provenance", () => {
  const draft: ExpenseDraft = { id: "d", transaction_id: "t", revision: 1, source_hash: "a".repeat(64),
    nature: "new_direct_expense", reference: "utility-1", description: "Utility bill debit", attested: true, dismissals: [] };
  const candidate: DuplicateCandidate = { key: "vendor_bill:vb1", kind: "vendor_bill", id: "vb1", reference: "VB-1",
    amount_cents: 12001, day: "2026-09-01", link_path: "/vendor-bills/vb1", definite: false, fingerprint: "hash" };
  it("never interprets unsupported source kinds as a new expense", () => {
    const { id: _id, revision: _revision, transaction_id: _tx, ...body } = draft;
    for (const nature of ["payroll", "vendor_bill", "wire", "loan", "uncertain"]) {
      expect(accountingDraftSchema.safeParse({ ...body, expected_revision: 0, nature }).success).toBe(false);
    }
  });
  it("requires affirmative attestation", () => {
    expect(() => validateExpenseResolutions({ ...draft, attested: false as true }, [])).toThrow("BANKING_EXPENSE_ATTESTATION_REQUIRED");
  });
  it("does not treat absence of candidate resolution as permission", () => {
    expect(() => validateExpenseResolutions(draft,[candidate])).toThrow("BANKING_EXPENSE_UNRESOLVED_CANDIDATE");
  });
  it("accepts equal-amount false positives only with explicit reason", () => {
    expect(() => validateExpenseResolutions({ ...draft, dismissals: [{ key: candidate.key, reason: "Different property utility invoice" }] },[candidate])).not.toThrow();
  });
  it("rejects an explicitly identified existing source even with dismissal", () => {
    expect(() => validateExpenseResolutions({ ...draft, dismissals: [{ key: candidate.key, reason: "Override existing bill" }] },
      [{ ...candidate, definite: true }])).toThrow("BANKING_EXPENSE_ALREADY_RECOGNIZED");
  });
  it("invalidates a resolution when the candidate set changes", () => {
    expect(() => validateExpenseResolutions({ ...draft, dismissals: [{ key: "wire:old", reason: "Different source document" }] },[]))
      .toThrow("BANKING_EXPENSE_CANDIDATES_CHANGED");
  });
});
