import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { CREDIT_MEMO_MODULE } from "../../../../../../modules/credit_memos"
import CreditMemoModuleService from "../../../../../../modules/credit_memos/service"
import { Modules } from "@medusajs/utils"
import { createCreditMemoInQb } from "../../../../../../lib/quickbooks/client"
import { ensureCustomerInQb } from "../../../../../../lib/quickbooks/order-flow-core"
import { FINANCE_MODULE } from "../../../../../../modules/finance"
import { writePipelineRow } from "../../../../../../lib/quickbooks/qb-pipeline"

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const logger = req.scope.resolve("logger")
    const creditMemoService: CreditMemoModuleService = req.scope.resolve(CREDIT_MEMO_MODULE)
    const inventoryService = req.scope.resolve(Modules.INVENTORY)
    const stockLocationService = req.scope.resolve(Modules.STOCK_LOCATION)
    const customerModule = req.scope.resolve(Modules.CUSTOMER)
    const financeService = req.scope.resolve(FINANCE_MODULE) as any
    
    const { id } = req.params as { id: string }
    
    try {
        const creditMemo = await creditMemoService.retrievePosCreditMemo(id, {
            relations: ["items"]
        }) as any

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
                
                try {
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

        // -- QUICKBOOKS SYNC BEGIN --
        let qbOperationId = null
        try {
            if (creditMemo.customer_id) {
                // Ensure customer in QB
                const customer = await customerModule.retrieveCustomer(creditMemo.customer_id, { relations: ["addresses"] })
                const custResult: any = await ensureCustomerInQb(customer, customerModule, (m: string) => logger.info(m))
                
                if (custResult.success && custResult.qbCustomerId) {
                    const qbCustomerId = custResult.qbCustomerId
                    
                    // Map items for QB Payload
                    const qbItems = creditMemo.items.map((item: any) => ({
                        productId: item.variant_id || item.product_id, // QB matcher falls back nicely
                        productName: item.title,
                        quantity: item.quantity,
                        price: item.unit_price,
                        amount: item.quantity * item.unit_price,
                        desc: item.title
                    }))

                    logger.info(`[credit_memos complete] Mirroring Credit Memo to QB for customer ${qbCustomerId}...`)
                    const cmResult = await createCreditMemoInQb({
                        customerId: qbCustomerId,
                        date: new Date().toISOString().split('T')[0],
                        refNumber: creditMemo.credit_memo_number ? `CM-${creditMemo.credit_memo_number}` : `CM-${creditMemo.id.slice(-6)}`,
                        memo: `Medusa POS Credit Memo`,
                        items: qbItems
                    })

                    if (cmResult.success && cmResult.data?.operationId) {
                        qbOperationId = cmResult.data.operationId
                        logger.info(`[credit_memos complete] QB Sync queued: ${qbOperationId}`)

                        // Record credit_memo step in pipeline
                        try {
                            await writePipelineRow({
                                referenceId:   id,
                                referenceType: "credit_memo",
                                step:          "credit_memo",
                                status:        "submitted",
                                bridgeOpId:    qbOperationId,
                                qbRefNumber:   creditMemo.credit_memo_number ? `CM-${creditMemo.credit_memo_number}` : null,
                            })
                        } catch (pErr: any) {
                            logger.warn(`[credit_memos complete] Could not write pipeline row: ${pErr.message}`)
                        }
                    } else {
                        logger.error(`[credit_memos complete] QB Sync failed: ${cmResult.error}`)

                        // Record failure in pipeline
                        try {
                            await writePipelineRow({
                                referenceId:   id,
                                referenceType: "credit_memo",
                                step:          "credit_memo",
                                status:        "failed",
                                error:         cmResult.error || "QB credit memo creation failed",
                            })
                        } catch (pErr: any) {
                            logger.warn(`[credit_memos complete] Could not write pipeline row: ${pErr.message}`)
                        }
                    }
                }
            }
        } catch (qbErr: any) {
            logger.error(`[credit_memos complete] QuickBooks sync execution error: ${qbErr.message}`)
        }
        // -- QUICKBOOKS SYNC END --

        // Mark Credit Memo as completed
        await creditMemoService.updatePosCreditMemoes({
            id,
            status: 'completed',
            completed_at: new Date()
        })

        // -- AR LEDGER SYNC BEGIN --
        // Register a Finance Ledger entry based on the chosen refund method:
        //   store_credit → type:'credit_memo', status:'available'  (credit for future purchases)
        //   refund       → type:'refund',      status:'applied'    (physical refund done by staff)
        const { refund_method } = req.body as { refund_method?: string }
        const isStoreCredit = !refund_method || refund_method === 'store_credit'

        if (creditMemo.customer_id) {
            try {
                const cmTotal = creditMemo.total || creditMemo.subtotal
                    || creditMemo.items.reduce((sum: number, i: any) => sum + (i.quantity * i.unit_price), 0)

                const pgConnection = req.scope.resolve("__pg_connection__") as any
                const seqPgRes = await pgConnection.raw(`SELECT nextval('custom_payment_seq') AS seq`)
                    .catch(() => ({ rows: [{ seq: null }] }))
                const nextPayNum = seqPgRes.rows[0]?.seq || seqPgRes.rows[0]?.SEQ
                    ? Number(seqPgRes.rows[0].seq || seqPgRes.rows[0].SEQ)
                    : null

                const cmRef = creditMemo.credit_memo_number
                    ? `CM-${creditMemo.credit_memo_number}`
                    : `CM-${creditMemo.id.slice(-6)}`

                await financeService.createCustomerPayments({
                    customer_id: creditMemo.customer_id,
                    display_id:  nextPayNum,
                    amount:      cmTotal,
                    method:      isStoreCredit ? 'credit_memo' : 'refund',
                    reference:   cmRef,
                    notes:       isStoreCredit
                        ? `Store Credit generated from Return/Credit Memo`
                        : `Refund — to be processed manually by staff`,
                    received_at: new Date(),
                    created_by:  'system',
                    source:      'pos',
                    type:        isStoreCredit ? 'credit_memo' : 'refund',
                    status:      isStoreCredit ? 'available' : 'applied',
                    medusa_payment_synced: false,
                })

                logger.info(
                    `[credit_memos complete] Registered $${cmTotal} as '${isStoreCredit ? 'store_credit' : 'refund'}' ` +
                    `in Finance Ledger for customer ${creditMemo.customer_id}`
                )

                // If this is a physical cash refund → queue a write_check pipeline row
                // (the write_check is issued manually by staff in QB, but we track the intent)
                if (!isStoreCredit) {
                    try {
                        await writePipelineRow({
                            referenceId:   id,
                            referenceType: "credit_memo",
                            step:          "write_check",
                            status:        "pending",
                            error:         null,
                        })
                        logger.info(`[credit_memos complete] Queued write_check pipeline row for cash refund`)
                    } catch (pErr: any) {
                        logger.warn(`[credit_memos complete] Could not write write_check pipeline row: ${pErr.message}`)
                    }
                }
            } catch (finErr: any) {
                logger.error(`[credit_memos complete] Failed to create Finance Ledger record: ${finErr.message}`)
            }
        }
        // -- AR LEDGER SYNC END --

        res.status(200).json({ success: true, message: "Credit Memo completed and inventory restocked" })

    } catch (e: any) {
        logger.error(`[credit_memos complete] failed: ${e.message}`)
        res.status(500).json({ success: false, message: e.message })
    }
}
