import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../../modules/quickbooks-catalog";

export type QbItemType = "Inventory" | "Service" | "NonInventory";

type SendToQbInput = {
  action: "add" | "mod";
  data: any;
  /** When true the step short-circuits and returns a null operationId.
   * Callers can build a QB payload only when QB-relevant fields changed,
   * avoiding unnecessary QBXML round-trips for non-QB edits (images,
   * categories, shipping, etc.). */
  skip?: boolean;
  /**
   * When provided, the step writes a row to qb_item_pipeline before issuing
   * the bridge call. Enables full audit trail + retry pipeline visibility
   * for every QB item operation (add or mod). Omit only for callers that
   * already manage the pipeline row themselves (e.g. enqueueQbItemsStep).
   */
  pipeline?: {
    variant_id: string;
    sku: string;
    item_type: QbItemType;
  };
};

export type SendToQbResult = {
  success: boolean;
  operationId: string | null;
  response: any;
  pipeline_row_id: string | null;
  /** True when at least one QB-relevant field was sent (skip=false). */
  qb_op_queued: boolean;
};

export const sendToQbStep = createStep(
  "send-to-qb-step",
  async (input: SendToQbInput, { container }) => {
    const logger = container.resolve("logger");
    const catalog = input.pipeline
      ? (container.resolve(QUICKBOOKS_CATALOG_MODULE) as any)
      : null;

    if (input.skip) {
      logger.info(
        `[sendToQbStep] skipped — no QB-relevant fields changed (action=${input.action})`
      );
      const result: SendToQbResult = {
        success: true,
        operationId: null,
        response: null,
        pipeline_row_id: null,
        qb_op_queued: false,
      };
      return new StepResponse(result, null);
    }

    let pipelineRowId: string | null = null;
    if (catalog && input.pipeline) {
      // Defensive SKU resolution: callers occasionally pass an empty/undefined
      // sku (e.g. admin partial updates that don't echo the SKU field). The
      // pipeline row is the only audit trail for the operation, so an empty
      // sku breaks observability. Hydrate from the variant when missing.
      let resolvedSku = (input.pipeline.sku ?? "").trim();
      if (!resolvedSku) {
        try {
          const query = container.resolve(ContainerRegistrationKeys.QUERY);
          const { data: variants } = await query.graph({
            entity: "product_variant",
            fields: ["sku"],
            filters: { id: input.pipeline.variant_id },
            pagination: { skip: 0, take: 1 },
          });
          const fetched = (variants as Array<{ sku: string | null }>)[0]?.sku;
          if (fetched && fetched.trim()) {
            resolvedSku = fetched.trim();
            logger.warn(
              `[sendToQbStep] empty sku in input — resolved "${resolvedSku}" from variant ${input.pipeline.variant_id}`
            );
          } else {
            logger.warn(
              `[sendToQbStep] empty sku in input AND variant ${input.pipeline.variant_id} has no sku either`
            );
          }
        } catch (lookupErr: any) {
          logger.warn(
            `[sendToQbStep] sku lookup failed for variant ${input.pipeline.variant_id}: ${lookupErr.message}`
          );
        }
      }

      try {
        const row = await catalog.createQbItemPipelines({
          variant_id: input.pipeline.variant_id,
          sku: resolvedSku,
          item_type: input.pipeline.item_type,
          op_action: input.action,
          op_payload: input.data,
          qb_id: input.action === "mod" ? (input.data?.ListID ?? null) : null,
          status: "waiting",
        });
        pipelineRowId = row.id;
      } catch (e: any) {
        // A failed pipeline insert must not block the bridge call — but log it
        // loudly so we know the audit trail is missing.
        logger.error(
          `[sendToQbStep] failed to insert qb_item_pipeline row for ${resolvedSku || input.pipeline.variant_id}: ${e.message}`
        );
      }
    }

    try {
      const qbBridgeUrl = process.env.QB_BRIDGE_URL || "http://localhost:3000";
      const reqUrl =
        input.action === "add"
          ? `${qbBridgeUrl}/api/products`
          : `${qbBridgeUrl}/api/products/${input.data.ListID}`;
      const method = input.action === "add" ? "POST" : "PUT";

      logger.info(`Sending item to QB Bridge: ${input.action} - ${reqUrl}`);

      const apiKey = process.env.QB_API_KEY || "";

      // Bridge shape differs per route: POST /api/products (add) reads the QB
      // fields from the TOP LEVEL of the body, while PUT /api/products/:id (mod)
      // unwraps a nested `data`. Send each the shape it actually honors —
      // sending nested to the add endpoint silently queues `{action,data}` as
      // the item payload and the add fails.
      const requestBody =
        input.action === "add"
          ? { action: "add", ...input.data }
          : { action: input.action, data: input.data };

      const response = await fetch(reqUrl, {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "bypass-tunnel-reminder": "true",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Failed to send to QB Bridge: ${response.status} - ${text}`
        );
      }

      const jsonVal = await response.json();
      const operationId = jsonVal.operationId || null;

      if (catalog && pipelineRowId) {
        await catalog.updateQbItemPipelines({
          id: pipelineRowId,
          qb_operation_id: operationId,
        });
      }

      const result: SendToQbResult = {
        success: true,
        operationId,
        response: jsonVal,
        pipeline_row_id: pipelineRowId,
        qb_op_queued: true,
      };
      return new StepResponse(result, null);
    } catch (error: any) {
      logger.error(`sendToQbStep error: ${error.message}`);
      if (catalog && pipelineRowId) {
        await catalog.updateQbItemPipelines({
          id: pipelineRowId,
          status: "error",
          last_error: error.message,
          retries: 0,
          next_retry_at: new Date(Date.now() + 2 * 60 * 1000), // 2 min backoff
        });
      }
      throw error;
    }
  }
);
