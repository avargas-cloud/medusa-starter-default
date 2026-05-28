/**
 * Pure helpers for payment-application-rebind subscriber.
 * Kept separate so they are unit-testable without Medusa container setup.
 */

export interface ProrateRatioInputs {
  invoiceTotalCents: number;
  orderTotalCents: number;
  otherInvoicesTotalCents: number;
}

/**
 * Ratio of this invoice against what's still uninvoiced on the order.
 *
 * remaining_capacity = order_total − sum(other non-voided invoices)
 * ratio              = min(1, invoice_total / remaining_capacity)
 *
 * Fallback to 1.0 (full bind) when the ratio is meaningless — e.g. unknown
 * order total, zero invoice total, or remaining capacity already exhausted.
 */
export function computeProrateRatio(inputs: ProrateRatioInputs): number {
  const { invoiceTotalCents, orderTotalCents, otherInvoicesTotalCents } =
    inputs;
  const remaining = Math.max(0, orderTotalCents - otherInvoicesTotalCents);
  if (remaining <= 0 || invoiceTotalCents <= 0) return 1;
  return Math.min(1, invoiceTotalCents / remaining);
}

/**
 * Cents share of an application that should bind to the current invoice.
 * Uses Math.round so two opposite rounds of a partial split do not lose cents.
 */
export function computeProrateShare(
  applicationAmountCents: number,
  ratio: number
): number {
  if (applicationAmountCents <= 0 || ratio <= 0) return 0;
  if (ratio >= 1) return applicationAmountCents;
  return Math.round(applicationAmountCents * ratio);
}
