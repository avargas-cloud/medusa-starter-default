/**
 * verify-qb-pipeline-consistency.ts
 *
 * Detects inconsistencies in the QB order pipeline related to the Sales Receipt /
 * terminal payment flow:
 *
 *   1. ORPHAN PAYMENT ROWS — orders that already have a confirmed `sales_receipt`
 *      row but still have a `payment` or `apply_payment` row stuck in waiting/pending.
 *      These rows should have been skipped when the SR was created.
 *
 *   2. UNTAGGED SR PAYMENTS — customer_payments linked to orders whose SR is confirmed
 *      in the pipeline but which don't carry any of the SR-embedding metadata flags
 *      (`qb_source='sales_receipt'` / `is_sales_receipt_payment=true` / `qb_sync_status='pending_sr'`).
 *      Without a flag, handlePosPaymentCreated could later try to push them to QB as
 *      standalone ReceivePayments.
 *
 *   3. APPLIED MISMATCH — customer_payments that are fully consumed by applications
 *      but still sit on status='available' (should be 'applied').
 *
 * Exit code: 0 if clean, 1 if any inconsistency found. Suitable for CI / cron.
 *
 * Run: npx ts-node src/scripts/verify/verify-qb-pipeline-consistency.ts
 */

import { Pool } from "pg"
import * as dotenv from "dotenv"
dotenv.config()

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function findOrphanPaymentRows() {
    const res = await pool.query(
        `SELECT p.id,
                p.order_id,
                p.medusa_ref_number AS payment_ref,
                p.status           AS payment_status,
                sr.medusa_ref_number AS sr_ref,
                sr.status          AS sr_status,
                p.created_at
           FROM qb_order_pipeline sr
           JOIN qb_order_pipeline p ON p.order_id = sr.order_id
          WHERE sr.step   = 'sales_receipt'
            AND sr.status = 'confirmed'
            AND p.step   IN ('payment','apply_payment')
            AND p.status IN ('waiting','pending')
          ORDER BY sr.created_at DESC`
    )
    return res.rows
}

async function findUntaggedSrPayments() {
    const res = await pool.query(
        `SELECT cp.id,
                cp.display_id,
                cp.status,
                cp.metadata->>'order_id'       AS order_id,
                cp.metadata->>'qb_source'      AS qb_source,
                cp.metadata->>'qb_sync_status' AS qb_sync_status,
                cp.metadata->>'deposit_type'   AS deposit_type
           FROM customer_payment cp
          WHERE cp.metadata->>'order_id' IS NOT NULL
            AND cp.metadata->>'order_id' IN (
                SELECT order_id FROM qb_order_pipeline
                 WHERE step='sales_receipt' AND status='confirmed'
            )
            AND COALESCE(cp.metadata->>'qb_source', '') <> 'sales_receipt'
            AND COALESCE(cp.metadata->>'qb_sync_status', '') <> 'pending_sr'
            AND COALESCE(cp.metadata->>'qb_sync_status', '') <> 'voided'
            AND (cp.metadata->>'is_sales_receipt_payment') IS DISTINCT FROM 'true'
            AND cp.status <> 'voided'
            AND cp.deleted_at IS NULL`
    )
    return res.rows
}

async function findAppliedMismatch() {
    const res = await pool.query(
        `SELECT cp.id,
                cp.display_id,
                cp.amount,
                cp.status,
                COALESCE(SUM(pa.amount_applied) FILTER (WHERE pa.voided_at IS NULL), 0) AS total_applied
           FROM customer_payment cp
           LEFT JOIN payment_application pa ON pa.payment_id = cp.id
          WHERE cp.status = 'available'
            AND cp.deleted_at IS NULL
          GROUP BY cp.id, cp.display_id, cp.amount, cp.status
         HAVING COALESCE(SUM(pa.amount_applied) FILTER (WHERE pa.voided_at IS NULL), 0) >= cp.amount
            AND cp.amount > 0`
    )
    return res.rows
}

async function main() {
    const [orphans, untagged, mismatch] = await Promise.all([
        findOrphanPaymentRows(),
        findUntaggedSrPayments(),
        findAppliedMismatch(),
    ])

    let issues = 0

    console.log("═══ QB Pipeline Consistency Check ═══\n")

    console.log(`1. Orphan payment rows (SR confirmed but payment/apply_payment still waiting):`)
    if (orphans.length === 0) {
        console.log("   ✅ None")
    } else {
        issues += orphans.length
        console.log(`   ❌ ${orphans.length} issue(s):`)
        for (const r of orphans) {
            console.log(`      - order=${r.order_id} sr=${r.sr_ref} stale=${r.payment_ref}(${r.payment_status})`)
        }
    }

    console.log(`\n2. Untagged SR payments (linked to confirmed SR without SR-embedding flag):`)
    if (untagged.length === 0) {
        console.log("   ✅ None")
    } else {
        issues += untagged.length
        console.log(`   ❌ ${untagged.length} issue(s):`)
        for (const r of untagged) {
            console.log(`      - cpay=${r.id} PAY-${r.display_id} order=${r.order_id} qb_source=${r.qb_source ?? 'null'} status=${r.qb_sync_status ?? 'null'}`)
        }
    }

    console.log(`\n3. Applied-mismatch payments (fully consumed but status='available'):`)
    if (mismatch.length === 0) {
        console.log("   ✅ None")
    } else {
        issues += mismatch.length
        console.log(`   ❌ ${mismatch.length} issue(s):`)
        for (const r of mismatch) {
            console.log(`      - cpay=${r.id} PAY-${r.display_id} amount=${r.amount} applied=${r.total_applied}`)
        }
    }

    console.log(`\n═════════════════════════════════════`)
    if (issues === 0) {
        console.log("✅ All clean — no inconsistencies found.")
        await pool.end()
        process.exit(0)
    } else {
        console.log(`❌ ${issues} total inconsistencies.`)
        await pool.end()
        process.exit(1)
    }
}

main().catch(async (err) => {
    console.error("verify-qb-pipeline-consistency failed:", err)
    await pool.end()
    process.exit(2)
})
