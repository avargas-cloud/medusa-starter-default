import { AccountMap, LedgerError, LedgerLine, RoundingSnapshot } from "../types";

/**
 * §2: `pos_rounding_adjustment` — según `direction`, AR ↔ `account_list_id`
 * de la fila (`sales/rounding/write-off.ts`). `shortage` = residuo que se
 * perdona contra AR (débito la cuenta de la fila, crédito AR, AR baja).
 * `overage` = residuo que sobró (débito AR, crédito la cuenta de la fila).
 * Siempre 2 líneas, mismo monto en los dos lados.
 */
export function buildRoundingLines(
  snapshot: RoundingSnapshot,
  map: AccountMap
): LedgerLine[] {
  if (snapshot.amountCents <= 0n)
    throw new LedgerError("GL_SOURCE_INVALID", {
      amountCents: snapshot.amountCents.toString(),
    });

  if (snapshot.direction === "shortage")
    return [
      {
        role: "rounding_account",
        account: snapshot.account,
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
      role: "rounding_account",
      account: snapshot.account,
      debit_cents: 0n,
      credit_cents: snapshot.amountCents,
    },
  ];
}
