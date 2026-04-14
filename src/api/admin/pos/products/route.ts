import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  createPosProductWorkflow,
  CreatePosProductInput,
} from "../../../../workflows/pos/create-pos-product";
import { pollOperationResult } from "../../../../lib/quickbooks/client/core";

export const POST = async (
  req: MedusaRequest<CreatePosProductInput>,
  res: MedusaResponse
) => {
  try {
    const { result, errors } = await createPosProductWorkflow(req.scope).run({
      input: req.body,
      throwOnError: false,
    });

    const logger = req.scope.resolve("logger");

    if (errors && errors.length > 0) {
      logger.error(`Failed to create POS product: ${JSON.stringify(errors)}`);
      return res
        .status(400)
        .json({
          error: errors[0]?.error?.message || "Failed to create product",
        });
    }

    const variantId = result?.product?.variants?.[0]?.id;
    const qbOperationId = result?.qbOperationId;

    // Async Fire-and-Forget polling to get the ListID later
    if (qbOperationId && variantId) {
      (async () => {
        try {
          logger.info(
            `[pos-sync] Polling operation ${qbOperationId} for new Product/Variant ${variantId}...`
          );
          const pollResult = await pollOperationResult(qbOperationId, (msg) =>
            logger.info(msg)
          );

          if (pollResult.txnId) {
            // txnId acts as listId for Items and Customers in pollOperationResult

            // Update it directly or via native fetch to avoid medusa update overhead
            logger.info(
              `[pos-sync] Got ListID ${pollResult.txnId}. Updating variant ${variantId} metadata.`
            );

            // We use direct query instead of workflow as we just want to patch the qb_id cheaply
            const pool = (req.scope as any).resolve("__pg_connection__");
            if (pool) {
              await pool.query(
                `UPDATE product_variant SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('quickbooks_id', $1::text, 'qb_edit_sequence', $3::text) WHERE id = $2`,
                [pollResult.txnId, variantId, pollResult.editSequence || null]
              );
            }
          }
        } catch (err: any) {
          logger.error(
            `[pos-sync] Failed to poll/update new item ListID: ${err.message}`
          );
        }
      })();
    }

    return res.status(200).json({ product: result?.product, qbOperationId });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
};
