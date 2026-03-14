/**
 * Check order_item.raw_unit_price and order.version for a given order
 * Run: npx tsx src/scripts/diagnostics/check-order-item-raw.ts ORDER_ID
 */
import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL
    || "postgresql://postgres:hUMSVtteMnqSBZSuSGUBivBooMdRoKtj@interchange.proxy.rlwy.net:34919/railway"

const orderId = process.argv[2] ?? 'order_01KJ8D67JKZETPVCHQ5S46J6T5'

async function main() {
    const client = new pg.Client({ connectionString: DATABASE_URL })
    await client.connect()

    try {
        const r = await client.query(`
            SELECT
                o.display_id,
                o.version        AS order_version,
                oi.id            AS oi_id,
                oi.version       AS oi_version,
                oi.unit_price    AS oi_unit_price,
                oi.raw_unit_price::text AS oi_raw_unit_price,
                oi.quantity      AS oi_quantity,
                oi.raw_quantity::text   AS oi_raw_quantity,
                oli.unit_price   AS oli_unit_price,
                oli.raw_unit_price::text AS oli_raw_unit_price,
                oli.title
            FROM "order" o
            JOIN order_item oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
            JOIN order_line_item oli ON oli.id = oi.item_id
            WHERE o.id = $1
            ORDER BY oi.version ASC
        `, [orderId])

        console.log(`\n🔍 order.version and order_item records for ${orderId}\n`)
        if (!r.rows.length) {
            console.log('   ❌ No order_item records found')
            return
        }
        for (const row of r.rows) {
            console.log(`   ┌─ "${row.title}" ───`)
            console.log(`   │  order.version (used by Admin to filter items): ${row.order_version}`)
            console.log(`   │  order_item.version:       ${row.oi_version}`)
            console.log(`   │  order_item.unit_price:    ${row.oi_unit_price}`)
            console.log(`   │  order_item.raw_unit_price: ${row.oi_raw_unit_price}`)
            console.log(`   │  order_item.quantity:       ${row.oi_quantity}`)
            console.log(`   │  order_item.raw_quantity:   ${row.oi_raw_quantity}`)
            console.log(`   │  order_line_item.unit_price:    ${row.oli_unit_price}`)
            console.log(`   │  order_line_item.raw_unit_price: ${row.oli_raw_unit_price}`)

            console.log(`   │`)
            if (row.oi_version !== row.order_version) {
                console.log(`   │  ⚠️  order_item version (${row.oi_version}) ≠ order.version (${row.order_version})`)
                console.log(`   │     Admin filters items WHERE version=${row.order_version} — this version may not match!`)
            } else {
                console.log(`   │  ✅ order_item.version matches order.version (${row.order_version}) — Admin will read this row`)
            }
            const raw = row.oi_raw_unit_price ? JSON.parse(row.oi_raw_unit_price) : null
            if (raw?.value === '0' || raw?.value === 0) {
                console.log(`   │  ❌ raw_unit_price.value=0 → decorateCartTotals computes $0 for this item → Admin shows shipping-only total`)
            } else if (raw) {
                console.log(`   │  ✅ raw_unit_price.value=${raw.value} → decorateCartTotals should compute correct item price`)
            } else {
                console.log(`   │  ℹ️  raw_unit_price is NULL → formatOrder falls back to order_line_item.raw_unit_price`)
            }
            console.log(`   └──`)
        }
    } finally {
        await client.end()
    }
}

main().catch(e => { console.error(e); process.exit(1) })
