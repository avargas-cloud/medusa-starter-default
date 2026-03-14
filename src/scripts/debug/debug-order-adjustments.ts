import { ExecArgs } from "@medusajs/framework/types"

export default async function debugOrderAdjustments({ container }: ExecArgs) {
    const orderId = "order_01KKHJ0NKPVAXC9XTFJJ8TCFEY"
    const knex = container.resolve("__pg_connection__") as any

    console.log(`\n=== Order Adjustments for ${orderId} ===\n`)

    // 1. Line item adjustments (active)
    const adjustments = await knex.raw(`
        SELECT 
            a.id, a.code, a.amount, a.created_at,
            i.unit_price, i.quantity,
            i.title
        FROM order_line_item_adjustment a
        JOIN order_item i ON i.id = a.item_id
        WHERE i.order_id = ?
          AND a.deleted_at IS NULL
        ORDER BY a.created_at DESC
    `, [orderId])

    console.log("Active adjustments:")
    console.table(adjustments.rows.map((r: any) => ({
        code: r.code,
        amount: r.amount,
        unit_price: r.unit_price,
        qty: r.quantity,
        item: r.title?.substring(0, 30),
    })))

    // 2. Current order summary
    const summary = await knex.raw(`
        SELECT item_total, discount_total, shipping_total, tax_total, total
        FROM order_summary
        WHERE order_id = ?
        ORDER BY created_at DESC
        LIMIT 1
    `, [orderId])

    console.log("\nOrder summary:")
    console.table(summary.rows)

    // 3. Current items
    const items = await knex.raw(`
        SELECT oi.id, oi.title, oi.unit_price, oi.quantity,
               oi.unit_price * oi.quantity as line_total
        FROM order_item oi
        WHERE oi.order_id = ? AND oi.deleted_at IS NULL
    `, [orderId])

    console.log("\nCurrent items:")
    console.table(items.rows.map((r: any) => ({
        title: r.title?.substring(0, 30),
        unit_price: r.unit_price,
        qty: r.quantity,
        line_total: r.line_total,
    })))

    // 4. Promotion application method config
    const promoConfig = await knex.raw(`
        SELECT p.code, p.status, p.is_tax_inclusive,
               am.target_type, am.type, am.value
        FROM promotion p
        JOIN promotion_application_method am ON am.promotion_id = p.id
        WHERE p.code = 'ORDER-DISCOUNT-10%'
          AND p.deleted_at IS NULL
          AND am.deleted_at IS NULL
    `)

    console.log("\nPromotion config (ORDER-DISCOUNT-10%):")
    console.table(promoConfig.rows)
}
