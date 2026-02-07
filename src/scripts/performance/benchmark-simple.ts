#!/usr/bin/env tsx
/**
 * Simple HTTP-based benchmark for products-with-filters endpoint
 * Run with: npx tsx src/scripts/performance/benchmark-simple.ts
 */

const BACKEND_URL = "http://localhost:9000"
const LED_STRIPS_ID = "pcat_01KGAD1KQXDWJEP7HE92G5FCS4"

async function benchmark() {
    console.log("🔥 PERFORMANCE BENCHMARK")
    console.log("=".repeat(60))

    const results: number[] = []

    for (let i = 1; i <= 5; i++) {
        const url = `${BACKEND_URL}/store/categories/${LED_STRIPS_ID}/products-with-filters?limit=100`

        console.log(`\n📊 Iteration ${i}/5...`)
        const start = performance.now()

        try {
            const res = await fetch(url)
            const data = await res.json()
            const duration = performance.now() - start

            results.push(duration)
            console.log(`   ⏱️  ${duration.toFixed(2)}ms`)
            console.log(`   📦 ${data.products?.length} products`)
        } catch (e: any) {
            console.log(`   ❌ Error: ${e.message}`)
        }

        await new Promise(r => setTimeout(r, 500))
    }

    const avg = results.reduce((a, b) => a + b, 0) / results.length
    console.log(`\n${"=".repeat(60)}`)
    console.log(`📈 Average: ${avg.toFixed(2)}ms`)
    console.log(`📊 Min: ${Math.min(...results).toFixed(2)}ms`)
    console.log(`📊 Max: ${Math.max(...results).toFixed(2)}ms`)
    console.log("=".repeat(60))

    if (avg > 3000) {
        console.log("🔥 VERY SLOW - Needs optimization!")
    } else if (avg > 1000) {
        console.log("⚠️  SLOW - Could be better")
    } else if (avg > 300) {
        console.log("✅ ACCEPTABLE")
    } else {
        console.log("🚀 EXCELLENT!")
    }
}

benchmark().catch(console.error)
