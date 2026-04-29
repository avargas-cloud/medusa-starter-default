/**
 * Pure landed-cost calculation engine — same math as the vendor-bill confirm
 * route. Lives here standalone so the Landing Cost module can use it without
 * touching the purchase-orders module.
 *
 * - Commission (percent) is per-unit cost × rate
 * - Commission (fixed)   is total ÷ totalQty
 * - Freight is CBM-distributed (cbm_per_unit × qty / totalCbm)
 * - Tariff  is cost-distributed (unit_cost × qty / totalCost)
 */

export interface LandingCostHeader {
  commission_mode: "percent" | "fixed";
  commission_rate_bps: number;
  commission_amount_cents: number;
  freight_included: boolean;
  freight_amount_cents: number;
  tariff_included: boolean;
  tariff_amount_cents: number;
}

export interface LineInput {
  id: string;
  qty: number;
  unit_cost_cents: number;
  cbm_per_unit: number | null;
}

export interface LineBreakdown {
  id: string;
  commission_per_unit_cents: number;
  freight_per_unit_cents: number;
  tariff_per_unit_cents: number;
  landed_unit_cost_cents: number;
}

export function computeLandedCosts(
  header: LandingCostHeader,
  lines: LineInput[]
): LineBreakdown[] {
  let totalCbm = 0;
  let totalSubtotalCents = 0;
  let totalQty = 0;

  for (const line of lines) {
    if (line.cbm_per_unit != null) {
      totalCbm += line.cbm_per_unit * line.qty;
    }
    totalSubtotalCents += line.unit_cost_cents * line.qty;
    totalQty += line.qty;
  }

  const freightCents = header.freight_included ? header.freight_amount_cents : 0;
  const tariffCents = header.tariff_included ? header.tariff_amount_cents : 0;

  return lines.map((line) => {
    let commissionPerUnit = 0;
    if (header.commission_mode === "percent") {
      commissionPerUnit = Math.round(
        (line.unit_cost_cents * header.commission_rate_bps) / 10_000
      );
    } else {
      commissionPerUnit =
        totalQty > 0 ? Math.round(header.commission_amount_cents / totalQty) : 0;
    }

    const freightPerUnit =
      totalCbm > 0 && line.cbm_per_unit != null
        ? Math.round((line.cbm_per_unit / totalCbm) * freightCents)
        : 0;

    const tariffPerUnit =
      totalSubtotalCents > 0
        ? Math.round((line.unit_cost_cents / totalSubtotalCents) * tariffCents)
        : 0;

    const landed =
      line.unit_cost_cents +
      commissionPerUnit +
      freightPerUnit +
      tariffPerUnit;

    return {
      id: line.id,
      commission_per_unit_cents: commissionPerUnit,
      freight_per_unit_cents: freightPerUnit,
      tariff_per_unit_cents: tariffPerUnit,
      landed_unit_cost_cents: landed,
    };
  });
}
