import { randomUUID } from "crypto"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { CREDIT_MEMO_MODULE } from "../../../../../../modules/credit_memos"
import CreditMemoModuleService from "../../../../../../modules/credit_memos/service"
import { Modules } from "@medusajs/utils"

/**
 * PATCH /admin/pos/credit_memos/:id/damaged
 *
 * Update damaged_qty for items on a COMPLETED credit memo.
 * Called by supervisors (after PIN gate) when defective products are identified
 * post-return (e.g., after testing).
 *
 * Inventory is adjusted based on the delta:
 *   delta > 0 → more units are now damaged → deduct from stocked_quantity
 *   delta < 0 → fewer units are damaged   → restore to stocked_quantity
 */
export async function PATCH(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const logger = req.scope.resolve("logger")
    const creditMemoService: CreditMemoModuleService = req.scope.resolve(CREDIT_MEMO_MODULE)
    const inventoryService = req.scope.resolve(Modules.INVENTORY)
    const stockLocationService = req.scope.resolve(Modules.STOCK_LOCATION)

    const { id } = req.params as { id: string }
    const { items } = req.body as { items: { id: string; damaged_qty: number }[] }

    if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ success: false, message: "items array is required" })
        return
    }

    try {
        const creditMemo = await creditMemoService.retrievePosCreditMemo(id, {
            relations: ["items"],
        }) as any

        if (!creditMemo) {
            res.status(404).json({ success: false, message: "Credit Memo not found" })
            return
        }

        if (creditMemo.status !== 'completed') {
            res.status(400).json({ success: false, message: "Damaged qty can only be edited on completed credit memos" })
            return
        }

        const allLocations = await stockLocationService.listStockLocations({})
        const locationId = allLocations[0]?.id

        const pgConnection = req.scope.resolve("__pg_connection__") as any

        for (const update of items) {
            const dbItem = (creditMemo.items as any[]).find((i: any) => i.id === update.id)
            if (!dbItem) {
                logger.warn(`[damaged update] Item ${update.id} not found on credit memo ${id} — skipping`)
                continue
            }

            const oldDamaged = dbItem.damaged_qty || 0
            const newDamaged = Math.max(0, Math.min(update.damaged_qty, dbItem.quantity))
            const delta = newDamaged - oldDamaged   // positive: more damaged; negative: fewer damaged

            if (delta === 0) continue

            // Adjust inventory to reflect the change in damaged units
            if (locationId && dbItem.variant_id) {
                try {
                    const query = req.scope.resolve("query")
                    const { data } = await query.graph({
                        entity: "product_variant",
                        fields: ["id", "inventory_items.*", "inventory_items.inventory.id"],
                        filters: { id: dbItem.variant_id },
                    })

                    const variant = data[0] as any
                    if (variant?.inventory_items?.length > 0) {
                        const invItemId = variant.inventory_items[0]?.inventory?.id
                        if (invItemId) {
                            const levels = await inventoryService.listInventoryLevels({
                                inventory_item_id: invItemId,
                                location_id: locationId,
                            })

                            if (levels?.length > 0) {
                                const currentQty = levels[0]?.stocked_quantity || 0
                                // delta > 0: units became damaged → reduce stock
                                // delta < 0: units cleared from damaged → restore stock
                                const newQty = Math.max(0, currentQty - delta)
                                await inventoryService.updateInventoryLevels({
                                    id: levels[0]?.id as string,
                                    inventory_item_id: invItemId,
                                    location_id: locationId,
                                    stocked_quantity: newQty,
                                } as any)
                                logger.info(`[damaged update] Variant ${dbItem.variant_id}: stock ${currentQty} → ${newQty} (damaged delta: +${delta})`)
                            }
                        }
                    }
                } catch (invErr: any) {
                    logger.warn(`[damaged update] Inventory adjustment failed for variant ${dbItem.variant_id}: ${invErr.message}`)
                }
            }

            // Persist new damaged_qty on the item row
            await pgConnection('pos_credit_memo_item')
                .where({ id: update.id })
                .update({ damaged_qty: newDamaged })
        }

        // Rebuild pos_damaged_item tracking records for this CM
        await pgConnection('pos_damaged_item').where({ credit_memo_id: id }).delete()

        const updatedItems = await creditMemoService.listPosCreditMemoItems({ credit_memo_id: id })
        const damagedRows = (updatedItems as any[])
            .filter((item: any) => (item.damaged_qty || 0) > 0)
            .map((item: any) => ({
                id:            randomUUID(),
                credit_memo_id: id,
                order_id:      creditMemo.order_id || null,
                variant_id:    item.variant_id || null,
                sku:           item.sku || null,
                title:         item.title || null,
                quantity:      item.damaged_qty,
                unit_price:    item.unit_price || 0,
                created_at:    new Date(),
            }))

        if (damagedRows.length > 0) {
            await pgConnection('pos_damaged_item').insert(damagedRows)
        }

        logger.info(`[damaged update] CM ${id}: ${items.length} item(s) updated, ${damagedRows.length} damaged record(s) logged`)
        res.status(200).json({ success: true, message: "Damaged quantities updated and inventory adjusted" })

    } catch (e: any) {
        logger.error(`[damaged update] failed: ${e.message}`)
        res.status(500).json({ success: false, message: e.message })
    }
}
