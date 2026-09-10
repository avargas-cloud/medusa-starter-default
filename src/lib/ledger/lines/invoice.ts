import { absBigInt, allocateEqually, allocateLargestRemainder, costCentsHalfUp } from "../money";
import { AccountMap, InvoiceSnapshot, LedgerError, LedgerLine } from "../types";

/** Red de seguridad defensiva — el reparto queda balanceado EXACTO por construcción; esto nunca debería disparar. */
export const ROUNDING_TOLERANCE_CENTS = 5n;

function mirror(lines: LedgerLine[]): LedgerLine[] {
  return lines.map((l) => ({ ...l, debit_cents: l.credit_cents, credit_cents: l.debit_cents }));
}

/**
 * §2 (corregido 2026-09-10, dos veces):
 *
 * 1) `pos_invoice.subtotal` NO es una fuente confiable del target de income:
 *    para algunas facturas (medido: invoice #20563) `total ≠ subtotal +
 *    shipping + tax` por un monto real (no de redondeo) — `subtotal` quedó
 *    desincronizado del ajuste real que sí vive en `total`/`amount_paid`. El
 *    ÚNICO valor que la identidad contable exige que sea consistente es
 *    `total` (lo que se cobra, lo que debita AR): el target de income se
 *    DERIVA de `total − shipping − tax + discount`, nunca de `subtotal`. Con
 *    eso la ecuación balancea EXACTO por construcción — no hay "sobrante" que
 *    tolerar, sólo el caso genuinamente inconsistente donde el target da
 *    negativo (shipping+tax superan total+discount), que se rechaza.
 *
 * 2) Documentos con `total` NEGATIVO (una "factura" que en los hechos es una
 *    devolución posteada por el pipeline de invoices, no por credit memo) y
 *    documentos con `total = 0` (ítems 100% regalados/descontados, o
 *    write-offs de costo sin venta) son reales y DEBEN postear:
 *      - negativo: se arma la entrada con los valores ABSOLUTOS (misma
 *        lógica que un total positivo) y se ESPEJA (débito↔crédito) toda la
 *        entrada al final — economía de una reversa, sin usar `kind=reversal`.
 *      - cero: ninguna línea de $0 se emite (`accounts_receivable` incluida:
 *        antes se empujaba SIEMPRE, y una línea 0/0 viola el CHECK de "un
 *        solo lado > 0"). Si además no hay income que repartir (Σweights=0 y
 *        discount=0), no hay líneas de income — sólo COGS/inventory si el
 *        costo existe (ítems regalados igual expensan su costo).
 */
export function buildInvoiceLines(
  snapshot: InvoiceSnapshot,
  map: AccountMap
): LedgerLine[] {
  const negative = snapshot.totalCents < 0n;
  const totalAbs = absBigInt(snapshot.totalCents);
  const discountAbs = absBigInt(snapshot.discountCents);
  const shippingAbs = absBigInt(snapshot.shippingCents);
  const taxAbs = absBigInt(snapshot.taxCents);

  const incomeTarget = totalAbs - shippingAbs - taxAbs;
  const grossTarget = incomeTarget + discountAbs;
  if (grossTarget < 0n)
    throw new LedgerError("GL_UNBALANCED_DOCUMENT", {
      reason: "shipping+tax exceed total+discount",
      totalCents: snapshot.totalCents.toString(),
      discountCents: snapshot.discountCents.toString(),
      shippingCents: snapshot.shippingCents.toString(),
      taxCents: snapshot.taxCents.toString(),
    });

  const weights = snapshot.lines.map((l) => absBigInt(l.lineNetCents));
  const sumWeights = weights.reduce((a, b) => a + b, 0n);

  let grossPerLine: bigint[];
  if (grossTarget === 0n) {
    grossPerLine = weights.map(() => 0n);
  } else if (sumWeights === 0n) {
    if (discountAbs === 0n) grossPerLine = weights.map(() => 0n);
    else grossPerLine = allocateEqually(weights.length, grossTarget);
  } else {
    grossPerLine = allocateLargestRemainder(weights, grossTarget);
  }

  const lines: LedgerLine[] = [];
  let cogsSum = 0n;

  snapshot.lines.forEach((line, i) => {
    const gross = grossPerLine[i] ?? 0n;
    if (gross !== 0n) {
      lines.push({
        role: `income_${i}`,
        account: line.incomeAccount,
        debit_cents: 0n,
        credit_cents: gross,
      });
    }
    const cogsCents = costCentsHalfUp(line.unitCostDollars, line.quantity);
    if (line.cogsAccount && cogsCents > 0n) {
      lines.push({
        role: `cogs_${i}`,
        account: line.cogsAccount,
        debit_cents: cogsCents,
        credit_cents: 0n,
      });
      cogsSum += cogsCents;
    }
  });

  if (totalAbs > 0n)
    lines.push({
      role: "accounts_receivable",
      account: map.accounts_receivable,
      debit_cents: totalAbs,
      credit_cents: 0n,
    });
  if (discountAbs > 0n)
    lines.push({
      role: "sales_discounts",
      account: map.sales_discounts,
      debit_cents: discountAbs,
      credit_cents: 0n,
    });
  if (shippingAbs > 0n)
    lines.push({
      role: "shipping_income",
      account: map.shipping_income,
      debit_cents: 0n,
      credit_cents: shippingAbs,
    });
  if (taxAbs > 0n)
    lines.push({
      role: "sales_tax_payable",
      account: map.sales_tax_payable,
      debit_cents: 0n,
      credit_cents: taxAbs,
    });
  if (cogsSum > 0n)
    lines.push({
      role: "inventory_asset",
      account: map.inventory_asset,
      debit_cents: 0n,
      credit_cents: cogsSum,
    });

  // Red de seguridad: por construcción esto es siempre 0 (income = total −
  // shipping − tax + discount, exacto). Si algún día deja de serlo, no se
  // adivina un monto — se rechaza con el detalle.
  const incomeSum = grossPerLine.reduce((a, b) => a + b, 0n);
  const imbalance = totalAbs + discountAbs - (incomeSum + shippingAbs + taxAbs);
  if (imbalance !== 0n) {
    const magnitude = absBigInt(imbalance);
    if (magnitude > ROUNDING_TOLERANCE_CENTS)
      throw new LedgerError("GL_UNBALANCED_DOCUMENT", {
        imbalanceCents: imbalance.toString(),
      });
    lines.push(
      imbalance > 0n
        ? { role: "rounding", account: map.sales_discounts, debit_cents: 0n, credit_cents: imbalance }
        : { role: "rounding", account: map.sales_discounts, debit_cents: magnitude, credit_cents: 0n }
    );
  }

  return negative ? mirror(lines) : lines;
}
