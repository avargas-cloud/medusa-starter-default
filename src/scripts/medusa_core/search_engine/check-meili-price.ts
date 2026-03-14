/**
 * Check MeiliSearch inventory index for EPS-MDA-60-24
 */

import { MeiliSearch } from "meilisearch"

export default async function checkMeiliPrice() {
    const logger = console

    const log = (msg: string) => {
        console.log(msg)
        logger.info(msg)
    }

    log(`\n🔍 CHECKING MEILISEARCH INVENTORY INDEX\n`)

    try {
        const client = new MeiliSearch({
            host: process.env.MEILI_HOST || "http://localhost:7700",
            apiKey: process.env.MEILI_MASTER_KEY || "masterKey"
        })

        const index = client.index("inventory")

        // Get specific document
        const doc = await index.getDocument("EPS-MDA-60-24")

        log(`✅ Found in MeiliSearch:`)
        log(`   SKU: ${doc.sku}`)
        log(`   Title: ${doc.title}`)
        log(`   Price: $${(doc as any).price}`)
        log(`   Currency: ${(doc as any).currency_code}`)
        log(`\n📋 Full document:`)
        log(JSON.stringify(doc, null, 2))

        log(`\n${"=".repeat(70)}`)
        log("📝 COMPARISON")
        log("=".repeat(70))
        log(`Database: $45.25`)
        log(`MeiliSearch: $${(doc as any).price}`)

        if ((doc as any).price === 34.99) {
            log(`\n❌ MEILISEARCH HAS OLD PRICE!`)
            log(`   Need to re-sync inventory to MeiliSearch`)
        } else if ((doc as any).price === 45.25) {
            log(`\n✅ MeiliSearch has correct price`)
        }
        log("=".repeat(70))

        return { success: true }

    } catch (error: any) {
        log(`❌ Error: ${error.message}`)
        console.error(error.stack)
        throw error
    }
}
