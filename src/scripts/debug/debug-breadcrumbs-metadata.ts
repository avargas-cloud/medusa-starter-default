import { MedusaModule } from "@medusajs/framework/modules-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

async function debugBreadcrumbs() {
    const { medusaAppLoader } = await import("@medusajs/framework")
    const { container } = await medusaAppLoader({})

    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    const handle = "ul-freecut-cob-led-strip-single-color-bright-output"

    // 1. Query using query.graph (what the API uses)
    const { data: products } = await query.graph({
        entity: "product",
        fields: [
            "id",
            "title",
            "handle",
            "metadata"
        ],
        filters: { handle }
    })

    const product = products[0]

    console.log('\n=== QUERY.GRAPH RESULT ===')
    console.log('Product:', product.title)
    console.log('Metadata type:', typeof product.metadata)
    console.log('Metadata keys:', Object.keys(product.metadata || {}))
    console.log('\nBreadcrumbs from query.graph:')
    console.log(JSON.stringify(product.metadata?.main_category_breadcrumbs, null, 2))
    console.log('Count:', product.metadata?.main_category_breadcrumbs?.length || 0)

    // 2. Direct database query
    const knex = container.resolve("__pg_connection__")
    const dbResult = await knex("product")
        .select("id", "title", "metadata")
        .where("handle", handle)
        .first()

    console.log('\n=== DIRECT DB QUERY ===')
    console.log('Product:', dbResult.title)
    console.log('Metadata type:', typeof dbResult.metadata)
    console.log('\nBreadcrumbs from DB:')
    console.log(JSON.stringify(dbResult.metadata?.main_category_breadcrumbs, null, 2))
    console.log('Count:', dbResult.metadata?.main_category_breadcrumbs?.length || 0)

    process.exit(0)
}

debugBreadcrumbs().catch(console.error)
