import { ExecArgs } from "@medusajs/framework/types"

interface WcAttribute {
    id: number
    name: string
    slug: string
    type: string
    order_by: string
    has_archives: boolean
}

interface WcTerm {
    id: number
    name: string
    slug: string
    count: number
}

export default async function inspectWcAttributes({ container }: ExecArgs) {
    const WC_URL = process.env.WC_URL
    const WC_KEY = process.env.WC_CONSUMER_KEY
    const WC_SECRET = process.env.WC_CONSUMER_SECRET

    if (!WC_URL || !WC_KEY || !WC_SECRET) {
        console.error("❌ Missing WooCommerce credentials in .env")
        return
    }

    console.log(`\n🔍 Connecting to WooCommerce: ${WC_URL}`)
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

        const previewData: any[] = []

        // 2. Fetch Terms for each Attribute
        for (const attr of attributes) {
            const termsResponse = await fetch(`${WC_URL}/wp-json/wc/v3/products/attributes/${attr.id}/terms`, {
                headers: { Authorization: authHeader }
            })

            const terms = (await termsResponse.json()) as WcTerm[]

            console.log(`📦 [${attr.name}] (slug: ${attr.slug}) - ${terms.length} options`)

            previewData.push({
                label: attr.name,
                handle: attr.slug, // Will become 'material', 'color', etc.
                options_count: terms.length,
                example_values: terms.slice(0, 5).map(t => t.name).join(", ") + (terms.length > 5 ? "..." : "")
            })
        }

        console.log("\n---------------------------------------------------")
        console.log("📄 SUMMARY OF DATA TO BE MIGRATED:")
        console.table(previewData)
        console.log("---------------------------------------------------")
        console.log("⚠️  NOTE: This was a READ-ONLY inspection. No data was saved.")

    } catch (error) {
        console.error("❌ Error during inspection:", error)
    }
}
