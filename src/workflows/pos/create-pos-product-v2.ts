import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { createProductsWorkflow } from "@medusajs/medusa/core-flows";

import { syncProductToMeiliSearchWorkflow } from "../sync-product-meilisearch";
import { updateInventoryIncrementalWorkflow } from "../update-inventory-incremental";

import {
  enqueueQbItemsStep,
  QbItemType,
} from "./steps/enqueue-qb-items-step";
import { applyWholesalePricesStep } from "./steps/apply-wholesale-prices-step";
import { linkQbVendorStep } from "./steps/link-qb-vendor-step";

export type CreatePosProductV2VariantInput = {
  sku: string;
  title?: string;
  barcode?: string;
  mpn?: string;
  weight?: number;
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
  variants: CreatePosProductV2VariantInput[];
  currency_code?: string;
};

const VENDOR_QB_ID_PLACEHOLDER = "__NO_VENDOR__";

export const createPosProductV2Workflow = createWorkflow(
  "create-pos-product-v2",
  function (input: CreatePosProductV2Input) {
    const productsInput = transform({ input }, (data) => {
      const i = data.input;
      const currency = (i.currency_code ?? "usd").toLowerCase();
      const manageInventory = i.item_type === "Inventory";
      const sharedMeta = {
        qb_item_type: i.item_type,
        qb_income_account_full_name: i.income_account_full_name ?? null,
        qb_cogs_account_full_name: i.cogs_account_full_name ?? null,
        qb_vendor_full_name: i.vendor_full_name ?? null,
        qb_vendor_list_id: i.vendor_qb_id ?? null,
      };

      const optionTitle = i.option_title ?? "Item";
      const optionValues =
        i.option_values && i.option_values.length > 0
          ? i.option_values
          : i.variants.map(
              (v, idx) => v.options?.[optionTitle] ?? v.title ?? `Variant ${idx + 1}`
            );

      const variants = i.variants.map((v, idx) => {
        const optValue =
          v.options?.[optionTitle] ?? v.title ?? optionValues[idx] ?? v.sku;
        return {
          title: v.title ?? v.sku,
          sku: v.sku,
          barcode: v.barcode,
          weight: v.weight,
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
            qb_override_vendor_full_name:
              v.overrides?.vendor_full_name ?? null,
            qb_override_vendor_qb_id: v.overrides?.vendor_qb_id ?? null,
          },
        };
      });

      return [
        {
          title: i.title,
          description: i.sales_description,
          status: "draft" as const,
          sales_channels: [],
          categories:
            i.category_ids.length > 0
              ? i.category_ids.map((id) => ({ id }))
              : undefined,
          options: [{ title: optionTitle, values: optionValues }],
          variants,
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
        .filter(
          (w) => w.variant_id && w.wholesale_price > 0
        ) as Array<{ variant_id: string; wholesale_price: number }>;
    });

    const currencyCode = transform({ input }, (data) =>
      (data.input.currency_code ?? "usd").toLowerCase()
    );

    applyWholesalePricesStep({
      prices: wholesalePrices,
      currency_code: currencyCode,
    });

    const qbItems = transform({ input, productRef }, (data) => {
      const variants = (data.productRef as any)?.variants ?? [];
      return data.input.variants.map((v, idx) => ({
        variant_id: variants[idx]?.id ?? "",
        sku: v.sku,
        title: v.title ?? v.sku,
        sales_description:
          v.sales_description ?? data.input.sales_description ?? data.input.title,
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
        vendor_full_name:
          v.overrides?.vendor_full_name ?? data.input.vendor_full_name ?? null,
        mpn: v.mpn ?? null,
      }));
    });

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
