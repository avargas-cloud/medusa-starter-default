import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { meiliClient, transformProduct, PRODUCTS_INDEX } from "../lib/meili-backend"

export default async function ({ container }: ExecArgs) {
    console.log("🔄 FORCE RE-SYNC: Deleting all products from MeiliSearch and re-syncing with variants...")

    const productModule = container.resolve(Modules.PRODUCT)
    const index = meiliClient.index(PRODUCTS_INDEX)

    // 1. Delete ALL documents from MeiliSearch
    console.log("📦 Step 1: Deleting all products from MeiliSearch...")
    await index.deleteAllDocuments()
    console.log("   ✅ All products deleted")

    // 2. Wait for deletion task
    console.log("⏳ Step 2: Waiting 3 seconds for deletion...")
    await new Promise(r => setTimeout(r, 3000))

    // 3. Fetch ALL products WITH VARIANTS from Postgres
    console.log("📦 Step 3: Fetching all products with variants from Postgres...")
    const allProducts = await productModule.listProducts({}, {
        relations: ["variants"],
        take: 5000
    })
    console.log(`   Found ${allProducts.length} products`)

    // 4. Transform and index
    console.log("📦 Step 4: Transforming and indexing products...")
    const transformed = allProducts.map(transformProduct)

    // Log first product to verify it has SKUs
    console.log("\n🔍 Sample transformed product:")
    console.log("ID:", transformed[0].id)
    console.log("Title:", transformed[0].title)
    console.log("variant_sku:", transformed[0].variant_sku)
    console.log("")

    const result = await index.addDocuments(transformed)
    console.log(`   ✅ Indexed ${allProducts.length} products`)
    console.log(`   Task UID: ${result.taskUid}`)

    // 5. Wait for indexing
    console.log("⏳ Step 5: Waiting for MeiliSearch to finish indexing...")
    await (meiliClient as any).waitForTask(result.taskUid)
    console.log("   ✅ Indexing complete!")

    console.log("\n🎉 Force re-sync completed! All products now have variants.")
}
