import { buildMovementLines, movementStructuralBlockers } from "../../lib/banking/movement-rules";
import { movementSaveSchema, type MovementInput } from "../../lib/banking/movement-types";
import { validateCompletionLines } from "../../lib/banking/completion-journal";
import { mergeCompletionClaims } from "../../lib/banking/movement-read";
import type { AccountingAccount } from "../../lib/banking/accounting-types";
import { assertMovementSourceDate, payrollInstallment } from "../../lib/banking/movement-source";

const account = (id: string, account_type: string): AccountingAccount => ({ id, name: id, account_type, currency: "USD" });
const bank = account("bank", "Bank"), liability = account("loan", "LongTermLiability"), interest = account("interest", "Expense");
function loan(): MovementInput {
  return { expected_revision: 0, kind: "loan_payment", reference: "Loan SEP", description: "Documented loan payment",
    day: "2026-09-09", bank_account_id: "ba_1", transaction_id: null, evidence_id: "ev_1", amount_cents: 10000,
    destination_bank_account_id: null, transit_account_list_id: null, attested: true,
    allocations: [
      { role: "principal", account_list_id: "loan", amount_cents: 9000, source_kind: "document", source_id: "loan agreement",
        documented_capacity_cents: 90000, documented_as_of: "2026-09-01", recognition_owner: "existing", evidence_id: "ev_1" },
      { role: "interest", account_list_id: "interest", amount_cents: 1000, source_kind: "document", source_id: "interest september",
        documented_capacity_cents: 1000, documented_as_of: "2026-09-01", recognition_owner: "new", evidence_id: "ev_1" },
    ] };
}
describe("Documented bank movements", () => {
  test.each(["vendor_bill", "wire", "refund"] as const)("%s cannot predate its economic source", kind => {
    const identity = { economic_day: "2026-09-09", sent_date: "2026-09-09", batch_day: "2026-09-09" };
    expect(() => assertMovementSourceDate(kind, identity, "2026-09-08", 1)).toThrow("BANKING_MOVEMENT_SOURCE_DATE_INVALID");
    expect(() => assertMovementSourceDate(kind, identity, "2026-09-09", 1)).not.toThrow();
  });
  test("payroll capacity follows actual canonical 15/30 recognition including odd cent", () => {
    const first = payrollInstallment("2026-02", 101, "2026-02:15"), second = payrollInstallment("2026-02", 101, "2026-02:28");
    expect([first.amount_cents, second.amount_cents]).toEqual([50, 51]);
    const identity = { month: "2026-02", amount_cents: first.amount_cents, economic_day: first.day };
    expect(() => assertMovementSourceDate("payroll", identity, "2026-02-14", 1)).toThrow("BANKING_MOVEMENT_SOURCE_DATE_INVALID");
    expect(() => assertMovementSourceDate("payroll", identity, "2026-02-15", 50)).not.toThrow();
    expect(() => assertMovementSourceDate("payroll", identity, "2026-02-28", 51)).toThrow("BANKING_DOCUMENTED_CAPACITY_INVALID");
    expect(() => payrollInstallment("2026-02", 101, "2026-02")).toThrow("BANKING_MOVEMENT_SOURCE_UNRESOLVED");
    expect(() => payrollInstallment("2000-02", 101, "2000-02:28")).toThrow("BANKING_MOVEMENT_SOURCE_UNRESOLVED");
    expect(payrollInstallment("2000-02", 101, "2000-02:29").amount_cents).toBe(51);
  });
  test("loan 100 posts principal 90 and only 10 new expense", () => {
    const body = loan();
    expect(movementStructuralBlockers(body)).toEqual([]);
    const lines = buildMovementLines(body, bank, new Map([[liability.id, liability], [interest.id, interest]]));
    expect(validateCompletionLines(lines)).toBe(10000);
    expect(lines.find(l => l.role === "bank")?.credit_cents).toBe(10000);
    expect(lines.find(l => l.role === "counterpart_0")?.debit_cents).toBe(9000);
    expect(lines.find(l => l.role === "expense")?.debit_cents).toBe(1000);
  });
  test("unknown external capacity remains unknown and blocks recognition", () => {
    const body = loan(); body.allocations[0]!.documented_capacity_cents = null;
    expect(movementSaveSchema.safeParse(body).success).toBe(true);
    expect(movementStructuralBlockers(body)).toContain("BANKING_DOCUMENTED_CAPACITY_REQUIRED");
  });
  test.each(["obligation_payment", "payroll_match", "wire_match", "refund_match"] as const)("%s requires exact existing source kind", kind => {
    const body = loan(); body.kind = kind; body.allocations = [{ ...body.allocations[0]!, amount_cents: 10000 }];
    expect(movementStructuralBlockers(body)).toContain("BANKING_RECOGNITION_OWNERSHIP_REQUIRED");
  });
  test("existing fee recognition cannot become new expense", () => {
    const body = loan(); body.allocations[1]!.recognition_owner = "existing";
    expect(movementStructuralBlockers(body)).toContain("BANKING_RECOGNITION_OWNERSHIP_INVALID");
  });
  test("principal cannot point to Expense even if totals balance", () => {
    const body = loan(); body.allocations[0]!.account_list_id = "interest";
    expect(() => buildMovementLines(body, bank, new Map([[interest.id, interest]]))).toThrow("BANKING_COUNTERPART_ACCOUNT_INVALID");
  });
  test("owner contribution credits equity and debits bank with no revenue", () => {
    const body = loan(), equity = account("equity", "Equity"); body.kind = "owner_contribution";
    body.allocations = [{ ...body.allocations[0]!, amount_cents: 10000, account_list_id: equity.id }];
    const lines = buildMovementLines(body, bank, new Map([[equity.id, equity]]));
    expect(lines.map(l => [l.account_list_id, l.debit_cents, l.credit_cents])).toEqual([["bank", 10000, 0], ["equity", 0, 10000]]);
  });
  test("transfer cannot claim same bank or pretend an obligation allocation", () => {
    const body = loan(); body.kind = "bank_transfer"; body.destination_bank_account_id = body.bank_account_id;
    expect(movementStructuralBlockers(body)).toContain("BANKING_TRANSFER_INVALID");
  });
  test("missing cent is rejected rather than balanced with an adjustment", () => {
    const body = loan(); body.allocations[0]!.amount_cents--;
    expect(movementStructuralBlockers(body)).toContain("BANKING_MOVEMENT_AMOUNT_INVALID");
  });
  test("multiple fees on different accounts retain typed expense roles", () => {
    const body = loan(), fee = account("fee", "OtherExpense"); body.amount_cents += 100;
    body.allocations.push({ ...body.allocations[1]!, role: "fee", account_list_id: fee.id, source_id: "fee", amount_cents: 100 });
    const lines = buildMovementLines(body, bank, new Map([[liability.id, liability], [interest.id, interest], [fee.id, fee]]));
    expect(lines.filter(l => l.role.startsWith("expense")).reduce((sum, l) => sum + l.debit_cents, 0)).toBe(1100);
    const bad = lines.map(l => l.role === "expense_1" ? { ...l, account_snapshot: { ...l.account_snapshot, account_type: "Equity" } } : l);
    expect(() => validateCompletionLines(bad)).toThrow("BANKING_JOURNAL_UNBALANCED");
  });
  test("same documentary capacity merges allocations, never doubles capacity", () => {
    const claim = { source_kind: "document_evidence", source_id: "pdf:account:principal", source_hash: "a".repeat(64),
      amount_cents: 30, capacity_cents: 100, source_snapshot: {} };
    expect(mergeCompletionClaims([claim, { ...claim, amount_cents: 40 }])).toEqual([{ ...claim, amount_cents: 70 }]);
    expect(() => mergeCompletionClaims([claim, { ...claim, capacity_cents: 200 }])).toThrow("BANKING_SOURCE_CAPACITY_STALE");
  });
  test("101 allocations rejected before write", () => {
    const body = loan(); body.allocations = Array.from({ length: 101 }, (_, i) => ({ ...body.allocations[0]!, source_id: `ref-${i}` }));
    expect(movementSaveSchema.safeParse(body).success).toBe(false);
  });
});
