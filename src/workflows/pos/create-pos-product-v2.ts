import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { createProductsWorkflow } from "@medusajs/medusa/core-flows";

import { updateProductAttributesWorkflow } from "../product-attributes/update-product-attributes";
import { syncProductToMeiliSearchWorkflow } from "../sync-product-meilisearch";
import { updateInventoryIncrementalWorkflow } from "../update-inventory-incremental";

import { applyShippingAttributesStep } from "./steps/apply-shipping-attributes-step";
import { applyWholesalePricesStep } from "./steps/apply-wholesale-prices-step";
import { enqueueQbItemsStep, QbItemType } from "./steps/enqueue-qb-items-step";
import { linkQbVendorStep } from "./steps/link-qb-vendor-step";
import { resolveQbVendorListIdStep } from "./steps/resolve-qb-vendor-list-id-step";
import { setProductTaxableStep } from "./steps/set-product-taxable-step";

export type CreatePosProductV2VariantInput = {
  sku: string;
  title?: string;
  barcode?: string;
  mpn?: string;
  material?: string;
  hs_code?: string;
  country_of_origin?: string;
  mid_code?: string;
  cost: number;
  retail_price: number;
  wholesale_price?: number;
  sales_description?: string;
  options?: Record<string, string>;
  overrides?: {
    cogs_account_full_name?: string;
    income_account_full_name?: string;
    vendor_full_name?: string;
    vendor_qb_id?: string;
  };
};

/**
 * Shipping Attributes panel in the admin stores weight/length/width/height
 * directly on inventory_item (lbs and inches — UPS rate quote units).
 * These values are shared across all variants of a product, so they live
 * at the root level of the input and fan out to each variant's auto-created
 * inventory_item after createProductsWorkflow runs.
 */
export type ShippingAttributes = {
  weight_lbs?: number;
  length_in?: number;
  width_in?: number;
  height_in?: number;
};

export type CreatePosProductV2Input = {
  item_type: QbItemType;
  title: string;
  sales_description: string;
  category_ids: string[];
  option_title?: string;
  option_values?: string[];
  cogs_account_full_name?: string;
  income_account_full_name?: string;
  vendor_full_name?: string;
  vendor_qb_id?: string;
  /** Default true. False marks the product non-taxable across all order line items (services / labor). */
  taxable?: boolean;
  variants: CreatePosProductV2VariantInput[];
  currency_code?: string;
  /** MinIO URLs from POST /admin/uploads. First entry becomes the thumbnail. */
  image_urls?: string[];
  /** Shared across every variant's inventory_item for UPS rate quotes. */
  shipping_attributes?: ShippingAttributes;
  /**
   * Product-attributes module link — when the POS picks an attribute
   * (e.g. Color Options) and enables values (3000K, 4000K), we pass the
   * attribute_key id + selected attribute_value ids here so the backend can
   * link them through the product-attributes module and mark the attribute
   * as "variant" (shows the purple Variant badge in admin).
   */
  product_attribute?: {
    attribute_key_id: string;
    attribute_value_ids: string[];
  };
};

const VENDOR_QB_ID_PLACEHOLDER = "__NO_VENDOR__";

export const createPosProductV2Workflow = createWorkflow(
  "create-pos-product-v2",
  function (input: CreatePosProductV2Input) {
    // Resolve internal qb_vendor.id values → actual QB Desktop ListIDs before
    // building the product payload. Passing the internal Medusa ID as ListID
    // causes QB Error 3000 (invalid object ID).
    const vendorIdsForResolution = transform({ input }, (data) => ({
      vendor_qb_ids: [
        data.input.vendor_qb_id ?? null,
        ...data.input.variants.map((v) => v.overrides?.vendor_qb_id ?? null),
      ],
    }));
    const resolvedVendors = resolveQbVendorListIdStep(vendorIdsForResolution);

    const productsInput = transform({ input, resolvedVendors }, (data) => {
      const i = data.input;
      const currency = (i.currency_code ?? "usd").toLowerCase();
      const manageInventory = i.item_type === "Inventory";
      const globalListId =
        i.vendor_qb_id != null
          ? (data.resolvedVendors.listIdByVendorId[i.vendor_qb_id] ?? null)
          : null;
      const sharedMeta = {
        qb_item_type: i.item_type,
        qb_income_account_full_name: i.income_account_full_name ?? null,
        qb_cogs_account_full_name: i.cogs_account_full_name ?? null,
        qb_vendor_full_name: i.vendor_full_name ?? null,
        qb_vendor_list_id: globalListId,
      };

      // Prefer explicit option_title; otherwise infer from the first variant's
      // options keys so the product shows e.g. "Color Options" → [3000K, 4000K]
      // instead of the generic "Item" fallback when the POS picks an attribute.
      const inferredTitle =
        i.option_title ??
        (i.variants[0]?.options
          ? Object.keys(i.variants[0].options)[0]
          : undefined) ??
        "Item";
      const optionTitle = inferredTitle;

      const optionValues = (() => {
        if (i.option_values && i.option_values.length > 0)
          return i.option_values;
        // Dedupe values coming from variants to avoid duplicate entries when
        // multiple variants share the same option value.
        const fromVariants = i.variants
          .map((v) => v.options?.[optionTitle])
          .filter((x): x is string => !!x);
        if (fromVariants.length > 0) return Array.from(new Set(fromVariants));
        // Single-product fallback — synthesize one value per variant.
        return i.variants.map((v, idx) => v.title ?? `Variant ${idx + 1}`);
      })();

      const variants = i.variants.map((v, idx) => {
        const optValue =
          v.options?.[optionTitle] ?? v.title ?? optionValues[idx] ?? v.sku;
        return {
          title: v.title ?? v.sku,
          sku: v.sku,
          // Coerce blank barcode to undefined → Medusa stores NULL. The unique
          // partial index IDX_product_variant_barcode_unique allows many NULLs
          // but only ONE empty string "", so an empty "" from the form would
          // collide with any prior barcode-less variant ("barcode already exists").
          barcode: v.barcode?.trim() || undefined,
          material: v.material,
          hs_code: v.hs_code,
          origin_country: v.country_of_origin,
          mid_code: v.mid_code,
          manage_inventory: manageInventory,
          options: { [optionTitle]: optValue },
          prices: [
            {
              amount: v.retail_price,
              currency_code: currency,
            },
          ],
          metadata: {
            ...sharedMeta,
            sales_description:
              v.sales_description ?? i.sales_description ?? i.title,
            qb_purchase_cost: v.cost,
            qb_retail_price: v.retail_price,
            qb_wholesale_price: v.wholesale_price ?? null,
            mpn: v.mpn ?? null,
            qb_override_cogs_account:
              v.overrides?.cogs_account_full_name ?? null,
            qb_override_income_account:
              v.overrides?.income_account_full_name ?? null,
            qb_override_vendor_full_name: v.overrides?.vendor_full_name ?? null,
            qb_override_vendor_qb_id: v.overrides?.vendor_qb_id ?? null,
          },
        };
      });

      const imageUrls = (i.image_urls ?? []).filter(
        (u): u is string => typeof u === "string" && u.trim().length > 0
      );

      // Medusa enforces a unique product.handle. Titles like "TEST" collide
      // quickly across POS-created products, so we slugify the title and append
      // a short random suffix to guarantee uniqueness without forcing the
      // cashier to invent distinct titles.
      const slugBase =
        i.title
          .toLowerCase()
          .trim()
          .replace(/['"]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60) || "product";
      const suffix = Math.random().toString(36).slice(2, 6);
      const handle = `${slugBase}-${suffix}`;

      return [
        {
          title: i.title,
          handle,
          description: i.sales_description,
          status: "draft" as const,
          sales_channels: [],
          categories:
            i.category_ids.length > 0
              ? i.category_ids.map((id) => ({ id }))
              : undefined,
          options: [{ title: optionTitle, values: optionValues }],
          variants,
          thumbnail: imageUrls[0],
          images:
            imageUrls.length > 0
              ? imageUrls.map((url) => ({ url }))
              : undefined,
        },
      ];
    });

    const products = createProductsWorkflow.runAsStep({
      input: { products: productsInput },
    });

    const productRef = transform({ products }, (data) => data.products[0]);

    const wholesalePrices = transform({ input, productRef }, (data) => {
      const variants = (data.productRef as any)?.variants ?? [];
      return data.input.variants
        .map((v, idx) => ({
          variant_id: variants[idx]?.id,
          wholesale_price: v.wholesale_price ?? 0,
        }))
        .filter((w) => w.variant_id && w.wholesale_price > 0) as Array<{
        variant_id: string;
        wholesale_price: number;
      }>;
    });

    const currencyCode = transform({ input }, (data) =>
      (data.input.currency_code ?? "usd").toLowerCase()
    );

    applyWholesalePricesStep({
      prices: wholesalePrices,
      currency_code: currencyCode,
    });

    const qbItems = transform(
      { input, productRef, resolvedVendors },
      (data) => {
        const variants = (data.productRef as any)?.variants ?? [];
        return data.input.variants.map((v, idx) => {
          const vendorQbId =
            v.overrides?.vendor_qb_id ?? data.input.vendor_qb_id ?? null;
          const vendorListId =
            vendorQbId != null
              ? (data.resolvedVendors.listIdByVendorId[vendorQbId] ?? null)
              : null;
          return {
            variant_id: variants[idx]?.id ?? "",
            sku: v.sku,
            title: v.title ?? v.sku,
            sales_description:
              v.sales_description ??
              data.input.sales_description ??
              data.input.title,
            cost: v.cost,
            retail_price: v.retail_price,
            item_type: data.input.item_type,
            cogs_account_full_name:
              v.overrides?.cogs_account_full_name ??
              data.input.cogs_account_full_name ??
              null,
            income_account_full_name:
              v.overrides?.income_account_full_name ??
              data.input.income_account_full_name ??
              null,
            vendor_list_id: vendorListId,
            vendor_full_name:
              v.overrides?.vendor_full_name ??
              data.input.vendor_full_name ??
              null,
            mpn: v.mpn ?? null,
          };
        });
      }
    );

    const qbEnqueue = enqueueQbItemsStep({ items: qbItems });

    const vendorLinks = transform({ input, productRef }, (data) => {
      const variants = (data.productRef as any)?.variants ?? [];
      return data.input.variants
        .map((v, idx) => ({
          variant_id: variants[idx]?.id,
          qb_vendor_id:
            v.overrides?.vendor_qb_id ??
            data.input.vendor_qb_id ??
            VENDOR_QB_ID_PLACEHOLDER,
        }))
        .filter(
          (l) => l.variant_id && l.qb_vendor_id !== VENDOR_QB_ID_PLACEHOLDER
        ) as Array<{ variant_id: string; qb_vendor_id: string }>;
    });

    linkQbVendorStep({ links: vendorLinks });

    // Link attribute values + mark as "Variant" — mirrors the admin's
    // "Manage Product Attributes" modal (Save button). Empty attribute_value_ids
    // or no attribute_key_id = single product, we skip the call.
    const productAttributesInput = transform({ input, productRef }, (data) => {
      const pa = data.input.product_attribute;
      return {
        productId: (data.productRef as any)?.id as string,
        valueIds: pa?.attribute_value_ids ?? [],
        variantKeys: pa?.attribute_key_id ? [pa.attribute_key_id] : [],
      };
    });
    updateProductAttributesWorkflow.runAsStep({
      input: productAttributesInput,
    });

    // Write UPS shipping attrs (lbs, inches) onto each variant's inventory_item —
    // same columns the admin "Shipping Attributes" widget uses. Values are shared
    // at the product level because variants of one product usually ship identically.
    const shippingStepInput = transform({ input, productRef }, (data) => {
      const attrs = data.input.shipping_attributes ?? {};
      return {
        product_id: (data.productRef as any)?.id as string,
        weight_lbs: attrs.weight_lbs ?? null,
        length_in: attrs.length_in ?? null,
        width_in: attrs.width_in ?? null,
        height_in: attrs.height_in ?? null,
      };
    });
    applyShippingAttributesStep(shippingStepInput);

    // Persist the per-product tax flag (default TRUE; non-taxable products skip FL 7%).
    const taxableStepInput = transform({ input, productRef }, (data) => ({
      product_id: (data.productRef as any)?.id as string,
      taxable: data.input.taxable !== false,
    }));
    setProductTaxableStep(taxableStepInput);

    // Meilisearch indexes must reflect the new product immediately so the cashier
    // can find it in Load Template / product search right after creation. The QB
    // item poller will re-sync on ListID resolution (see qb-item-pipeline-poller).
    const meiliInput = transform({ productRef }, (data) => ({
      productId: (data.productRef as any)?.id as string,
    }));
    syncProductToMeiliSearchWorkflow.runAsStep({ input: meiliInput });
    updateInventoryIncrementalWorkflow.runAsStep({ input: meiliInput });

    return new WorkflowResponse({
      product: productRef,
      pipeline: qbEnqueue.results,
    });
  }
);
