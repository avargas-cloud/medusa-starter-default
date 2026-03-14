/**
 * Quick test: Call sync-attributes to see if it works
 */
async function test() {
    const response = await fetch(
        "http://localhost:9000/admin/product-categories/pcat_led-strips-white/sync-attributes",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            }
        }
    )

    console.log("Status:", response.status)
    const data = await response.json()
    console.log("Response:", JSON.stringify(data, null, 2))
}

test().catch(console.error)
