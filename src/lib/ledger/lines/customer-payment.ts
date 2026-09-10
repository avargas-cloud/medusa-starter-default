import { AccountMap, LedgerError, LedgerLine, PaymentSnapshot } from "../types";

/**
 * §2: pago recibido → débito undeposited_funds, crédito accounts_receivable.
 * Refund → exactamente al revés. Siempre 2 líneas, siempre balanceado por
 * construcción (mismo monto en los dos lados) — sin tolerancia de redondeo.
 */
export function buildCustomerPaymentLines(
  snapshot: PaymentSnapshot,
  map: AccountMap
): LedgerLine[] {
  if (snapshot.amountCents <= 0n)
    throw new LedgerError("GL_SOURCE_INVALID", {
      amountCents: snapshot.amountCents.toString(),
    });

  if (snapshot.type === "payment")
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
