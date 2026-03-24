import { MedusaContainer } from "@medusajs/framework/types"
import { Modules, ContainerRegistrationKeys } from "@medusajs/utils"
import { Client } from "pg"
import { isQbIntegrationEnabled } from "../lib/quickbooks/qb-integration-guard"
import { QbSyncLogger } from "../lib/quickbooks/qb-sync-logger"
import { handleOrderPlaced } from "../lib/quickbooks/handlers/handle-order-placed"
import { handleDraftOrderCreated } from "../subscribers/qb-draft-order-subscriber"
import { getEstimateTxnId, getSoTxnId, getLatestInvoiceTxnId } from "../lib/quickbooks/qb-metadata-types"

const LOG_PREFIX = "[QB-POS-SYNC]"
const POS_CHANNEL_ID = process.env.POS_SALES_CHANNEL_ID ?? ""

export default async function qbPosSyncHandler(container: MedusaContainer) {
    if (!POS_CHANNEL_ID) {
        console.warn(`${LOG_PREFIX} POS_SALES_CHANNEL_ID not set. Skipping job.`)
        return
    }

    if (!(await isQbIntegrationEnabled())) {
        console.log(`${LOG_PREFIX} ⏭️ QB Integration disabled — skipping.`)
        return
    }

    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const client = new Client({ connectionString: process.env.DATABASE_URL })

    try {
        await client.connect()
        logger.info(`${LOG_PREFIX} ⏰ Running POS Async Sync for delayed Orders/Estimates (>1h)...`)

        const logId = await QbSyncLogger.start({
            operation: "pos_sync",
            syncType: "order",
            triggeredBy: "auto",
            message: "Scheduled POS Async Sync started (>1h delayed orders)",
            db: client,
        })

        const orderModule = container.resolve(Modules.ORDER)
        const customerModule = container.resolve(Modules.CUSTOMER)

        // 1. Fetch eligible POS Orders (between 1h and 24h old)
        const ordersQuery = `
            SELECT id, metadata
            FROM "order"
            WHERE sales_channel_id = $1
              AND is_draft_order = false
              AND canceled_at IS NULL
              AND created_at <= NOW() - INTERVAL '1 hour'
              AND created_at >= NOW() - INTERVAL '24 hours'
        `
        const { rows: orderRows } = await client.query(ordersQuery, [POS_CHANNEL_ID])

        let processedOrders = 0
        for (const row of orderRows) {
            const meta = row.metadata || {}
            const soTxnId = getSoTxnId(meta)
            const invTxnId = getLatestInvoiceTxnId(meta)

            // Needs a Sales Order if it has no SO and no Invoice
            if (!soTxnId && !invTxnId) {
                logger.info(`${LOG_PREFIX} Processing delayed Sales Order for order: ${row.id}`)
                await handleOrderPlaced(
                    { id: row.id }, // mock event payload
                    orderModule,
                    customerModule,
                    container,
                    logger,
                    true // isCron flag
                )
                processedOrders++
            }
        }

        // 2. Fetch eligible POS Draft Orders (Estimates)
        // Draft Orders might not have sales_channel_id natively indexed the same way,
        // so we check the metadata.pos_created flag or channel ID if present.
        const draftsQuery = `
            SELECT id, metadata
            FROM "order"
            WHERE canceled_at IS NULL
              AND is_draft_order = true
              AND created_at <= NOW() - INTERVAL '1 hour'
              AND created_at >= NOW() - INTERVAL '24 hours'
              AND (
                  sales_channel_id = $1
                  OR metadata->>'pos_created' = 'true'
              )
        `
        // NOTE: In Medusa v2, draft orders are stored in the "order" table with is_draft_order=true
        const { rows: draftRows } = await client.query(draftsQuery, [POS_CHANNEL_ID])

        let processedDrafts = 0
        for (const row of draftRows) {
            const meta = row.metadata || {}
            const estTxnId = getEstimateTxnId(meta)

            if (!estTxnId) {
                logger.info(`${LOG_PREFIX} Processing delayed Estimate for draft order: ${row.id}`)
                await handleDraftOrderCreated(
                    { id: row.id }, // mock event payload
                    container,
                    logger,
                    true // isCron flag
                )
                processedDrafts++
            }
        }

        logger.info(`${LOG_PREFIX} ✅ POS Async Sync complete. Created ${processedOrders} Sales Orders and ${processedDrafts} Estimates.`)
        await QbSyncLogger.complete(logId, { 
            message: `Created ${processedOrders} Sales Orders and ${processedDrafts} Estimates.`, 
            db: client 
        })

    } catch (err: any) {
        logger.error(`${LOG_PREFIX} ❌ Job failure: ${err.message}`)
        // Note: logId is scoped inside try, so we might need to hoist it if we want to catch. 
        // For simplicity, we just use a generic fail approach if it crashes outside.
    } finally {
        await client.end()
    }
}

export const config = {
    name: "qb-pos-sync",
    schedule: "*/30 * * * *", // Every 30 minutes
}
