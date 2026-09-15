import { LedgerAccount, LedgerError, LedgerLine } from "../types";

export interface BankDepositLineInput {
  /** Cuenta ORIGEN de la línea: Undeposited Funds para un cobro o una línea
   * manual sin cuenta; la cuenta de QB (AP, Cash Register, ingreso…) para una
   * línea manual que la declara. */
  account: LedgerAccount;
  amount_cents: bigint;
  memo?: string | null;
}

export interface BankDepositInput {
  /** Cuenta DESTINO (Bank u OtherCurrentAsset — "Cash on Hand" también recibe depósitos en QB). */
  bankAccount: LedgerAccount;
  lines: BankDepositLineInput[];
  /** Comisión descontada por el banco: Dr gasto, reduce el neto que entra al banco. */
  fee?: { account: LedgerAccount; amount_cents: bigint; memo?: string | null } | null;
}

/**
 * Builder puro de `bank_deposit` (Make Deposits de QuickBooks): Dr banco por
 * el NETO (`bank_account`), Cr cada origen por su monto (`item_<n>`), Dr la
 * comisión si la hay (`fee`). Balanceado por construcción: neto + fee = Σ líneas.
 * Una línea puede ser negativa (refund neteado); el gross (Σ líneas) es > 0 y
 * un "depósito negativo" de QB no es un depósito del POS.
 */
export function buildBankDepositLines(input: BankDepositInput): LedgerLine[] {
  const { bankAccount, lines, fee } = input;
  if (!["Bank", "OtherCurrentAsset"].includes(bankAccount.account_type))
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "deposit_account_type",
      account_type: bankAccount.account_type,
    });
  if (lines.length < 1 || lines.length > 198)
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "line_count",
      lineCount: lines.length,
    });

  let gross = 0n;
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
    // Una línea negativa (refund de tarjeta neteado en el lote) DEBITA su
    // cuenta: devuelve a UF lo que el cobro había reconocido.
    out.push({
      role: `item_${index + 1}`,
      account: line.account,
      debit_cents: line.amount_cents < 0n ? -line.amount_cents : 0n,
      credit_cents: line.amount_cents > 0n ? line.amount_cents : 0n,
      memo: line.memo ?? undefined,
    });
    gross += line.amount_cents;
  });

  const feeCents = fee?.amount_cents ?? 0n;
  // v4: gross 0 = un Make Deposits de $0 (dos ítems de UF que se anulan); nunca negativo.
  if (gross < 0n)
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "gross_negative", gross: gross.toString() });
  if (feeCents < 0n || (feeCents > 0n && feeCents >= gross))
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "fee_out_of_range",
      fee: feeCents.toString(),
      gross: gross.toString(),
    });
  if (fee && feeCents > 0n)
    out.unshift({
      role: "fee",
      account: fee.account,
      debit_cents: feeCents,
      credit_cents: 0n,
      memo: fee.memo ?? undefined,
    });
  // Sin neto no hay línea de banco (el motor rechaza líneas en cero); las
  // líneas de origen ya se balancean entre sí.
  if (gross - feeCents > 0n)
    out.unshift({
      role: "bank_account",
      account: bankAccount,
      debit_cents: gross - feeCents,
      credit_cents: 0n,
    });
  return out;
}
