import "dotenv/config"
import { getDbPool } from "../../api/utils/db-pool"
import { findLatestInFlightRow, pollUntilQbConfirmed } from "../../lib/quickbooks/qb-pipeline"
import { withQbSerialized } from "../../lib/quickbooks/qb-serializer"

const TEST_ORDER_ID = "TEST_SERIALIZER_VERIFY"
const TEST_STEP = "estimate"

// ─── Result tracking ─────────────────────────────────────────────────────────

interface TestResult {
    name: string
    passed: boolean
    detail: string
}

const results: TestResult[] = []

function pass(name: string, detail = ""): void {
    results.push({ name, passed: true, detail })
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`)
}

function fail(name: string, detail: string): void {
    results.push({ name, passed: false, detail })
    console.log(`  FAIL  ${name} — ${detail}`)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function elapsedMs(start: number): number {
    return Date.now() - start
}

async function insertFakeRow(status: string, updatedAtExpr = "NOW()"): Promise<string> {
    const pool = getDbPool()
    const { rows } = await pool.query(
        `INSERT INTO qb_order_pipeline
            (order_id, step, status, updated_at,
             submitted_at, confirmed_at, failed_at)
         VALUES ($1, $2, $3, ${updatedAtExpr},
             CASE WHEN $3 = 'submitted' THEN NOW() ELSE NULL END,
             CASE WHEN $3 = 'confirmed' THEN NOW() ELSE NULL END,
             CASE WHEN $3 = 'failed'    THEN NOW() ELSE NULL END)
         RETURNING id`,
        [TEST_ORDER_ID, TEST_STEP, status]
    )
    return rows[0].id as string
}

async function cleanup(): Promise<void> {
    const pool = getDbPool()
    await pool.query(
        `DELETE FROM qb_order_pipeline WHERE order_id = $1`,
        [TEST_ORDER_ID]
    )
}

// ─── Test 1: findLatestInFlightRow — no rows → null ──────────────────────────

async function test1(): Promise<void> {
    const name = "Test 1: findLatestInFlightRow — no rows → returns null"
    try {
        const result = await findLatestInFlightRow(TEST_ORDER_ID, [TEST_STEP])
        if (result === null) {
            pass(name)
        } else {
            fail(name, `expected null but got row id=${result.id}`)
        }
    } catch (err: unknown) {
        fail(name, err instanceof Error ? err.message : String(err))
    }
}

// ─── Test 2: findLatestInFlightRow — submitted row → returns it ──────────────

async function test2(): Promise<void> {
    const name = "Test 2: findLatestInFlightRow — submitted row → returns it"
    try {
        await insertFakeRow("submitted")
        const result = await findLatestInFlightRow(TEST_ORDER_ID, [TEST_STEP])
        if (result !== null && result.status === "submitted") {
            pass(name)
        } else if (result === null) {
            fail(name, "expected submitted row but got null")
        } else {
            fail(name, `expected status=submitted but got status=${result.status}`)
        }
    } catch (err: unknown) {
        fail(name, err instanceof Error ? err.message : String(err))
    }
}

// ─── Test 3: Stale detection — pollUntilQbConfirmed returns "stale" ──────────

async function test3(): Promise<void> {
    const name = "Test 3: Stale detection — pollUntilQbConfirmed returns \"stale\""
    try {
        // The row from test 2 is still there; update it to be 20 minutes stale.
        // Temporarily disable the updated_at trigger so we can backdate it.
        const pool = getDbPool()
        await pool.query(`ALTER TABLE qb_order_pipeline DISABLE TRIGGER trg_qb_pipeline_updated_at`)
        await pool.query(
            `UPDATE qb_order_pipeline
             SET updated_at = NOW() - INTERVAL '20 minutes'
             WHERE order_id = $1 AND step = $2 AND status = 'submitted'`,
            [TEST_ORDER_ID, TEST_STEP]
        )
        await pool.query(`ALTER TABLE qb_order_pipeline ENABLE TRIGGER trg_qb_pipeline_updated_at`)

        const inFlight = await findLatestInFlightRow(TEST_ORDER_ID, [TEST_STEP])
        if (!inFlight) {
            fail(name, "could not find the stale row to poll")
            return
        }

        const start = Date.now()
        const outcome = await pollUntilQbConfirmed(inFlight.id, 10_000, 500)
        const elapsed = elapsedMs(start)

        if (outcome === "stale") {
            pass(name, `returned "stale" in ${elapsed}ms (expected near-instant)`)
        } else {
            fail(name, `expected "stale" but got "${outcome}" (${elapsed}ms)`)
        }
    } catch (err: unknown) {
        fail(name, err instanceof Error ? err.message : String(err))
    }
}

// ─── Test 4: withQbSerialized — waits for in-flight then proceeds ────────────

async function test4(): Promise<void> {
    const name = "Test 4: withQbSerialized — waits for in-flight then proceeds"
    try {
        // Clean up stale row from test 3 and insert a fresh submitted row
        await cleanup()
        const rowId = await insertFakeRow("submitted")

        let fnWasCalled = false
        const start = Date.now()

        // Confirm the row after 2 seconds (simulating QB bridge response)
        const confirmTimer = setTimeout(async () => {
            const pool = getDbPool()
            await pool.query(
                `UPDATE qb_order_pipeline
                 SET status = 'confirmed', updated_at = NOW(), confirmed_at = NOW()
                 WHERE id = $1`,
                [rowId]
            )
        }, 2_000)

        await withQbSerialized(
            `estimate:${TEST_ORDER_ID}`,
            { orderId: TEST_ORDER_ID, steps: [TEST_STEP] },
            async () => { fnWasCalled = true },
            { maxWaitMs: 10_000 }
        )

        clearTimeout(confirmTimer)
        const elapsed = elapsedMs(start)

        if (!fnWasCalled) {
            fail(name, "fn was never called")
        } else if (elapsed >= 10_000) {
            fail(name, `fn was called but took ${elapsed}ms — expected < 10s`)
        } else {
            pass(name, `fn called after ${elapsed}ms (expected ~2-5s)`)
        }
    } catch (err: unknown) {
        fail(name, err instanceof Error ? err.message : String(err))
    }
}

// ─── Test 5: withQbSerialized — no in-flight → proceeds immediately ──────────

async function test5(): Promise<void> {
    const name = "Test 5: withQbSerialized — no in-flight → proceeds immediately"
    try {
        // Ensure no in-flight rows
        await cleanup()

        let fnWasCalled = false
        const start = Date.now()

        await withQbSerialized(
            `estimate:${TEST_ORDER_ID}`,
            { orderId: TEST_ORDER_ID, steps: [TEST_STEP] },
            async () => { fnWasCalled = true },
            { maxWaitMs: 10_000 }
        )

        const elapsed = elapsedMs(start)

        if (!fnWasCalled) {
            fail(name, "fn was never called")
        } else if (elapsed >= 500) {
            fail(name, `fn took ${elapsed}ms — expected < 500ms`)
        } else {
            pass(name, `fn called in ${elapsed}ms`)
        }
    } catch (err: unknown) {
        fail(name, err instanceof Error ? err.message : String(err))
    }
}

// ─── Test 6: Serialization order — two concurrent calls execute sequentially ─

async function test6(): Promise<void> {
    const name = "Test 6: Serialization order — two concurrent calls execute sequentially"
    try {
        await cleanup()

        const events: Array<{ label: string; ts: number }> = []

        const fn1 = async (): Promise<void> => {
            events.push({ label: "fn1-start", ts: Date.now() })
            await new Promise<void>((resolve) => setTimeout(resolve, 2_000))
            events.push({ label: "fn1-end", ts: Date.now() })
        }

        const fn2 = async (): Promise<void> => {
            events.push({ label: "fn2-start", ts: Date.now() })
            events.push({ label: "fn2-end", ts: Date.now() })
        }

        // Launch both concurrently with the same lock key
        await Promise.all([
            withQbSerialized(
                `estimate:${TEST_ORDER_ID}`,
                { orderId: TEST_ORDER_ID, steps: [TEST_STEP] },
                fn1,
                { maxWaitMs: 10_000 }
            ),
            withQbSerialized(
                `estimate:${TEST_ORDER_ID}`,
                { orderId: TEST_ORDER_ID, steps: [TEST_STEP] },
                fn2,
                { maxWaitMs: 10_000 }
            ),
        ])

        const fn1End   = events.find((e) => e.label === "fn1-end")?.ts
        const fn2Start = events.find((e) => e.label === "fn2-start")?.ts

        if (fn1End === undefined || fn2Start === undefined) {
            fail(name, "could not find fn1-end or fn2-start events")
            return
        }

        if (fn2Start >= fn1End) {
            const gap = fn2Start - fn1End
            pass(name, `fn2 started ${gap}ms after fn1 ended (sequential)`)
        } else {
            const overlap = fn1End - fn2Start
            fail(name, `fn2 started ${overlap}ms BEFORE fn1 ended (concurrent — not sequential)`)
        }
    } catch (err: unknown) {
        fail(name, err instanceof Error ? err.message : String(err))
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log("\n=== QB Serializer Verification ===\n")

    try {
        // Ensure no leftover rows from a previous run
        await cleanup()

        await test1()
        await test2()
        await test3()
        await test4()
        await test5()
        await test6()
    } finally {
        await cleanup()
        await getDbPool().end()
    }

    const passed = results.filter((r) => r.passed).length
    const total  = results.length
    console.log(`\n${passed}/${total} tests passed\n`)

    process.exit(passed === total ? 0 : 1)
}

main().catch((err: unknown) => {
    console.error("Fatal error:", err instanceof Error ? err.message : String(err))
    process.exit(1)
})
