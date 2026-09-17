/**
 * Aritmética del DR-15 (sales-tax-center-20260917). Puro, en centavos (bigint).
 *
 * - El ítem de QuickBooks es UNO, plano ("Sale Tax 7%" = 6% estatal + 1% de
 *   surtax de Miami-Dade), así que el surtax COBRADO es exactamente 1/7 del tax
 *   cobrado (decisión del operador 09/17/2026 para la línea 15(d)). El tope de
 *   $5,000 por ítem NO se modela: sólo se avisa si hubo una línea que lo supere.
 * - Collection allowance (línea 14): 2.5% de los primeros $1,200 de tax, máx $30,
 *   sólo si se declara y paga electrónicamente a tiempo.
 * - Remesa = tax due + penalty + interest − allowance − prior credit (± other).
 */

export const ALLOWANCE_RATE_BP = 250n; // 2.5% en basis points
export const ALLOWANCE_BASE_CAP_CENTS = 120_000n; // primeros $1,200 de tax
export const ALLOWANCE_MAX_CENTS = 3_000n; // $30

export type AdjustmentType =
  | "collection_allowance"
  | "penalty"
  | "interest"
  | "rounding"
  | "prior_credit"
  | "other";
export type AdjustmentDirection = "decrease" | "increase";

/** Dirección FIJA por tipo: penalty/interest suben la deuda; allowance y prior credit la bajan. `rounding`/`other` la elige el ajuste. */
export function fixedDirectionFor(type: AdjustmentType): AdjustmentDirection | null {
  switch (type) {
    case "collection_allowance":
    case "prior_credit":
      return "decrease";
    case "penalty":
    case "interest":
      return "increase";
    default:
      return null;
  }
}

/** Reparto estado / condado de un tax cobrado a tasa plana: surtax = tax × surtax / (state + surtax). */
export function splitStateSurtax(
  taxCents: bigint,
  stateRateBp: number,
  surtaxRateBp: number
): { state_cents: bigint; surtax_cents: bigint } {
  const total = BigInt(stateRateBp + surtaxRateBp);
  if (total === 0n) return { state_cents: taxCents, surtax_cents: 0n };
  // redondeo al centavo más cercano, con signo (un período con más CM que ventas es negativo)
  const num = taxCents * BigInt(surtaxRateBp);
  const surtax = roundDiv(num, total);
  return { state_cents: taxCents - surtax, surtax_cents: surtax };
}

function roundDiv(num: bigint, den: bigint): bigint {
  const sign = num < 0n ? -1n : 1n;
  const abs = num < 0n ? -num : num;
  return sign * ((abs * 2n + den) / (den * 2n));
}

/** Línea 14 del DR-15. 0 cuando el tax no es positivo o no fue a tiempo. */
export function collectionAllowanceCents(taxDueCents: bigint, timely: boolean): bigint {
  if (!timely || taxDueCents <= 0n) return 0n;
  const base = taxDueCents < ALLOWANCE_BASE_CAP_CENTS ? taxDueCents : ALLOWANCE_BASE_CAP_CENTS;
  const raw = roundDiv(base * ALLOWANCE_RATE_BP, 10_000n);
  return raw > ALLOWANCE_MAX_CENTS ? ALLOWANCE_MAX_CENTS : raw;
}

export interface RemittanceInput {
  tax_due_cents: bigint;
  /** Ajustes del período, con signo ya resuelto por `direction` (increase +, decrease −). */
  adjustments: Array<{ type: AdjustmentType; signed_cents: bigint }>;
}

export interface RemittanceBreakdown {
  tax_due_cents: bigint;
  penalty_cents: bigint;
  interest_cents: bigint;
  allowance_cents: bigint;
  prior_credit_cents: bigint;
  other_cents: bigint;
  remittance_cents: bigint;
}

/** `tax due + penalty + interest − allowance − prior credit ± other` — una sola ecuación, la que imprime la pantalla. */
export function remittance(input: RemittanceInput): RemittanceBreakdown {
  let penalty = 0n;
  let interest = 0n;
  let allowance = 0n;
  let prior = 0n;
  let other = 0n;
  for (const a of input.adjustments) {
    switch (a.type) {
      case "penalty":
        penalty += a.signed_cents;
        break;
      case "interest":
        interest += a.signed_cents;
        break;
      case "collection_allowance":
        allowance += -a.signed_cents;
        break;
      case "prior_credit":
        prior += -a.signed_cents;
        break;
      default:
        other += a.signed_cents;
    }
  }
  return {
    tax_due_cents: input.tax_due_cents,
    penalty_cents: penalty,
    interest_cents: interest,
    allowance_cents: allowance,
    prior_credit_cents: prior,
    other_cents: other,
    remittance_cents: input.tax_due_cents + penalty + interest - allowance - prior + other,
  };
}

export function signedAdjustment(direction: AdjustmentDirection, amountCents: bigint): bigint {
  return direction === "increase" ? amountCents : -amountCents;
}
