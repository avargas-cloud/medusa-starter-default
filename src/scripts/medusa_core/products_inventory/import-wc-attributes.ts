import { ExecArgs } from "@medusajs/framework/types"
import { createAttributeKeyWorkflow } from "../workflows/product-attributes/create-attribute-key"

interface WcAttribute {
    id: number
    name: string
    slug: string
}

interface WcTerm {
    id: number
    name: string
    slug: string
}

export default async function importWcAttributes({ container }: ExecArgs) {
    const WC_URL = process.env.WC_URL
    const WC_KEY = process.env.WC_CONSUMER_KEY
    const WC_SECRET = process.env.WC_CONSUMER_SECRET

    if (!WC_URL || !WC_KEY || !WC_SECRET) {
        console.error("❌ Missing WooCommerce credentials in .env")
        return
    }

    console.log(`\n🔗 Connecting to WooCommerce: ${WC_URL}`)
    console.log("---------------------------------------------------")

    const authHeader = 'Basic ' + Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString('base64')

    try {
        // 1. Fetch Attributes (Taxonomies)
        const attrsResponse = await fetch(`${WC_URL}/wp-json/wc/v3/products/attributes`, {
            headers: { Authorization: authHeader }
        })

        if (!attrsResponse.ok) {
            throw new Error(`Failed to fetch attributes: ${attrsResponse.statusText}`)
        }

        const attributes = (await attrsResponse.json()) as WcAttribute[]
        console.log(`✅ Found ${attributes.length} Attribute Taxonomies\n`)

        let imported = 0
        let skipped = 0

        // 2. Import Each Attribute
        for (const attr of attributes) {
            try {
                // Fetch terms for this attribute
                const termsResponse = await fetch(`${WC_URL}/wp-json/wc/v3/products/attributes/${attr.id}/terms`, {
                    headers: { Authorization: authHeader }
                })

                const terms = (await termsResponse.json()) as WcTerm[]

                // Strip "pa_" prefix from handle
                const cleanHandle = attr.slug.startsWith("pa_")
                    ? attr.slug.substring(3)
                    : attr.slug

                // Execute workflow to create AttributeKey
                const { result } = await createAttributeKeyWorkflow(container).run({
                    input: {
                        handle: cleanHandle,
                        label: attr.name,
                        options: terms.map(t => t.name)
                    }
                })

                console.log(`✅ [${imported + 1}/${attributes.length}] Imported: ${attr.name} (${cleanHandle}) - ${terms.length} options`)
                imported++

            } catch (error: any) {
                if (error.message?.includes('duplicate') || error.message?.includes('unique')) {
                    console.log(`⚠️  Skipped (already exists): ${attr.name}`)
                    skipped++
                } else {
                    console.error(`❌ Failed to import ${attr.name}:`, error.message)
                    skipped++
                }
            }
        }

        console.log("\n---------------------------------------------------")
        console.log("📊 IMPORT SUMMARY:")
        console.log(`   ✅ Successfully imported: ${imported}`)
        console.log(`   ⚠️  Skipped/Failed: ${skipped}`)
        console.log(`   📦 Total: ${attributes.length}`)
        console.log("---------------------------------------------------")

    } catch (error) {
        console.error("❌ Error during import:", error)
    }
}
