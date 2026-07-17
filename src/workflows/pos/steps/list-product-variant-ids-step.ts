import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

export type ListProductVariantIdsInput = {
  product_id: string;
};

export type ListProductVariantIdsOutput = {
  /** All live (non-deleted) variant ids of the product. */
  variant_ids: string[];
  /**
   * Current metadata of every live variant, keyed by id. Needed because
   * `upsertProductVariants` REPLACES the metadata JSONB column (it does NOT
   * deep-merge like the product-level upsert does) — so any partial metadata
   * write must first hydrate the existing value or it silently wipes the
   * variant's other keys (quickbooks_id, cost, vendor, sales_description…).
   */
  variants: Array<{ id: string; metadata: Record<string, unknown> }>;
};

/**
 * Lists every live variant of a product (id + metadata). Used by
 * update-pos-product to (a) fan the canonical QB fields (vendor / income /
 * COGS) out to ALL variants, and (b) hydrate existing variant metadata before
 * writing, since the variant upsert replaces rather than merges the column.
 */
export const listProductVariantIdsStep = createStep(
  "list-product-variant-ids",
  async (
    input: ListProductVariantIdsInput,
    { container }
  ): Promise<StepResponse<ListProductVariantIdsOutput>> => {
    if (!input.product_id) {
      return new StepResponse({ variant_ids: [], variants: [] });
    }

    const productService = container.resolve(Modules.PRODUCT) as any;
    const variants = await productService.listProductVariants(
      { product_id: input.product_id },
      { select: ["id", "metadata"] }
    );

    return new StepResponse({
      variant_ids: variants.map((v: { id: string }) => v.id),
      variants: variants.map((v: { id: string; metadata?: Record<string, unknown> }) => ({
        id: v.id,
        metadata: v.metadata ?? {},
      })),
    });
  }
);
