
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function verifyDbCount({ container }: ExecArgs) {
    const query = container.resolve("query")
    const id = "prod_100w-dimmable-power-supply-for-12vdc-led-units" // Known processed product

    console.log(`🔥 AUDIT: Checking actual DB link count for: ${id}`)

    // We use the same method that worked for the API: query.graph on the link entity
    const { data: links } = await query.graph({
        entity: "product_attribute_value",
        fields: ["attribute_value_id"],
        filters: { product_id: id }
    })

    console.log(`\n📊 RESULT: Found ${links.length} links in database.`)

    if (links.length > 1) {
        console.log("✅ PROOF: Multiple attributes persisted! (1:N constraint is working)")
    } else {
        console.log("❌ FAILURE: Still only 1 link found.")
    }
}
