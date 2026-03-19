import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"

const ORDER_ID = "order_01KJV03YATCKZGG7ZRA1102RZF"

export default async function cleanupReservations({ container }: ExecArgs) {
    const pgConnection = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
    const orderModule = container.resolve(Modules.ORDER) as any

    console.log(`\n🔍 Finding line items for order: ${ORDER_ID}`)
    const [orders] = await orderModule.listAndCountOrders(
        { id: ORDER_ID },
        { relations: ["items"] }
    )
    const order = orders?.[0]
    if (!order) { console.error("Order not found!"); return }

    const lineItemIds: string[] = (order.items ?? []).map((i: any) => i.id)
    console.log(`  Found ${lineItemIds.length} line item(s):`, lineItemIds)
    if (lineItemIds.length === 0) { console.log("  No items."); return }

    // Knex raw uses ? placeholders (NOT $1/$2)
    const inClause = lineItemIds.map(() => "?").join(", ")

    const resvResult = await pgConnection.raw(
        `SELECT id, line_item_id, inventory_item_id, location_id, quantity
         FROM reservation_item
         WHERE line_item_id IN (${inClause}) AND deleted_at IS NULL`,
        lineItemIds
    )
    const reservations: any[] = resvResult.rows ?? []
    console.log(`\n📦 Found ${reservations.length} reservation(s):`)
    for (const r of reservations) {
        console.log(`  ${r.id}: qty=${r.quantity}, line_item=${r.line_item_id}`)
    }

    if (reservations.length === 0) {
        console.log("\n✅ No orphaned reservations. Order should be editable.")
        console.log("   Variants now have allow_backorder=true → try Convert to Order.")
        return
    }

    const rIds: string[] = reservations.map((r: any) => r.id)
    const rClause = rIds.map(() => "?").join(", ")
    console.log(`\n🗑️  Soft-deleting ${rIds.length} reservation(s)...`)
    const del = await pgConnection.raw(
        `UPDATE reservation_item SET deleted_at = NOW() WHERE id IN (${rClause})`,
        rIds
    )
    console.log(`  Rows soft-deleted: ${del.rowCount}`)

    console.log(`\n🔄 Restoring inventory levels...`)
    for (const r of reservations) {
        await pgConnection.raw(
            `UPDATE inventory_level SET reserved_quantity = GREATEST(0, reserved_quantity - ?)
             WHERE inventory_item_id = ? AND location_id = ? AND deleted_at IS NULL`,
            [r.quantity, r.inventory_item_id, r.location_id]
        )
    }

    console.log(`\n✅ Order unlocked. Variants have allow_backorder=true.`)
    console.log(`   Refresh the page and try Convert to Order again.`)
}
