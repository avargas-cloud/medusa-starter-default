import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Update ALL product variants to allow_backorder = true using raw Knex SQL.
 * (The MikroORM entity filter with empty {} causes an error in this version of Medusa.)
 *
 * In Medusa v2, Medusa's draft order conversion workflow reads variant.allow_backorder
 * and passes it to createReservationItems — which uses it to bypass the stock check.
 *
 * Run with:
 *   npx medusa exec src/scripts/enable-variant-backorder.ts
 */
export default async function enableVariantBackorder({ container }: ExecArgs) {
    // Resolve the raw Knex/pg connection from the Medusa DI container
    const pgConnection = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any

    console.log("⏳ Updating all product variants via raw SQL...")

    try {
        // Count before
        const beforeResult = await pgConnection.raw(
            `SELECT COUNT(*) as count FROM product_variant WHERE allow_backorder = true AND deleted_at IS NULL`
        )
        const countBefore = parseInt(beforeResult.rows[0].count, 10)
        console.log(`  Before: ${countBefore} variants already had allow_backorder = true`)

        // Update all variants
        const updateResult = await pgConnection.raw(
            `UPDATE product_variant SET allow_backorder = true WHERE deleted_at IS NULL`
        )
        const affected = updateResult.rowCount ?? "unknown"

        // Count after
        const afterResult = await pgConnection.raw(
            `SELECT COUNT(*) as count FROM product_variant WHERE allow_backorder = true AND deleted_at IS NULL`
        )
        const countAfter = parseInt(afterResult.rows[0].count, 10)

        console.log(`\n✅ Done!`)
        console.log(`   Rows affected : ${affected}`)
        console.log(`   After update  : ${countAfter} variants have allow_backorder = true`)
        console.log(`\nℹ️  Medusa's conversion workflow will now pass allow_backorder=true`)
        console.log(`   to inventory reservation creation, bypassing the stock quantity check.`)
    } catch (e: any) {
        console.error("❌ Error:", e?.message)
    }
}
