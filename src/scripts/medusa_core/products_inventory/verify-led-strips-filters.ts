#!/usr/bin/env tsx

/**
 * Compare FILTER COUNTS: Endpoint vs Metadata
 * 
 * Ignores structure differences, only compares:
 * - Number of filters
 * - Number of options per filter
 * - COUNT values
 */

import { Client } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const LED_STRIPS_ID = "pcat_01KGAD1KQXDWJEP7HE92G5FCS4"
const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"
const PUBLISHABLE_KEY = process.env.PUBLIC_MEDUSA_PUBLISHABLE_KEY || ""

async function compareFilterCounts() {
    console.log(`\n${"=".repeat(80)}`)
    console.log(`🔍 LED Strips: Comparing Filter COUNTS (Endpoint vs Metadata)`)
    console.log(`${"=".repeat(80)}`)

    // 1. Fetch from endpoint
    const endpointResponse = await fetch(
        `${BACKEND_URL}/store/categories/${LED_STRIPS_ID}/products-with-filters?limit=1`,
        {
            headers: {
                'x-publishable-api-key': PUBLISHABLE_KEY
            }
        }
    )

    if (!endpointResponse.ok) {
        console.error(`❌ Endpoint failed: ${endpointResponse.status}`)
        return
    }

    const endpointData = await endpointResponse.json()
    const endpointFilters = endpointData.filters || []

    // 2. Fetch from database
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()

    const result = await client.query(`
        SELECT metadata 
        FROM product_category 
        WHERE id = $1
    `, [LED_STRIPS_ID])

    await client.end()

    const metadata = result.rows[0]?.metadata || {}
    const metadataFilters = metadata.filters || []

    // 3. Compare
    console.log(`\n📊 FILTER COUNT COMPARISON`)
    console.log(`${"=".repeat(80)}\n`)

    console.log(`Total Filters:`)
    console.log(`  Endpoint: ${endpointFilters.length}`)
    console.log(`  Metadata: ${metadataFilters.length}`)

    if (endpointFilters.length !== metadataFilters.length) {
        console.log(`\n❌ MISMATCH: Different number of filters!`)
        return
    }

    console.log(`  ✅ Match!\n`)

    // 4. Sort both by attribute/name to compare in order
    const sortEndpoint = [...endpointFilters].sort((a, b) =>
        (a.attribute || a.name).localeCompare(b.attribute || b.name)
    )
    const sortMetadata = [...metadataFilters].sort((a, b) =>
        a.name.localeCompare(b.name)
    )

    console.log(`${"─".repeat(80)}`)
    console.log(`Filter-by-Filter Comparison:\n`)

    let allMatch = true

    for (let i = 0; i < sortEndpoint.length; i++) {
        const eFilter = sortEndpoint[i]
        const mFilter = sortMetadata[i]

        const eAttr = eFilter.attribute || eFilter.name
        const mAttr = mFilter.name

        const eOptions = eFilter.options || []
        const mOptions = mFilter.options || []

        // Compare option counts
        if (eOptions.length !== mOptions.length) {
            console.log(`❌ ${i + 1}. ${eAttr}`)
            console.log(`   Options: E(${eOptions.length}) vs M(${mOptions.length}) - MISMATCH`)
            allMatch = false
            continue
        }

        // Sort options by value
        const eSorted = [...eOptions].sort((a, b) =>
            (a.option || a.value).localeCompare(b.option || b.value)
        )
        const mSorted = [...mOptions].sort((a, b) =>
            a.value.localeCompare(b.value)
        )

        // Compare counts
        let countsMatch = true
        for (let j = 0; j < eSorted.length; j++) {
            const eCount = eSorted[j].count
            const mCount = mSorted[j].count

            if (eCount !== mCount) {
                countsMatch = false
                break
            }
        }

        if (countsMatch) {
            console.log(`✅ ${i + 1}. ${eAttr}`)
            console.log(`   Options: ${eOptions.length}, all counts match`)
        } else {
            console.log(`⚠️  ${i + 1}. ${eAttr}`)
            console.log(`   Options: ${eOptions.length}, but COUNTS differ:`)
            for (let j = 0; j < Math.min(3, eSorted.length); j++) {
                const eOpt = eSorted[j]
                const mOpt = mSorted[j]
                const eVal = eOpt.option || eOpt.value
                const mVal = mOpt.value
                console.log(`     ${eVal}: E(${eOpt.count}) vs M(${mOpt.count})`)
            }
            allMatch = false
        }
    }

    console.log(`\n${"=".repeat(80)}`)
    console.log(`📈 FINAL RESULT`)
    console.log(`${"=".repeat(80)}`)

    if (allMatch) {
        console.log(`\n🎉 PERFECT MATCH!`)
        console.log(`   ✅ All filter counts are IDENTICAL`)
        console.log(`   ✅ Endpoint calculation matches metadata`)
        console.log(`   ✅ Ready for full Nuclear Sync (Opción C)`)
    } else {
        console.log(`\n⚠️  Counts differ`)
        console.log(`   The endpoint is calculating differently than metadata`)
    }
}

async function main() {
    try {
        await compareFilterCounts()
    } catch (error: any) {
        console.error(`\n❌ Error: ${error.message}`)
        console.error(error.stack)
    }
}

main()
