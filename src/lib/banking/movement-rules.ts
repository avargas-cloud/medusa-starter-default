import { BankingError } from "./security";
import type { AccountingAccount } from "./accounting-types";
import type { CompletionLine, MovementInput, MovementKind, MovementSourceKind } from "./movement-types";

export const MOVEMENT_COUNTERPART_TYPES: Record<MovementKind, readonly string[]> = {
  obligation_payment: ["AccountsPayable"], payroll_match: ["OtherCurrentLiability"],
  wire_match: ["AccountsPayable", "OtherCurrentLiability", "OtherCurrentAsset"],
  refund_match: ["AccountsReceivable", "OtherCurrentLiability"], bank_transfer: ["OtherCurrentAsset"],
  credit_card_payment: ["CreditCard"], loan_payment: ["LongTermLiability", "OtherCurrentLiability"],
  owner_contribution: ["Equity"], owner_withdrawal: ["Equity"], advance: ["OtherCurrentAsset", "OtherAsset"],
};
const sourceForKind: Partial<Record<MovementKind, MovementSourceKind>> = {
  obligation_payment: "vendor_bill", payroll_match: "payroll", wire_match: "wire", refund_match: "refund",
};
export function movementStructuralBlockers(body: Omit<MovementInput, "id" | "expected_revision">): string[] {
  const blockers: string[] = [];
  if (!body.attested) blockers.push("BANKING_MOVEMENT_ATTESTATION_REQUIRED");
  if (body.kind === "bank_transfer") {
    if (!body.destination_bank_account_id || body.destination_bank_account_id === body.bank_account_id || !body.transit_account_list_id
      || body.allocations.length) blockers.push("BANKING_TRANSFER_INVALID");
    return blockers;
  }
  if (body.destination_bank_account_id || body.transit_account_list_id || !body.allocations.some(l => l.role === "principal")
    || body.allocations.reduce((sum, l) => sum + l.amount_cents, 0) !== body.amount_cents)
    blockers.push("BANKING_MOVEMENT_AMOUNT_INVALID");
  if (new Set(body.allocations.map(l => `${l.source_kind}:${l.source_id}`)).size !== body.allocations.length)
    blockers.push("BANKING_SOURCE_DUPLICATED");
  for (const line of body.allocations) {
    if (line.documented_capacity_cents === null || line.documented_as_of === null) blockers.push("BANKING_DOCUMENTED_CAPACITY_REQUIRED");
    else if (line.amount_cents > line.documented_capacity_cents || line.documented_as_of > body.day)
      blockers.push("BANKING_DOCUMENTED_CAPACITY_INVALID");
    if (line.role === "principal") {
      if (line.recognition_owner !== "existing" || line.source_kind !== (sourceForKind[body.kind] ?? "document"))
        blockers.push("BANKING_RECOGNITION_OWNERSHIP_REQUIRED");
    } else if (line.recognition_owner !== "new" || line.source_kind !== "document" || body.kind === "owner_contribution"
      || (line.role === "interest" && body.kind !== "loan_payment")) blockers.push("BANKING_RECOGNITION_OWNERSHIP_INVALID");
  }
  return [...new Set(blockers)];
}
export function movementLine(role: string, account: AccountingAccount, cents: number, debit: boolean): CompletionLine {
  return { role, account_list_id: account.id, account_snapshot: account, debit_cents: debit ? cents : 0, credit_cents: debit ? 0 : cents };
}
/** Exactly one expense role for the shared P&L reader; distinct fee accounts remain explicit. */
export function buildMovementLines(body: Omit<MovementInput, "id" | "expected_revision">, bank: AccountingAccount,
  accounts: Map<string, AccountingAccount>): CompletionLine[] {
  if (body.kind === "bank_transfer") throw new BankingError("BANKING_TRANSFER_STAGE_REQUIRED", 409);
  const inflow = body.kind === "owner_contribution";
  const rows: CompletionLine[] = [movementLine("bank", bank, body.amount_cents, inflow)];
  const expenses = new Map<string, { account: AccountingAccount; cents: number }>();
  for (const [index, allocation] of body.allocations.entries()) {
    const account = accounts.get(allocation.account_list_id);
    if (!account || account.currency !== "USD") throw new BankingError("BANKING_COUNTERPART_ACCOUNT_INVALID", 409);
    const allowed = allocation.role === "principal" ? MOVEMENT_COUNTERPART_TYPES[body.kind] : ["Expense", "OtherExpense"];
    if (!allowed.includes(account.account_type) || account.id === bank.id) throw new BankingError("BANKING_COUNTERPART_ACCOUNT_INVALID", 409);
    if (allocation.role === "principal") rows.push(movementLine(`counterpart_${index}`, account, allocation.amount_cents, !inflow));
    else expenses.set(account.id, { account, cents: (expenses.get(account.id)?.cents ?? 0) + allocation.amount_cents });
  }
  // Multiple expense accounts are explicit expense-prefixed lines; report reader must include this prefix.
  for (const [index, expense] of [...expenses.values()].entries()) rows.push(movementLine(index === 0 ? "expense" : `expense_${index}`,
    expense.account, expense.cents, true));
  return rows;
}
