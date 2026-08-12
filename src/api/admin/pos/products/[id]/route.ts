import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { Logger } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import {
  readVendorFullName,
  readVendorListId,
} from "../../../../../lib/vendor-metadata/keys";

import {
  updatePosProductWorkflow,
  type UpdatePosProductInput,
} from "../../../../../workflows/pos/update-pos-product";
import {
  updatePosProductFullWorkflow,
  type UpdatePosProductFullInput,
} from "../../../../../workflows/pos/update-pos-product-full";
import { updateSingleProductWorkflow } from "../../../../../workflows/update-single-product";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../../workflows/sync-inventory-item-meilisearch";

/**
 * Fire-and-forget reindex of BOTH MeiliSearch indexes a product lives in:
 *   • "products"  — full-text product index (web / generic search)
 *   • "inventory" — the index the POS inventory list reads (sku, stock, price)
 *
 * The POS edit modal mutates fields (notably `sku`) that the cashier must see
 * immediately on the list, so the "inventory" index MUST be refreshed here.
 * Relying on the product-variant.updated subscriber alone left the inventory
 * index stale (e.g. a renamed SKU kept showing the old value on the list).
 */
function reindexProductMeili(
  scope: MedusaRequest["scope"],
  productId: string,
  logger: Logger
): void {
  void updateSingleProductWorkflow(scope)
    .run({ input: { productId } })
    .catch((e: any) =>
      logger.error(
        `[pos-product] Meili "products" sync failed for ${productId}:`,
        e?.message
      )
    );
  void syncInventoryItemToMeiliSearchWorkflow(scope)
    .run({ input: { productId } })
    .catch((e: any) =>
      logger.error(
        `[pos-product] Meili "inventory" sync failed for ${productId}:`,
        e?.message
      )
    );
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);

  try {
    const id = req.params.id as string;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const bodyVariantId = body.variant_id as string | undefined;

    // ── Product mode: body carries a variants[] array ──────────────────────
    // Triggered by the EditItemModal "Producto" toggle. Dispatches to the
    // full-product workflow which handles per-variant create/update/delete
    // explicitly (no Medusa authoritative-array semantics → no sibling wipe).
    if (Array.isArray(body.variants)) {
      const fullInput: UpdatePosProductFullInput = {
        id,
        title: body.title as string | undefined,
        category_ids: body.category_ids as string[] | undefined,
        image_urls: body.image_urls as string[] | undefined,
        income_account_full_name: body.income_account_full_name as
          | string
          | undefined,
        cogs_account_full_name: body.cogs_account_full_name as
          | string
          | undefined,
        vendor_full_name: body.vendor_full_name as string | undefined,
        vendor_qb_id: body.vendor_qb_id as string | undefined,
        is_sourced_via_agent: body.is_sourced_via_agent as boolean | undefined,
        is_sourced_via_agent_manual: body.is_sourced_via_agent_manual as
          | boolean
          | undefined,
        shipping_attributes: body.shipping_attributes as
          | UpdatePosProductFullInput["shipping_attributes"]
          | undefined,
        variants: body.variants as UpdatePosProductFullInput["variants"],
        delete_variant_ids: body.delete_variant_ids as string[] | undefined,
      };

      const { result: fullResult, errors: fullErrors } =
        await updatePosProductFullWorkflow(req.scope).run({
          input: fullInput,
          throwOnError: false,
        });

      if (fullErrors && fullErrors.length > 0) {
        logger.error(
          `Failed to update POS product (full mode): ${JSON.stringify(fullErrors)}`
        );
        return res.status(400).json({
          error: fullErrors[0]?.error?.message || "Failed to update product",
        });
      }

      // Keep both search indexes honest — product mode can rename SKUs,
      // titles, and add/remove variants the cashier must see on the list.
      reindexProductMeili(req.scope, id, logger);

      return res.status(200).json({
        success: true,
        mode: "product",
        result: fullResult,
      });
    }

    // ── Single-variant mode (default, existing behavior) ──────────────────

    // Resolve the EXACT variant the UI opened. If the modal passed variant_id,
    // filter by it directly (multi-variant products). Otherwise fall back to
    // the first variant of the product for backwards compatibility.
    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: ["id", "product_id", "sku", "metadata"],
      filters: bodyVariantId ? { id: bodyVariantId } : { product_id: id },
    });

    if (!variants || variants.length === 0) {
      return res.status(404).json({ error: "Product/Variant not found" });
    }

    const variant = variants[0] as any;
    const meta = (variant.metadata ?? {}) as Record<string, unknown>;
    const qbId =
      typeof meta.quickbooks_id === "string" && meta.quickbooks_id.trim()
        ? (meta.quickbooks_id as string)
        : undefined;
    const qbEditSequence =
      typeof meta.qb_edit_sequence === "string"
        ? (meta.qb_edit_sequence as string)
        : undefined;

    // No quickbooks_id → the item was created in Medusa but never synced to QB
    // (the create-time add failed). Treat the edit as a first-time "add" instead
    // of blocking, hydrating the full item definition from variant.metadata.
    const isNew = !qbId;
    if (isNew) {
      logger.warn(
        `[pos-product] variant ${variant.id} has no quickbooks_id — dispatching edit as a first-time QB add (item was never synced).`
      );
    } else if (!qbEditSequence) {
      // EditSequence may be missing (legacy/orphan record). Don't block — the
      // pipeline worker has an EditSequence auto-fallback that hydrates it via
      // ItemQuery and retries the Mod automatically (F2).
      logger.warn(
        `Missing qb_edit_sequence for variant ${variant.id}. Worker will hydrate via ItemQuery fallback before retrying.`
      );
    }

    // Strip routing/identity keys from body so the client cannot override them.
    const {
      id: _bodyId,
      variant_id: _bodyVariantId,
      qb_id: _bodyQbId,
      qb_edit_sequence: _bodyEditSeq,
      ...restBody
    } = (req.body as Record<string, unknown>) ?? {};

    const inputPayload: UpdatePosProductInput = {
      id: variant.product_id,
      variant_id: variant.id,
      qb_id: qbId,
      qb_edit_sequence: qbEditSequence || "",
      ...restBody,
    };

    // For a first-time add, QB needs the complete item definition. Anything the
    // user just edited (already merged via restBody) wins; stored metadata only
    // fills the gaps so the add doesn't fail on missing required refs.
    if (isNew) {
      const asNumber = (v: unknown): number | undefined =>
        typeof v === "number" ? v : undefined;
      const asString = (v: unknown): string | undefined =>
        typeof v === "string" && v.trim() ? v : undefined;

      inputPayload.item_type =
        (asString(meta.qb_item_type) as UpdatePosProductInput["item_type"]) ??
        "Inventory";
      inputPayload.sku = inputPayload.sku ?? asString(variant.sku);
      inputPayload.retail_price =
        inputPayload.retail_price ?? asNumber(meta.qb_retail_price);
      inputPayload.salesDescription =
        inputPayload.salesDescription ?? asString(meta.sales_description);
      inputPayload.purchaseDescription =
        inputPayload.purchaseDescription ?? asString(meta.qb_purchase_desc);
      inputPayload.cost = inputPayload.cost ?? asNumber(meta.purchase_cost);
      inputPayload.mpn = inputPayload.mpn ?? asString(meta.mpn);
      inputPayload.income_account_full_name =
        inputPayload.income_account_full_name ??
        asString(meta.qb_income_account_full_name);
      inputPayload.cogs_account_full_name =
        inputPayload.cogs_account_full_name ??
        asString(meta.qb_cogs_account_full_name);
      inputPayload.vendor_full_name =
        inputPayload.vendor_full_name ?? readVendorFullName(meta) ?? undefined;
      // NOTE: this hydrates a QB ListID into a field named `vendor_qb_id`, which
      // elsewhere carries an internal `qbvnd_` id. The workflows resolve only
      // `qbvnd_`-prefixed ids for exactly that reason — see update-pos-product.
      inputPayload.vendor_qb_id =
        inputPayload.vendor_qb_id ?? readVendorListId(meta) ?? undefined;
    }

    const { result, errors } = await updatePosProductWorkflow(req.scope).run({
      input: inputPayload,
      throwOnError: false,
    });

    if (errors && errors.length > 0) {
      logger.error(`Failed to update POS product: ${JSON.stringify(errors)}`);
      return res.status(400).json({
        error: errors[0]?.error?.message || "Failed to update product",
      });
    }

    // Pipeline visibility flags so the modal can render an honest toast:
    //   qb_op_queued: true       → "Item updated — QB sync queued"
    //   skipped_qb:   true       → "Saved locally — no QB metadata changes"
    const productId = req.params.id as string;
    reindexProductMeili(req.scope, productId, logger);

    return res.status(200).json({
      success: true,
      qbOperationId: result?.qbOperationId ?? null,
      qb_op_queued: !!result?.qbOperationId,
      pipeline_row_id: result?.pipelineRowId ?? null,
      skipped_qb: !result?.qbOperationId,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
};
