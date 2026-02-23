import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

/**
 * DRY RUN — Customer Sync
 * Shows what would be imported/skipped without writing to DB.
 *
 * QB Bridge takes ~10 min to process 7200 customers.
 * Script polls every 2 minutes, up to 8 attempts (16 min max).
 *
 * Run with: npx medusa exec ./src/scripts/diagnostics/dry-run-customer-sync.ts
 */

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://ecopower-qb.loca.lt"
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const INITIAL_WAIT_MS = 2 * 60 * 1000   // 2 minutes before first poll
const POLL_INTERVAL_MS = 2 * 60 * 1000  // 2 minutes between polls
const MAX_POLL_ATTEMPTS = 8              // up to 16 minutes total

export default async function dryRunCustomerSync({ container }: ExecArgs) {
    const logger = container.resolve("logger")
    const customerModule = container.resolve(Modules.CUSTOMER)

    logger.info("=== DRY RUN: Customer Sync ===")
    logger.info(`Bridge URL: ${BRIDGE_URL}`)
    logger.info("(No changes will be written to the database)\n")

    // 1. Fetch QB customers
    logger.info("📡 Requesting Customer Data from Bridge...")
    const initRes = await fetch(`${BRIDGE_URL}/api/customers?MaxReturned=99999&ActiveStatus=All`, {
        headers: { "x-api-key": API_KEY }
    })

    if (!initRes.ok) {
        logger.error(`❌ Bridge Error: ${initRes.status} ${initRes.statusText}`)
        return
    }

    const initJson: any = await initRes.json()
    const operationId = initJson.operationId
    logger.info(`✅ Operation Queued! ID: ${operationId}`)
    logger.info(`⏳ Waiting 2 minutes before first poll (7200 customers take time)...`)

    // Wait 2 minutes before first poll
    await new Promise(r => setTimeout(r, INITIAL_WAIT_MS))

    // 2. Poll for results — QB processes the large dataset, response download also takes time
    let qbCustomers: any[] = []
    let attempts = 0
    let rawStatus: any = null

    while (attempts < MAX_POLL_ATTEMPTS) {
        attempts++
        logger.info(`⏳ Polling (${attempts}/${MAX_POLL_ATTEMPTS}) — waiting for QB to complete...`)

        try {
            const statusRes = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
                headers: { "x-api-key": API_KEY }
            })

            if (!statusRes.ok) {
                logger.warn(`   Bridge poll error: ${statusRes.status}`)
                await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
                continue
            }

            rawStatus = await statusRes.json()
            const opStatus = rawStatus.operation?.status || "unknown"
            logger.info(`   Status: ${opStatus}`)

            if (rawStatus.success && rawStatus.operation?.status === "completed") {
                // Bridge stores results in operation.result (xml2js parsed QBXML)
                const raw = rawStatus.operation?.result?.QBXML?.QBXMLMsgsRs?.CustomerQueryRs?.CustomerRet
                qbCustomers = !raw ? [] : Array.isArray(raw) ? raw : [raw]
                logger.info(`✅ Data received! ${qbCustomers.length} QB customers`)
                break
            }

            if (rawStatus.operation?.status === "failed") {
                logger.error(`❌ QB sync failed: ${rawStatus.operation.error}`)
                return
            }

        } catch (err: any) {
            logger.warn(`   Error during poll: ${err.message}`)
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    }

    if (qbCustomers.length === 0) {
        logger.error("❌ No customer data received from QB after all polling attempts")
        logger.info(`Last raw status (non-data fields): ${JSON.stringify({
            success: rawStatus?.success,
            operation: rawStatus?.operation,
            dataType: typeof rawStatus?.data,
            dataLength: Array.isArray(rawStatus?.data) ? rawStatus.data.length : "not array",
            keys: rawStatus ? Object.keys(rawStatus) : []
        }, null, 2)}`)
        return
    }

    // 3. Fetch existing Medusa customers
    logger.info("\n🔍 Fetching existing Medusa customers...")
    const [medusaCustomers] = await customerModule.listAndCountCustomers(
        {},
        { take: 50000, select: ["id", "email", "metadata"] }
    )
    logger.info(`📊 ${medusaCustomers.length} customers already in Medusa`)

    const existingQbIds = new Set(
        medusaCustomers
            .filter((c: any) => c.metadata?.qb_list_id)
            .map((c: any) => c.metadata.qb_list_id)
    )
    const existingEmails = new Set(
        medusaCustomers.map((c: any) => c.email?.toLowerCase()).filter(Boolean)
    )

    // 4. Analyze
    const alreadySynced: any[] = []
    const wouldImport: any[] = []
    const dummyEmail: any[] = []

    for (const qb of qbCustomers) {
        const hasRealEmail = qb.Email?.trim() && qb.Email.includes("@")
        const dummyEmailAddress = `customer-${qb.ListID}@ecopowertech.com`
        const foundById = existingQbIds.has(qb.ListID)
        const foundByEmail = hasRealEmail
            ? existingEmails.has(qb.Email.toLowerCase().trim())
            : existingEmails.has(dummyEmailAddress)

        if (foundById || foundByEmail) {
            alreadySynced.push(qb)
        } else {
            if (!hasRealEmail) dummyEmail.push(qb)
            wouldImport.push(qb)
        }
    }

    // 5. Report
    logger.info(`\n${"=".repeat(60)}`)
    logger.info("DRY RUN RESULTS")
    logger.info(`${"=".repeat(60)}`)
    logger.info(`Total in QB:            ${qbCustomers.length}`)
    logger.info(`Already in Medusa:      ${alreadySynced.length}`)
    logger.info(`Would import (new):     ${wouldImport.length}`)
    logger.info(`  - With real email:    ${wouldImport.length - dummyEmail.length}`)
    logger.info(`  - With dummy email:   ${dummyEmail.length}`)
    logger.info(`${"=".repeat(60)}\n`)

    if (wouldImport.length > 0) {
        logger.info(`📋 Sample (first 20 that would be imported):`)
        for (const qb of wouldImport.slice(0, 20)) {
            const email = qb.Email?.trim() || `[dummy] customer-${qb.ListID}@ecopowertech.com`
            logger.info(`   - ${qb.Name} | ${email} | ${qb.PriceLevelRef?.FullName || "no price level"}`)
        }
        if (wouldImport.length > 20) logger.info(`   ... and ${wouldImport.length - 20} more`)
    } else {
        logger.info("✅ All QB customers are already in Medusa — nothing to import!")
    }

    // Price level breakdown
    const priceLevelCounts: Record<string, number> = {}
    for (const qb of qbCustomers) {
        const pl = qb.PriceLevelRef?.FullName || "none"
        priceLevelCounts[pl] = (priceLevelCounts[pl] || 0) + 1
    }
    logger.info("\n📊 Price Level Breakdown (all QB customers):")
    for (const [level, count] of Object.entries(priceLevelCounts).sort((a, b) => b[1] - a[1])) {
        logger.info(`   ${level}: ${count}`)
    }

    logger.info("\n✅ DRY RUN complete. No changes were made.")
}
