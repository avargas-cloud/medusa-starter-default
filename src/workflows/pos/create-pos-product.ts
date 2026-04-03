import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createProductsWorkflow } from "@medusajs/medusa/core-flows"
import { sendToQbStep } from "../qb/send-to-qb-step"

export type CreatePosProductInput = {
    title: string
    salesDescription: string
    sku: string
    barcode?: string
    weight?: number
    material?: string
    hs_code?: string
    country_of_origin?: string
    mid_code?: string
    cost: number
    vendor: string
    mpn: string
}

export const createPosProductWorkflow = createWorkflow(
    "create-pos-product",
    function (input: CreatePosProductInput) {
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
                                barcode: input.barcode,
                                weight: input.weight,
                                material: input.material,
                                hs_code: input.hs_code,
                                origin_country: input.country_of_origin,
                                mid_code: input.mid_code,
                                manage_inventory: true, // Will create an inventory_item automatically
                                options: {
                                    "Item": "Default Unit"
                                },
                                metadata: {
                                    qb_purchase_cost: input.cost,
                                    qb_vendor_name: input.vendor,
                                    mpn: input.mpn,
                                    sales_description: input.salesDescription,
                                }
                            }
                        ]
                    }
                ]
            }
        })

        const product = products[0]

        // 2. Send the creation to QuickBooks Bridge
        const qbResponse = sendToQbStep({
            action: "add",
            data: {
                Name: input.sku,
                SalesDesc: input.salesDescription,
                PurchaseDesc: input.salesDescription,
                SalesPrice: 0.00, // POS doesn't set selling price yet, edit later
                PurchaseCost: input.cost,
                PrefVendorRef: input.vendor ? { FullName: input.vendor } : undefined,
                ManufacturerPartNumber: input.mpn || undefined,
            }
        })

        // We could theoretically write back the operation ID to the variant here if needed
        // but for now we just return the created product
        return new WorkflowResponse({
            product: product,
            qbOperationId: qbResponse.operationId
        })
    }
)
