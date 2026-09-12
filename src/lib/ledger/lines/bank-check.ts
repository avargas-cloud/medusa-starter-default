import { signedLine } from "../money";
import { LedgerAccount, LedgerError, LedgerLine } from "../types";

export type BankCheckKind = "check" | "expense" | "card_charge";

export interface BankCheckLineInput {
  account: LedgerAccount;
  /** Positivo = gasto normal (Dr cuenta). Negativo = reduce (Cr cuenta). Nunca 0. */
  amount_cents: bigint;
  memo?: string | null;
}

export interface BankCheckInput {
  bankAccount: LedgerAccount;
  lines: BankCheckLineInput[];
}

/**
 * `kind` se DERIVA al guardar, nunca lo manda el cliente: una cuenta
 * `CreditCard` es un cargo de tarjeta; con número de cheque es `check`; sin
 * número es un `expense` (débito directo / ACH / efectivo).
 */
export function deriveBankCheckKind(
  bankAccountType: string,
  checkNumber: string | null | undefined
): BankCheckKind {
  if (bankAccountType === "CreditCard") return "card_charge";
  return checkNumber && checkNumber.trim() ? "check" : "expense";
}

/**
 * Builder puro de `bank_check`: Dr cada línea contra su cuenta (`item_<n>`),
 * Cr la cuenta de banco/tarjeta por el total (`bank_account`). Un cargo de
 * tarjeta es idéntico — la contrapartida es la CreditCard (pasivo, sube con
 * el crédito). Total = Σ líneas y tiene que ser > 0.
 */
export function buildBankCheckLines(input: BankCheckInput): LedgerLine[] {
  const { bankAccount, lines } = input;
  if (
    bankAccount.account_type !== "Bank" &&
    bankAccount.account_type !== "CreditCard"
  )
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "bank_account_type",
      account_type: bankAccount.account_type,
    });
  if (lines.length < 1 || lines.length > 199)
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "line_count",
      lineCount: lines.length,
    });

  let total = 0n;
  const out: LedgerLine[] = [];
  lines.forEach((line, index) => {
    if (line.amount_cents === 0n)
      throw new LedgerError("GL_SOURCE_INVALID", {
        reason: "zero_line",
        index,
      });
    if (line.account.account_type === "NonPosting")
      throw new LedgerError("GL_SOURCE_INVALID", {
        reason: "non_posting_account",
        index,
        account_list_id: line.account.id,
      });
    const built = signedLine(
      `item_${index + 1}`,
      line.account,
      line.amount_cents
    );
    if (built) out.push({ ...built, memo: line.memo ?? undefined });
    total += line.amount_cents;
  });
  if (total <= 0n)
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "total_not_positive",
      total: total.toString(),
    });

  out.push({
    role: "bank_account",
    account: bankAccount,
    debit_cents: 0n,
    credit_cents: total,
  });
  return out;
}

/** Σ amount_cents de las líneas (el `total_cents` que se persiste en el header). */
export function bankCheckTotal(lines: { amount_cents: bigint }[]): bigint {
  return lines.reduce((acc, l) => acc + l.amount_cents, 0n);
}
