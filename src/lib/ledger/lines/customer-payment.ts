import { AccountMap, LedgerAccount, LedgerError, LedgerLine, PaymentSnapshot } from "../types";

/**
 * §2: pago recibido → débito undeposited_funds, crédito accounts_receivable.
 * Refund → exactamente al revés. Siempre balanceado por construcción.
 *
 * Card surcharge (2026-09-14): el banco deposita amount+surcharge — el
 * comprador paga el recargo, pero AR nunca lo ve. Con `surchargeCents > 0n`
 * en un `payment`, undeposited_funds recibe el total (amount+surcharge) y
 * el surcharge se reconoce como su propia línea de income (`surchargeAccount`,
 * requerido en ese caso — GL_ACCOUNT_MAP_MISSING si falta). `surchargeCents`
 * se ignora en refund: el reembolso del recargo por el procesador no está
 * modelado (no hay evidencia hoy de que Dejavoo/BAMS lo reembolsen).
 */
export function buildCustomerPaymentLines(
  snapshot: PaymentSnapshot,
  map: AccountMap,
  surchargeAccount?: LedgerAccount
): LedgerLine[] {
  if (snapshot.amountCents <= 0n)
    throw new LedgerError("GL_SOURCE_INVALID", {
      amountCents: snapshot.amountCents.toString(),
    });

  if (snapshot.type === "payment") {
    if (snapshot.surchargeCents > 0n) {
      if (!surchargeAccount)
        throw new LedgerError("GL_ACCOUNT_MAP_MISSING", {
          missing: ["credit_card_surcharge"],
        });
      return [
        {
          role: "undeposited_funds",
          account: map.undeposited_funds,
          debit_cents: snapshot.amountCents + snapshot.surchargeCents,
          credit_cents: 0n,
        },
        {
          role: "accounts_receivable",
          account: map.accounts_receivable,
          debit_cents: 0n,
          credit_cents: snapshot.amountCents,
        },
        {
          role: "credit_card_surcharge",
          account: surchargeAccount,
          debit_cents: 0n,
          credit_cents: snapshot.surchargeCents,
        },
      ];
    }
    return [
      {
        role: "undeposited_funds",
        account: map.undeposited_funds,
        debit_cents: snapshot.amountCents,
        credit_cents: 0n,
      },
      {
        role: "accounts_receivable",
        account: map.accounts_receivable,
        debit_cents: 0n,
        credit_cents: snapshot.amountCents,
      },
    ];
  }

  return [
    {
      role: "accounts_receivable",
      account: map.accounts_receivable,
      debit_cents: snapshot.amountCents,
      credit_cents: 0n,
    },
    {
      role: "undeposited_funds",
      account: map.undeposited_funds,
      debit_cents: 0n,
      credit_cents: snapshot.amountCents,
    },
  ];
}
