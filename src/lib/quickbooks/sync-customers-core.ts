import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ICustomerModuleService } from "@medusajs/types"
import { isQbIntegrationEnabled } from "./qb-integration-guard"

// Config — from env vars
const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://ecopower-qb.loca.lt"
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const POLL_INTERVAL_MS = 2 * 60 * 1000  // 2 minutes — 7200 customers take time to process
const INITIAL_WAIT_MS = 2 * 60 * 1000   // wait 2 min before first poll
const MAX_POLL_ATTEMPTS = 8              // up to 16 min total

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
export async function syncCustomersCore(
    container: any,
    options: { onLog?: (line: string) => void } = {}
): Promise<SyncCustomersResult> {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const customerModule: ICustomerModuleService = container.resolve(Modules.CUSTOMER)
    const log = (line: string) => { logger.info(line); options.onLog?.(line) }
    const warn = (line: string) => { logger.warn(line); options.onLog?.(`⚠️ ${line}`) }

    const stats = {
        totalInQb: 0,
        alreadyInMedusa: 0,
        imported: 0,
        errors: 0
    }

    try {
        // Master integration kill switch
        if (!(await isQbIntegrationEnabled())) {
            logger.info("[QB] Integration is DISABLED. Skipping customer sync.")
            return {
                success: false,
                stats: { totalInQb: 0, alreadyInMedusa: 0, imported: 0, errors: 0 },
                error: "QB integration is disabled"
            }
        }
        logger.info(`👥 Starting QuickBooks Customer Sync...`)
        logger.info(`⏰ Sync initiated: ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short' })}`)

        // 1. Fetch QB Customers
        logger.info("📡 Requesting Customer Data from Bridge...")
        const initRes = await fetch(`${BRIDGE_URL}/api/customers?MaxReturned=99999&ActiveStatus=All`, {
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

        // 2. Poll for Results (7200 customers = QB takes ~10 min to process)
        let qbCustomers: any[] = []
        let attempts = 0

        // Wait before first poll — QB needs time to pull all 7200 customers
        log(`⏳ Waiting 2 minutes before first poll (large dataset)...`)
        await new Promise(r => setTimeout(r, INITIAL_WAIT_MS))

        while (attempts < MAX_POLL_ATTEMPTS) {
            attempts++
            log(`⏳ Polling Status (${attempts}/${MAX_POLL_ATTEMPTS})...`)

            const statusRes = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
                headers: { "x-api-key": API_KEY }
            })

            if (!statusRes.ok) {
                warn(`   Bridge Status Error: ${statusRes.status}`)
                await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
                continue
            }

            const statusJson: any = await statusRes.json()

            if (statusJson.success && statusJson.operation) {
                if (statusJson.operation.status === "completed") {
                    // Data is in operation.result.QBXML.QBXMLMsgsRs.CustomerQueryRs.CustomerRet
                    // (xml2js parsed QB XML, explicitArray: false — single item = object, multi = array)
                    const raw = statusJson.operation.result?.QBXML?.QBXMLMsgsRs?.CustomerQueryRs?.CustomerRet
                    qbCustomers = !raw ? [] : Array.isArray(raw) ? raw : [raw]
                    log(`✅ Data Received! ${qbCustomers.length} customers from QuickBooks.`)
                    break
                }

                if (statusJson.operation.status === "failed") {
                    const error = `QB sync failed: ${statusJson.operation.error || "Unknown"}`
                    logger.error(`❌ ${error}`)
                    return { success: false, stats, error }
                }

                log(`   Status: ${statusJson.operation.status} — waiting...`)
            }

            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
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

                // Map price level: All non-wholesale are Retail, Distributor -> Wholesale
                const qbPriceLevel = (qb.PriceLevelRef?.FullName || qb.PriceLevel || '').toLowerCase()
                const priceLevel = (qbPriceLevel.includes('wholesale') || qbPriceLevel.includes('distributor')) ? "Wholesale" : "Retail"
                const customerType = qb.CustomerTypeRef?.FullName || qb.CustomerType || ''

                await customerModule.createCustomers({
                    email,
                    first_name: firstName,
                    last_name: lastName,
                    company_name: qb.CompanyName || null,
                    phone: qb.Phone || null,
                    has_account: false,
                    metadata: {
                        qb_list_id: qb.ListID,
                        qb_display_name: qb.Name,
                        qb_customer_type: customerType,
                        qb_price_level: priceLevel,
                        email_is_placeholder: isDummyEmail,
                        qb_original_email: isDummyEmail ? qb.Email || '' : email
                    }
                })

                stats.imported++

                if (stats.imported % 50 === 0) {
                    log(`   ✅ Progress: ${stats.imported} customers imported...`)
                }

            } catch (err: any) {
                warn(`   ❌ Failed to import ${qb.Email}: ${err.message}`)
                stats.errors++
            }
        }

        log(`\n${"=".repeat(50)}`)
        log("✅ CUSTOMER SYNC SUMMARY")
        log(`${"-".repeat(50)}`)
        log(`Total in QB:           ${stats.totalInQb}`)
        log(`Already in Medusa:     ${stats.alreadyInMedusa}`)
        log(`Newly Imported:        ${stats.imported}`)
        log(`Errors:                ${stats.errors}`)
        log(`${"=".repeat(50)}\n`)

        return { success: true, stats }

    } catch (error: any) {
        logger.error(`❌ Sync failed: ${error.message}`)
        return { success: false, stats, error: error.message }
    }
}
