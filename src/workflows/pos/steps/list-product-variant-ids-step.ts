import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

export type ListProductVariantIdsInput = {
  product_id: string;
};

export type ListProductVariantIdsOutput = {
  /** All live (non-deleted) variant ids of the product. */
  variant_ids: string[];
};

/**
 * Lists every live variant id of a product. Used by update-pos-product to fan
 * the canonical QB fields (vendor / income / COGS) out to ALL variants — those
 * are product-level facts shared across variants, so an edit must not leave
 * sibling variants with a stale value.
 */
export const listProductVariantIdsStep = createStep(
  "list-product-variant-ids",
  async (
    input: ListProductVariantIdsInput,
    { container }
  ): Promise<StepResponse<ListProductVariantIdsOutput>> => {
    if (!input.product_id) {
      return new StepResponse({ variant_ids: [] });
    }

    const productService = container.resolve(Modules.PRODUCT) as any;
    const variants = await productService.listProductVariants(
      { product_id: input.product_id },
      { select: ["id"] }
    );

    return new StepResponse({
      variant_ids: variants.map((v: { id: string }) => v.id),
    });
  }
);
