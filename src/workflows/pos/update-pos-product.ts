import {
  createWorkflow,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { updateProductsWorkflow } from "@medusajs/medusa/core-flows";
import { sendToQbStep } from "../qb/send-to-qb-step";

export type UpdatePosProductInput = {
  readonly id: string; // The product ID
  readonly variant_id: string;
  title?: string;
  salesDescription?: string;
  sku?: string;
  barcode?: string;
  weight?: number;
  material?: string;
  hs_code?: string;
  country_of_origin?: string;
  mid_code?: string;
  cost?: number;
  vendor?: string;
  mpn?: string;
  // Quickbooks logic properties
  qb_id: string;
  qb_edit_sequence: string;
};

export const updatePosProductWorkflow = createWorkflow(
  "update-pos-product",
  function (input: UpdatePosProductInput) {
    // 1. Update Product and Variant natively
    const updatePayload: any = {
      id: input.id,
    };

    if (input.title || input.salesDescription) {
      if (input.title) updatePayload.title = input.title;
      if (input.salesDescription)
        updatePayload.description = input.salesDescription;
    }

    const variantPayload: any = {
      id: input.variant_id,
    };

    if (input.sku) variantPayload.sku = input.sku;
    if (input.barcode) variantPayload.barcode = input.barcode;
    if (input.weight !== undefined) variantPayload.weight = input.weight;
    if (input.material !== undefined) variantPayload.material = input.material;
    if (input.hs_code !== undefined) variantPayload.hs_code = input.hs_code;
    if (input.country_of_origin !== undefined)
      variantPayload.origin_country = input.country_of_origin;
    if (input.mid_code !== undefined) variantPayload.mid_code = input.mid_code;

    // Append metadata updates
    variantPayload.metadata = {
      qb_purchase_cost: input.cost,
      qb_vendor_name: input.vendor,
      mpn: input.mpn,
      sales_description: input.salesDescription,
    };

    updateProductsWorkflow.runAsStep({
      input: {
        products: [
          {
            ...updatePayload,
            variants: [variantPayload],
          },
        ],
      },
    });

    // 2. Send the modification to QuickBooks Bridge if qb_id is present
    const qbResponse = sendToQbStep({
      action: "mod",
      data: {
        ListID: input.qb_id,
        EditSequence: input.qb_edit_sequence,
        Name: input.sku,
        SalesDesc: input.salesDescription,
        PurchaseDesc: input.salesDescription,
        SalesPrice: 0.0, // Safe default or skip updating price if not provided
        PurchaseCost: input.cost,
        PrefVendorRef: input.vendor ? { FullName: input.vendor } : undefined,
        ManufacturerPartNumber: input.mpn || undefined,
      },
    });

    return new WorkflowResponse({
      qbOperationId: qbResponse.operationId,
    });
  }
);
