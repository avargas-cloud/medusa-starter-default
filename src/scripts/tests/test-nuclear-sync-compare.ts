#!/usr/bin/env tsx

/**
 * Test: Nuclear Sync + Compare Filters
 * 
 * 1. Ejecuta Nuclear Sync para regenerar todos los filtros
 * 2. Compara filtros del endpoint combinado vs metadata.filters
 */

const BACKEND_URL = "http://localhost:9000"
const LED_STRIPS_ID = "pcat_01KGAD1KQXDWJEP7HE92G5FCS4"

async function runNuclearSync() {
    console.log("\n🚀 Ejecutando Nuclear Sync...\n")

    try {
        const response = await fetch(`${BACKEND_URL}/admin/product-categories/nuclear-sync`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
        })

        if (!response.ok) {
            console.error(`❌ Nuclear sync failed: ${response.status}`)
            const error = await response.json()
            console.error(error)
            return false
        }

        const result = await response.json()
        console.log(`✅ Nuclear Sync Complete!`)
        console.log(`   Phase 1: ${result.phase1.processed} categories processed, ${result.phase1.skipped} skipped`)
        console.log(`   Phase 2: ${result.phase2.generated} filters generated, ${result.phase2.failed} failed`)

        return true
    } catch (error: any) {
        console.error(`❌ Error: ${error.message}`)
        return false
    }
}

async function compareFilters() {
    console.log(`\n${"=".repeat(80)}`)
    console.log(`🔍 Comparando Filtros: LED Strips`)
    console.log(`${"=".repeat(80)}`)

    try {
        // 1. Fetch from combined endpoint
        console.log(`\n📡 1. Fetching from combined endpoint...`)
        const combinedResponse = await fetch(
            `${BACKEND_URL}/store/categories/${LED_STRIPS_ID}/products-with-filters?limit=1`
        )

        if (!combinedResponse.ok) {
            console.error(`❌ Combined endpoint failed: ${combinedResponse.status}`)
            return
        }

        const combinedData = await combinedResponse.json()
        const endpointFilters = combinedData.filters || []

        console.log(`   ✅ Filters from endpoint: ${endpointFilters.length}`)

        // 2. Fetch category metadata directly
        console.log(`\n📦 2. Fetching category metadata...`)
        const categoryResponse = await fetch(
            `${BACKEND_URL}/store/categories/${LED_STRIPS_ID}`
        )

        if (!categoryResponse.ok) {
            console.error(`❌ Category fetch failed: ${categoryResponse.status}`)
            return
        }

        const categoryData = await categoryResponse.json()
        const metadataFilters = categoryData.product_category?.metadata?.filters || []

        console.log(`   ✅ Filters from metadata: ${metadataFilters.length}`)

        // 3. Compare
        console.log(`\n🔄 3. Comparing...`)
        console.log(`${"=".repeat(80)}`)

        if (endpointFilters.length !== metadataFilters.length) {
            console.log(`⚠️  COUNT MISMATCH!`)
            console.log(`   Endpoint: ${endpointFilters.length}`)
            console.log(`   Metadata: ${metadataFilters.length}`)
        } else {
            console.log(`✅ Same count: ${endpointFilters.length} filters`)
        }

        // 4. Deep comparison filter by filter
        console.log(`\n📊 Filter-by-Filter Comparison:\n`)

        for (let i = 0; i < Math.max(endpointFilters.length, metadataFilters.length); i++) {
            const endpointFilter = endpointFilters[i]
            const metadataFilter = metadataFilters[i]

            if (!endpointFilter && metadataFilter) {
                console.log(`❌ Filter ${i + 1}: Only in METADATA`)
                console.log(`   Name: ${metadataFilter.name}`)
                continue
            }

            if (endpointFilter && !metadataFilter) {
                console.log(`❌ Filter ${i + 1}: Only in ENDPOINT`)
                console.log(`   Name: ${endpointFilter.name}`)
                continue
            }

            // Compare IDs
            if (endpointFilter.id !== metadataFilter.id) {
                console.log(`⚠️  Filter ${i + 1}: ID mismatch`)
                console.log(`   Endpoint: ${endpointFilter.id}`)
                console.log(`   Metadata: ${metadataFilter.id}`)
                continue
            }

            // Compare names
            if (endpointFilter.name !== metadataFilter.name) {
                console.log(`⚠️  Filter ${i + 1}: Name mismatch`)
                console.log(`   Endpoint: ${endpointFilter.name}`)
                console.log(`   Metadata: ${metadataFilter.name}`)
                continue
            }

            // Compare options count
            const endpointOptionsCount = endpointFilter.options?.length || 0
            const metadataOptionsCount = metadataFilter.options?.length || 0

            if (endpointOptionsCount !== metadataOptionsCount) {
                console.log(`⚠️  Filter ${i + 1}: ${endpointFilter.name}`)
                console.log(`   Options count mismatch`)
                console.log(`   Endpoint: ${endpointOptionsCount}`)
                console.log(`   Metadata: ${metadataOptionsCount}`)
                continue
            }

            // Deep compare options
            let optionMismatch = false
            for (let j = 0; j < endpointOptionsCount; j++) {
                const endpointOpt = endpointFilter.options[j]
                const metadataOpt = metadataFilter.options[j]

                if (endpointOpt.value !== metadataOpt.value ||
                    endpointOpt.count !== metadataOpt.count) {
                    optionMismatch = true
                    break
                }
            }

            if (optionMismatch) {
                console.log(`⚠️  Filter ${i + 1}: ${endpointFilter.name}`)
                console.log(`   Option values/counts mismatch`)
            } else {
                console.log(`✅ Filter ${i + 1}: ${endpointFilter.name} (${endpointOptionsCount} options) - MATCH`)
            }
        }

        // 5. JSON comparison (full objects)
        console.log(`\n📄 Full JSON Comparison:\n`)

        const endpointJSON = JSON.stringify(endpointFilters, null, 2)
        const metadataJSON = JSON.stringify(metadataFilters, null, 2)

        if (endpointJSON === metadataJSON) {
            console.log(`✅ PERFECT MATCH! JSONs are identical.`)
        } else {
            console.log(`⚠️  JSONs differ.`)
            console.log(`\nEndpoint Sample (first filter):`)
            console.log(JSON.stringify(endpointFilters[0], null, 2))
            console.log(`\nMetadata Sample (first filter):`)
            console.log(JSON.stringify(metadataFilters[0], null, 2))
        }

    } catch (error: any) {
        console.error(`❌ Comparison failed: ${error.message}`)
    }
}

async function main() {
    console.log(`\n${"=".repeat(80)}`)
    console.log(`🧪 Nuclear Sync + Filter Comparison Test`)
    console.log(`${"=".repeat(80)}`)

    // Step 1: Nuclear Sync
    const syncSuccess = await runNuclearSync()

    if (!syncSuccess) {
        console.log(`\n❌ Nuclear sync failed. Cannot proceed with comparison.`)
        return
    }

    // Wait 2 seconds for data to settle
    console.log(`\n⏳ Waiting 2 seconds for data to settle...`)
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Step 2: Compare
    await compareFilters()

    console.log(`\n✅ Test completed!\n`)
}

main().catch(console.error)
