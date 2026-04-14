import {
  ITaxProvider,
  TaxCalculationContext,
  ItemTaxCalculationLine,
  ShippingTaxCalculationLine,
  ItemTaxLineDTO,
  ShippingTaxLineDTO,
} from "@medusajs/framework/types";

export default class PosTaxProvider implements ITaxProvider {
  static identifier = "pos-tax";

  // The ID of the primary Florida Sales Tax from your Admin panel.
  static FLORIDA_TAX_RATE_ID = "txr_01KHVFFVRFRG3R0DZNPXSWMQB0";

  // The ID of the US Sales Tax (0%) from your Admin panel for Exempts.
  static US_EXEMPT_TAX_RATE_ID = "txr_01KHVFD7C5N2X6ZDFFNVT0Q3N9";

  getIdentifier(): string {
    return PosTaxProvider.identifier;
  }

  async getTaxLines(
    itemLines: ItemTaxCalculationLine[],
    shippingLines: ShippingTaxCalculationLine[],
    context: TaxCalculationContext
  ): Promise<(ItemTaxLineDTO | ShippingTaxLineDTO)[]> {
    console.log(
      "\n[PosTaxProvider] ----------- getTaxLines INVOKED -----------"
    );
    console.log(
      "[PosTaxProvider] Context:",
      JSON.stringify(context.address?.metadata ?? {}, null, 2)
    );

    // 1. Is it Tax Exempt?
    // We look for a custom flag in the context or customer metadata
    const grps = (context.customer?.customer_groups as any[]) || [];
    const isExemptGrp = grps.some(
      (g) =>
        g === "tax-exempt" ||
        g.name === "tax-exempt" ||
        (typeof g === "object" && g.name?.toLowerCase().includes("exempt"))
    );
    const isExempt =
      isExemptGrp || context.address?.metadata?.tax_mode === "exempt";

    console.log("[PosTaxProvider] isExempt evaluated to:", isExempt);

    if (isExempt) {
      // Return 0% lines for everything using the official 0% Tax Rate ID
      let taxLines: (ItemTaxLineDTO | ShippingTaxLineDTO)[] = itemLines.map(
        (l) => ({
          rate_id: PosTaxProvider.US_EXEMPT_TAX_RATE_ID,
          rate: 0,
          name: "Tax Exempt",
          code: "EXEMPT",
          line_item_id: l.line_item.id,
          provider_id: this.getIdentifier(),
        })
      );

      taxLines = taxLines.concat(
        shippingLines.map((l) => ({
          rate_id: PosTaxProvider.US_EXEMPT_TAX_RATE_ID,
          rate: 0,
          name: "Tax Exempt",
          code: "EXEMPT",
          shipping_line_id: l.shipping_line.id,
          provider_id: this.getIdentifier(),
        }))
      );
      return taxLines;
    }

    // 2. Normal Flow - Florida 7%
    const taxLines: (ItemTaxLineDTO | ShippingTaxLineDTO)[] = itemLines.flatMap(
      (l) => {
        return {
          rate_id: PosTaxProvider.FLORIDA_TAX_RATE_ID,
          rate: 7,
          name: "Florida Sales Tax",
          code: "FL",
          line_item_id: l.line_item.id,
          provider_id: this.getIdentifier(),
        };
      }
    );

    /* 
        // Florida Exempts Shipping by law.
        // We omit explicit 0% lines to avoid cluttering the Medusa Admin UI.
        // Medusa will default to $0 tax for shipping if no lines are provided.
        taxLines = taxLines.concat(
            shippingLines.map((l) => ({
                rate_id: PosTaxProvider.FLORIDA_TAX_RATE_ID,
                rate: 0,
                name: "FL-SHIPPING",
                code: "FL-SHIPPING",
                shipping_line_id: l.shipping_line.id,
                provider_id: this.getIdentifier(),
            }))
        )
        */

    return taxLines;
  }
}
