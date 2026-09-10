import { absBigInt, allocateEqually, allocateLargestRemainder, costCentsHalfUp } from "../money";
import {
  AccountMap,
  CreditMemoSnapshot,
  LedgerError,
  LedgerLine,
} from "../types";
import { ROUNDING_TOLERANCE_CENTS } from "./invoice";

function mirror(lines: LedgerLine[]): LedgerLine[] {
  return lines.map((l) => ({ ...l, debit_cents: l.credit_cents, credit_cents: l.debit_cents }));
}

/**
 * §2, fraude/bad-debt: `bad_debt = total` (débito) contra `accounts_receivable`
 * (crédito), SIN líneas de income ni de restock — la clasificación es del
 * header (`lib/reports/fraud-writeoff.ts`), nunca de la línea.
 */
export function buildFraudWriteoffLines(
  totalCents: bigint,
  map: AccountMap
): LedgerLine[] {
  if (totalCents <= 0n)
    throw new LedgerError("GL_SOURCE_INVALID", { totalCents: totalCents.toString() });
  return [
    {
      role: "bad_debt",
      account: map.bad_debt,
      debit_cents: totalCents,
      credit_cents: 0n,
    },
    {
      role: "accounts_receivable",
      account: map.accounts_receivable,
      debit_cents: 0n,
      credit_cents: totalCents,
    },
  ];
}

/**
 * §2 (corregido 2026-09-10, dos veces — misma familia de bugs que la
 * invoice): el target de income NUNCA se lee de `pos_credit_memo.subtotal`
 * (puede desincronizarse del `total` real, igual que en invoices) — se
 * DERIVA de `total + discount − shipping − tax`, que balancea EXACTO por
 * construcción. Documentos con `total` negativo (ajustes internos
 * espejados, p.ej. compensaciones QB) se arman en valores ABSOLUTOS y se
 * espejan al final; `total = 0` no emite líneas de $0 (ni `accounts_
 * receivable` — antes se empujaba siempre y una línea 0/0 viola el CHECK de
 * "un solo lado > 0").
 */
export function buildCreditMemoLines(
  snapshot: CreditMemoSnapshot,
  map: AccountMap
): LedgerLine[] {
  if (snapshot.isFraudWriteoff)
    return buildFraudWriteoffLines(snapshot.totalCents, map);

  const negative = snapshot.totalCents < 0n;
  const totalAbs = absBigInt(snapshot.totalCents);
  const discountAbs = absBigInt(snapshot.discountCents);
  const shippingAbs = absBigInt(snapshot.shippingCents);
  const taxAbs = absBigInt(snapshot.taxCents);

  const grossTarget = totalAbs + discountAbs - shippingAbs - taxAbs;
  if (grossTarget < 0n)
    throw new LedgerError("GL_UNBALANCED_DOCUMENT", {
      reason: "shipping+tax exceed total+discount",
      totalCents: snapshot.totalCents.toString(),
      discountCents: snapshot.discountCents.toString(),
      shippingCents: snapshot.shippingCents.toString(),
      taxCents: snapshot.taxCents.toString(),
    });

  const weights = snapshot.lines.map((l) => absBigInt(l.lineTotalCents));
  const sumWeights = weights.reduce((a, b) => a + b, 0n);

  let incomePerLine: bigint[];
  if (grossTarget === 0n) {
    incomePerLine = weights.map(() => 0n);
  } else if (sumWeights === 0n) {
    incomePerLine = allocateEqually(weights.length, grossTarget);
  } else {
    incomePerLine = allocateLargestRemainder(weights, grossTarget);
  }

  const lines: LedgerLine[] = [];
  let cogsSum = 0n;

  snapshot.lines.forEach((line, i) => {
    const income = incomePerLine[i] ?? 0n;
    if (income !== 0n) {
      lines.push({
        role: `income_${i}`,
        account: line.incomeAccount,
        debit_cents: income,
        credit_cents: 0n,
      });
    }
    const restockQty = line.quantity - line.damagedQty;
    const cogsCents = costCentsHalfUp(line.unitCostDollars, restockQty);
    if (line.cogsAccount && cogsCents > 0n) {
      lines.push({
        role: `cogs_${i}`,
        account: line.cogsAccount,
        debit_cents: 0n,
        credit_cents: cogsCents,
      });
      cogsSum += cogsCents;
    }
  });

  if (shippingAbs > 0n)
    lines.push({
      role: "shipping_income",
      account: map.shipping_income,
      debit_cents: shippingAbs,
      credit_cents: 0n,
    });
  if (taxAbs > 0n)
    lines.push({
      role: "sales_tax_payable",
      account: map.sales_tax_payable,
      debit_cents: taxAbs,
      credit_cents: 0n,
    });
  if (cogsSum > 0n)
    lines.push({
      role: "inventory_asset",
      account: map.inventory_asset,
      debit_cents: cogsSum,
      credit_cents: 0n,
    });

  if (totalAbs > 0n)
    lines.push({
      role: "accounts_receivable",
      account: map.accounts_receivable,
      debit_cents: 0n,
      credit_cents: totalAbs,
    });
  if (discountAbs > 0n)
    lines.push({
      role: "sales_discounts",
      account: map.sales_discounts,
      debit_cents: 0n,
      credit_cents: discountAbs,
    });

  // Red de seguridad defensiva: por construcción esto es siempre 0.
  const incomeSum = incomePerLine.reduce((a, b) => a + b, 0n);
  const imbalance = incomeSum + shippingAbs + taxAbs - (totalAbs + discountAbs);
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
