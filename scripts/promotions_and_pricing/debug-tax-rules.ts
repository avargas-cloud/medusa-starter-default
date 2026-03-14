import 'dotenv/config';
import { initialize } from '@medusajs/framework/utils';

async function run() {
    const { container } = await initialize({ configModule: require('../../../medusa-config').default });
    const query = container.resolve('query');

    console.log("--- Tax Rates ---");
    const { data: taxRates } = await query.graph({
        entity: "tax_rate",
        fields: ["id", "name", "rate", "code", "tax_region_id"],
        pagination: { limit: 10 }
    });
    console.log(JSON.stringify(taxRates, null, 2));

    console.log("\n--- Tax Rate Rules ---");
    const { data: taxRateRules } = await query.graph({
        entity: "tax_rate_rule",
        fields: ["id", "reference", "reference_id", "tax_rate_id"],
        pagination: { limit: 50 }
    });
    console.log(JSON.stringify(taxRateRules, null, 2));

    process.exit(0);
}
run();
