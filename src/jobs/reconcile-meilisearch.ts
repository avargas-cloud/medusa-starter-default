import { MedusaContainer, ScheduledJobConfig } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { meiliClient, transformProduct, transformCustomer, PRODUCTS_INDEX, CUSTOMERS_INDEX } from "../lib/meili-backend"

/**
 * Scheduled Job: MeiliSearch Reconciliation
 * 
 * Runs every 5 minutes to ensure MeiliSearch is in sync with Postgres
 * Acts as a safety net for any missed syncs from middleware or subscribers
 */
export default async function reconcileMeiliSearchHandler(container: MedusaContainer) {
    console.log("🔄 [RECONCILE] Starting MeiliSearch reconciliation...")

    const productModule = container.resolve(Modules.PRODUCT)
    const customerModule = container.resolve(Modules.CUSTOMER)

    try {
        // ========== PRODUCTS RECONCILIATION ==========
        console.log("📦 [RECONCILE] Checking products...")

        // 1. Get all products from Postgres (WITH VARIANTS for SKUs)
        const pgProducts = await productModule.listProducts({}, {
            select: ["id", "updated_at"],
            relations: ["variants"],  // CRITICAL: Include variants to get SKUs
            take: 5000  // Adjust based on your product count
        })

        console.log(`   Found ${pgProducts.length} products in Postgres`)

        // 2. Get all products from MeiliSearch
        const productsIndex = meiliClient.index(PRODUCTS_INDEX)
        const meiliProductsResponse = await productsIndex.getDocuments({
            limit: 5000,
            fields: ["id", "updated_at"]
        })

        const meiliProducts = meiliProductsResponse.results
        console.log(`   Found ${meiliProducts.length} products in MeiliSearch`)

        // 3. Build map of MeiliSearch products
        const meiliProductMap = new Map(
            meiliProducts.map((p: any) => [p.id, p.updated_at])
        )

        // 4. Find stale/missing products
        const staleProducts = pgProducts.filter(pg => {
            const meiliTimestamp = meiliProductMap.get(pg.id)
            if (!meiliTimestamp) return true // Missing in MeiliSearch

            const pgTime = new Date(pg.updated_at).getTime()
            return pgTime > meiliTimestamp // Postgres is newer
        })

        if (staleProducts.length > 0) {
            console.log(`   ⚠️  Found ${staleProducts.length} stale products, syncing...`)

            // Fetch full product data WITH VARIANTS
            const fullProducts = await productModule.listProducts(
                { id: staleProducts.map(p => p.id) },
                { relations: ["variants"] }  // CRITICAL: Include variants for SKUs
            )

            // Transform and sync
            const transformed = fullProducts.map(transformProduct)
            await productsIndex.addDocuments(transformed)

            console.log(`   ✅ Synced ${staleProducts.length} products to MeiliSearch`)
        } else {
            console.log(`   ✅ All products in sync`)
        }

        // ========== CUSTOMERS RECONCILIATION ==========
        console.log("👥 [RECONCILE] Checking customers...")

        const pgCustomers = await customerModule.listCustomers({}, {
            select: ["id", "updated_at"],
            take: 10000
        })

        console.log(`   Found ${pgCustomers.length} customers in Postgres`)

        const customersIndex = meiliClient.index(CUSTOMERS_INDEX)
        const meiliCustomersResponse = await customersIndex.getDocuments({
            limit: 10000,
            fields: ["id", "updated_at"]
        })

        const meiliCustomers = meiliCustomersResponse.results
        console.log(`   Found ${meiliCustomers.length} customers in MeiliSearch`)

        const meiliCustomerMap = new Map(
            meiliCustomers.map((c: any) => [c.id, c.updated_at])
        )

        const staleCustomers = pgCustomers.filter(pg => {
            const meiliTimestamp = meiliCustomerMap.get(pg.id)
            if (!meiliTimestamp) return true

            const pgTime = new Date(pg.updated_at).getTime()
            return pgTime > meiliTimestamp
        })

        if (staleCustomers.length > 0) {
            console.log(`   ⚠️  Found ${staleCustomers.length} stale customers, syncing...`)

            const fullCustomers = await customerModule.listCustomers({
                id: staleCustomers.map(c => c.id)
            })

            const transformed = fullCustomers.map(transformCustomer)
            await customersIndex.addDocuments(transformed)

            console.log(`   ✅ Synced ${staleCustomers.length} customers to MeiliSearch`)
        } else {
            console.log(`   ✅ All customers in sync`)
        }

        console.log("🎉 [RECONCILE] Reconciliation completed successfully")

    } catch (error: any) {
        console.error("❌ [RECONCILE] Reconciliation failed:", error.message)
        console.error(error.stack)
    }
}

/**
 * Schedule: Every 5 minutes
 * Cron format: minute hour day month weekday
 */
export const config: ScheduledJobConfig = {
    name: "meilisearch-reconciliation",
    schedule: "*/5 * * * *", // Every 5 minutes
}
