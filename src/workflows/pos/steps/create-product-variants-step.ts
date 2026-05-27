import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";
import { IProductModuleService } from "@medusajs/types";

export type NewVariantInput = {
  title: string;
  sku: string;
  barcode?: string;
  manage_inventory: boolean;
  allow_backorder?: boolean;
  weight?: number;
  material?: string;
  hs_code?: string;
  origin_country?: string;
  mid_code?: string;
  options?: Record<string, string>;
  metadata?: Record<string, unknown>;
};

export type CreateProductVariantsStepInput = {
  product_id: string;
  variants: NewVariantInput[];
};

export type CreateProductVariantsStepOutput = {
  created_variant_ids: string[];
};

export const createProductVariantsStep = createStep(
  "create-product-variants-step",
  async (input: CreateProductVariantsStepInput, { container }) => {
    if (input.variants.length === 0) {
      return new StepResponse({ created_variant_ids: [] }, null);
    }

    const productModule = container.resolve(
      Modules.PRODUCT
    ) as IProductModuleService;

    const dtos = input.variants.map((v) => ({
      product_id: input.product_id,
      title: v.title,
      sku: v.sku,
      barcode: v.barcode,
      manage_inventory: v.manage_inventory,
      allow_backorder: v.allow_backorder ?? false,
      weight: v.weight,
      material: v.material,
      hs_code: v.hs_code,
      origin_country: v.origin_country,
      mid_code: v.mid_code,
      options: v.options,
      metadata: v.metadata,
    }));

    const created = (await productModule.createProductVariants(
      dtos as any
    )) as unknown as Array<{ id: string }>;
    const createdIds = created.map((v) => v.id);

    return new StepResponse({ created_variant_ids: createdIds }, createdIds);
  },
  async (createdIds, { container }) => {
    if (!createdIds || createdIds.length === 0) return;
    const productModule = container.resolve(
      Modules.PRODUCT
    ) as IProductModuleService;
    await productModule.deleteProductVariants(createdIds);
  }
);
