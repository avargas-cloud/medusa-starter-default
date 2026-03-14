/**
 * Check if available_attributes and filters_metadata were removed
 */

const basePath = "http://localhost:9000"
const apiKey = "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3"

async function check() {
    const response = await fetch(`${basePath}/store/debug/white-led-metadata`, {
        headers: { 'x-publishable-api-key': apiKey }
    })

    const data = await response.json()

    console.log("✅ Metadata keys present:")
    console.log(Object.keys(data.metadata))

    console.log("\n📊 Checking old metadata:")
    console.log("- available_attributes:", data.metadata.available_attributes ? "❌ STILL EXISTS" : "✅ REMOVED")
    console.log("- filters_metadata:", data.metadata.filters_metadata ? "❌ STILL EXISTS" : "✅ REMOVED")
    console.log("- filters:", data.metadata.filters ? `✅ EXISTS (${data.metadata.filters.length} filters)` : "❌ MISSING")

    if (data.metadata.filters && data.metadata.filters.length > 0) {
        console.log("\n📋 First filter example:")
        console.log(JSON.stringify(data.metadata.filters[0], null, 2))
    }
}

check().catch(console.error)
