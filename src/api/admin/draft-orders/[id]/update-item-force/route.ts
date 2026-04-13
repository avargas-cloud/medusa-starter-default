import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"

/**
 * POST /admin/draft-orders/:id/update-item-force
 *
 * Updates quantity and/or unit_price of an existing line item in a draft order
 * WITHOUT going through the order-edit workflow (which silently fails for draft orders).
 *
 * Uses orderModule.updateOrderLineItems() directly — pure data layer,
 * bypasses workflow validation including inventory checks.
 *
 * Body: { line_item_id: string, quantity?: number, unit_price?: number, sort_order?: number }
 *
 * NOTE: unit_price should be in DOLLARS (decimal), matching Medusa v2 API convention.
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { line_item_id, quantity, unit_price, sort_order, line_discount, original_unit_price, price_list_id, price_list_label, custom_title, custom_description, attached_image } = req.body as {
        line_item_id: string
        quantity?: number
        unit_price?: number            // effective (post-discount) price in DOLLARS
        sort_order?: number            // 0-indexed display position
        line_discount?: { type: 'percent' | 'fixed'; value: number } | null  // POS discount descriptor
        original_unit_price?: number | null  // pre-discount price for POS rehydration
        price_list_id?: string | null        // Rehydrating retail/wholesale tags
        price_list_label?: string | 'Default' // Rehydrating retail/wholesale tags
        custom_title?: string          // User-edited title for "Special Items"
        custom_description?: string    // User-edited description for "Special Items"
        attached_image?: string | null // base64 JPEG — per-document temp image (does not modify product)
    }

    if (!line_item_id) {
        res.status(400).json({ message: "line_item_id is required" })
        return
    }

    if (quantity === undefined && unit_price === undefined && sort_order === undefined && line_discount === undefined && original_unit_price === undefined && price_list_id === undefined && price_list_label === undefined && custom_title === undefined && custom_description === undefined) {
        res.status(400).json({ message: "At least one field to update is required" })
        return
    }

    try {
        const orderModule = req.scope.resolve(Modules.ORDER) as any

        const updateData: Record<string, any> = {}
        if (quantity !== undefined) updateData.quantity = quantity
        if (unit_price !== undefined) updateData.unit_price = unit_price
        if (custom_title !== undefined) {
            updateData.title = custom_title
            updateData.product_title = custom_title // Keep denormalized field in sync
        }

        // Persist sort_order, line_discount, and original_unit_price in metadata.
        // Always merge with existing metadata to avoid overwriting sales_description or other keys.
        const needsMetadataUpdate = sort_order !== undefined || line_discount !== undefined || original_unit_price !== undefined || price_list_id !== undefined || price_list_label !== undefined || custom_description !== undefined || attached_image !== undefined
        if (needsMetadataUpdate) {
            let existingMeta: Record<string, any> = {}
            if (typeof orderModule.retrieveOrderLineItem === "function") {
                try {
                    const existing = await orderModule.retrieveOrderLineItem(line_item_id)
                    existingMeta = existing?.metadata ?? {}
                } catch { /* ignore — will overwrite gracefully */ }
            }
            updateData.metadata = {
                ...existingMeta,
                ...(sort_order !== undefined ? { sort_order } : {}),
                ...(custom_description !== undefined ? { sales_description: custom_description } : {}),
                // null explicitly clears the key (discount removed); undefined = no change
                ...(line_discount !== undefined ? { line_discount: line_discount ?? null } : {}),
                ...(original_unit_price !== undefined ? { original_unit_price: original_unit_price ?? null } : {}),
                ...(price_list_id !== undefined ? { price_list_id: price_list_id ?? null } : {}),
                ...(price_list_label !== undefined ? { price_list_label: price_list_label ?? null } : {}),
                ...(attached_image !== undefined ? { attached_image: attached_image ?? null } : {}),
            }
        }
        if (typeof orderModule.updateOrderLineItems === "function") {
            await orderModule.updateOrderLineItems(line_item_id, updateData)
            console.log(`[update-item-force] updateOrderLineItems OK: ${line_item_id} → qty=${quantity} price=${unit_price}`)
            res.status(200).json({ success: true, method: "updateOrderLineItems" })
            return
        }

        if (typeof orderModule.updateLineItems === "function") {
            await orderModule.updateLineItems([{ id: line_item_id, ...updateData }])
            console.log(`[update-item-force] updateLineItems OK: ${line_item_id}`)
            res.status(200).json({ success: true, method: "updateLineItems" })
            return
        }

        res.status(500).json({ message: "No suitable update method found on order module" })
    } catch (e: any) {
        console.error("[update-item-force] Error:", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to update item" })
    }
}
