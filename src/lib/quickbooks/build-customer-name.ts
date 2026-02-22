/**
 * build-customer-name.ts
 *
 * Builds the QuickBooks customer display name with Medusa customer ID suffix
 * to prevent duplicates of popular names (e.g., multiple "Joe Smith" in QB).
 *
 * Priority:
 *   1. CompanyName + " #" + shortId   → "Green Energy LLC #ab12cd34"
 *   2. FullName + " #" + shortId      → "Joe Smith #ab12cd34"
 *
 * QB Name field limit: 41 characters total.
 * shortId = last 8 chars of Medusa customer.id
 */

export function buildQbCustomerName(customer: {
    company_name?: string | null
    first_name?: string | null
    last_name?: string | null
    id: string
}): string {
    // Use last 8 chars of Medusa ID for uniqueness without being too long
    const shortId = customer.id.replace(/[^a-zA-Z0-9]/g, "").slice(-8)
    const suffix = ` #${shortId}` // e.g., " #ab12cd34" = 10 chars
    const maxNameLen = 41 - suffix.length // QB limit is 41 chars total

    if (customer.company_name?.trim()) {
        const name = customer.company_name.trim().slice(0, maxNameLen)
        return `${name}${suffix}`
    }

    const first = (customer.first_name || "").trim()
    const last = (customer.last_name || "").trim()
    const fullName = `${first} ${last}`.trim().slice(0, maxNameLen)
    return `${fullName}${suffix}`
}

/**
 * Quick self-test — run with: npx tsx src/lib/quickbooks/build-customer-name.ts
 */
if (require.main === module) {
    const tests = [
        { id: "cust_01JXXXXAB12CD34", company_name: "Green Energy LLC", first_name: "John", last_name: "Doe" },
        { id: "cust_01JYYYYEF56GH78", company_name: null, first_name: "Joe", last_name: "Smith" },
        { id: "cust_01JZZZZIJ90KL12", company_name: "A Very Long Company Name That Exceeds The QB Limit And Should Be Truncated Properly", first_name: null, last_name: null },
        { id: "cust_01JAAAAMNOP3456", company_name: null, first_name: null, last_name: null },
    ]
    for (const t of tests) {
        const name = buildQbCustomerName(t)
        console.log(`[${name.length} chars] ${name}`)
    }
}
