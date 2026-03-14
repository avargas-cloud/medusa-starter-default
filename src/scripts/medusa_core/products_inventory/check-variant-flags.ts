import { ExecArgs } from "@medusajs/framework/types"

export default async function ({ container }: ExecArgs) {
    const query = container.resolve("query")

    const { data: products } = await query.graph({
        entity: "product",
        fields: ["id", "title", "metadata"],
        filters: { id: "prod_ul-freecut-cob-led-strip-single-color-bright-output" }
    })

    const product = products[0]

    console.log("\n📦 Product:", product.title)
    console.log("🔧 Variant Attributes:", product.metadata?.variant_attributes || "None")
    console.log("\n")
}
