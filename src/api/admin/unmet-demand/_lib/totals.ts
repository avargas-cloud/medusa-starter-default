/**
 * src/api/admin/unmet-demand/_lib/totals.ts
 *
 * Total snapshot math. The frontend may send any combination of lines —
 * backend always recomputes subtotals and totals server-side so analytics
 * columns (requested_total_cents / purchased_total_cents / unmet_value_cents)
 * are always correct.
 */

import type { ItemInput } from "./validators";

export interface NormalizedItem extends ItemInput {
  subtotal_cents: number;
}

export interface RecordTotals {
  requested_total_cents: number;
  purchased_total_cents: number;
  unmet_value_cents: number;
}

export function normalizeItem(input: ItemInput): NormalizedItem {
  return {
    ...input,
    subtotal_cents: input.quantity * input.unit_price_cents,
  };
}

export function computeTotals(items: NormalizedItem[]): RecordTotals {
  let requested_total_cents = 0;
  let purchased_total_cents = 0;
  for (const it of items) {
    if (it.kind === "requested") requested_total_cents += it.subtotal_cents;
    else purchased_total_cents += it.subtotal_cents;
  }
  return {
    requested_total_cents,
    purchased_total_cents,
    unmet_value_cents: requested_total_cents - purchased_total_cents,
  };
}
