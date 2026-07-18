import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import {
  updateProductsWorkflow,
  updateProductVariantsWorkflow,
} from "@medusajs/medusa/core-flows";

import { sendToQbStep, type QbItemType } from "../qb/send-to-qb-step";
import { syncProductToMeiliSearchWorkflow } from "../sync-product-meilisearch";
import { buildPrefVendorRef } from "../../lib/quickbooks/pref-vendor-ref";

import { applyShippingAttributesStep } from "./steps/apply-shipping-attributes-step";
import { linkQbVendorStep } from "./steps/link-qb-vendor-step";
import { listProductVariantIdsStep } from "./steps/list-product-variant-ids-step";
import { resolveQbVendorListIdStep } from "./steps/resolve-qb-vendor-list-id-step";
import { syncInventoryItemSkuStep } from "./steps/sync-inventory-item-sku-step";

/**
 * Canonical field layout (post mass-sync):
 *   product.metadata
 *     qb_item_type                  (read-only — QB doesn't support change)
 *     qb_income_account_full_name
 *     qb_cogs_account_full_name
 *     qb_vendor_full_name
 *     qb_vendor_list_id
 *   variant.metadata
 *     purchase_cost
 *     mpn
 *     sales_description (duplicated here for legacy POS pickers)
 *     qb_override_*  (optional per-variant overrides)
 */
export type UpdatePosProductInput = {
  readonly id: string;
  readonly variant_id: string;

  // QB identity. Absent when the product was created in Medusa but never synced
  // to QuickBooks (e.g. the create-time QB add failed). In that case the edit is
  // dispatched as a first-time "add" instead of a "mod".
  qb_id?: string;
  qb_edit_sequence?: string;

  // item_type only matters for a first-time "add" (the route hydrates it from
  // variant.metadata when qb_id is missing). retail_price is sent on BOTH add
  // and mod so QB's SalesPrice stays in sync with the POS edit modal.
  item_type?: QbItemType;
  retail_price?: number;

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
  /** Product Source: true = CHINA (sourced via agent), false = USA. Product-level (is_sourced_via_agent). */
  is_sourced_via_agent?: boolean;
  /** true when set through the PIN-gated toggle — bulk-set-sourcing-agent skips these. */
  is_sourced_via_agent_manual?: boolean;
  /**
   * Discontinued lifecycle flag. VARIANT-level (product_variant.metadata.discontinued).
   * Purely a display/merchandising signal: the Inventory & Inventory China lists hide
   * discontinued items by default. NOT sent to QuickBooks (no QB field mirrors it).
   */
  discontinued?: boolean;
  category_ids?: string[];
  image_urls?: string[];
  shipping_attributes?: {
    weight_lbs?: number;
    length_in?: number;
    width_in?: number;
    height_in?: number;
  };
};

const pruneUndefined = <T extends Record<string, unknown>>(
  obj: T
): Partial<T> =>
  Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  ) as Partial<T>;

/**
 * Pure builder for the QuickBooks step payload from a POS product edit.
 * Extracted (and exported) so the add/mod shape — especially SalesPrice
 * handling — is unit-testable without running the whole workflow.
 *
 * No `qb_id` → the item was never created in QB, so build a first-time "add"
 * (a "mod" would 400 on a missing ListID). Otherwise build a "mod".
 *
 * SalesPrice: the POS edit modal always carries the price, so send it on a mod
 * whenever `retail_price` is present (including an explicit 0). When it's
 * undefined the key drops out and the bridge omits it, leaving QB's price
 * untouched — we must NEVER coerce it to 0 here (that zeroed real prices during
 * the qb-item-pipeline retry loop).
 */
export const buildQbStepInput = (i: UpdatePosProductInput) => {
  // PrefVendorRef prefers ListID (stable) over FullName (renamable) — shared by
  // both add and mod. buildPrefVendorRef guards against ever sending an internal
  // qb_vendor.id as a ListID (QB Error 3000); it falls back to FullName.
  const prefVendorRef = buildPrefVendorRef({
    vendorIdOrListId: i.vendor_qb_id,
    vendorFullName: i.vendor_full_name ?? i.vendor,
  });

  if (!i.qb_id) {
    const itemType: QbItemType = i.item_type ?? "Inventory";
    const addData: Record<string, unknown> = {
      Name: i.sku,
      SalesDesc: i.salesDescription,
      SalesPrice: i.retail_price ?? 0,
      ItemType: itemType,
    };
    if (i.mpn) addData.ManufacturerPartNumber = i.mpn;
    if (prefVendorRef) addData.PrefVendorRef = prefVendorRef;
    if (i.income_account_full_name)
      addData.IncomeAccountRef = { FullName: i.income_account_full_name };
    if (itemType === "Inventory") {
      addData.PurchaseDesc = i.salesDescription;
      addData.PurchaseCost = i.cost ?? 0;
      if (i.cogs_account_full_name)
        addData.COGSAccountRef = { FullName: i.cogs_account_full_name };
    } else if ((i.cost ?? 0) > 0) {
      addData.PurchaseDesc = i.salesDescription;
      addData.PurchaseCost = i.cost ?? 0;
      if (i.cogs_account_full_name)
        addData.ExpenseAccountRef = { FullName: i.cogs_account_full_name };
    }

    return {
      action: "add" as const,
      // Never skip — the whole point is that the item is missing from QB.
      skip: false,
      pipeline: {
        variant_id: i.variant_id,
        sku: i.sku ?? "",
        item_type: itemType,
      },
      data: addData,
    };
  }

  const hasQbFields =
    i.sku !== undefined ||
    i.salesDescription !== undefined ||
    i.retail_price !== undefined ||
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
    pipeline: {
      variant_id: i.variant_id,
      sku: i.sku ?? "",
      item_type: "Inventory" as const,
    },
    data: {
      ListID: i.qb_id,
      EditSequence: i.qb_edit_sequence,
      Name: i.sku,
      SalesDesc: i.salesDescription,
      SalesPrice: i.retail_price,
      PurchaseDesc: i.salesDescription,
      PurchaseCost: i.cost,
      ManufacturerPartNumber: i.mpn || undefined,
      SalesIncomeAccountRef: i.income_account_full_name
        ? { FullName: i.income_account_full_name }
        : undefined,
      COGSAccountRef: i.cogs_account_full_name
        ? { FullName: i.cogs_account_full_name }
        : undefined,
      PrefVendorRef: prefVendorRef,
    },
  };
};

export const updatePosProductWorkflow = createWorkflow(
  "update-pos-product",
  function (input: UpdatePosProductInput) {
    // Resolve the internal qb_vendor.id → real QB Desktop ListID so the value we
    // persist matches create-pos-product-v2 and mass-metadata-sync (the raw
    // qbvnd_ id must NEVER land in qb_vendor_list_id — it isn't the canonical
    // ListID other readers expect, and QB rejects it as a PrefVendorRef).
    const vendorResolveInput = transform({ input }, (data) => ({
      vendor_qb_ids: [data.input.vendor_qb_id ?? null],
    }));
    const resolvedVendors = resolveQbVendorListIdStep(vendorResolveInput);

    // Vendor / income / COGS are PRODUCT-level facts shared by every variant, so
    // an edit fans them out to ALL variants (not just the edited one) — otherwise
    // a sibling keeps a stale value that the re-add hydration path would read back.
    const variantListInput = transform({ input }, (data) => ({
      product_id: data.input.id,
    }));
    const allVariants = listProductVariantIdsStep(variantListInput);

    // Shared canonical QB metadata — only the keys actually provided in the edit.
    // qb_vendor_list_id carries the RESOLVED ListID (null when the vendor has no QB
    // ListID yet), never the internal id.
    const canonicalMeta = transform({ input, resolvedVendors }, (data) => {
      const i = data.input;
      // vendor_qb_id may be an internal qb_vendor.id (user picked a vendor →
      // resolve to its ListID) OR an already-resolved QB ListID (the route
      // hydrates qb_vendor_list_id from existing metadata when the edit didn't
      // change the vendor). Only internal ids (qbvnd_…) need resolving; a ListID
      // passes through as-is so an unrelated edit never wipes the vendor.
      const resolvedListId =
        i.vendor_qb_id != null
          ? i.vendor_qb_id.startsWith("qbvnd_")
            ? (data.resolvedVendors.listIdByVendorId[i.vendor_qb_id] ?? null)
            : i.vendor_qb_id
          : undefined;
      return pruneUndefined({
        qb_income_account_full_name: i.income_account_full_name,
        qb_cogs_account_full_name: i.cogs_account_full_name,
        qb_vendor_full_name: i.vendor_full_name,
        qb_vendor_list_id:
          i.vendor_qb_id !== undefined ? resolvedListId : undefined,
      });
    });

    // Build product-level and variant-level patches independently. They go to
    // SEPARATE workflows: passing a `variants` array to updateProductsWorkflow
    // is interpreted as the authoritative variant SET (siblings get hard-
    // deleted). updateProductVariantsWorkflow is scoped to the listed variants
    // and never touches siblings — that's the safe path for per-variant edits.
    const productsInput = transform({ input, canonicalMeta }, (data) => {
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
      // is_sourced_via_agent (Product Source) is PRODUCT-only — it rides the
      // product patch, NOT the variant fan-out (canonicalMeta), because every
      // China reader reads p.metadata. Only written when the edit sent it.
      const productMeta = pruneUndefined({
        ...data.canonicalMeta,
        is_sourced_via_agent: i.is_sourced_via_agent,
        is_sourced_via_agent_manual: i.is_sourced_via_agent_manual,
      });
      if (Object.keys(productMeta).length > 0) {
        productPatch.metadata = productMeta;
      }
      return [productPatch];
    });

    const variantsInput = transform(
      { input, canonicalMeta, allVariants },
      (data) => {
        const i = data.input;
        const canonical = data.canonicalMeta;
        const hasCanonical = Object.keys(canonical).length > 0;

        // upsertProductVariants REPLACES the metadata JSONB (unlike the product
        // upsert, which merges) — so every partial write must be layered on top
        // of the variant's CURRENT metadata or it wipes the other keys
        // (quickbooks_id, cost, vendor, sales_description, …). Hydrate here.
        const metaById = new Map(
          data.allVariants.variants.map((v) => [v.id, v.metadata ?? {}])
        );

        // Edited variant: its own per-variant fields (cost/mpn/sku/sales_desc are
        // variant-specific) PLUS the shared canonical fields.
        const editedVariantMeta = pruneUndefined({
          purchase_cost: i.cost,
          qb_vendor_name: i.vendor,
          mpn: i.mpn,
          sales_description: i.salesDescription,
          // Variant-level lifecycle flag (never fanned out to siblings; each
          // variant can be discontinued independently). false is a legitimate
          // "reactivate" write, so it must survive pruneUndefined (it does).
          discontinued: i.discontinued,
          ...canonical,
        });
        const editedPatch: Record<string, unknown> = { id: i.variant_id };
        if (i.sku !== undefined) editedPatch.sku = i.sku;
        if (i.barcode !== undefined) editedPatch.barcode = i.barcode;
        if (i.weight !== undefined) editedPatch.weight = i.weight;
        if (i.material !== undefined) editedPatch.material = i.material;
        if (i.hs_code !== undefined) editedPatch.hs_code = i.hs_code;
        if (i.country_of_origin !== undefined)
          editedPatch.origin_country = i.country_of_origin;
        if (i.mid_code !== undefined) editedPatch.mid_code = i.mid_code;
        if (Object.keys(editedVariantMeta).length > 0) {
          // Layer the changed keys on top of the CURRENT metadata (the upsert
          // replaces, so we must send the full merged object).
          editedPatch.metadata = {
            ...(metaById.get(i.variant_id as string) ?? {}),
            ...editedVariantMeta,
          };
        }

        const patches: Array<Record<string, unknown>> = [editedPatch];

        // Sibling variants: the shared canonical fields layered on top of each
        // sibling's existing metadata (again, the upsert replaces — sending only
        // `canonical` would wipe the sibling's own cost/mpn/sales_description).
        // Skipped entirely when the edit didn't touch a canonical field.
        if (hasCanonical) {
          for (const vid of data.allVariants.variant_ids) {
            if (vid === i.variant_id) continue;
            patches.push({
              id: vid,
              metadata: { ...(metaById.get(vid) ?? {}), ...canonical },
            });
          }
        }

        return patches;
      }
    );

    updateProductsWorkflow.runAsStep({
      input: { products: productsInput as any },
    });

    updateProductVariantsWorkflow.runAsStep({
      input: { product_variants: variantsInput as any },
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

    // Keep inventory_item.sku in lockstep with the variant SKU edit. The POS
    // inventory Meili doc reads inventory_item.sku, so without this the list
    // keeps showing the pre-edit SKU. No-ops when sku wasn't changed.
    const skuSyncInput = transform({ input }, (data) => ({
      variants: [{ variant_id: data.input.variant_id, sku: data.input.sku }],
    }));
    syncInventoryItemSkuStep(skuSyncInput);

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
    const qbStepInput = transform({ input }, (data) =>
      buildQbStepInput(data.input)
    );

    const qbResponse = sendToQbStep(qbStepInput);

    // Keep the search index honest — cashier sees the change immediately.
    const meiliInput = transform({ input }, (data) => ({
      productId: data.input.id,
    }));
    syncProductToMeiliSearchWorkflow.runAsStep({ input: meiliInput });

    return new WorkflowResponse({
      qbOperationId: qbResponse.operationId,
      pipelineRowId: qbResponse.pipeline_row_id,
      qbOpQueued: qbResponse.qb_op_queued,
    });
  }
);
