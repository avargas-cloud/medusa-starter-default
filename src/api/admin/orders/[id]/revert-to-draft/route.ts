import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const { id } = req.params

    try {
        const orderService = req.scope.resolve("order")
        const inventoryModule = req.scope.resolve("inventory") as any

        const pgConnection = req.scope.resolve("__pg_connection__") as any

        // 1. Fetch the order
        const orders = await orderService.listOrders({ id }, {
            relations: ["items"]
        })
        const order = orders[0]

        if (!order) {
            return res.status(404).json({ error: "Order not found" })
        }

        // Validate that there are no invoices generated for this order yet to safely revert it
        const invoiceCheck = await pgConnection.raw(`SELECT count(*) as count FROM fin_invoice WHERE order_id = ? AND status != 'voided'`, [order.id])
        if (parseInt(invoiceCheck.rows[0].count, 10) > 0) {
            return res.status(400).json({ error: "Cannot revert an order that has generated invoices" })
        }

        // SEQUENCE CHECK RECOVERY LOGIC
        // Only allow reverting if this order is the most recent one to get an 'S' number
        const meta = (order.metadata || {}) as Record<string, any>
        const docNumber = meta.document_number as string || ""
        
        if (docNumber.startsWith('S')) {
            const numericPart = parseInt(docNumber.replace(/\\D/g, ''), 10)
            if (!isNaN(numericPart)) {
                // Check current sequence value
                const seqRes = await pgConnection.raw(`SELECT last_value FROM custom_order_seq`)
                const lastValue = parseInt(seqRes.rows[0].last_value, 10)
                
                if (lastValue === numericPart) {
                    // It is the absolute latest! We can safely recover the sequence gap
                    await pgConnection.raw(`SELECT setval('custom_order_seq', ?, false)`, [numericPart])
                    console.log(`[revert-to-draft] Recovered sequence custom_order_seq back to ${numericPart}`)
                } else if (numericPart < lastValue) {
                    return res.status(400).json({ error: `Cannot revert Order ${docNumber} since newer Sales Orders have already been sequentially generated.` })
                }
            }
        }

        // 2. Clear out the S sequence and inject the E sequence (E + display_id)
        const newDocNumber = `E${order.display_id}`

        await orderService.updateOrders([
            {
                id: order.id,
                is_draft_order: true,
                status: "draft" as any, // TypeScript expects OrderStatus, but 'draft' is used heavily internally
                metadata: {
                    ...meta,
                    document_number: newDocNumber
                }
            }
        ])

        // 3. Clear existing inventory reservations (from Strategy 1 native fulfillment allocations)
        try {
            for (const item of order.items || []) {
                const existingRes = await inventoryModule.listReservationItems({ line_item_id: item.id })
                if (existingRes?.length > 0) {
                    await inventoryModule.deleteReservationItems(existingRes.map((r: any) => r.id))
                }
            }
        } catch (invErr) {
            console.warn(`[revert-to-draft] Failed to clear reservations for ${id}`, invErr)
        }

        console.log(`[revert-to-draft] ✅ Successfully reverted ${id} back to draft state as ${newDocNumber}`)
        return res.status(200).json({ success: true, document_number: newDocNumber })

    } catch (error: any) {
        console.error(`[revert-to-draft] Error reverting order ${id}:`, error)
        return res.status(500).json({ error: error.message })
    }
}
