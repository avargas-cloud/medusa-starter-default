/**
 * Diagnose Medusa v2 order schema and unit_price stored values
 *
 * Run: npx tsx src/scripts/diagnostics/diagnose-order-schema.ts ORDER_ID
 * Example: npx tsx src/scripts/diagnostics/diagnose-order-schema.ts order_01KJ899JZ04BXATV8XD3DA9K5K
 */
import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL
    || "postgresql://postgres:hUMSVtteMnqSBZSuSGUBivBooMdRoKtj@interchange.proxy.rlwy.net:34919/railway"
const orderId = process.argv[2]

async function main() {
    if (!orderId) {
        console.log("Usage: npx tsx diagnose-order-schema.ts <order_id>")
        console.log("Example: npx tsx diagnose-order-schema.ts order_01KJ899JZ04BXATV8XD3DA9K5K")
        process.exit(1)
    }

    const client = new pg.Client({ connectionString: DATABASE_URL })
    await client.connect()

    try {
        // 1. List all order-related tables
        const tables = await client.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name LIKE '%order%'
            ORDER BY table_name
        `)
        console.log("\n📋 ORDER-RELATED TABLES:")
        tables.rows.forEach((r: any) => console.log(`   ${r.table_name}`))

        // 2. Check order_item columns (the pivot between order and line_item)
        const oiCols = await client.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'order_item'
            ORDER BY ordinal_position
        `)
        console.log("\n📋 order_item COLUMNS:")
        oiCols.rows.forEach((r: any) => console.log(`   ${r.column_name} (${r.data_type})`))

        // 3. Check order_line_item columns
        const liCols = await client.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'order_line_item'
            ORDER BY ordinal_position
        `)
        console.log("\n📋 order_line_item COLUMNS:")
        liCols.rows.forEach((r: any) => console.log(`   ${r.column_name} (${r.data_type})`))

        // 4. Fetch the order via order_item → order_line_item join
        console.log(`\n🔍 Items for order: ${orderId}`)
        let found = false

        // Try to find the right join based on actual column names
        const orderItemCols = oiCols.rows.map((r: any) => r.column_name)
        const hasOrderId = orderItemCols.includes('order_id')
        const hasItemId = orderItemCols.includes('item_id')
        const hasQuantity = orderItemCols.includes('quantity')

        console.log(`   order_item has: order_id=${hasOrderId}, item_id=${hasItemId}, quantity=${hasQuantity}`)

        if (hasOrderId && hasItemId) {
            // NOTE: unit_price and quantity are on order_item, NOT order_line_item
            // order_line_item only has product metadata (title, variant_id, sku etc.)
            const items = await client.query(`
                SELECT
                    oi.order_id,
                    oi.item_id,
                    oi.version,
                    oi.unit_price    AS oi_unit_price,
                    oi.quantity      AS oi_quantity,
                    oli.unit_price   AS oli_unit_price,
                    oli.title,
                    v.sku
                FROM order_item oi
                JOIN order_line_item oli ON oli.id = oi.item_id
                LEFT JOIN product_variant v ON v.id = oli.variant_id
                WHERE oi.order_id = $1
                ORDER BY oi.item_id, oi.version
            `, [orderId])

            if (items.rows.length) {
                found = true
                console.log(`\n   ┌─ order_item (prices) + order_line_item (metadata) ────`)
                let itemSubtotal = 0
                for (const row of items.rows) {
                    const qty = Number(row.oi_quantity ?? 0)
                    const priceOnItem = Number(row.oi_unit_price ?? 0)    // THE authoritative price
                    const priceOnLi = Number(row.oli_unit_price ?? 0)     // line_item copy
                    const lineTotal = priceOnItem * qty
                    itemSubtotal += lineTotal
                    console.log(`   │  "${row.title}" [version=${row.version}]`)
                    console.log(`   │    SKU:                  ${row.sku ?? 'N/A'}`)
                    console.log(`   │    quantity (order_item): ${qty}`)
                    console.log(`   │    unit_price (order_item): $${priceOnItem.toFixed(2)}  ← ADMIN uses this`)
                    console.log(`   │    unit_price (line_item):  $${priceOnLi.toFixed(2)}   ← Store API uses this`)
                    console.log(`   │    line total: $${lineTotal.toFixed(2)}`)
                    if (priceOnItem === 0) console.log(`   │    ❌ order_item.unit_price=0 STORED → ADMIN shows $0 items!`)
                    if (priceOnLi === 0) console.log(`   │    ❌ order_line_item.unit_price=0 → Store API may be wrong`)
                }
                console.log(`   └──────────────────────────────────────────────────────`)
                console.log(`   Computed item subtotal: $${itemSubtotal.toFixed(2)}`)
            }
        }

        // 5b. Check order_summary (where Medusa stores the pre-computed totals)
        const osCols = await client.query(`
            SELECT column_name, data_type FROM information_schema.columns
            WHERE table_name = 'order_summary' ORDER BY ordinal_position
        `)
        console.log("\n📋 order_summary COLUMNS:")
        osCols.rows.forEach((r: any) => console.log(`   ${r.column_name} (${r.data_type})`))

        const osSummary = await client.query(`SELECT * FROM order_summary WHERE order_id = $1`, [orderId])
            .catch(() => ({ rows: [] }))
        if ((osSummary as any).rows.length) {
            console.log(`\n📋 order_summary ROW (what Admin totals come from):`)
            const s = (osSummary as any).rows[0]
            console.log(`   version: ${s.version}`)
            console.log(`   totals (JSONB):\n${JSON.stringify(s.totals, null, 4).split('\n').map((l: string) => '   ' + l).join('\n')}`)
        } else {
            console.log(`\n   No order_summary row found for this order`)
        }

        if (!found) {
            // Try querying order_line_item by different join strategy
            console.log(`   Could not find via order_item join. Checking alternate tables...`)
            // Check if there's an order_summary or order_totals table
            const sumTables = await client.query(`
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public'
                AND (table_name LIKE '%summary%' OR table_name LIKE '%total%')
            `)
            console.log("   Summary/total tables:", sumTables.rows.map((r: any) => r.table_name).join(', ') || "none")
        }

        // 5. Check tax lines on the order
        let taxTables: string[] = []
        const taxTablesRes = await client.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name LIKE '%tax%'
        `)
        taxTables = taxTablesRes.rows.map((r: any) => r.table_name)
        console.log("\n📋 Tax-related tables:", taxTables.join(', '))

        // 6. Check order_shipping_method for the order
        const smCols = await client.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'order_shipping_method' ORDER BY ordinal_position LIMIT 10
        `).catch(() => ({ rows: [] }))
        const smColNames = (smCols as any).rows.map((r: any) => r.column_name)

        if (smColNames.includes('order_id')) {
            const shipping = await client.query(`
                SELECT * FROM order_shipping_method WHERE order_id = $1 LIMIT 5
            `, [orderId]).catch(() => ({ rows: [] }))
            console.log(`\n📋 Shipping methods for this order:`)
                ; (shipping as any).rows.forEach((r: any) => console.log("   ", JSON.stringify(r)))
        }

    } finally {
        await client.end()
    }
}

main().catch(e => { console.error("❌", e.message); process.exit(1) })
