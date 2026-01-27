import { ExecArgs } from "@medusajs/framework/types"
import { ICustomerModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function verifyCustomerIntegrity({ container }: ExecArgs) {
    const customerService: ICustomerModuleService = container.resolve(Modules.CUSTOMER)

    console.log("🔍 Starting Customer Data Integrity Verification...")

    // 1. Fetch all customers (batching if necessary, but 7k is manageable in memory for analysis scripts usually, 
    // but good practice to iterate. For simplicity/speed here we'll take a large limit)
    const [customers, count] = await customerService.listAndCountCustomers(
        {},
        {
            take: 10000,
            select: ["id", "email", "first_name", "last_name", "metadata", "groups"],
            relations: ["groups", "addresses"]
        }
    )

    console.log(`📊 Total Customers: ${count}`)
    console.log(`---------------------------------------------------`)

    let stats = {
        total: count,
        validEmails: 0,
        placeholderEmails: 0,
        invalidEmails: 0,
        missingQbId: 0,
        missingQbType: 0,
        missingQbPriceLevel: 0,
        assignedToGroup: 0,
        assignedToWholesale: 0,
        assignedToRetail: 0,
        orphanedFromGroups: 0,
        withAddress: 0,
        withoutAddress: 0,
        priceLevelMismatches: 0
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

    for (const c of customers) {
        // 1. Email Checks
        const isPlaceholder = c.email.endsWith("@ecopowertech.com") && c.metadata?.email_is_placeholder === true
        const isValidFormat = emailRegex.test(c.email)

        if (isPlaceholder) {
            stats.placeholderEmails++
        } else if (isValidFormat) {
            stats.validEmails++
        } else {
            stats.invalidEmails++
            // console.log(`   ❌ Invalid Email: ${c.email} (ID: ${c.id})`)
        }

        // 2. Metadata Checks
        if (!c.metadata?.qb_list_id) stats.missingQbId++
        if (!c.metadata?.qb_customer_type) stats.missingQbType++

        const qbPriceLevel = c.metadata?.qb_price_level as string
        if (!qbPriceLevel) stats.missingQbPriceLevel++

        // 3. Group Checks
        // Note: groups relations might need explicit loading depending on config, but listAndCount with relations should work
        const groups = c.groups || []
        const groupNames = groups.map(g => g.name)

        if (groups.length > 0) {
            stats.assignedToGroup++
            if (groupNames.includes("Wholesale Customers")) stats.assignedToWholesale++
            if (groupNames.includes("Retail Customers")) stats.assignedToRetail++
        } else {
            stats.orphanedFromGroups++
        }

        // Check Logic: Wholesale Price Level should be in Wholesale Group
        if (qbPriceLevel) {
            const isWholesaleLevel = ["Wholesale", "Distributor"].includes(qbPriceLevel)
            const isRetailLevel = ["Retail", "Standard"].includes(qbPriceLevel)

            const inWholesaleGroup = groupNames.includes("Wholesale Customers")
            const inRetailGroup = groupNames.includes("Retail Customers")

            if (isWholesaleLevel && !inWholesaleGroup) {
                stats.priceLevelMismatches++
                // console.log(`   ⚠️ Mismatch: Level ${qbPriceLevel} but not in Wholesale Group (ID: ${c.metadata?.qb_list_id})`)
            }
            if (isRetailLevel && !inRetailGroup) {
                // Technically Retail Level could be in Wholesale group? Probably not reverse.
                // Strict check:
                if (!inRetailGroup && !inWholesaleGroup) {
                    // Just orphaned, tracked elsewhere
                } else if (!inRetailGroup) {
                    stats.priceLevelMismatches++
                }
            }
        }

        // 4. Address Checks
        if (c.addresses && c.addresses.length > 0) {
            stats.withAddress++
        } else {
            stats.withoutAddress++
        }
    }

    // Report
    console.log(`📧 Email Health:`)
    console.log(`   Real Emails: ${stats.validEmails} (${((stats.validEmails / count) * 100).toFixed(1)}%)`)
    console.log(`   Placeholders: ${stats.placeholderEmails} (${((stats.placeholderEmails / count) * 100).toFixed(1)}%)`)
    console.log(`   Invalid Formats: ${stats.invalidEmails}`)

    console.log(`\n🏷️  QuickBooks Metadata:`)
    console.log(`   Missing ListID: ${stats.missingQbId}`)
    console.log(`   Missing CustomerType: ${stats.missingQbType}`)
    console.log(`   Missing PriceLevel: ${stats.missingQbPriceLevel}`)

    console.log(`\n👥 Customer Groups:`)
    console.log(`   Assigned: ${stats.assignedToGroup}`)
    console.log(`   Orphaned: ${stats.orphanedFromGroups}`)
    console.log(`   - Wholesale: ${stats.assignedToWholesale}`)
    console.log(`   - Retail: ${stats.assignedToRetail}`)
    if (stats.priceLevelMismatches > 0) {
        console.log(`   ⚠️ Logic Mismatches (Level vs Group): ${stats.priceLevelMismatches}`)
    }

    console.log(`\n📍 Addresses:`)
    console.log(`   With Address: ${stats.withAddress} (${((stats.withAddress / count) * 100).toFixed(1)}%)`)
    console.log(`   Without Address: ${stats.withoutAddress}`)

    const passed = stats.invalidEmails === 0 && stats.missingQbId === 0 && stats.orphanedFromGroups === 0
    console.log(`\n---------------------------------------------------`)
    if (passed) {
        console.log(`✅ VERIFICATION PASSED: Data integrity looks good.`)
    } else {
        console.log(`❌ VERIFICATION FAILED: See errors above.`)
    }
}
