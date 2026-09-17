import { LedgerAccount, LedgerError, LedgerLine } from "../types";

/**
 * Builders puros de los documentos de sales tax (sales-tax-center-20260917).
 *
 * Adjust Sales Tax Due (STA):
 *   decrease  Dr Sales Tax Payable / Cr contrapartida   (collection allowance, prior credit)
 *   increase  Dr contrapartida / Cr Sales Tax Payable   (penalty, interest)
 *
 * Pay Sales Tax (STP): Dr Sales Tax Payable / Cr banco por la remesa NETA
 * (tax bruto + Σ líneas de ajuste, que son negativas cuando bajan la deuda).
 * QuickBooks muestra el mismo neto como SalesTaxPaymentCheck con la línea del
 * tax item por el bruto y las líneas de ajuste sin item — el asiento del POS
 * no copia esa forma: el ajuste ya movió el payable cuando se posteó (STA).
 */

export interface SalesTaxAdjustmentInput {
  payable: LedgerAccount;
  offset: LedgerAccount;
  direction: "decrease" | "increase";
  amount_cents: bigint;
}

export function buildSalesTaxAdjustmentLines(input: SalesTaxAdjustmentInput): LedgerLine[] {
  const { payable, offset, direction, amount_cents } = input;
  if (amount_cents <= 0n)
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "amount_not_positive", amount: amount_cents.toString() });
  if (payable.account_type !== "OtherCurrentLiability")
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "payable_account_type", account_type: payable.account_type });
  if (offset.account_type === "NonPosting" || offset.id === payable.id)
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "offset_account", account_list_id: offset.id });
  const zero = 0n;
  return direction === "decrease"
    ? [
        { role: "sales_tax_payable", account: payable, debit_cents: amount_cents, credit_cents: zero },
        { role: "offset", account: offset, debit_cents: zero, credit_cents: amount_cents },
      ]
    : [
        { role: "offset", account: offset, debit_cents: amount_cents, credit_cents: zero },
        { role: "sales_tax_payable", account: payable, debit_cents: zero, credit_cents: amount_cents },
      ];
}

export interface SalesTaxPaymentInput {
  payable: LedgerAccount;
  bankAccount: LedgerAccount;
  tax_cents: bigint;
  /** Con signo: negativo = baja la remesa (allowance aplicado), positivo = la sube. */
  adjustment_cents: bigint[];
}

export function salesTaxPaymentTotal(input: Pick<SalesTaxPaymentInput, "tax_cents" | "adjustment_cents">): bigint {
  return input.adjustment_cents.reduce((acc, c) => acc + c, input.tax_cents);
}

export function buildSalesTaxPaymentLines(input: SalesTaxPaymentInput): LedgerLine[] {
  const { payable, bankAccount, tax_cents } = input;
  if (tax_cents <= 0n)
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "tax_not_positive", tax: tax_cents.toString() });
  if (input.adjustment_cents.some((c) => c === 0n))
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "zero_line" });
  if (payable.account_type !== "OtherCurrentLiability")
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "payable_account_type", account_type: payable.account_type });
  if (bankAccount.account_type !== "Bank")
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "bank_account_type", account_type: bankAccount.account_type });
  const total = salesTaxPaymentTotal(input);
  if (total <= 0n)
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "total_not_positive", total: total.toString() });
  return [
    { role: "sales_tax_payable", account: payable, debit_cents: total, credit_cents: 0n },
    { role: "bank_account", account: bankAccount, debit_cents: 0n, credit_cents: total },
  ];
}
