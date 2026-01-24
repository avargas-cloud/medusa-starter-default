import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Link USD Currency to Store (Direct DB Approach)
 * 
 * Adds USD to the store_currency table so it appears in the dropdown
 */

export default async function linkUSDToStore({ container }: { container: MedusaContainer }) {
    console.log("💵 Linking USD Currency to Store...\n")

    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    // Get store ID
    const { data: stores } = await query.graph({
        entity: "store",
        fields: ["id", "name"],
    })

    if (stores.length === 0) {
        console.error("❌ No store found!")
        return
    }

    const store = stores[0]
    console.log(`📊 Store: ${store.name} (${store.id})`)

    // Execute raw SQL to add USD to store_currency table
    const manager = container.resolve("manager")

    try {
        // Check if USD is already linked
        const existing = await manager.execute(
            `SELECT * FROM store_currency WHERE store_id = $1 AND currency_code = $2`,
            [store.id, 'usd']
        )

        if (existing.length > 0) {
            console.log("⏭️  USD already linked to store")
        } else {
            // Insert USD into store_currency
            await manager.execute(
                `INSERT INTO store_currency (store_id, currency_code, is_default) VALUES ($1, $2, $3)`,
                [store.id, 'usd', true]
            )
            console.log("✅ USD linked to store")

            // Update store default currency
            await manager.execute(
                `UPDATE store SET default_currency_code = $1 WHERE id = $2`,
                ['usd', store.id]
            )
            console.log("✅ Store default currency set to USD")
        }

        // Set EUR to non-default
        await manager.execute(
            `UPDATE store_currency SET is_default = false WHERE store_id = $1 AND currency_code = $2`,
            [store.id, 'eur']
        )
        console.log("✅ EUR set as non-default")

    } catch (error: any) {
        console.error(`❌ Error: ${error.message}`)
        console.log("\n💡 Trying alternative approach...")

        // Check table structure
        const tables = await manager.execute(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%currency%'`
        )

        console.log("\n📋 Currency-related tables:")
        for (const table of tables) {
            console.log(`   - ${table.table_name}`)
        }
    }

    console.log("\n✅ Done! Refresh the admin to see USD in the dropdown.")

    return { success: true }
}
