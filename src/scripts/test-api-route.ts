import { ExecArgs } from "@medusajs/framework/types"

export default async function testApiRoute({ container }: ExecArgs) {
    console.log("🚀 Testing API Route Accessibility...")
    const port = process.env.PORT || 9000
    try {
        const response = await fetch(`http://localhost:${port}/admin/search/inventory/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ q: "", limit: 1 })
        })

        console.log("Status:", response.status)
        if (response.ok) {
            const data = await response.json()
            console.log("✅ API Route Working!")
            console.log("Hits:", data.hits?.length)
        } else {
            console.error("❌ API Route Failed:", await response.text())
        }
    } catch (error) {
        console.error("❌ Connection Failed:", error)
    }
}
