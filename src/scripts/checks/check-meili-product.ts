import dotenv from "dotenv"
dotenv.config()

const PRODUCT_ID = "prod_100w-dimmable-power-supply-for-12vdc-led-units"

async function main() {
    console.log("🔍 Checking MeiliSearch for product update...")
    const { MeiliSearch } = await import("meilisearch")

    const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST!,
        apiKey: process.env.MEILISEARCH_API_KEY!,
    })

    const index = client.index("products")

    try {
        const document = await index.getDocument(PRODUCT_ID)
        console.log("📄 Document found:")
        console.log(`   ID: ${document.id}`)
        console.log(`   Title: ${document.title}`)

        if (document.title.includes("(Sync Test)")) {
            console.log("✅ SUCCESS: Product title updated in MeiliSearch!")
        } else {
            console.log("❌ FAILURE: Product title outdated in MeiliSearch.")
        }
    } catch (e: any) {
        console.error("❌ Error fetching document:", e.message)
    }
}

main()
