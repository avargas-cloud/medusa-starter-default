import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import {
  updatePosProductWorkflow,
  UpdatePosProductInput,
} from "../../../../../workflows/pos/update-pos-product";
import { pollOperationResult } from "../../../../../lib/quickbooks/client/core";

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);

  try {
    const id = req.params.id;

    // Fetch Native Variant and Metadata first to get current qb_edit_sequence
    // Since the POS currently knows the product, we can fetch exactly what we need
    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: ["id", "product_id", "metadata"],
      filters: { product_id: id }, // Using product_id if the UI passes Product ID, or id itself if passing Variant ID. Assuming Product ID.
    });

    if (!variants || variants.length === 0) {
      return res.status(404).json({ error: "Product/Variant not found" });
    }

    const variant = variants[0] as any;
    const qbId = variant.metadata?.quickbooks_id;
    let qbEditSequence = variant.metadata?.qb_edit_sequence;

    if (!qbId) {
      return res
        .status(400)
        .json({
          error:
            "This product is not linked to Quickbooks (Missing qb_id). Please create it properly first.",
        });
    }

    // If for some reason we don't have the edit sequence but we have the qbId, we could theoretically fetch it here
    // using getCustomerEditSequence but for items. For now, QB might reject it if missing. We will pass what we have.
    if (!qbEditSequence) {
      logger.warn(
        `Missing qb_edit_sequence for variant ${variant.id}. QB might reject the modification.`
      );
    }

    const inputPayload: UpdatePosProductInput = {
      id: variant.product_id,
      variant_id: variant.id,
      qb_id: qbId,
      qb_edit_sequence: qbEditSequence || "",
      ...(req.body as any),
    };

    const { result, errors } = await updatePosProductWorkflow(req.scope).run({
      input: inputPayload,
      throwOnError: false,
    });

    if (errors && errors.length > 0) {
      logger.error(`Failed to update POS product: ${JSON.stringify(errors)}`);
      return res
        .status(400)
        .json({
          error: errors[0]?.error?.message || "Failed to update product",
        });
    }

    const qbOperationId = result?.qbOperationId;
    const variantId = variant.id;

    // Async Fire-and-Forget polling to get the NEW EditSequence after modification
    if (qbOperationId && variantId) {
      (async () => {
        try {
          logger.info(
            `[pos-sync] Polling operation ${qbOperationId} for modified Product/Variant ${variantId}...`
          );
          const pollResult = await pollOperationResult(qbOperationId, (msg) =>
            logger.info(msg)
          );

          if (pollResult.editSequence) {
            logger.info(
              `[pos-sync] Update successful! Got NEW EditSequence ${pollResult.editSequence}. Saving to variant...`
            );
            const pool = (req.scope as any).resolve("__pg_connection__");
            if (pool) {
              await pool.query(
                `UPDATE product_variant SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('qb_edit_sequence', $1::text) WHERE id = $2`,
                [pollResult.editSequence, variantId]
              );
            }
          }
        } catch (err: any) {
          logger.error(
            `[pos-sync] Failed to poll/update modified item EditSequence: ${err.message}`
          );
        }
      })();
    }

    return res.status(200).json({ success: true, qbOperationId });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
};
