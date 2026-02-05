import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import * as fs from "fs"
import * as path from "path"

export default async function importCustomers({ container, args }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const customerModule = container.resolve(Modules.CUSTOMER)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    const csvFileName = "customers_import.csv"
    const csvPath = path.resolve(process.cwd(), csvFileName)

    if (!fs.existsSync(csvPath)) {
        logger.error(`❌ File not found: ${csvPath}`)
        logger.info(`Please create a file named '${csvFileName}' with columns:`)
        logger.info(`Email,FirstName,LastName,QuickBooksID,CompanyName,Phone`)
        return
    }

    logger.info(`📂 Reading CSV: ${csvPath}`)
    const content = fs.readFileSync(csvPath, "utf-8")
    // Handle BOM
    const cleanContent = content.replace(/^\uFEFF/, '')
    const lines = cleanContent.split("\n").filter(l => l.trim().length > 0)

    // Skip header if present
    const startRow = lines[0].toLowerCase().includes("email") ? 1 : 0
    const dataRows = lines.slice(startRow)

    logger.info(`📊 Found ${dataRows.length} customers to process`)

    let created = 0
    let skipped = 0
    let updated = 0
    let errors = 0

    for (const row of dataRows) {
        // Basic CSV split by comma (assuming no commas in fields for MVP)
        // Ideally use a CSV parser library if fields contain commas
        const cols = row.split(",").map(c => c.trim().replace(/^"|"$/g, ''))

        if (cols.length < 1) continue

        const email = cols[0]
        const firstName = cols[1] || ""
        const lastName = cols[2] || ""
        const qbId = cols[3] || ""
        const company = cols[4] || ""
        const phone = cols[5] || ""

        if (!email || !email.includes("@")) {
            logger.warn(`⚠️ Invalid email in row: ${row}`)
            skipped++
            continue
        }

        try {
            // Check if exists
            const { data: existing } = await query.graph({
                entity: "customer",
                fields: ["id", "email", "metadata"],
                filters: { email: email }
            })

            if (existing.length > 0) {
                const cust = existing[0]

                // Only update if missing QB ID or needs flag update?
                // Strategy: If existing, maybe they are already active, so we DON'T set the flag?
                // Or if we are syncing, we might want to add the QB ID.

                const currentMeta = cust.metadata || {}
                let needsUpdate = false

                const newMeta = { ...currentMeta }

                if (qbId && currentMeta.quickbooks_id !== qbId) {
                    newMeta.quickbooks_id = qbId
                    needsUpdate = true
                }

                // NOTE: If they already exist, we assume they might be active 
                // or previously registered. We generally avoid overwriting 'is_pre_imported'
                // unless we are sure. But for this specific migration, 
                // we only set 'is_pre_imported' on creation.

                if (needsUpdate) {
                    await customerModule.updateCustomers(cust.id, {
                        metadata: newMeta
                    })
                    logger.info(`🔄 Updated Existing: ${email} (Added QB ID)`)
                    updated++
                } else {
                    logger.info(`⏭️  Skipped Existing: ${email}`)
                    skipped++
                }

            } else {
                // Create New
                const customerData = {
                    email: email,
                    first_name: firstName,
                    last_name: lastName,
                    phone: phone,
                    company_name: company,
                    has_account: true, // They are "registered" in DB...
                    metadata: {
                        quickbooks_id: qbId,
                        is_pre_imported: true // <--- THE KEY FLAG
                    }
                }

                await customerModule.createCustomers(customerData)
                logger.info(`✅ Created New: ${email}`)
                created++
            }

        } catch (e: any) {
            logger.error(`❌ Error processing ${email}: ${e.message}`)
            errors++
        }
    }

    logger.info("\n" + "=".repeat(50))
    logger.info(`🏁 Import Complete`)
    logger.info(`   Created: ${created}`)
    logger.info(`   Updated: ${updated}`)
    logger.info(`   Skipped: ${skipped}`)
    logger.info(`   Errors:  ${errors}`)
    logger.info("=".repeat(50))
}
