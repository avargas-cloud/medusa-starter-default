import { ExecArgs } from "@medusajs/framework/types"

export default async function forceMeiliSettings({ container }: ExecArgs) {
    console.log("🛠️ Forcing MeiliSearch Settings Update...")
    const { MeiliSearch } = await import("meilisearch")

    const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST!,
        apiKey: process.env.MEILISEARCH_API_KEY!,
    })
    const index = client.index("products")

    // Force reset displayedAttributes to ALL
    console.log("... Resetting displayedAttributes to ['*']")
    await index.updateSettings({
        displayedAttributes: ["*"],
        sortableAttributes: [
            "title",
            "status",
            "id",
            "updated_at",
            "created_at"
        ]
    })

    // Poll for task completion
    console.log("... Waiting for settings update to apply")
    const settings = await index.getSettings()
    console.log("✅ NEW SETTINGS:", JSON.stringify(settings.displayedAttributes, null, 2))
}
