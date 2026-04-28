import type { DraftLineInput } from "./validators";

export interface NormalizedFoLine extends DraftLineInput {
  total_cents: number;
}

export interface FoTotals {
  subtotal_cents: number;
  tax_cents: number;
  shipping_cents: number;
  other_fees_cents: number;
  total_cents: number;
  total_units_ordered: number;
  total_lines: number;
}

export function normalizeLine(line: DraftLineInput): NormalizedFoLine {
  const subtotal = line.qty_ordered * line.unit_cost_cents;
  const total = subtotal + (line.tax_cents ?? 0);
  return { ...line, total_cents: total };
}

export function computeTotals(
  lines: NormalizedFoLine[],
  extras: {
    shipping_cents?: number;
    tax_cents?: number;
    other_fees_cents?: number;
  }
): FoTotals {
  let subtotal = 0;
  let lineTax = 0;
  let totalUnits = 0;
  for (const l of lines) {
    subtotal += l.qty_ordered * l.unit_cost_cents;
    lineTax += l.tax_cents ?? 0;
    totalUnits += l.qty_ordered;
  }
  const tax = (extras.tax_cents ?? 0) + lineTax;
  const shipping = extras.shipping_cents ?? 0;
  const other = extras.other_fees_cents ?? 0;
  return {
    subtotal_cents: subtotal,
    tax_cents: tax,
    shipping_cents: shipping,
    other_fees_cents: other,
    total_cents: subtotal + tax + shipping + other,
    total_units_ordered: totalUnits,
    total_lines: lines.length,
  };
}
