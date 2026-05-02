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

  // Raw pg connection (knex) used to read the custom `taxable` column,
  // which lives outside Medusa's MikroORM entity model so the line items
  // passed to getTaxLines do not carry it.
  private pg: any;

  constructor(container: any) {
    try {
      this.pg = container?.__pg_connection__ ?? container?.pg_connection;
    } catch {
      this.pg = undefined;
    }
  }

  getIdentifier(): string {
    return PosTaxProvider.identifier;
  }

  /**
   * Fetches the `taxable` flag for the given line items by id, joining all
   * sales-side tables (order_line_item / pos_invoice_item / pos_credit_memo_item).
   * Falls back to `true` if the row is not found, the column is missing, or
   * the pg connection is not available.
   */
  private async fetchTaxableMap(ids: string[]): Promise<Record<string, boolean>> {
    if (!this.pg || ids.length === 0) return {};
    try {
      const r = await this.pg.raw(
        `SELECT id, taxable FROM (
            SELECT id, taxable FROM order_line_item WHERE id = ANY(?::text[])
            UNION ALL
            SELECT id, taxable FROM pos_invoice_item WHERE id = ANY(?::text[])
            UNION ALL
            SELECT id, taxable FROM pos_credit_memo_item WHERE id = ANY(?::text[])
         ) t`,
        [ids, ids, ids]
      );
      const map: Record<string, boolean> = {};
      for (const row of r.rows ?? []) {
        map[row.id] = row.taxable !== false;
      }
      return map;
    } catch {
      return {};
    }
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

    // 2. Normal Flow - Florida 7% per line, with per-item exemption
    // A line is non-taxable when:
    //   • the DB column line_item.taxable === false (loaded via raw SQL since
    //     MikroORM strips this custom column from the payload), OR
    //   • line_item.taxable === false on the inbound payload (defensive), OR
    //   • line_item.metadata?.taxable === false (POS direct override for custom items)
    // Default = taxable (preserves prior behavior).
    const lineIds = itemLines
      .map((l) => l.line_item?.id)
      .filter((x): x is string => !!x);
    const dbTaxable = await this.fetchTaxableMap(lineIds);

    const taxLines: (ItemTaxLineDTO | ShippingTaxLineDTO)[] = itemLines.map(
      (l) => {
        const li: any = l.line_item;
        const dbFlag = li?.id ? dbTaxable[li.id] : undefined;
        const isLineExempt =
          dbFlag === false ||
          li?.taxable === false ||
          li?.metadata?.taxable === false;

        if (isLineExempt) {
          return {
            rate_id: PosTaxProvider.US_EXEMPT_TAX_RATE_ID,
            rate: 0,
            name: "Non-Taxable",
            code: "EXEMPT",
            line_item_id: l.line_item.id,
            provider_id: this.getIdentifier(),
          };
        }

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
