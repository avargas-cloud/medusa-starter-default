
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"

const LOG_PREFIX = "📋 [Document Number]"

export default async function documentNumberSubscriber({
    event: { name: eventName, data },
    container,
}: SubscriberArgs<{ id: string }>) {
    const orderId: string = data?.id
    if (!orderId) return

    try {
        const logger = container.resolve("logger")
        const orderModule = container.resolve(Modules.ORDER)
        const pgConnection = container.resolve("__pg_connection__") as any

        // Fetch the full order explicitly for safety to examine metadata
        const order = await orderModule.retrieveOrder(orderId, {
            select: ["id", "status", "metadata", "display_id"],
        })

        if (eventName === "order.updated") {
            // Only assign Estimate sequence if it is a draft
            if (order.status !== "draft") return

            const meta = (order.metadata || {}) as Record<string, any>
            if (meta.document_number) return // Already assigned

            // We simply use Medusa's native display_id prefixed with 'E' since Estimates are temporary 
            // and natively disappear upon conversion anyway. No need to waste a gapless Postgres sequence here.
            const documentNumber = `E${order.display_id}`
            
            logger.info(`${LOG_PREFIX} Assigned ${documentNumber} to Draft Order ${order.id}`)

            await orderModule.updateOrders(order.id, {
                metadata: {
                    ...(order.metadata || {}),
                    document_number: documentNumber
                }
            })
        } 
        else if (eventName === "order.placed") {
            const meta = (order.metadata || {}) as Record<string, any>
            const docNum = meta.document_number as string | undefined
            
            // Skip if it ALREADY has an 'S' number (e.g. was already an order, edited later)
            if (docNum && docNum.startsWith("S")) return
            
            // If it had an 'E' number, it was an estimate. We will OVERWRITE it with an 'S' number,
            // but we'll save the old 'E' number in a new field for historical tracking.
            const oldEstimateNumber = (docNum && docNum.startsWith("E")) ? docNum : null

            // Fetch natively from Postgres sequence using Knex
            const result = await pgConnection.raw(`SELECT nextval('custom_order_seq') AS seq`)
            const nextOrdNum = result.rows[0].seq || result.rows[0].SEQ

            const documentNumber = `S${nextOrdNum}`
            
            logger.info(`${LOG_PREFIX} Assigned ${documentNumber} to Order ${order.id}${oldEstimateNumber ? ` (converted from ${oldEstimateNumber})` : ''}`)

            await orderModule.updateOrders(order.id, {
                metadata: {
                    ...meta,
                    document_number: documentNumber,
                    ...(oldEstimateNumber ? { original_estimate_number: oldEstimateNumber } : {})
                }
            })
        }
    } catch (err: any) {
        console.error(`${LOG_PREFIX} Failed to assign document number: ${err.message}`)
    }
}

export const config: SubscriberConfig = {
    event: [
        "order.updated",
        "order.placed"
    ],
}
