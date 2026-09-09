import type { AccountingAccount } from "./accounting-types";
import { movementLine } from "./movement-rules";
import { BankingError } from "./security";
import type { CompletionLine } from "./movement-types";
import type { SettlementLine, SettlementTotals } from "./settlement-types";

/** Surcharge is an audit value: customer_payment.amount already excludes it. */
export function settlementTotals(lines: SettlementLine[]): SettlementTotals {
  const totals: SettlementTotals = { receipts_cents: 0, refunds_cents: 0, chargebacks_cents: 0, fees_cents: 0,
    reserve_held_cents: 0, reserve_released_cents: 0, net_cents: 0, surcharge_audit_cents: 0 };
  const fields = { receipt: "receipts_cents", refund: "refunds_cents", chargeback: "chargebacks_cents", fee: "fees_cents",
    reserve_hold: "reserve_held_cents", reserve_release: "reserve_released_cents" } as const;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.amount_cents) || line.amount_cents <= 0
      || !Number.isSafeInteger(line.surcharge_cents) || line.surcharge_cents < 0)
      throw new BankingError("BANKING_SETTLEMENT_AMOUNT_INVALID");
    totals[fields[line.kind]] += line.amount_cents;
    totals.surcharge_audit_cents += line.surcharge_cents;
    totals.net_cents += line.amount_cents * (["receipt", "reserve_release"].includes(line.kind) ? 1 : -1);
  }
  if (Object.values(totals).some(n => !Number.isSafeInteger(n) || Math.abs(n) > 999999999999))
    throw new BankingError("BANKING_SETTLEMENT_AMOUNT_INVALID");
  return totals;
}

export function settlementStructuralBlockers(lines: SettlementLine[]): string[] {
  const blockers: string[] = [];
  if (!lines.length || lines.length > 100) blockers.push("BANKING_SETTLEMENT_LINES_INVALID");
  if (new Set(lines.map(l => `${l.kind}:${l.source_id.trim().toLowerCase()}`)).size !== lines.length)
    blockers.push("BANKING_SOURCE_DUPLICATED");
  for (const line of lines) {
    if (line.kind !== "receipt" && line.surcharge_cents !== 0) blockers.push("BANKING_SETTLEMENT_SURCHARGE_INVALID");
    if (["fee", "reserve_hold"].includes(line.kind) ? line.recognition_owner !== "new" : line.recognition_owner !== "existing")
      blockers.push("BANKING_RECOGNITION_OWNERSHIP_INVALID");
    if (line.documented_capacity_cents === null || line.documented_as_of === null)
      blockers.push("BANKING_DOCUMENTED_CAPACITY_REQUIRED");
    else if (line.documented_capacity_cents < line.amount_cents) blockers.push("BANKING_DOCUMENTED_CAPACITY_INVALID");
  }
  return [...new Set(blockers)];
}

/** Refund/chargeback pays an evidenced existing balance-sheet obligation; it creates no second expense/revenue. */
export function buildSettlementLines(lines: SettlementLine[], bank: AccountingAccount,
  accounts: Map<string, AccountingAccount>): CompletionLine[] {
  const totals = settlementTotals(lines);
  if (bank.account_type !== "Bank" || bank.currency !== "USD") throw new BankingError("BANKING_OPENING_ACCOUNT_INVALID", 409);
  const result: CompletionLine[] = [];
  if (totals.net_cents !== 0) result.push(movementLine("bank", bank, Math.abs(totals.net_cents), totals.net_cents > 0));
  for (const [index, line] of lines.entries()) {
    const account = accounts.get(line.account_list_id);
    const allowed = line.kind === "fee" ? ["Expense", "OtherExpense"]
      : ["refund", "chargeback"].includes(line.kind) ? ["OtherCurrentLiability", "AccountsPayable"] : ["OtherCurrentAsset"];
    if (!account || account.currency !== "USD" || !allowed.includes(account.account_type) || account.id === bank.id)
      throw new BankingError("BANKING_COUNTERPART_ACCOUNT_INVALID", 409);
    result.push(movementLine(`${line.kind === "fee" ? "expense" : "counterpart"}_${index}`, account,
      line.amount_cents, !["receipt", "reserve_release"].includes(line.kind)));
  }
  return result;
}
