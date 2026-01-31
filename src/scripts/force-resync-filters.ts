export default async function ({ container }: any) {
    const http = container.resolve("@medusajs/framework/http")

    const categoryHandle = "led-strips-white"

    console.log(`🔄 Forcing filter re-sync for category: ${categoryHandle}`)

    // Trigger filter generation
    const response = await http.fetch(
        `http://localhost:9000/admin/product-categories/${categoryHandle}/generate-filters`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            }
        }
    )

    if (!response.ok) {
        console.error(`❌ Failed to sync filters: ${response.status}`)
        const text = await response.text()
        console.error(text)
        return
    }

    const data = await response.json()
    console.log(`✅ Filter sync complete`)
    console.log(JSON.stringify(data, null, 2))
}
