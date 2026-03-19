import { MedusaContainer } from "@medusajs/framework/types"
import { Modules, ContainerRegistrationKeys } from "@medusajs/utils"
import { Pool } from "pg"

export default async function testNativePricing({ container }: { container: MedusaContainer }) {
    console.log("==========================================")
    console.log("🧪 MEDUSA V2 INTERNAL PRICING VERIFICATION")
    console.log("==========================================")

    const pricingModule = container.resolve(Modules.PRICING)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    // DB connection to easily fetch test IDs
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL || "postgresql://postgres:hUMSVtteMnqSBZSuSGUBivBooMdRoKtj@interchange.proxy.rlwy.net:34919/railway",
        ssl: { rejectUnauthorized: false }
    })

    try {
        console.log("\n1. Fetching Wholesale Price List dynamically...")
        const { data: priceLists } = await query.graph({
            entity: "price_list",
            fields: ["id", "title", "rules.*"],
            filters: { title: { $ilike: "%Wholesale%" } }
        })

        if (!priceLists.length) throw new Error("Could not find Wholesale price list")
        const priceList = priceLists[0]
        console.log(`✅ Wholesale Price List ID: ${priceList.id} (${priceList.title})`)

        console.log("\n2. Finding a Variant with a Wholesale Price...")
        const priceRes = await pool.query(`SELECT price_set_id, amount FROM price WHERE price_list_id = $1 LIMIT 1`, [priceList.id])
        if (priceRes.rows.length === 0) throw new Error("No prices found in wholesale list")

        const priceSetId = priceRes.rows[0].price_set_id
        const expectedWholesaleAmount = priceRes.rows[0].amount

        console.log(`✅ Using PriceSet ID: ${priceSetId}`)
        console.log(`✅ Expected Wholesale Price: ${expectedWholesaleAmount} (Raw DB)`)

        console.log("\n3. Finding the Customer Group targeted by this Price List...")
        // In v2, priceList.rules contains the rule attributes
        console.log("Rules attached to this Price List:", JSON.stringify(priceList.rules, null, 2))

        let targetGroupIds: string[] = []
        if (priceList.rules) {
            const groupRule = priceList.rules.find((r: any) => r.attribute === 'customer_group_id')
            if (groupRule?.value) {
                targetGroupIds = Array.isArray(groupRule.value) ? groupRule.value : [groupRule.value]
            }
        }

        if (targetGroupIds.length === 0) {
            console.log("⚠️ No customer_group_id rule found on the price list! Using a fallback group.")
            const groupRes = await pool.query(`SELECT id FROM customer_group LIMIT 1`)
            if (groupRes.rows.length) {
                targetGroupIds = [groupRes.rows[0].id]
            }
        }
        console.log(`✅ Targeted Customer Group IDs:`, targetGroupIds)

        console.log("\n4. Calculating Native Prices...")

        console.log("\n--- TEST A: RETAIL CONTEXT (No Customer Group) ---")
        const retailPrices = await pricingModule.calculatePrices(
            { id: [priceSetId] },
            { context: { currency_code: "usd", region_id: "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1" } }
        )
        const retailAmount = retailPrices[0]?.calculated_amount
        console.log(`Result: $${retailAmount}`)

        console.log("\n--- TEST B: WHOLESALE CONTEXT (With Customer Group) ---")
        const wholesalePrices = await pricingModule.calculatePrices(
            { id: [priceSetId] },
            {
                context: {
                    currency_code: "usd",
                    region_id: "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1",
                    customer_group_id: targetGroupIds
                }
            }
        )
        const calculatedWholesale = wholesalePrices[0]?.calculated_amount
        console.log(`Result: $${calculatedWholesale}`)

        console.log("\n====== CONCLUSION ======")
        if (Number(calculatedWholesale) === Number(expectedWholesaleAmount)) {
            console.log("✅ THE NATIVE PRICING ENGINE WORKS PERFECTLY!")
            console.log("Medusa dynamically calculated the wholesale price based on the Rules Engine context.")
        } else {
            console.log("❌ Failed: Native engine calculated the wrong/same price.")
        }

    } catch (e: any) {
        console.error("Test Error:", e.message || e)
    } finally {
        await pool.end()
    }
}
