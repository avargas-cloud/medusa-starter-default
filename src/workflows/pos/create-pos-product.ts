import {
  createWorkflow,
  WorkflowResponse,
  transform,
} from "@medusajs/framework/workflows-sdk";
import { createProductsWorkflow } from "@medusajs/medusa/core-flows";

import { sendToQbStep } from "../qb/send-to-qb-step";
import { buildPrefVendorRef } from "../../lib/quickbooks/pref-vendor-ref";
import { roundCostDollarsOpt } from "../../lib/cost/avco";

export type CreatePosProductInput = {
  title: string;
  salesDescription: string;
  sku: string;
  barcode?: string;
  weight?: number;
  material?: string;
  hs_code?: string;
  country_of_origin?: string;
  mid_code?: string;
  cost: number;
  vendor: string;
  vendor_qb_id?: string;
  mpn: string;
};

export const createPosProductWorkflow = createWorkflow(
  "create-pos-product",
  function (input: CreatePosProductInput) {
    // Blank barcode → undefined (Medusa stores NULL). An empty "" collides with
    // the unique partial index on barcode (only one "" allowed; NULLs unlimited).
    // Must run inside transform(): in the raw workflow body `input` is a deferred
    // proxy, so calling .trim() on it throws at load time ("trim is not a function").
    const cleanBarcode = transform(
      { input },
      (data) => data.input.barcode?.trim() || undefined
    );

    // 1. Create Product and Variant natively via Core Flow
    const products = createProductsWorkflow.runAsStep({
      input: {
        products: [
          {
            title: input.title,
            description: input.salesDescription,
            options: [{ title: "Item", values: ["Default Unit"] }],
            variants: [
              {
                title: "Default Unit",
                sku: input.sku,
                barcode: cleanBarcode,
                weight: input.weight,
                material: input.material,
                hs_code: input.hs_code,
                origin_country: input.country_of_origin,
                mid_code: input.mid_code,
                manage_inventory: true, // Will create an inventory_item automatically
                options: {
                  Item: "Default Unit",
                },
                metadata: {
                  purchase_cost: roundCostDollarsOpt(input.cost),
                  qb_vendor_name: input.vendor,
                  mpn: input.mpn,
                  sales_description: input.salesDescription,
                },
              },
            ],
          },
        ],
      },
    });

    const product = products[0];

    // 2. Build the QB payload inside transform(): `input` is a deferred proxy in
    // the workflow body, so the PrefVendorRef guard (which must never emit an
    // internal qb_vendor.id as a ListID) has to run on resolved values.
    const qbData = transform({ input }, (data) => {
      const i = data.input;
      return {
        Name: i.sku,
        SalesDesc: i.salesDescription,
        PurchaseDesc: i.salesDescription,
        SalesPrice: 0.0, // POS doesn't set selling price yet, edit later
        PurchaseCost: roundCostDollarsOpt(i.cost),
        PrefVendorRef: buildPrefVendorRef({
          vendorIdOrListId: i.vendor_qb_id,
          vendorFullName: i.vendor,
        }),
        ManufacturerPartNumber: i.mpn || undefined,
      };
    });

    // 3. Send the creation to QuickBooks Bridge
    const qbResponse = sendToQbStep({
      action: "add",
      data: qbData,
    });

    // We could theoretically write back the operation ID to the variant here if needed
    // but for now we just return the created product
    return new WorkflowResponse({
      product: product,
      qbOperationId: qbResponse.operationId,
    });
  }
);
