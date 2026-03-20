import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { CREDIT_MEMO_MODULE } from "../../../../../../modules/credit_memos"
import CreditMemoModuleService from "../../../../../../modules/credit_memos/service"
import { Modules } from "@medusajs/utils"

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const logger = req.scope.resolve("logger")
    const creditMemoService: CreditMemoModuleService = req.scope.resolve(CREDIT_MEMO_MODULE)
    const inventoryService = req.scope.resolve(Modules.INVENTORY)
    const stockLocationService = req.scope.resolve(Modules.STOCK_LOCATION)
    
    const { id } = req.params as { id: string }
    
    try {
        const creditMemo = await creditMemoService.retrievePosCreditMemo(id, {
            relations: ["items"]
        })

        if (!creditMemo) {
            res.status(404).json({ message: "Credit Memo not found" })
            return
        }
        
        if (creditMemo.status !== 'draft') {
            res.status(400).json({ message: "Credit Memo is already completed or voided" })
            return
        }

        // Restock Inventory for every variant in the credit memo
        const defaultLocation = await stockLocationService.listStockLocations({ name: "Default" })
        const locationId = defaultLocation[0]?.id

        if (locationId) {
            for (const item of creditMemo.items) {
                if (!item.variant_id) continue;
                
                // Get inventory item for this variant
                // (Assuming 1:1 variant:inventory relationship typical in simple setups)
                
                // Instead of interacting with inventory locations manually since it's complex,
                // We should adjust the standard Medusa stock API or use core workflows if available.
                // For Medusa v2, updating inventory levels directly:
                try {
                    // Try to resolve inventory items linked to variant via Query
                    const query = req.scope.resolve("query")
                    const { data } = await query.graph({
                        entity: "product_variant",
                        fields: ["id", "inventory_items.*", "inventory_items.inventory.id"],
                        filters: { id: item.variant_id }
                    })
                    
                    const variant = data[0]
                    if (variant && variant.inventory_items && variant.inventory_items.length > 0) {
                        const invItemId = variant.inventory_items[0]?.inventory?.id
                        
                        // Fetch current level
                        if (invItemId) {
                            const levels = await inventoryService.listInventoryLevels({
                                inventory_item_id: invItemId,
                                location_id: locationId
                            })
                            
                            if (levels && levels.length > 0) {
                                const newQty = (levels[0]?.stocked_quantity || 0) + item.quantity
                                await inventoryService.updateInventoryLevels({
                                    id: levels[0]?.id as string,
                                    inventory_item_id: invItemId,
                                    location_id: locationId,
                                    stocked_quantity: newQty
                                } as any)
                                logger.info(`Restocked inventory for variant ${item.variant_id}: +${item.quantity}`)
                            }
                        }
                    }
                } catch (invErr: any) {
                    logger.warn(`Failed to restock inventory for variant ${item.variant_id}: ${invErr.message}`)
                }
            }
        }

        // Mark Credit Memo as completed
        await creditMemoService.updatePosCreditMemoes({
            id,
            status: 'completed',
            completed_at: new Date()
        })

        res.status(200).json({ success: true, message: "Credit Memo completed and inventory restocked" })

    } catch (e: any) {
        logger.error(`[credit_memos complete] failed: ${e.message}`)
        res.status(500).json({ success: false, message: e.message })
    }
}
