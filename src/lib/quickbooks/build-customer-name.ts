/**
 * build-customer-name.ts
 *
 * Builds the QuickBooks customer display name from company or full name.
 *
 * Priority:
 *   1. CompanyName  → "Green Energy LLC"
 *   2. FullName     → "Joe Smith"
 *
 * QB Name field limit: 41 characters total.
 *
 * No suffix is added. If QB rejects the name as duplicate, the caller
 * should handle that error (logged + returned as error from ensureCustomerInQb).
 */

export function buildQbCustomerName(customer: {
    company_name?: string | null
    first_name?: string | null
    last_name?: string | null
    id: string
}): string {
    const MAX_LEN = 41 // QB hard limit

    if (customer.company_name?.trim()) {
        return customer.company_name.trim().slice(0, MAX_LEN)
    }

    const first = (customer.first_name || "").trim()
    const last = (customer.last_name || "").trim()
    return `${first} ${last}`.trim().slice(0, MAX_LEN)
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
        console.log(`[${name.length} chars] "${name}"`)
    }
}
