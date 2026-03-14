#!/usr/bin/env tsx
/**
 * Debug: Promotion Calculation
 * Usage: npx tsx src/scripts/debug/debug-promotion-calc.ts [order_id]
 *
 * Shows: promotion config, item prices, stored adjustments, and expected vs actual discount
 */
import { Client } from 'pg'
import dotenv from 'dotenv'
dotenv.config()

const ORDER_ID = process.argv[2] || 'order_01KKAG16Q1WPFNTWMX9MV8MEFW'

async function main() {
    const db = new Client({ connectionString: process.env.DATABASE_URL })
    await db.connect()
    console.log(`\n🔍 Diagnosing promotion calculation for order: ${ORDER_ID}\n`)

    // 1. Order summary
    const summaryRes = await db.query(`
        SELECT id, display_id, currency_code,
               s.raw_original_item_subtotal,
               s.raw_item_subtotal,
               s.raw_discount_total,
               s.raw_tax_total,
               s.raw_original_total,
               s.raw_current_order_total
        FROM "order" o
        LEFT JOIN order_summary s ON s.order_id = o.id AND s.deleted_at IS NULL
        WHERE o.id = $1 AND o.deleted_at IS NULL
    `, [ORDER_ID])

    const summary = summaryRes.rows[0]
    if (!summary) { console.error('❌ Order not found'); return }
    console.log('📋 Order Summary (raw values in dollars):')
    console.log(JSON.stringify(summary, null, 2))

    // 2. Line items
    const itemsRes = await db.query(`
        SELECT oi.id, oi.title, oi.quantity, oi.unit_price,
               oi.raw_unit_price,
               oi.compare_at_unit_price,
               oi.is_tax_inclusive
        FROM order_item oi
        WHERE oi.order_id = $1 AND oi.deleted_at IS NULL
        ORDER BY oi.created_at
    `, [ORDER_ID])

    console.log(`\n📦 Line Items (${itemsRes.rows.length} items):`)
    let itemSubtotal = 0
    for (const row of itemsRes.rows) {
        const lineTotal = Number(row.unit_price) * Number(row.quantity)
        itemSubtotal += lineTotal
        console.log(`  - ${row.title?.substring(0,40)}: unit=$${row.unit_price} qty=${row.quantity} total=$${lineTotal.toFixed(2)} tax_inclusive=${row.is_tax_inclusive}`)
    }
    console.log(`  👉 Computed Item Subtotal: $${itemSubtotal.toFixed(2)}`)

    // 3. Adjustments
    const adjRes = await db.query(`
        SELECT olia.id, olia.code, olia.amount, olia.raw_amount, olia.item_id, 
               olia.deleted_at IS NOT NULL as is_deleted
        FROM order_line_item_adjustment olia
        JOIN order_item oi ON oi.id = olia.item_id
        WHERE oi.order_id = $1
        ORDER BY olia.deleted_at NULLS FIRST, olia.created_at DESC
        LIMIT 20
    `, [ORDER_ID])

    console.log(`\n🎯 Adjustments (all, including deleted):`)
    let activeAdjTotal = 0
    for (const row of adjRes.rows) {
        const tag = row.is_deleted ? '❌ [DELETED]' : '✅ [ACTIVE]'
        if (!row.is_deleted) activeAdjTotal += Number(row.amount)
        console.log(`  ${tag} code=${row.code} amount=$${row.amount} item=${row.item_id.substring(0,20)}`)
    }
    console.log(`  👉 Active adjustment total: $${activeAdjTotal.toFixed(2)}`)

    // 4. Check promotion config
    const promoRes = await db.query(`
        SELECT p.id, p.code, p.status, p.is_tax_inclusive,
               am.type, am.target_type, am.value, am.currency_code
        FROM promotion p
        JOIN promotion_application_method am ON am.promotion_id = p.id AND am.deleted_at IS NULL
        WHERE p.deleted_at IS NULL
        AND (p.code = 'GOOGLE-REVIEW' OR p.code LIKE 'CUSTOM-DISC%' OR p.code LIKE 'POS-DISC%')
        ORDER BY p.created_at DESC LIMIT 10
    `, [])

    console.log(`\n🏷️  Promotions:`)
    for (const p of promoRes.rows) {
        console.log(`  code=${p.code} status=${p.status} is_tax_inclusive=${p.is_tax_inclusive} type=${p.type} value=${p.value}`)
        if (p.type === 'percentage' && p.code === 'GOOGLE-REVIEW') {
            const expectedOnFullSubtotal = Number((itemSubtotal * p.value / 100).toFixed(2))
            const taxRate = 0.07
            const taxInclusiveSubtotal = Number((itemSubtotal * (1 + taxRate)).toFixed(2))
            const expectedOnTaxInclusive = Number((taxInclusiveSubtotal * p.value / 100).toFixed(2))
            console.log(`\n  📐 Expected Discount Calculation:`)
            console.log(`     Pre-tax subtotal ($${itemSubtotal.toFixed(2)}) × ${p.value}% = $${expectedOnFullSubtotal.toFixed(2)} ← CORRECT`)
            console.log(`     Tax-inclusive ($${taxInclusiveSubtotal.toFixed(2)}) × ${p.value}% = $${expectedOnTaxInclusive.toFixed(2)} ← WRONG`)
            console.log(`     Medusa stored adjustment: $${activeAdjTotal.toFixed(2)}`)
            if (Math.abs(activeAdjTotal - expectedOnTaxInclusive) < 0.05) {
                console.log(`\n  ❌ CONFIRMED: Medusa computed on tax-INCLUSIVE base despite is_tax_inclusive=false`)
            } else if (Math.abs(activeAdjTotal - expectedOnFullSubtotal) < 0.05) {
                console.log(`\n  ✅ Adjustment is correct (pre-tax base)`)
            } else {
                console.log(`\n  ⚠️  Adjustment doesn't match either expected value — may have line discounts affecting base`)
            }
        }
    }

    // 5. Tax lines
    const taxRes = await db.query(`
        SELECT olt.code, olt.rate, olt.amount, olt.item_id
        FROM order_line_item_tax_line olt
        JOIN order_item oi ON oi.id = olt.item_id
        WHERE oi.order_id = $1 AND olt.deleted_at IS NULL
        ORDER BY oli.created_at LIMIT 10
    `, [ORDER_ID]).catch(() => ({ rows: [] as any[] }))

    if (taxRes.rows.length > 0) {
        console.log(`\n💰 Tax Lines:`)
        for (const t of taxRes.rows) {
            console.log(`  code=${t.code} rate=${t.rate}% amount=$${t.amount}`)
        }
    }

    await db.end()
    console.log('\n✅ Done\n')
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
