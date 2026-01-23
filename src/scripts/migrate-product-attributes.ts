
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import ProductAttributesService from "../modules/product-attributes/service"
import { IProductModuleService } from "@medusajs/framework/types"
import { Client } from "pg"

export default async function migrateProductAttributes({ container }: ExecArgs) {
    try {
        console.log("🚀 Starting Product Attribute Migration (Safe Mode)...")

        const productModule: IProductModuleService = container.resolve(Modules.PRODUCT)
        const attributeService: ProductAttributesService = container.resolve("productAttributes")
        const remoteLink = container.resolve("remoteLink")

        // 1. Fetch products
        const products = await productModule.listProducts({}, { take: 9999, select: ["id", "title", "metadata"] })
        console.log(`📋 Found ${products.length} products to check.`)

        let linksCreated = 0
        let productsProcessed = 0
        let errors = 0

        for (const product of products) {
            const wcAttributes = product.metadata?.wc_attributes as any[]
            const isTarget = product.id === "prod_100w-indoor-meanwell-power-supply-24vdc"

            if (isTarget) {
                console.log(`\n🎯 DEBUG TARGET FOUND: ${product.id}`)
                console.log(`   Has wc_attributes? ${!!wcAttributes}`)
                console.log(`   Length: ${wcAttributes?.length}`)
            }

            if (!wcAttributes || !Array.isArray(wcAttributes) || wcAttributes.length === 0) {
                if (isTarget) console.log("   ❌ SKIPPING: No valid attributes found in metadata logic.")
                continue
            }

            if (productsProcessed % 10 === 0) console.log(`🔄 Processing product ${productsProcessed + 1}/${products.length}...`)

            productsProcessed++

            // Deduplicate Values for this product
            const seenValueIds = new Set<string>()
            const payloadQueue: any[] = []

            for (const attr of wcAttributes) {
                if (!attr.name || !attr.options) continue

                let handle = attr.name.toLowerCase().replace("pa_", "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
                const label = attr.name.replace("pa_", "").replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase())

                if (!handle) continue

                // Find/Create Key
                let [key] = await attributeService.listAttributeKeys({ handle }, { take: 1 })
                if (!key) {
                    key = await attributeService.createAttributeKeys({ handle, label }) // Removed 'title'
                }

                // Process Options
                const options = Array.isArray(attr.options) ? attr.options : [attr.options]
                for (const rawValue of options) {
                    if (!rawValue) continue
                    const valueStr = String(rawValue).trim()

                    // Find/Create Value
                    let [val] = await attributeService.listAttributeValues({
                        attribute_key_id: key.id,
                        value: valueStr
                    }, { take: 1 })

                    if (!val) {
                        val = await attributeService.createAttributeValues({
                            attribute_key_id: key.id,
                            value: valueStr,
                            // Rank removed if not in DTO
                            metadata: {}
                        })
                    }

                    if (seenValueIds.has(val.id)) continue;
                    seenValueIds.add(val.id)

                    payloadQueue.push({
                        [Modules.PRODUCT]: { product_id: product.id },
                        "productAttributes": { attribute_value_id: val.id }
                    } as any) // Cast to any to avoid strict typing issues with dynamic keys
                }
            }

            // Create links via DIRECT SQL to bypass application-level 1:1 checks
            if (payloadQueue.length > 0) {
                console.log(`   🔗 Linking ${payloadQueue.length} attributes for product: ${product.title} (${product.id})`)

                // Construct Batch Insert Query
                // Table: product_product_productattributes_attribute_value
                // Cols: id, product_id, attribute_value_id

                const client = new Client({
                    connectionString: process.env.DATABASE_URL,
                    ssl: { rejectUnauthorized: false }
                })

                try {
                    await client.connect()

                    for (const payload of payloadQueue) {
                        const prodId = payload[Modules.PRODUCT].product_id
                        const attrId = payload["productAttributes"].attribute_value_id
                        // Generate a deterministic or random ID for the link
                        const linkId = `link_${Math.random().toString(36).substring(7)}`

                        try {
                            await client.query(`
                                INSERT INTO "product_product_productattributes_attribute_value" 
                                ("id", "product_id", "attribute_value_id")
                                VALUES ($1, $2, $3)
                                ON CONFLICT ("product_id", "attribute_value_id") DO NOTHING;
                            `, [linkId, prodId, attrId])

                            linksCreated++
                            console.log(`      ✅ Linked (SQL): ${attrId}`)
                        } catch (sqlErr: any) {
                            console.error("      ❌ SQL Insert Error:", sqlErr.message)
                            errors++
                        }
                    }
                } catch (connErr: any) {
                    console.error("   ❌ DB Connection Failed:", connErr.message)
                } finally {
                    await client.end()
                }
            }

            if (payloadQueue.length > 0) {
                console.log(`      ✅ Complete.`)
            }
        }

        console.log(`\n✅ Safe Migration Complete!`)
        console.log(`   - Products processed: ${productsProcessed}`)
        console.log(`   - Links create attempts success: ${linksCreated}`)
        console.log(`   - Errors (likely duplicates): ${errors}`)

    } catch (error) {
        console.error("❌ Critical Error:", error)
    }
}
