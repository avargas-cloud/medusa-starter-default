import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import {
  updatePosProductWorkflow,
  type UpdatePosProductInput,
} from "../../../../../workflows/pos/update-pos-product";

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);

  try {
    const id = req.params.id;
    const bodyVariantId = (req.body as { variant_id?: string })?.variant_id;

    // Resolve the EXACT variant the UI opened. If the modal passed variant_id,
    // filter by it directly (multi-variant products). Otherwise fall back to
    // the first variant of the product for backwards compatibility.
    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: ["id", "product_id", "metadata"],
      filters: bodyVariantId
        ? { id: bodyVariantId }
        : { product_id: id },
    });

    if (!variants || variants.length === 0) {
      return res.status(404).json({ error: "Product/Variant not found" });
    }

    const variant = variants[0] as any;
    const qbId = variant.metadata?.quickbooks_id;
    const qbEditSequence = variant.metadata?.qb_edit_sequence;

    if (!qbId) {
      return res.status(400).json({
        error:
          "This product is not linked to Quickbooks (Missing qb_id). Please create it properly first.",
      });
    }

    // EditSequence may be missing (legacy/orphan record). Don't block — the
    // pipeline worker has an EditSequence auto-fallback that hydrates it via
    // ItemQuery and retries the Mod automatically (F2).
    if (!qbEditSequence) {
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
