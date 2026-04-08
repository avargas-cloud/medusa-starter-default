/**
 * verify-qb-edit-sequence-cache.ts
 *
 * Verifies that the EditSequence cache (with TxnLineIDs) works correctly end-to-end.
 * Run with: npx ts-node src/scripts/verify/verify-qb-edit-sequence-cache.ts
 */

import { Pool } from "pg"
import * as dotenv from "dotenv"
dotenv.config()

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// ── Minimal copies of the functions (to avoid Medusa bootstrap overhead) ──────

async function cacheEditSequence(
    entityType: string,
    qbId: string,
    editSeq: string,
    lineIds?: Record<string, string> | null
): Promise<void> {
    await pool.query(
        `INSERT INTO qb_edit_sequence_cache (entity_type, qb_id, edit_seq, line_ids, cached_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (entity_type, qb_id) DO UPDATE
             SET edit_seq  = EXCLUDED.edit_seq,
                 line_ids  = COALESCE(EXCLUDED.line_ids, qb_edit_sequence_cache.line_ids),
                 cached_at = NOW()`,
        [entityType, qbId, editSeq, lineIds ? JSON.stringify(lineIds) : null]
    )
}

async function getCachedEditSequence(
    entityType: string,
    qbId: string
): Promise<{ editSeq: string; lineIds: Record<string, string> | null } | null> {
    const { rows } = await pool.query(
        `SELECT edit_seq, line_ids FROM qb_edit_sequence_cache WHERE entity_type = $1 AND qb_id = $2`,
        [entityType, qbId]
    )
    if (!rows[0]) return null
    return {
        editSeq: rows[0].edit_seq as string,
        lineIds: (rows[0].line_ids as Record<string, string> | null) ?? null,
    }
}

async function pollUntilQbConfirmed(
    rowId: string,
    maxWaitMs = 10_000,
    intervalMs = 500
): Promise<"confirmed" | "failed" | "skipped" | "timeout"> {
    const deadline = Date.now() + maxWaitMs
    while (Date.now() < deadline) {
        const { rows } = await pool.query(
            `SELECT status FROM qb_order_pipeline WHERE id = $1`,
            [rowId]
        )
        const status = rows[0]?.status as string | undefined
        if (status === "confirmed") return "confirmed"
        if (status === "failed")    return "failed"
        if (status === "skipped")   return "skipped"
        await new Promise(r => setTimeout(r, intervalMs))
    }
    return "timeout"
}

// ── Test helpers ───────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function ok(label: string, cond: boolean) {
    if (cond) { console.log(`  ✅ ${label}`); passed++ }
    else       { console.error(`  ❌ ${label}`); failed++ }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runTests() {
    const TEST_ID = `TEST-${Date.now()}`

    console.log("\n─── 1. line_ids column exists ────────────────────────────────")
    const { rows: cols } = await pool.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = 'qb_edit_sequence_cache' AND column_name = 'line_ids'`
    )
    ok("line_ids column exists in qb_edit_sequence_cache", cols.length === 1)
    ok("line_ids column is JSONB", cols[0]?.data_type === "jsonb")

    console.log("\n─── 2. Cache miss returns null ───────────────────────────────")
    const miss = await getCachedEditSequence("estimate", `NONEXISTENT-${TEST_ID}`)
    ok("Cache miss returns null", miss === null)

    console.log("\n─── 3. Cache write + read (EditSequence only) ────────────────")
    await cacheEditSequence("estimate", TEST_ID, "ES-100")
    const hit1 = await getCachedEditSequence("estimate", TEST_ID)
    ok("editSeq stored correctly", hit1?.editSeq === "ES-100")
    ok("lineIds is null when not provided", hit1?.lineIds === null)

    console.log("\n─── 4. Cache update with lineIds ─────────────────────────────")
    const mockLineIds = { "QB-ITEM-001": "TXN-LINE-A", "QB-ITEM-002": "TXN-LINE-B" }
    await cacheEditSequence("estimate", TEST_ID, "ES-101", mockLineIds)
    const hit2 = await getCachedEditSequence("estimate", TEST_ID)
    ok("editSeq updated to ES-101", hit2?.editSeq === "ES-101")
    ok("lineIds stored as JSON object", JSON.stringify(hit2?.lineIds) === JSON.stringify(mockLineIds))
    ok("lineIds[QB-ITEM-001] = TXN-LINE-A", hit2?.lineIds?.["QB-ITEM-001"] === "TXN-LINE-A")

    console.log("\n─── 5. COALESCE: lineIds preserved on editSeq-only update ───")
    await cacheEditSequence("estimate", TEST_ID, "ES-102") // no lineIds
    const hit3 = await getCachedEditSequence("estimate", TEST_ID)
    ok("editSeq updated to ES-102", hit3?.editSeq === "ES-102")
    ok("lineIds preserved from previous cache (COALESCE)", hit3?.lineIds?.["QB-ITEM-001"] === "TXN-LINE-A")

    console.log("\n─── 6. pollUntilQbConfirmed: mock row lifecycle ──────────────")
    const { rows: [pipeRow] } = await pool.query(
        `INSERT INTO qb_order_pipeline (step, status, order_id, created_at, updated_at)
         VALUES ('estimate', 'submitted', 'verify-script-test', NOW(), NOW())
         RETURNING id`
    )
    const rowId = pipeRow.id as string
    ok("Test pipeline row created", !!rowId)

    // Simulate consolidator confirming 1s later
    setTimeout(async () => {
        await pool.query(
            `UPDATE qb_order_pipeline SET status = 'confirmed', updated_at = NOW() WHERE id = $1`,
            [rowId]
        )
    }, 1000)

    const outcome = await pollUntilQbConfirmed(rowId, 10_000, 300)
    ok(`pollUntilQbConfirmed detected 'confirmed' (got: ${outcome})`, outcome === "confirmed")

    // Cleanup test rows
    await pool.query(`DELETE FROM qb_edit_sequence_cache WHERE qb_id = $1`, [TEST_ID])
    await pool.query(`DELETE FROM qb_order_pipeline WHERE id = $1`, [rowId])

    console.log("\n─── 7. Existing cache entries have valid structure ───────────")
    const { rows: existing } = await pool.query(
        `SELECT entity_type, qb_id, edit_seq, line_ids, cached_at
         FROM qb_edit_sequence_cache ORDER BY cached_at DESC LIMIT 5`
    )
    ok(`${existing.length} existing cache entries found`, existing.length >= 0)
    for (const row of existing) {
        ok(`${row.entity_type}/${row.qb_id}: editSeq present`, !!row.edit_seq)
        console.log(`    ${row.entity_type}/${row.qb_id} | editSeq=${row.edit_seq} | lineIds=${row.line_ids ? "✅ present" : "⬜ null (expected for pre-migration entries)"}`)
    }

    console.log(`\n═══════════════════════════════════════════════════════════`)
    console.log(`  Results: ${passed} passed, ${failed} failed`)
    if (failed === 0) console.log(`  ✅ All verifications passed!`)
    else              console.log(`  ❌ Some verifications FAILED — check above`)
    console.log(`═══════════════════════════════════════════════════════════\n`)
}

runTests()
    .catch(e => { console.error("Script error:", e); process.exit(1) })
    .finally(() => pool.end())
