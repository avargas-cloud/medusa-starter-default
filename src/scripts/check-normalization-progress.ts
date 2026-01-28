import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { ICustomerModuleService } from "@medusajs/types";

export default async function checkNormalizationProgress({ container }: ExecArgs) {
    const customerService: ICustomerModuleService = container.resolve(
        Modules.CUSTOMER
    );

    const customers = await customerService.listCustomers(
        {},
        {
            select: ["metadata"],
            take: 100000,
        }
    );

    let standardCount = 0;
    let distributorCount = 0;
    let retailCount = 0;
    let wholesaleCount = 0;

    customers.forEach((c) => {
        const level = c.metadata?.qb_price_level;
        if (level === "Standard") standardCount++;
        if (level === "Distributor") distributorCount++;
        if (level === "Retail") retailCount++;
        if (level === "Wholesale") wholesaleCount++;
    });

    console.log("\n--- Normalization Progress ---");
    console.log(`Remaining 'Standard':    ${standardCount}`);
    console.log(`Remaining 'Distributor': ${distributorCount}`);
    console.log(`Converted 'Retail':      ${retailCount}`);
    console.log(`Converted 'Wholesale':   ${wholesaleCount}`);

    const totalRemaining = standardCount + distributorCount;
    const initialTotal = 2280; // We know this from previous run
    const processed = initialTotal - totalRemaining;
    const percent = ((processed / initialTotal) * 100).toFixed(1);

    console.log(`\nProgress: ${processed} / ${initialTotal} (${percent}%)`);
}
