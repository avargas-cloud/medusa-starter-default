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

export interface CapCheckInput extends CommissionBaseInput {
  recipientPercentsBps: number[];
  capBps: number;
}

export interface CapCheckResult {
  ok: boolean;
  discountBps: number;
  totalCommissionBps: number;
  combinedBps: number;
  capBps: number;
}

export function checkCombinedCap(input: CapCheckInput): CapCheckResult {
  const discountBps = discountBpsOf(input);
  const totalCommissionBps = input.recipientPercentsBps.reduce((acc, bps) => acc + bps, 0);
  const combinedBps = discountBps + totalCommissionBps;
  return {
    ok: combinedBps <= input.capBps,
    discountBps,
    totalCommissionBps,
    combinedBps,
    capBps: input.capBps,
  };
}

export function recipientAmountCents(baseCents: number, percentBps: number): number {
  return Math.round((baseCents * percentBps) / 10_000);
}

export interface RecipientInput {
  customerId?: string;
  qbVendorId?: string;
  percentBps: number;
}

export type RecipientsValidation =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "no_recipients"
        | "too_many_recipients"
        | "invalid_percent"
        | "missing_identity"
        | "duplicate_recipient";
    };

export function validateRecipients(recipients: RecipientInput[]): RecipientsValidation {
  if (recipients.length === 0) return { ok: false, reason: "no_recipients" };
  if (recipients.length > MAX_RECIPIENTS) return { ok: false, reason: "too_many_recipients" };

  const seen = new Set<string>();
  for (const r of recipients) {
    if (!Number.isFinite(r.percentBps) || r.percentBps <= 0) {
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
 * Devengo: max(pago completo, última factura + waitDays corridos).
 * Falta cualquiera de las dos condiciones → null (todavía no elegible).
 */
export function eligibleAt(
  fullyPaidAt: Date | null,
  lastInvoiceAt: Date | null,
  waitDays: number
): Date | null {
  if (!fullyPaidAt || !lastInvoiceAt) return null;
  const invoicePlusWait = new Date(lastInvoiceAt.getTime() + waitDays * DAY_MS);
  return invoicePlusWait.getTime() >= fullyPaidAt.getTime() ? invoicePlusWait : fullyPaidAt;
}
