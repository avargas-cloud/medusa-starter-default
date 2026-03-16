import { MedusaContainer } from "@medusajs/framework/types"

export default async function dbCheck({ container }: { container: MedusaContainer }) {
    const query = container.resolve("pgConnection")
    const { rows } = await query(`SELECT id, name, provider_id FROM tax_region`);
    console.log("=== TAX REGIONS ===")
    console.log(JSON.stringify(rows, null, 2))

    const { rows: rates } = await query(`SELECT id, name, tax_region_id, tax_provider_id FROM tax_rate`);
    console.log("=== TAX RATES ===")
    console.log(JSON.stringify(rates, null, 2))

    process.exit(0)
}
