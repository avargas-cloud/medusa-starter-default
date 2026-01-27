import { ExecArgs } from "@medusajs/framework/types"
import { IProductModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function verifyQuickbooksIds({ container }: ExecArgs) {
    const productService: IProductModuleService = container.resolve(Modules.PRODUCT)

    console.log("🔍 Verifying QuickBooks IDs in Product Metadata...")

    const limit = 1000
    let offset = 0
    let totalProducts = 0
    let productsWithQbId = 0
    const missingQbIdSamples: string[] = []

    while (true) {
        const [products, count] = await productService.listAndCountProducts(
            {},
            {
                select: ["id", "title", "handle", "metadata"],
                take: limit,
                skip: offset,
            }
        )

        if (products.length === 0) break

        totalProducts += products.length // Counting accumulated fetched instead of relying on 'count' for loop

        for (const product of products) {
            const qbId = product.metadata?.quickbooks_id

            if (qbId) {
                productsWithQbId++
            } else {
                if (missingQbIdSamples.length < 5) {
                    missingQbIdSamples.push(`${product.title} (Handle: ${product.handle})`)
                }
            }
        }

        offset += limit
        if (products.length < limit) break
    }

    const coverage = totalProducts > 0 ? ((productsWithQbId / totalProducts) * 100).toFixed(2) : "0"

    console.log("\n📊 Verification Results:")
    console.log(`----------------------------------------`)
    console.log(`Total Products:       ${totalProducts}`)
    console.log(`With QuickBooks ID:   ${productsWithQbId}`)
    console.log(`Coverage:             ${coverage}%`)
    console.log(`----------------------------------------`)

    if (missingQbIdSamples.length > 0) {
        console.log("\n⚠️  Sample Products MISSING QuickBooks ID:")
        missingQbIdSamples.forEach(p => console.log(` - ${p}`))
    } else {
        console.log("\n✅ All products have a QuickBooks ID!")
    }
}
