import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { updateProductsWorkflow } from "@medusajs/medusa/core-flows";

import { sendToQbStep } from "../qb/send-to-qb-step";
import { applyShippingAttributesStep } from "./steps/apply-shipping-attributes-step";
import { linkQbVendorStep } from "./steps/link-qb-vendor-step";
import { syncProductToMeiliSearchWorkflow } from "../sync-product-meilisearch";

/**
 * Canonical field layout (post mass-sync):
 *   product.metadata
 *     qb_item_type                  (read-only — QB doesn't support change)
 *     qb_income_account_full_name
 *     qb_cogs_account_full_name
 *     qb_vendor_full_name
 *     qb_vendor_list_id
 *   variant.metadata
 *     qb_purchase_cost
 *     mpn
 *     sales_description (duplicated here for legacy POS pickers)
 *     qb_override_*  (optional per-variant overrides)
 */
export type UpdatePosProductInput = {
  readonly id: string;
  readonly variant_id: string;

  // QB identity
  qb_id: string;
  qb_edit_sequence: string;

  // ── Basic (available to pos_user view) ──────────────────────────────────
  title?: string;
  salesDescription?: string;
  sku?: string;
  barcode?: string;
  mpn?: string;
  weight?: number;
  material?: string;
  hs_code?: string;
  country_of_origin?: string;
  mid_code?: string;
  cost?: number;
  /** Legacy flat vendor name (pos_user path only). Admin should use vendor_full_name. */
  vendor?: string;

  // ── Admin-only (canonical QB fields) ────────────────────────────────────
  income_account_full_name?: string;
  cogs_account_full_name?: string;
  vendor_full_name?: string;
  vendor_qb_id?: string;
  category_ids?: string[];
  image_urls?: string[];
  shipping_attributes?: {
    weight_lbs?: number;
    length_in?: number;
    width_in?: number;
    height_in?: number;
  };
};

const pruneUndefined = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  ) as Partial<T>;

export const updatePosProductWorkflow = createWorkflow(
  "update-pos-product",
  function (input: UpdatePosProductInput) {
    // Build the product + variant update payload conditionally so we don't
    // wipe fields the caller didn't include (pos_user submits a subset;
    // admin submits the full form).
    const productsInput = transform({ input }, (data) => {
      const i = data.input;

      const productPatch: Record<string, unknown> = { id: i.id };
      if (i.title !== undefined) productPatch.title = i.title;
      // salesDescription is variant-level only — do NOT write to product.description
      // (doing so would bleed across all other variants via the hydration fallback).
      // category_ids / image_urls: undefined = no change, [] = clear all.
      if (i.category_ids !== undefined) {
        productPatch.categories = i.category_ids.map((id) => ({ id }));
      }
      if (i.image_urls !== undefined) {
        productPatch.thumbnail = i.image_urls[0] ?? null;
        productPatch.images = i.image_urls.map((url) => ({ url }));
      }
      // Product-level canonical QB metadata (only touched if provided).
      const productMetaPatch = pruneUndefined({
        qb_income_account_full_name: i.income_account_full_name,
        qb_cogs_account_full_name: i.cogs_account_full_name,
        qb_vendor_full_name: i.vendor_full_name,
        qb_vendor_list_id: i.vendor_qb_id,
      });
      if (Object.keys(productMetaPatch).length > 0) {
        productPatch.metadata = productMetaPatch;
      }

      const variantPatch: Record<string, unknown> = { id: i.variant_id };
      if (i.sku !== undefined) variantPatch.sku = i.sku;
      if (i.barcode !== undefined) variantPatch.barcode = i.barcode;
      if (i.weight !== undefined) variantPatch.weight = i.weight;
      if (i.material !== undefined) variantPatch.material = i.material;
      if (i.hs_code !== undefined) variantPatch.hs_code = i.hs_code;
      if (i.country_of_origin !== undefined)
        variantPatch.origin_country = i.country_of_origin;
      if (i.mid_code !== undefined) variantPatch.mid_code = i.mid_code;

      // Variant-level metadata — pos_user path writes qb_vendor_name (legacy),
      // admin path is expected to update the canonical product.metadata instead
      // and leave variant.metadata untouched unless overriding explicitly.
      const variantMetaPatch = pruneUndefined({
        qb_purchase_cost: i.cost,
        qb_vendor_name: i.vendor,
        mpn: i.mpn,
        sales_description: i.salesDescription,
      });
      if (Object.keys(variantMetaPatch).length > 0) {
        variantPatch.metadata = variantMetaPatch;
      }

      const productEntry: Record<string, unknown> = { ...productPatch };
      if (Object.keys(variantPatch).length > 1) {
        productEntry.variants = [variantPatch];
      }
      return [productEntry];
    });

    updateProductsWorkflow.runAsStep({
      input: { products: productsInput as any },
    });

    // Shipping dims land on inventory_item — step is a no-op when nothing given.
    const shippingStepInput = transform({ input }, (data) => {
      const attrs = data.input.shipping_attributes ?? {};
      return {
        product_id: data.input.id,
        weight_lbs: attrs.weight_lbs ?? null,
        length_in: attrs.length_in ?? null,
        width_in: attrs.width_in ?? null,
        height_in: attrs.height_in ?? null,
      };
    });
    applyShippingAttributesStep(shippingStepInput);

    // Re-link variant ↔ qb-vendor when admin changes vendor_qb_id. Step no-ops
    // on empty links array.
    const vendorLinkInput = transform({ input }, (data) => {
      const vqb = data.input.vendor_qb_id;
      return {
        links: vqb
          ? [{ variant_id: data.input.variant_id, qb_vendor_id: vqb }]
          : [],
      };
    });
    linkQbVendorStep(vendorLinkInput);

    // Push the modification to QuickBooks Desktop via the bridge. Include every
    // optional ref the bridge knows about — it picks what's present and ignores
    // undefined. PrefVendorRef prefers ListID (stable) over FullName (renamable).
    //
    // Only dispatch to QB when at least one QB-relevant field changed. Fields
    // like image_urls, category_ids, and shipping_attributes do NOT round-trip
    // to QuickBooks, so saving just those should not generate a QBXML op.
    const qbStepInput = transform({ input }, (data) => {
      const i = data.input;
      const hasQbFields =
        i.sku !== undefined ||
        i.salesDescription !== undefined ||
        i.cost !== undefined ||
        i.mpn !== undefined ||
        i.income_account_full_name !== undefined ||
        i.cogs_account_full_name !== undefined ||
        i.vendor_qb_id !== undefined ||
        i.vendor_full_name !== undefined ||
        i.vendor !== undefined;

      return {
        action: "mod" as const,
        skip: !hasQbFields,
        data: {
          ListID: i.qb_id,
          EditSequence: i.qb_edit_sequence,
          Name: i.sku,
          SalesDesc: i.salesDescription,
          PurchaseDesc: i.salesDescription,
          PurchaseCost: i.cost,
          ManufacturerPartNumber: i.mpn || undefined,
          SalesIncomeAccountRef: i.income_account_full_name
            ? { FullName: i.income_account_full_name }
            : undefined,
          COGSAccountRef: i.cogs_account_full_name
            ? { FullName: i.cogs_account_full_name }
            : undefined,
          PrefVendorRef: i.vendor_qb_id
            ? { ListID: i.vendor_qb_id }
            : i.vendor_full_name
              ? { FullName: i.vendor_full_name }
              : i.vendor
                ? { FullName: i.vendor }
                : undefined,
        },
      };
    });

    const qbResponse = sendToQbStep(qbStepInput);

    // Keep the search index honest — cashier sees the change immediately.
    const meiliInput = transform({ input }, (data) => ({
      productId: data.input.id,
    }));
    syncProductToMeiliSearchWorkflow.runAsStep({ input: meiliInput });

    return new WorkflowResponse({
      qbOperationId: qbResponse.operationId,
    });
  }
);
