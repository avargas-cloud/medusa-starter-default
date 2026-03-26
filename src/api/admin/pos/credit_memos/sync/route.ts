import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { CREDIT_MEMO_MODULE } from "../../../../../modules/credit_memos"
import CreditMemoModuleService from "../../../../../modules/credit_memos/service"

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const logger = req.scope.resolve("logger")
    const creditMemoService: CreditMemoModuleService = req.scope.resolve(CREDIT_MEMO_MODULE)
    
    try {
        const { id, payload, items, totals, action } = req.body as any

        let resolvedId = id
        
        // Cents conversion for DB storage
        const dbTotals = {
            subtotal: Math.round((totals?.subtotal || 0) * 100),
            discount: Math.round((totals?.totalDiscount || 0) * 100), // POS gives totalDiscount (line + order)
            tax: Math.round((totals?.tax || 0) * 100),
            shipping: Math.round((totals?.shipping || 0) * 100),
            total: Math.round((totals?.total || 0) * 100)
        }

        if (action === "create" || id === "new" || !id || id.startsWith('new:')) {
            const pgConnection = req.scope.resolve("__pg_connection__") as any
            const seqRes = await pgConnection.raw(`SELECT nextval('custom_invoice_seq') AS seq`)
            const nextCmNum = seqRes.rows[0].seq || seqRes.rows[0].SEQ
            const cmNumber = `CM-${nextCmNum}`

            // 1. Create wrapper
            const created = await creditMemoService.createPosCreditMemoes({
                credit_memo_number: cmNumber,
                order_id: payload.order_id || null,
                invoice_id: payload.invoice_id || null,
                customer_id: payload.customer_id || null,
                status: 'draft',
                notes: payload.notes || null,
                ...dbTotals
            })
            
            resolvedId = created.id
            
            // 2. Add Items
            if (items && items.length > 0) {
                const itemsToCreate = items.map((item: any) => ({
                    credit_memo_id: resolvedId,
                    variant_id: item.variantId || null,
                    sku: item.sku || null,
                    title: item.title,
                    description: item.salesDescription || item.title,
                    quantity: item.quantity,
                    unit_price: Math.round((item.effectiveUnitPrice || item.unitPrice) * 100),
                    line_total: Math.round((item.effectiveUnitPrice || item.unitPrice) * 100 * item.quantity)
                }))
                
                await creditMemoService.createPosCreditMemoItems(itemsToCreate)
            }
            
            // No need to update CM number suffix as we used proper pg sequence from the start

        } else {
            // UPDATE EXISTING
            
            await creditMemoService.updatePosCreditMemoes({
                id: resolvedId,
                customer_id: payload.customer_id || null,
                notes: payload.notes || null,
                ...dbTotals
            })
            
            // Re-create items (safest total sync approach, since they have no side effects)
            // First, delete current items
            const existingItems = await creditMemoService.listPosCreditMemoItems({ credit_memo_id: resolvedId })
            if (existingItems.length > 0) {
                await creditMemoService.deletePosCreditMemoItems(existingItems.map((i: any) => i.id))
            }
            
            // Insert new ones
            if (items && items.length > 0) {
                const itemsToCreate = items.map((item: any) => ({
                    credit_memo_id: resolvedId,
                    variant_id: item.variantId || null,
                    sku: item.sku || null,
                    title: item.title,
                    description: item.salesDescription || item.title,
                    quantity: item.quantity,
                    unit_price: Math.round((item.effectiveUnitPrice || item.unitPrice) * 100),
                    line_total: Math.round((item.effectiveUnitPrice || item.unitPrice) * 100 * item.quantity)
                }))
                
                await creditMemoService.createPosCreditMemoItems(itemsToCreate)
            }
        }

        res.status(200).json({ success: true, credit_memo_id: resolvedId })

    } catch (e: any) {
        logger.error(`[credit_memos sync] failed: ${e.message}`)
        res.status(500).json({ success: false, message: e.message })
    }
}
