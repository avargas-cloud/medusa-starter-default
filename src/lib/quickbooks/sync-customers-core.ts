import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ICustomerModuleService } from "@medusajs/types"

// Config
const BRIDGE_URL = "https://ecopower-qb.loca.lt"
const API_KEY = "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const POLL_INTERVAL_MS = 30000
const MAX_POLL_ATTEMPTS = 20

export interface SyncCustomersResult {
    success: boolean
    stats: {
        totalInQb: number
        alreadyInMedusa: number
        imported: number
        errors: number
    }
    error?: string
}

/**
 * Core logic for syncing customers from QuickBooks to Medusa
 * Only imports customers that don't exist in Medusa yet
 * 
 * @NOTE: This is a simplified version. The full import logic from
 * import-customers-from-qb.ts includes address parsing, name parsing, etc.
 * For now, this imports basic customer data and saves for Phase 2.
 */
export async function syncCustomersCore(container: any): Promise<SyncCustomersResult> {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const customerModule: ICustomerModuleService = container.resolve(Modules.CUSTOMER)

    const stats = {
        totalInQb: 0,
        alreadyInMedusa: 0,
        imported: 0,
        errors: 0
    }

    try {
        logger.info(`👥 Starting QuickBooks Customer Sync...`)

        // 1. Fetch QB Customers
        logger.info("📡 Requesting Customer Data from Bridge...")
        const initRes = await fetch(`${BRIDGE_URL}/api/customers`, {
            headers: { "x-api-key": API_KEY }
        })

        if (!initRes.ok) {
            const error = `Bridge Error: ${initRes.status} ${initRes.statusText}`
            logger.error(`❌ ${error}`)
            return { success: false, stats, error }
        }

        const initJson: any = await initRes.json()
        const operationId = initJson.operationId
        logger.info(`✅ Operation Queued! ID: ${operationId}`)

        // 2. Poll for Results
        let qbCustomers: any[] = []
        let attempts = 0

        while (attempts < MAX_POLL_ATTEMPTS) {
            attempts++
            logger.info(`⏳ Polling Status (${attempts}/${MAX_POLL_ATTEMPTS})...`)

            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

            const statusRes = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
                headers: { "x-api-key": API_KEY }
            })

            if (!statusRes.ok) {
                logger.warn(`   Bridge Status Error: ${statusRes.status}`)
                continue
            }

            const statusJson: any = await statusRes.json()

            if (statusJson.success && statusJson.operation) {
                if (statusJson.operation.status === "completed") {
                    qbCustomers = statusJson.data || []
                    logger.info(`✅ Data Received! ${qbCustomers.length} customers from QuickBooks.`)
                    break
                }

                if (statusJson.operation.status === "failed") {
                    const error = `QB sync failed: ${statusJson.operation.error || "Unknown"}`
                    logger.error(`❌ ${error}`)
                    return { success: false, stats, error }
                }
            }
        }

        if (qbCustomers.length === 0) {
            const error = "No customer data received from QB"
            logger.error(`❌ ${error}`)
            return { success: false, stats, error }
        }

        stats.totalInQb = qbCustomers.length

        // 3. Fetch Existing Medusa Customers
        logger.info("🔍 Checking existing customers in Medusa...")
        const [medusaCustomers] = await customerModule.listAndCountCustomers(
            {},
            {
                take: 10000,
                select: ["id", "metadata"]
            }
        )

        const existingQbIds = new Set(
            medusaCustomers
                .filter((c: any) => c.metadata?.qb_list_id)
                .map((c: any) => c.metadata.qb_list_id)
        )

        logger.info(`📊 Found ${existingQbIds.size} customers already in Medusa`)

        // 4. Filter and Import New Customers
        const newCustomers = qbCustomers.filter(c => !existingQbIds.has(c.ListID))
        stats.alreadyInMedusa = qbCustomers.length - newCustomers.length

        logger.info(`\n🔄 Importing ${newCustomers.length} new customers...`)

        for (const qb of newCustomers) {
            try {
                // Basic email handling
                let email = qb.Email?.trim()
                let isDummyEmail = false

                if (!email || !email.includes('@')) {
                    email = `customer-${qb.ListID}@ecopowertech.com`
                    isDummyEmail = true
                }

                // Basic name parsing
                const firstName = qb.FirstName || qb.Name?.split(' ')[0] || 'Customer'
                const lastName = qb.LastName || qb.Name?.split(' ').slice(1).join(' ') || ''

                // Map price level: Standard→Retail, Distributor→Wholesale
                const priceLevel = qb.PriceLevel === "Standard" ? "Retail" :
                    (qb.PriceLevel === "Distributor" ? "Wholesale" : qb.PriceLevel)

                await customerModule.createCustomers({
                    email,
                    first_name: firstName,
                    last_name: lastName,
                    company_name: qb.CompanyName || null,
                    phone: qb.Phone || null,
                    has_account: false,
                    metadata: {
                        qb_list_id: qb.ListID,
                        qb_customer_type: qb.CustomerType,
                        qb_price_level: priceLevel,
                        email_is_placeholder: isDummyEmail,
                        qb_original_email: isDummyEmail ? qb.Email || '' : email
                    }
                })

                stats.imported++

                if (stats.imported % 50 === 0) {
                    logger.info(`   ✅ Progress: ${stats.imported} customers imported...`)
                }

            } catch (err: any) {
                logger.error(`   ❌ Failed to import ${qb.Email}: ${err.message}`)
                stats.errors++
            }
        }

        logger.info(`\n${"=".repeat(50)}`)
        logger.info("✅ CUSTOMER SYNC SUMMARY")
        logger.info(`${"=".repeat(50)}`)
        logger.info(`Total in QB:           ${stats.totalInQb}`)
        logger.info(`Already in Medusa:     ${stats.alreadyInMedusa}`)
        logger.info(`Newly Imported:        ${stats.imported}`)
        logger.info(`Errors:                ${stats.errors}`)
        logger.info(`${"=".repeat(50)}\n`)

        return { success: true, stats }

    } catch (error: any) {
        logger.error(`❌ Sync failed: ${error.message}`)
        return { success: false, stats, error: error.message }
    }
}
