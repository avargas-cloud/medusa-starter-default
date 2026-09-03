/**
 * Order Commissions — calculadora pura. Sin IO, sin fechas implícitas.
 *
 * Reglas: docs/ORDER_COMMISSIONS_PLAN.md §2 y §11.
 * Todo dinero en CENTS (int), todo porcentaje en BPS (int). El cap combinado se
 * mide en PUNTOS: el descuento contra el subtotal bruto, las comisiones contra
 * el neto — siempre cae del lado conservador en dólares (§2.2 del plan).
 */

export const MAX_RECIPIENTS = 3;

export interface CommissionBaseInput {
  /** Subtotal de ítems ANTES de descuento, sin tax ni flete. */
  itemSubtotalCents: number;
  /** Descuento total de la orden. */
  discountCents: number;
}

export function commissionBaseCents(input: CommissionBaseInput): number {
  return Math.max(0, Math.round(input.itemSubtotalCents) - Math.round(input.discountCents));
}

export function discountBpsOf(input: CommissionBaseInput): number {
  if (input.itemSubtotalCents <= 0) return 0;
  return Math.round((input.discountCents / input.itemSubtotalCents) * 10_000);
}

/**
 * Cómo se cargó un beneficiario, y por lo tanto QUÉ campo es su verdad:
 *  - 'percent' → `percentBps`; el monto se deriva y sigue a la base.
 *  - 'fixed'   → `fixedAmountCents`; el monto está clavado y el % se deriva.
 */
export type CommissionAmountMode = "percent" | "fixed";

/** La parte de un beneficiario que decide su plata. */
export interface RecipientAmount {
  mode: CommissionAmountMode;
  percentBps: number;
  fixedAmountCents?: number | null;
}

/**
 * Los centavos que le tocan a un beneficiario sobre una base dada.
 * En 'fixed' la base NO participa: ese es el punto del modo.
 */
export function effectiveAmountCents(baseCents: number, r: RecipientAmount): number {
  if (r.mode === "fixed") return Math.max(0, Math.round(r.fixedAmountCents ?? 0));
  return recipientAmountCents(baseCents, r.percentBps);
}

/**
 * El % VIVO de un beneficiario sobre la base vigente — lo que mide el cap.
 * Una fila fija sobre base 0 no tiene % determinable (sería infinito): devuelve
 * null, y el cap lo trata como no evaluable en vez de contarlo como 0. Contarlo
 * como 0 dejaría pasar cualquier monto sobre una orden sin base.
 */
export function effectiveBps(baseCents: number, r: RecipientAmount): number | null {
  if (r.mode === "percent") return r.percentBps;
  const fixed = Math.round(r.fixedAmountCents ?? 0);
  if (baseCents <= 0) return fixed > 0 ? null : 0;
  return Math.round((fixed / baseCents) * 10_000);
}

export interface CapCheckInput extends CommissionBaseInput {
  recipients: RecipientAmount[];
  capBps: number;
}

export interface CapCheckResult {
  ok: boolean;
  discountBps: number;
  totalCommissionBps: number;
  combinedBps: number;
  capBps: number;
  /** true = hay una fila fija sobre base 0: el cap no se puede evaluar. */
  undeterminedFixed: boolean;
}

export function checkCombinedCap(input: CapCheckInput): CapCheckResult {
  const discountBps = discountBpsOf(input);
  const baseCents = commissionBaseCents(input);

  let undeterminedFixed = false;
  let totalCommissionBps = 0;
  for (const r of input.recipients) {
    const bps = effectiveBps(baseCents, r);
    if (bps === null) {
      undeterminedFixed = true;
      continue;
    }
    totalCommissionBps += bps;
  }

  const combinedBps = discountBps + totalCommissionBps;
  return {
    ok: !undeterminedFixed && combinedBps <= input.capBps,
    discountBps,
    totalCommissionBps,
    combinedBps,
    capBps: input.capBps,
    undeterminedFixed,
  };
}

export function recipientAmountCents(baseCents: number, percentBps: number): number {
  return Math.round((baseCents * percentBps) / 10_000);
}

export interface RecipientInput extends RecipientAmount {
  customerId?: string;
  qbVendorId?: string;
}

export type RecipientsValidation =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "no_recipients"
        | "too_many_recipients"
        | "invalid_percent"
        | "invalid_fixed_amount"
        | "missing_identity"
        | "duplicate_recipient";
    };

export function validateRecipients(recipients: RecipientInput[]): RecipientsValidation {
  if (recipients.length === 0) return { ok: false, reason: "no_recipients" };
  if (recipients.length > MAX_RECIPIENTS) return { ok: false, reason: "too_many_recipients" };

  const seen = new Set<string>();
  for (const r of recipients) {
    // Cada modo exige SU campo. El del otro modo no se mira, así que un
    // percent_bps de arrastre nunca puede decidir la plata de una fila fija.
    if (r.mode === "fixed") {
      const fixed = r.fixedAmountCents;
      if (!Number.isFinite(fixed ?? NaN) || !Number.isInteger(fixed) || (fixed as number) <= 0) {
        return { ok: false, reason: "invalid_fixed_amount" };
      }
    } else if (!Number.isFinite(r.percentBps) || r.percentBps <= 0) {
      return { ok: false, reason: "invalid_percent" };
    }
    if (!r.customerId && !r.qbVendorId) {
      return { ok: false, reason: "missing_identity" };
    }
    const key = r.customerId ? `c:${r.customerId}` : `v:${r.qbVendorId}`;
    if (seen.has(key)) return { ok: false, reason: "duplicate_recipient" };
    seen.add(key);
  }
  return { ok: true };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Devengo: max(pago completo, PRIMERA factura + waitDays corridos).
 * Falta cualquiera de las dos condiciones → null (todavía no elegible).
 * La espera corre desde la primera factura viva de la orden (2026-09-03,
 * pedido del owner — antes corría desde la última, que la reiniciaba con
 * cada factura parcial nueva).
 */
export function eligibleAt(
  fullyPaidAt: Date | null,
  firstInvoiceAt: Date | null,
  waitDays: number
): Date | null {
  if (!fullyPaidAt || !firstInvoiceAt) return null;
  const invoicePlusWait = new Date(firstInvoiceAt.getTime() + waitDays * DAY_MS);
  return invoicePlusWait.getTime() >= fullyPaidAt.getTime() ? invoicePlusWait : fullyPaidAt;
}
