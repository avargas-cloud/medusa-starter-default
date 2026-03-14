import { ExecArgs } from "@medusajs/framework/types"

export default async function ({ container }: ExecArgs) {
    const knex = container.resolve("__pg_connection__")
    const query = container.resolve("query")

    console.log("\n🔍 CHECKING SOFT-DELETED ATTRIBUTE IMPACT")
    console.log("=".repeat(80))

    // 1. Get all products with WooCommerce attributes
    const { data: products } = await query.graph({
        entity: "product",
        fields: ["id", "title", "metadata"],
        filters: { status: "published" }
    })

    console.log(`\n📊 Total published products: ${products.length}`)

    let totalProductsWithWcAttrs = 0
    let totalProductsWithCurrentLinks = 0
    let totalProductsNeedingRestore = 0

    for (const product of products) {
        const wc_attributes = product.metadata?.wc_attributes || []

        if (wc_attributes.length > 0) {
            totalProductsWithWcAttrs++

            // Check current links
            const links = await knex("product_product_productattributes_attribute_value")
                .where("product_id", product.id)
                .count("* as count")
                .first()

            const linkCount = parseInt(links?.count || "0")

            if (linkCount === 0) {
                totalProductsNeedingRestore++
                console.log(`\n❌ ${product.title}`)
                console.log(`   WC Attributes: ${wc_attributes.length}`)
                console.log(`   Current Links: ${linkCount}`)
            } else {
                totalProductsWithCurrentLinks++
            }
        }
    }

    console.log("\n" + "=".repeat(80))
    console.log("\n📈 SUMMARY:")
    console.log(`   Total products: ${products.length}`)
    console.log(`   Products with WC metadata: ${totalProductsWithWcAttrs}`)
    console.log(`   Products with current links: ${totalProductsWithCurrentLinks}`)
    console.log(`   ❌ Products needing restore: ${totalProductsNeedingRestore}`)

    console.log("\n💡 Next step:")
    console.log("   Run bulk restore: npx medusa exec src/scripts/restore-all-attributes.ts")
    console.log()
}
