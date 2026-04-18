import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../../../modules/quickbooks-catalog";

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "";

type VariantRow = {
  id: string;
  sku: string;
  title: string | null;
  metadata: Record<string, any> | null;
};

type PipelineRow = {
  id: string;
  variant_id: string;
  sku: string;
  item_type: "Inventory" | "Service" | "NonInventory";
  status: string;
  retries: number;
};

const buildPayload = (
  variant: VariantRow,
  itemType: "Inventory" | "Service" | "NonInventory"
) => {
  const meta = variant.metadata ?? {};
  const retailPrice = Number(meta.qb_retail_price ?? 0) || 0;
  const cost = Number(meta.qb_purchase_cost ?? 0) || 0;
  const salesDesc = String(meta.sales_description ?? variant.title ?? variant.sku);
  const income = meta.qb_income_account_full_name ?? null;
  const cogs = meta.qb_cogs_account_full_name ?? null;
  const vendor = meta.qb_vendor_full_name ?? null;
  const mpn = meta.mpn ?? null;

  const base: Record<string, unknown> = {
    action: "add",
    Name: variant.sku,
    SalesDesc: salesDesc,
    SalesPrice: retailPrice,
    ItemType: itemType,
  };
  if (mpn) base.ManufacturerPartNumber = mpn;
  if (vendor) base.PrefVendorRef = { FullName: vendor };
  if (income) base.IncomeAccountRef = { FullName: income };
  if (itemType === "Inventory") {
    base.PurchaseDesc = salesDesc;
    base.PurchaseCost = cost;
    if (cogs) base.COGSAccountRef = { FullName: cogs };
  } else if (cost > 0) {
    base.PurchaseDesc = salesDesc;
    base.PurchaseCost = cost;
    if (cogs) base.ExpenseAccountRef = { FullName: cogs };
  }
  return base;
};

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const catalog = req.scope.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const id = req.params.id;

  const { data: rows } = await query.graph({
    entity: "qb_item_pipeline",
    fields: [
      "id",
      "variant_id",
      "sku",
      "item_type",
      "status",
      "retries",
    ],
    filters: { id },
    pagination: { skip: 0, take: 1 },
  });
  const row = (rows as PipelineRow[])[0];
  if (!row) return res.status(404).json({ error: "Pipeline row not found" });

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku", "title", "metadata"],
    filters: { id: row.variant_id },
    pagination: { skip: 0, take: 1 },
  });
  const variant = (variants as VariantRow[])[0];
  if (!variant)
    return res.status(404).json({ error: "Underlying variant missing" });

  try {
    const payload = buildPayload(variant, row.item_type);
    const bridgeRes = await fetch(`${BRIDGE_URL}/api/products`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "bypass-tunnel-reminder": "true",
      },
      body: JSON.stringify(payload),
    });
    const bridgeData = await bridgeRes.json();
    if (!bridgeRes.ok || !bridgeData.operationId) {
      throw new Error(
        bridgeData.error ?? `bridge status ${bridgeRes.status} no operationId`
      );
    }

    await catalog.updateQbItemPipelines({
      id: row.id,
      status: "waiting",
      qb_operation_id: bridgeData.operationId,
      last_error: null,
      retries: (row.retries ?? 0) + 1,
    });

    return res.json({
      success: true,
      operation_id: bridgeData.operationId,
      message: `Re-enqueued ${row.sku}. Pipeline will resolve within ~60s.`,
    });
  } catch (err: any) {
    logger.error(`[pipeline retry] ${row.sku} failed: ${err.message}`);
    await catalog.updateQbItemPipelines({
      id: row.id,
      status: "error",
      last_error: err.message,
      retries: (row.retries ?? 0) + 1,
    });
    return res.status(500).json({ success: false, error: err.message });
  }
};
