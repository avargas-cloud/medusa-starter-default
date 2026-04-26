import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import {
  createPosProductV2Workflow,
  CreatePosProductV2Input,
} from "../../../../../workflows/pos/create-pos-product-v2";

const validate = (body: any): string | null => {
  if (!body) return "Missing body";
  if (!body.title || typeof body.title !== "string") return "title is required";
  if (!["Inventory", "Service", "NonInventory"].includes(body.item_type))
    return "item_type must be Inventory | Service | NonInventory";
  if (!Array.isArray(body.category_ids) || body.category_ids.length === 0)
    return "category_ids must contain at least 1 category id";
  if (!body.income_account_full_name)
    return "income_account_full_name is required";
  if (body.item_type === "Inventory" && !body.cogs_account_full_name)
    return "cogs_account_full_name is required for Inventory items";
  if (!Array.isArray(body.variants) || body.variants.length === 0)
    return "variants must contain at least 1 variant";
  for (const v of body.variants) {
    if (!v.sku) return "each variant requires a sku";
    if (typeof v.cost !== "number")
      return `variant ${v.sku}: cost must be a number`;
    if (typeof v.retail_price !== "number")
      return `variant ${v.sku}: retail_price must be a number`;
  }
  return null;
};

export const POST = async (
  req: MedusaRequest<CreatePosProductV2Input>,
  res: MedusaResponse
) => {
  const logger = req.scope.resolve("logger");
  const validationError = validate(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const { result, errors } = await createPosProductV2Workflow(req.scope).run({
      input: req.body,
      throwOnError: false,
    });

    if (errors && errors.length > 0) {
      logger.error(
        `[pos-products-v2] workflow errors: ${JSON.stringify(errors)}`
      );
      return res.status(500).json({
        error: errors[0]?.error?.message ?? "Workflow failed",
      });
    }

    return res.status(200).json({
      product: result?.product,
      pipeline: result?.pipeline,
    });
  } catch (err: any) {
    logger.error(`[pos-products-v2] exception: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
};
