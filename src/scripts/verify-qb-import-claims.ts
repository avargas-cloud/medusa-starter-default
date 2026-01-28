import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { ICustomerModuleService } from "@medusajs/types";

export default async function verifyQbImportClaims({ container }: ExecArgs) {
    const customerService: ICustomerModuleService = container.resolve(
        Modules.CUSTOMER
    );

    const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

    console.log("\nStarting Verification of QuickBooks Import Claims...\n");
    console.log("--------------------------------------------------\n");

    const customers = await customerService.listCustomers(
        {},
        {
            select: ["id", "email", "metadata", "groups.id", "groups.name"],
            relations: ["groups"],
            take: 100000,
        }
    );

    console.log(`Total Customers Found: ${customers.length}\n`);

    // --- 1. Verify Price Level Mappings ---
    console.log("--- 1. Price Level Mappings ---");

    const groupCounts: Record<string, number> = {};
    const ungroupedCustomers: string[] = [];
    const wholesaleGroupIds = new Set<string>();
    const retailGroupIds = new Set<string>();

    // Map groups
    const allGroups = await customerService.listCustomerGroups({}, { take: 100 });
    allGroups.forEach(g => {
        if (g.name.toLowerCase().includes("wholesale")) wholesaleGroupIds.add(g.id);
        if (g.name.toLowerCase().includes("retail")) retailGroupIds.add(g.id);
    });

    customers.forEach((c) => {
        if (!c.groups || c.groups.length === 0) {
            ungroupedCustomers.push(c.id);
            return;
        }

        c.groups.forEach((g) => {
            groupCounts[g.name] = (groupCounts[g.name] || 0) + 1;
        });
    });

    console.table(groupCounts);
    if (ungroupedCustomers.length > 0) {
        console.warn(`\nWARNING: ${ungroupedCustomers.length} customers belong to NO group.`);
    } else {
        console.log("\nSUCCESS: All customers are assigned to a group.");
    }


    // --- 2. Verify QuickBooks Price Level Metadata ---
    console.log("\n--- 2. Metadata: QB Price Levels (Normalized) ---");
    const qbPriceLevelCounts: Record<string, number> = {};

    customers.forEach((c) => {
        const level = (c.metadata?.qb_price_level as string) || "MISSING";
        qbPriceLevelCounts[level] = (qbPriceLevelCounts[level] || 0) + 1;
    });

    console.table(qbPriceLevelCounts);

    // Verify normalization
    const hasLegacy = qbPriceLevelCounts["Standard"] || qbPriceLevelCounts["Distributor"];
    if (hasLegacy) {
        console.warn("\n⚠️  WARNING: Legacy values ('Standard', 'Distributor') still found. Normalization incomplete.");
    } else {
        console.log("\n✅ SUCCESS: Metadata is fully normalized to 'Retail' and 'Wholesale'.");
    }


    // --- 3. Verify QuickBooks IDs ---
    console.log("\n--- 3. QuickBooks IDs (qb_list_id) ---");
    let hasIdCount = 0;
    let missingIdCount = 0;

    customers.forEach((c) => {
        if (c.metadata?.qb_list_id) {
            hasIdCount++;
        } else {
            missingIdCount++;
        }
    });

    console.log(`- With Valid qb_list_id: ${hasIdCount}`);
    console.log(`- Missing qb_list_id:    ${missingIdCount}`);
    console.log(`- Coverage:              ${((hasIdCount / customers.length) * 100).toFixed(2)}%`);


    // --- 4. Verify Customer Types ---
    console.log("\n--- 4. Customer Types (qb_customer_type) ---");
    const typeCounts: Record<string, number> = {};

    customers.forEach((c) => {
        const type = (c.metadata?.qb_customer_type as string) || "MISSING";
        typeCounts[type] = (typeCounts[type] || 0) + 1;
    });

    console.table(typeCounts);

    console.log("\n--------------------------------------------------");
    console.log("Verification Complete.");
}
