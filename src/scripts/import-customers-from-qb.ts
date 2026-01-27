import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import fs from "fs"
import path from "path"

/**
 * Import QuickBooks Customers to Medusa
 * 
 * Imports 7,444 customers from customers_export.json with:
 * - Smart address detection (avoids false positives like "123 Supply")
 * - Name parsing fallback (FirstName/LastName or parsed from Name)
 * - Customer Groups by PriceLevel (Wholesale/Retail/Standard)
 * - QuickBooks metadata preservation
 * 
 * MODES:
 *   DRY_RUN=true  (default) - Preview without creating
 *   DRY_RUN=false - Execute import
 *   BATCH_SIZE=N  - Limit to first N customers (testing)
 * 
 * USAGE:
 *   DRY_RUN=true yarn medusa exec ./src/scripts/import-customers-from-qb.ts
 *   DRY_RUN=false BATCH_SIZE=100 yarn medusa exec ./src/scripts/import-customers-from-qb.ts
 *   DRY_RUN=false yarn medusa exec ./src/scripts/import-customers-from-qb.ts
 */

interface QBCustomer {
    ListID: string
    Name: string
    FirstName?: string
    LastName?: string
    CompanyName: string
    Email: string
    Phone?: string
    CustomerType: string
    PriceLevel: string
    BillingAddress: QBAddress
    ShippingAddress: QBAddress
}

interface QBAddress {
    Address1?: string
    Address2?: string
    Address3?: string
    Address4?: string
    Address5?: string
    FullAddress?: string
    City?: string
    Province?: string
    PostalCode?: string
    Country?: string
}

interface NameData {
    first_name: string | null
    last_name: string | null
}

interface ImportStats {
    total: number
    imported: number
    with_billing_address: number
    with_shipping_address: number
    without_address: number
    name_from_fields: number
    name_parsed: number
    dummy_email_generated: number      // Renamed from skipped_no_email
    invalid_email_fixed: number        // Renamed from skipped_invalid_email
    errors: Array<{ email: string; error: string }>
}

export default async function importCustomersFromQB({ container }: ExecArgs) {
    const isDryRun = process.env.DRY_RUN !== "false"
    const batchSize = process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE) : null

    const customerModule = container.resolve(Modules.CUSTOMER)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    logger.info("\n" + "=".repeat(70))
    logger.info(isDryRun ? "📋 DRY RUN MODE - No changes will be made" : "⚠️  LIVE IMPORT MODE")
    if (batchSize) {
        logger.info(`🔢 BATCH SIZE: ${batchSize} customers`)
    }
    logger.info("=".repeat(70) + "\n")

    try {
        // 1. Load JSON data
        const jsonPath = path.join(process.cwd(), "customers_export.json")
        const customersRaw = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as QBCustomer[]

        let customers = customersRaw
        if (batchSize) {
            customers = customersRaw.slice(0, batchSize)
        }

        logger.info(`📊 Total customers in file: ${customersRaw.length}`)
        logger.info(`🎯 Processing: ${customers.length} customers\n`)

        // 2. Create/Ensure Customer Groups exist
        const groups = await ensureCustomerGroups(customerModule, logger, isDryRun)

        // 3. Initialize stats
        const stats: ImportStats = {
            total: customers.length,
            imported: 0,
            with_billing_address: 0,
            with_shipping_address: 0,
            without_address: 0,
            name_from_fields: 0,
            name_parsed: 0,
            dummy_email_generated: 0,
            invalid_email_fixed: 0,
            errors: []
        }

        // 4. Import Loop
        logger.info("🔄 Starting import...\n")

        for (const qbCustomer of customers) {
            try {
                // Smart email extraction (handles multiple emails separated by comma/slash/etc)
                let customerEmail = qbCustomer.Email?.trim()
                let altEmails: string[] = []
                let isDummyEmail = false

                if (!customerEmail) {
                    // No email at all - generate dummy
                    customerEmail = `customer-${qbCustomer.ListID}@ecopowertech.com`
                    isDummyEmail = true
                    stats.dummy_email_generated++
                } else {
                    // Extract ALL valid emails
                    const validEmails = extractAllValidEmails(customerEmail)

                    if (validEmails.length > 0) {
                        // Use first as primary email
                        customerEmail = validEmails[0]

                        // Save additional emails to metadata
                        if (validEmails.length > 1) {
                            altEmails = validEmails.slice(1)
                            logger.info(`  📧 Multiple emails: ${validEmails[0]} + ${altEmails.length} more`)
                        }
                    } else {
                        // No valid email found - generate dummy
                        customerEmail = `customer-${qbCustomer.ListID}@ecopowertech.com`
                        isDummyEmail = true
                        stats.invalid_email_fixed++
                        logger.warn(`  ⚠️  Invalid email: ${qbCustomer.Email.substring(0, 50)} → Generated dummy`)
                    }
                }

                // Parse name
                const { first_name, last_name, fromFields } = parseCustomerName(qbCustomer)
                if (fromFields) {
                    stats.name_from_fields++
                } else {
                    stats.name_parsed++
                }

                // Extract contact name from Address2 (if looks like a person's name)
                const contactName = extractContactName(qbCustomer.BillingAddress.Address2 || '')

                // Detect addresses
                const billingStreet = findRealStreetAddress(
                    qbCustomer.BillingAddress,
                    qbCustomer.Name,
                    qbCustomer.CompanyName
                )

                const shippingStreet = findRealStreetAddress(
                    qbCustomer.ShippingAddress,
                    qbCustomer.Name,
                    qbCustomer.CompanyName
                )

                if (!isDryRun) {
                    // Create customer
                    const customer = await customerModule.createCustomers({
                        email: customerEmail,  // Use generated or real email
                        first_name,
                        last_name,
                        company_name: qbCustomer.CompanyName || null,
                        phone: qbCustomer.Phone || null,
                        has_account: false,
                        metadata: {
                            qb_list_id: qbCustomer.ListID,
                            qb_customer_type: qbCustomer.CustomerType,
                            qb_price_level: qbCustomer.PriceLevel,
                            qb_original_email: isDummyEmail ? qbCustomer.Email || '' : customerEmail,
                            email_is_placeholder: isDummyEmail,
                            alt_emails: altEmails.length > 0 ? altEmails.join(', ') : undefined,
                            alt_first_name: contactName?.first_name || undefined,
                            alt_last_name: contactName?.last_name || undefined,
                            alt_contact_phone: undefined,  // Reserved for future use
                        }
                    })

                    let billingAddrId: string | null = null
                    let shippingAddrId: string | null = null

                    // Add billing address
                    if (billingStreet && qbCustomer.BillingAddress.City && qbCustomer.BillingAddress.PostalCode) {
                        const billingAddr = await customerModule.createCustomerAddresses({
                            customer_id: customer.id,
                            company: qbCustomer.CompanyName || null,
                            address_1: billingStreet,
                            city: qbCustomer.BillingAddress.City,
                            province: qbCustomer.BillingAddress.Province || null,
                            postal_code: qbCustomer.BillingAddress.PostalCode,
                            country_code: qbCustomer.BillingAddress.Country || "US",
                        })

                        billingAddrId = billingAddr.id
                        stats.with_billing_address++
                    }

                    // Add shipping address (if different from billing)
                    const hasSeparateShipping = shippingStreet &&
                        shippingStreet !== billingStreet &&
                        qbCustomer.ShippingAddress.City &&
                        qbCustomer.ShippingAddress.PostalCode

                    if (hasSeparateShipping) {
                        const shippingAddr = await customerModule.createCustomerAddresses({
                            customer_id: customer.id,
                            company: qbCustomer.CompanyName || null,
                            address_1: shippingStreet!,
                            city: qbCustomer.ShippingAddress.City!,
                            province: qbCustomer.ShippingAddress.Province || null,
                            postal_code: qbCustomer.ShippingAddress.PostalCode!,
                            country_code: qbCustomer.ShippingAddress.Country || "US",
                        })

                        shippingAddrId = shippingAddr.id
                        stats.with_shipping_address++
                    }

                    // Track address stats (Note: Medusa v2 doesn't support default address IDs in customer model)
                    if (!billingAddrId && !shippingAddrId) {
                        stats.without_address++
                    }

                    // Assign to Customer Group
                    const groupId = groups[qbCustomer.PriceLevel.toLowerCase()]
                    if (groupId) {
                        await customerModule.addCustomerToGroup({
                            customer_id: customer.id,
                            customer_group_id: groupId
                        })
                    }

                    stats.imported++

                    // Progress logging
                    if (stats.imported % 100 === 0) {
                        logger.info(`  ✅ Imported ${stats.imported}...`)
                    }

                    // Detailed logging for first 5
                    if (stats.imported <= 5) {
                        logger.info(`  📝 ${qbCustomer.Email}`)
                        logger.info(`     Name: ${first_name} ${last_name}`)
                        logger.info(`     Company: ${qbCustomer.CompanyName}`)
                        if (billingStreet) {
                            logger.info(`     Billing: ${billingStreet}, ${qbCustomer.BillingAddress.City}`)
                        }
                        if (shippingStreet && shippingStreet !== billingStreet) {
                            logger.info(`     Shipping: ${shippingStreet}`)
                        }
                        logger.info(`     Group: ${qbCustomer.PriceLevel}\n`)
                    }
                }

            } catch (error: any) {
                stats.errors.push({
                    email: qbCustomer.Email,
                    error: error.message
                })

                if (stats.errors.length <= 10) {
                    logger.error(`  ❌ ${qbCustomer.Email}: ${error.message}`)
                }
            }
        }

        // 5. Summary
        printSummary(stats, logger, isDryRun)

    } catch (error: any) {
        logger.error(`\n❌ FATAL ERROR: ${error.message}`)
        logger.error(error.stack)
        throw error
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Find real street address from Address1-5 fields
 * Avoids false positives (company names that start with numbers)
 */
function findRealStreetAddress(
    addr: QBAddress,
    customerName: string,
    companyName: string
): string | null {
    const streetKeywords = /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|pl|place|way|nw|ne|sw|se)\b/i
    const suitePattern = /#\d+/

    function isRealStreet(text: string): boolean {
        if (!text || text.trim().length < 5) return false

        const cleaned = text.trim()

        // RULE 1: Address matches customer or company name → NOT a street
        if (cleaned === customerName || cleaned === companyName) {
            return false
        }

        // RULE 2: Address contains company name → NOT a street
        if (companyName && cleaned.includes(companyName)) {
            return false
        }

        // RULE 3: Has street keywords → IS a street
        if (streetKeywords.test(cleaned) || suitePattern.test(cleaned)) {
            return true
        }

        // RULE 4: Starts with number AND doesn't match name → likely street
        if (/^\d/.test(cleaned)) {
            return true
        }

        return false
    }

    // Check in order of likelihood: Addr2 → Addr3 → Addr1 → Addr4 → Addr5
    const checkOrder: Array<keyof QBAddress> = ['Address2', 'Address3', 'Address1', 'Address4', 'Address5']

    for (const field of checkOrder) {
        const text = addr[field]
        if (text && isRealStreet(text)) {
            return text
        }
    }

    return null
}

/**
 * Parse customer name from FirstName/LastName or Name field
 */
function parseCustomerName(customer: QBCustomer): NameData & { fromFields: boolean } {
    // Use FirstName/LastName if available
    if (customer.FirstName && customer.LastName) {
        return {
            first_name: customer.FirstName,
            last_name: customer.LastName,
            fromFields: true
        }
    }

    // Parse from Name field
    const fullName = customer.Name
        .replace(/\b(LLC|Inc|Corp|Ltd|Co)\b\.?/gi, '')
        .trim()

    const parts = fullName.split(/\s+/).filter(p => p.length > 0)

    if (parts.length === 0) {
        return { first_name: null, last_name: null, fromFields: false }
    } else if (parts.length === 1) {
        return { first_name: parts[0], last_name: null, fromFields: false }
    } else {
        return {
            first_name: parts[0],
            last_name: parts.slice(1).join(' '),
            fromFields: false
        }
    }
}

/**
 * Extract contact name from Address2 field (usually contains contact person)
 * Returns first and last name if it looks like a person's name
 */
function extractContactName(text: string): { first_name: string; last_name: string } | null {
    if (!text || text.trim().length === 0) return null

    const cleaned = text.trim()

    // Skip if looks like a company name or address
    if (cleaned.match(/\b(LLC|Inc|Corp|Ltd|Co|#\d+|\d+\s+(st|ave|rd|blvd))/i)) {
        return null
    }

    // Skip if too long (likely not a name)
    if (cleaned.length > 50) return null

    // Parse as name
    const parts = cleaned.split(/\s+/).filter(p => p.length > 0)

    if (parts.length < 2) return null

    return {
        first_name: parts[0],
        last_name: parts.slice(1).join(' ')
    }
}

/**
 * Extract all valid emails from text that may contain multiple emails
 * Handles separators: comma, semicolon, slash, pipe
 * Returns array of valid emails
 */
function extractAllValidEmails(text: string): string[] {
    if (!text) return []

    // Split by common separators
    const separators = /[,;/|]/
    const candidates = text.split(separators).map(s => s.trim())

    // Return all valid emails
    const validEmails: string[] = []
    for (const candidate of candidates) {
        if (isValidEmail(candidate)) {
            validEmails.push(candidate)
        }
    }

    return validEmails
}

/**
 * Validate email format
 */
function isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    return emailRegex.test(email)
}

/**
 * Ensure Customer Groups exist, create if needed
 */
async function ensureCustomerGroups(
    customerModule: any,
    logger: any,
    isDryRun: boolean
): Promise<Record<string, string>> {
    const groupsToCreate = [
        { name: "Wholesale Customers", handle: "wholesale", metadata: { qb_price_level: "Wholesale" } },
        { name: "Retail Customers", handle: "retail", metadata: { qb_price_level: "Retail" } }
    ]

    const groupMap: Record<string, string> = {}

    if (!isDryRun) {
        logger.info("🔧 Ensuring Customer Groups exist...\n")

        for (const groupData of groupsToCreate) {
            try {
                // Try to find existing group
                const existing = await customerModule.listCustomerGroups({
                    name: groupData.name
                })

                if (existing.length > 0) {
                    groupMap[groupData.handle] = existing[0].id
                    logger.info(`  ✓ Found: ${groupData.name}`)
                } else {
                    // Create new group
                    const created = await customerModule.createCustomerGroups(groupData)
                    groupMap[groupData.handle] = created.id
                    logger.info(`  ✅ Created: ${groupData.name}`)
                }
            } catch (error: any) {
                logger.warn(`  ⚠️  ${groupData.name}: ${error.message}`)
            }
        }

        // Map all PriceLevels to groups
        // Wholesale, Distributor → wholesale
        // Retail, Standard → retail
        groupMap['wholesale'] = groupMap['wholesale']
        groupMap['distributor'] = groupMap['wholesale']  // Distributor → Wholesale
        groupMap['retail'] = groupMap['retail']
        groupMap['standard'] = groupMap['retail']        // Standard → Retail

        logger.info("")
        logger.info("📋 PriceLevel Mapping:")
        logger.info("  • Wholesale → Wholesale Customers")
        logger.info("  • Distributor → Wholesale Customers")
        logger.info("  • Retail → Retail Customers")
        logger.info("  • Standard → Retail Customers")
        logger.info("")
    } else {
        logger.info("🔧 Customer Groups (dry-run, will be created on real import)\n")
        groupsToCreate.forEach(g => {
            logger.info(`  • ${g.name}`)
            groupMap[g.handle] = "dry-run-id"
        })

        // Map for dry-run
        groupMap['distributor'] = "dry-run-id"
        groupMap['standard'] = "dry-run-id"

        logger.info("")
        logger.info("📋 PriceLevel Mapping:")
        logger.info("  • Wholesale → Wholesale Customers")
        logger.info("  • Distributor → Wholesale Customers")
        logger.info("  • Retail → Retail Customers")
        logger.info("  • Standard → Retail Customers")
        logger.info("")
    }

    return groupMap
}

/**
 * Print final summary
 */
function printSummary(stats: ImportStats, logger: any, isDryRun: boolean) {
    logger.info("\n" + "=".repeat(70))
    logger.info(isDryRun ? "📋 DRY RUN SUMMARY" : "✅ IMPORT COMPLETE")
    logger.info("=".repeat(70))
    logger.info(`Total customers:           ${stats.total}`)
    logger.info(`Imported:                  ${stats.imported}`)
    logger.info(`  ↳ With billing address:  ${stats.with_billing_address}`)
    logger.info(`  ↳ With shipping address: ${stats.with_shipping_address}`)
    logger.info(`  ↳ Without address:       ${stats.without_address}`)
    logger.info(``)
    logger.info(`Names from First/Last:     ${stats.name_from_fields}`)
    logger.info(`Names parsed from Name:    ${stats.name_parsed}`)
    logger.info(``)
    logger.info(`Dummy emails generated:    ${stats.dummy_email_generated}`)
    logger.info(`Invalid emails fixed:      ${stats.invalid_email_fixed}`)
    logger.info(`Errors:                    ${stats.errors.length}`)

    if (stats.errors.length > 0) {
        logger.warn(`\n⚠️  ${stats.errors.length} errors occurred:`)
        stats.errors.slice(0, 10).forEach(e => {
            logger.warn(`  • ${e.email}: ${e.error}`)
        })
        if (stats.errors.length > 10) {
            logger.warn(`  ... and ${stats.errors.length - 10} more`)
        }
    }

    logger.info("=".repeat(70))

    if (isDryRun) {
        logger.info(`\n📝 This was a DRY RUN. To execute:`)
        logger.info(`   DRY_RUN=false yarn medusa exec ./src/scripts/import-customers-from-qb.ts`)
    } else {
        logger.info(`\n✅ Import complete! Check Admin UI to verify customers.`)
    }

    logger.info("")
}
