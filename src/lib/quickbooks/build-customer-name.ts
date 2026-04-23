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
 * No suffix is added on the first attempt. If QB rejects the name as a
 * duplicate (error 3100 "already in use"), the bridge re-queues the op
 * with data.nameSuffixed = true, and on the second call this function
 * appends " #XXXXXX" (last 6 chars of Medusa customer ID) to make the
 * name unique in QB.
 */

export function buildQbCustomerName(
  customer: {
    company_name?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    id: string;
  },
  { addSuffix = false }: { addSuffix?: boolean } = {}
): string {
  const MAX_LEN = 41; // QB hard limit
  const suffix = addSuffix ? " #" + customer.id.slice(-6).toUpperCase() : "";
  const AVAILABLE = MAX_LEN - suffix.length;

  if (customer.company_name?.trim()) {
    return customer.company_name.trim().slice(0, AVAILABLE) + suffix;
  }

  const first = (customer.first_name || "").trim();
  const last = (customer.last_name || "").trim();
  const base = `${first} ${last}`.trim();
  return (base.slice(0, AVAILABLE) + suffix).trim();
}

/**
 * Quick self-test — run with: npx tsx src/lib/quickbooks/build-customer-name.ts
 */
if (require.main === module) {
  const tests = [
    {
      id: "cust_01JXXXXAB12CD34",
      company_name: "Green Energy LLC",
      first_name: "John",
      last_name: "Doe",
    },
    {
      id: "cust_01JYYYYEF56GH78",
      company_name: null,
      first_name: "Joe",
      last_name: "Smith",
    },
    {
      id: "cust_01JZZZZIJ90KL12",
      company_name:
        "A Very Long Company Name That Exceeds The QB Limit And Should Be Truncated Properly",
      first_name: null,
      last_name: null,
    },
    {
      id: "cust_01JAAAAMNOP3456",
      company_name: null,
      first_name: null,
      last_name: null,
    },
  ];
  for (const t of tests) {
    const name = buildQbCustomerName(t);
    console.log(`[${name.length} chars] "${name}"`);
  }
}
