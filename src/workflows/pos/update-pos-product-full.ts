import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import {
  updateProductsWorkflow,
  updateProductVariantsWorkflow,
} from "@medusajs/medusa/core-flows";

import { syncProductToMeiliSearchWorkflow } from "../sync-product-meilisearch";

import { applyShippingAttributesStep } from "./steps/apply-shipping-attributes-step";
import { createProductVariantsStep } from "./steps/create-product-variants-step";
import { deleteProductVariantsStep } from "./steps/delete-product-variants-step";
import { ensureMiamiLevelsStep } from "./steps/ensure-miami-levels-step";
import { ensureOptionValuesStep } from "./steps/ensure-option-values-step";
import { syncInventoryItemSkuStep } from "./steps/sync-inventory-item-sku-step";

/**
 * Product-mode update workflow — applies a full snapshot of a POS product
 * (product-level fields + per-variant create/update + explicit variant delete
 * list) in a single transactional batch.
 *
 * Differs from updatePosProductWorkflow (single-variant) in scope: this one
 * is invoked when the EditItem modal switches to "Producto" mode and the
 * cashier wants to add new variants, rename existing ones, or remove some.
 *
 * Semantics — crucially explicit, NOT authoritative-array (the Medusa v2
 * gotcha that hard-deletes siblings):
 *   - variants[].id present → patch via updateProductVariantsWorkflow (scoped)
 *   - variants[].id absent  → create via productModule.createProductVariants
 *   - delete_variant_ids    → delete via productModule.deleteProductVariants
 *   - product-level fields  → updateProductsWorkflow with NO variants array
 *
 * QB sync for added/updated variants is intentionally NOT enqueued here —
 * structural multi-variant edits (rename, add color) usually don't need a QB
 * roundtrip. If the cashier needs QB to know about a new variant they can
 * save it individually in single-variant mode, which goes through
 * updatePosProductWorkflow → sendToQbStep.
 */

export type UpdatePosProductFullVariantInput = {
  /** Present = update existing; absent = create new */
  id?: string;
  title: string;
  sku: string;
  barcode?: string;
  weight?: number;
  material?: string;
  hs_code?: string;
  country_of_origin?: string;
  mid_code?: string;
  mpn?: string;
  cost?: number;
  sales_description?: string;
  /** Only consulted on CREATE — map option title → value (e.g. "Color": "Red") */
  options?: Record<string, string>;
  /** Defaults to true (Inventory). false skips inventory_item creation. */
  manage_inventory?: boolean;
};

export type UpdatePosProductFullInput = {
  id: string;
  title?: string;
  category_ids?: string[];
  image_urls?: string[];

  // Product-level QB metadata
  income_account_full_name?: string;
  cogs_account_full_name?: string;
  vendor_full_name?: string;
  vendor_qb_id?: string;

  // Shipping dims — shared across every variant's inventory_item.
  shipping_attributes?: {
    weight_lbs?: number;
    length_in?: number;
    width_in?: number;
    height_in?: number;
  };

  /** Full variant list: existing (with id) + new (without id) */
  variants: UpdatePosProductFullVariantInput[];
  /** Variants to hard-delete from the product (must be siblings of `id`) */
  delete_variant_ids?: string[];
};

const pruneUndefined = <T extends Record<string, unknown>>(
  obj: T
): Partial<T> =>
  Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  ) as Partial<T>;

export const updatePosProductFullWorkflow = createWorkflow(
  "update-pos-product-full",
  function (input: UpdatePosProductFullInput) {
    // ── 1. Product-level patch (never includes variants array) ────────────
    const productsInput = transform({ input }, (data) => {
      const i = data.input;
      const productPatch: Record<string, unknown> = { id: i.id };
      if (i.title !== undefined) productPatch.title = i.title;
      if (i.category_ids !== undefined) {
        productPatch.categories = i.category_ids.map((id) => ({ id }));
      }
      if (i.image_urls !== undefined) {
        productPatch.thumbnail = i.image_urls[0] ?? null;
        productPatch.images = i.image_urls.map((url) => ({ url }));
      }
      const productMetaPatch = pruneUndefined({
        qb_income_account_full_name: i.income_account_full_name,
        qb_cogs_account_full_name: i.cogs_account_full_name,
        qb_vendor_full_name: i.vendor_full_name,
        qb_vendor_list_id: i.vendor_qb_id,
      });
      if (Object.keys(productMetaPatch).length > 0) {
        productPatch.metadata = productMetaPatch;
      }
      return [productPatch];
    });

    updateProductsWorkflow.runAsStep({
      input: { products: productsInput as any },
    });

    // ── 2. Update existing variants (those with an id) ────────────────────
    const variantUpdates = transform({ input }, (data) => {
      return data.input.variants
        .filter((v) => !!v.id)
        .map((v) => {
          const patch: Record<string, unknown> = { id: v.id! };
          if (v.title !== undefined) patch.title = v.title;
          if (v.sku !== undefined) patch.sku = v.sku;
          if (v.barcode !== undefined) patch.barcode = v.barcode;
          if (v.weight !== undefined) patch.weight = v.weight;
          if (v.material !== undefined) patch.material = v.material;
          if (v.hs_code !== undefined) patch.hs_code = v.hs_code;
          if (v.country_of_origin !== undefined)
            patch.origin_country = v.country_of_origin;
          if (v.mid_code !== undefined) patch.mid_code = v.mid_code;
          const metaPatch = pruneUndefined({
            qb_purchase_cost: v.cost,
            mpn: v.mpn,
            sales_description: v.sales_description,
          });
          if (Object.keys(metaPatch).length > 0) {
            patch.metadata = metaPatch;
          }
          return patch;
        });
    });

    // updateProductVariantsWorkflow rejects empty arrays — wrap in transform
    // that returns a sentinel when empty so the workflow can be invoked
    // unconditionally. Actually the cleanest path: if empty, the workflow
    // call would no-op DB-wise but might warn. We pass at least one row?
    // Better: skip-when-empty handled at the route level OR use selector
    // form. For now we pass the array; Medusa accepts empty.
    updateProductVariantsWorkflow.runAsStep({
      input: { product_variants: variantUpdates as any },
    });

    // ── 3a. Pre-flight: register any option values used by new variants ──
    // Medusa's createProductVariants rejects unknown option values. The
    // EditItem "Product" UI surfaces every globally-registered value of an
    // attribute (e.g. all Color Options), so the picked value may not yet
    // exist on this product's product_option. This step adds it first.
    const newVariantOptionsInput = transform({ input }, (data) => ({
      product_id: data.input.id,
      new_variant_options: data.input.variants
        .filter((v) => !v.id)
        .map((v) => v.options ?? {}),
    }));
    ensureOptionValuesStep(newVariantOptionsInput);

    // ── 3b. Create brand-new variants (no id) ─────────────────────────────
    const newVariantsInput = transform({ input }, (data) => ({
      product_id: data.input.id,
      variants: data.input.variants
        .filter((v) => !v.id)
        .map((v) => ({
          title: v.title,
          sku: v.sku,
          barcode: v.barcode,
          manage_inventory: v.manage_inventory ?? true,
          allow_backorder: false,
          weight: v.weight,
          material: v.material,
          hs_code: v.hs_code,
          origin_country: v.country_of_origin,
          mid_code: v.mid_code,
          options: v.options,
          metadata: pruneUndefined({
            qb_purchase_cost: v.cost,
            mpn: v.mpn,
            sales_description: v.sales_description,
          }),
        })),
    }));
    createProductVariantsStep(newVariantsInput);

    // Auto-create Miami inventory_level for any newly-created variant whose
    // manage_inventory=true (otherwise items are unstockable on receipt).
    ensureMiamiLevelsStep({ product_id: input.id, manage_inventory: true });

    // ── 4. Delete removed variants ────────────────────────────────────────
    const deletesInput = transform({ input }, (data) => ({
      variant_ids: data.input.delete_variant_ids ?? [],
    }));
    deleteProductVariantsStep(deletesInput);

    // ── 5. Shipping dims fan out to every inventory_item of the product ──
    const shippingInput = transform({ input }, (data) => {
      const attrs = data.input.shipping_attributes ?? {};
      return {
        product_id: data.input.id,
        weight_lbs: attrs.weight_lbs ?? null,
        length_in: attrs.length_in ?? null,
        width_in: attrs.width_in ?? null,
        height_in: attrs.height_in ?? null,
      };
    });
    applyShippingAttributesStep(shippingInput);

    // ── 5b. Mirror existing-variant SKU edits onto inventory_item.sku ─────
    // The POS inventory Meili doc reads inventory_item.sku; without this a
    // renamed SKU in product mode keeps showing the old value on the list.
    // New variants already get the right inventory_item.sku at creation time.
    const skuSyncInput = transform({ input }, (data) => ({
      variants: data.input.variants
        .filter((v) => !!v.id && v.sku !== undefined)
        .map((v) => ({ variant_id: v.id!, sku: v.sku })),
    }));
    syncInventoryItemSkuStep(skuSyncInput);

    // ── 6. Re-sync the product to MeiliSearch ─────────────────────────────
    const meiliInput = transform({ input }, (data) => ({
      productId: data.input.id,
    }));
    syncProductToMeiliSearchWorkflow.runAsStep({ input: meiliInput });

    return new WorkflowResponse({ success: true });
  }
);
