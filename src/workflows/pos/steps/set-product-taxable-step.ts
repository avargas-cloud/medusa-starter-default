import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

export type SetProductTaxableInput = {
  product_id: string;
  taxable: boolean;
};

/**
 * Sets product.taxable directly via raw SQL since the column is added by
 * a custom migration outside Medusa's entity model. Default for new products
 * is TRUE; this step only needs to write when caller passed an explicit value
 * (the route forwards `taxable` from the POS V2 modal checkbox).
 */
export const setProductTaxableStep = createStep(
  "set-product-taxable",
  async (input: SetProductTaxableInput, { container }) => {
    const pg = container.resolve("__pg_connection__") as any;
    await pg.raw(`UPDATE product SET taxable = ? WHERE id = ?`, [
      input.taxable,
      input.product_id,
    ]);
    return new StepResponse({ product_id: input.product_id, taxable: input.taxable });
  }
);
