import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IProductModuleService } from "@medusajs/types";

export type DeleteProductVariantsStepInput = {
  variant_ids: string[];
};

type SnapshotVariant = {
  id: string;
  product_id: string | null;
  title: string;
  sku: string | null;
};

export type DeleteProductVariantsStepOutput = {
  deleted_variant_ids: string[];
};

export const deleteProductVariantsStep = createStep(
  "delete-product-variants-step",
  async (input: DeleteProductVariantsStepInput, { container }) => {
    if (input.variant_ids.length === 0) {
      return new StepResponse({ deleted_variant_ids: [] }, null);
    }

    const productModule = container.resolve(
      Modules.PRODUCT
    ) as IProductModuleService;
    const query = container.resolve(ContainerRegistrationKeys.QUERY);

    // Snapshot what we're deleting so compensation can recreate them. We only
    // restore the bare bones (title/sku/options/product_id) — re-linking
    // inventory_item / price_set on rollback is out of scope, this step
    // exists to undo the variant delete itself.
    const { data } = await query.graph({
      entity: "product_variant",
      fields: [
        "id",
        "product_id",
        "title",
        "sku",
        "barcode",
        "weight",
        "material",
        "hs_code",
        "origin_country",
        "mid_code",
        "metadata",
        "options.value",
        "options.option.title",
      ],
      filters: { id: input.variant_ids },
    });
    const snapshot = data as Array<SnapshotVariant & Record<string, unknown>>;

    await productModule.deleteProductVariants(input.variant_ids);

    return new StepResponse(
      { deleted_variant_ids: input.variant_ids },
      snapshot
    );
  },
  async (snapshot, { container }) => {
    if (!snapshot || snapshot.length === 0) return;
    const productModule = container.resolve(
      Modules.PRODUCT
    ) as IProductModuleService;

    const restored = snapshot
      .filter((v) => v.product_id)
      .map((v) => {
        const opts: Record<string, string> = {};
        for (const o of (v as any).options ?? []) {
          if (o?.option?.title && typeof o.value === "string") {
            opts[o.option.title] = o.value;
          }
        }
        return {
          product_id: v.product_id!,
          title: v.title,
          sku: v.sku ?? undefined,
          barcode: (v as any).barcode ?? undefined,
          weight: (v as any).weight ?? undefined,
          material: (v as any).material ?? undefined,
          hs_code: (v as any).hs_code ?? undefined,
          origin_country: (v as any).origin_country ?? undefined,
          mid_code: (v as any).mid_code ?? undefined,
          metadata: (v as any).metadata ?? undefined,
          options: opts,
          manage_inventory: false,
        };
      });

    if (restored.length === 0) return;
    await productModule.createProductVariants(restored as any);
  }
);
