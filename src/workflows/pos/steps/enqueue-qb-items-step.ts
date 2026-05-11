import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../modules/quickbooks-catalog";

export type QbItemType = "Inventory" | "Service" | "NonInventory";

export type EnqueueQbItemInput = {
  variant_id: string;
  sku: string;
  title: string;
  sales_description: string;
  cost: number;
  retail_price: number;
  item_type: QbItemType;
  cogs_account_full_name?: string | null;
  income_account_full_name?: string | null;
  vendor_list_id?: string | null;
  vendor_full_name?: string | null;
  mpn?: string | null;
};

export type EnqueueQbItemsStepInput = {
  items: EnqueueQbItemInput[];
};

type BridgeResponse = {
  operationId?: string;
  error?: string;
};

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "";

const buildQbPayload = (item: EnqueueQbItemInput) => {
  const base: Record<string, unknown> = {
    Name: item.sku,
    SalesDesc: item.sales_description || item.title,
    SalesPrice: item.retail_price,
    ItemType: item.item_type,
  };

  if (item.mpn) base.ManufacturerPartNumber = item.mpn;
  if (item.vendor_list_id)
    base.PrefVendorRef = { ListID: item.vendor_list_id };
  else if (item.vendor_full_name)
    base.PrefVendorRef = { FullName: item.vendor_full_name };
  if (item.income_account_full_name)
    base.IncomeAccountRef = { FullName: item.income_account_full_name };

  if (item.item_type === "Inventory") {
    base.PurchaseDesc = item.sales_description || item.title;
    base.PurchaseCost = item.cost;
    if (item.cogs_account_full_name) {
      base.COGSAccountRef = { FullName: item.cogs_account_full_name };
    }
  } else {
    if (item.cost > 0) {
      base.PurchaseDesc = item.sales_description || item.title;
      base.PurchaseCost = item.cost;
      if (item.cogs_account_full_name) {
        base.ExpenseAccountRef = { FullName: item.cogs_account_full_name };
      }
    }
  }

  return base;
};

const postToBridge = async (
  payload: Record<string, unknown>
): Promise<BridgeResponse> => {
  const res = await fetch(`${BRIDGE_URL}/api/products`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "bypass-tunnel-reminder": "true",
    },
    body: JSON.stringify({ action: "add", ...payload }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { error: `HTTP ${res.status} — ${text}` };
  }
  const data = (await res.json()) as BridgeResponse;
  return data;
};

export const enqueueQbItemsStep = createStep(
  "enqueue-qb-items-step",
  async (input: EnqueueQbItemsStepInput, { container }) => {
    const logger = container.resolve("logger");
    const catalog = container.resolve(QUICKBOOKS_CATALOG_MODULE) as any;

    const results: Array<{
      variant_id: string;
      sku: string;
      pipeline_id: string | null;
      operation_id: string | null;
      status: "waiting" | "error";
      error?: string;
    }> = [];

    for (const item of input.items) {
      const payload = buildQbPayload(item);

      try {
        const bridge = await postToBridge(payload);

        if (bridge.error || !bridge.operationId) {
          const row = await catalog.createQbItemPipelines({
            variant_id: item.variant_id,
            sku: item.sku,
            item_type: item.item_type,
            status: "error",
            last_error: bridge.error ?? "Bridge returned no operationId",
          });
          logger.warn(
            `[createPosProductV2] Variant ${item.sku} failed to enqueue: ${bridge.error}`
          );
          results.push({
            variant_id: item.variant_id,
            sku: item.sku,
            pipeline_id: row.id,
            operation_id: null,
            status: "error",
            error: bridge.error,
          });
          continue;
        }

        const row = await catalog.createQbItemPipelines({
          variant_id: item.variant_id,
          sku: item.sku,
          item_type: item.item_type,
          status: "waiting",
          qb_operation_id: bridge.operationId,
        });

        results.push({
          variant_id: item.variant_id,
          sku: item.sku,
          pipeline_id: row.id,
          operation_id: bridge.operationId,
          status: "waiting",
        });
      } catch (err: any) {
        logger.error(
          `[createPosProductV2] Variant ${item.sku} exception: ${err.message}`
        );
        const row = await catalog.createQbItemPipelines({
          variant_id: item.variant_id,
          sku: item.sku,
          item_type: item.item_type,
          status: "error",
          last_error: err.message,
        });
        results.push({
          variant_id: item.variant_id,
          sku: item.sku,
          pipeline_id: row.id,
          operation_id: null,
          status: "error",
          error: err.message,
        });
      }
    }

    return new StepResponse({ results }, null);
  }
);
