import { MedusaContainer } from "@medusajs/types"
import { Client } from "pg"

export default async function run({ container }: { container: MedusaContainer }) {
    const query = container.resolve("query")

    console.log("Loading qb_price_sync_output.json...")
    const fs = require("fs")
    const path = require("path")
    
    const filePath = path.join(__dirname, "../../qb_price_sync_output.json")
    if (!fs.existsSync(filePath)) {
         console.error("File not found! Run check-qb-products.ts first.")
         process.exit(1)
    }
    const qbData = JSON.parse(fs.readFileSync(filePath))
    const qbMap = new Map(qbData.map((item: any) => [item.ListID, item]))

    console.log("Fetching Medusa variants...")
    const { data: variants } = await query.graph({
        entity: "variant",
        fields: ["id", "sku", "metadata"]
    })

    const qbVariants = variants.filter((v: any) => v.metadata?.quickbooks_id)
    console.log(`Found ${qbVariants.length} variants linked to QB.`)

    const updates: any[] = []
    let unchangedCount = 0

    for (const variant of qbVariants) {
        const qbId = variant.metadata.quickbooks_id
        const qbItem = qbMap.get(qbId)

        if (!qbItem) continue

        const cost = parseFloat(qbItem.PurchaseCost || "0")
        const vendorId = qbItem.PrefVendorRef?.ListID || null
        const vendorName = qbItem.PrefVendorRef?.FullName || null
        const mpn = qbItem.ManufacturerPartNumber || null

        const m = variant.metadata || {}
        if (
            m.qb_purchase_cost === cost &&
            m.qb_vendor_id === vendorId &&
            m.qb_vendor_name === vendorName &&
            m.mpn === mpn
        ) {
            unchangedCount++
            continue
        }

        m.qb_purchase_cost = cost
        m.qb_vendor_id = vendorId
        m.qb_vendor_name = vendorName
        m.mpn = mpn

        updates.push({ id: variant.id, metadata: m })
    }

    if (updates.length > 0) {
        console.log(`\nPushing ${updates.length} metadata updates via RAW Postgres UNNEST...`)
        
        const client = new Client({ connectionString: process.env.DATABASE_URL })
        await client.connect()

        try {
            const ids = updates.map(u => u.id)
            const metadatas = updates.map(u => JSON.stringify(u.metadata))

            const queryText = `
                UPDATE product_variant AS pv
                SET 
                    metadata = (u.metadata)::jsonb,
                    updated_at = NOW()
                FROM UNNEST($1::text[], $2::text[]) AS u(id, metadata)
                WHERE pv.id = u.id;
            `
            const start = Date.now()
            const result = await client.query(queryText, [ids, metadatas])
            const end = Date.now()

            console.log(`✅ Bulk update complete! ${result.rowCount} rows updated in ${end - start}ms`)
        } catch (e) {
            console.error("Metadata bulk update failed:", e)
        } finally {
            await client.end()
        }
        
        console.log(`✅ Update complete! Updated: ${updates.length}, Unchanged: ${unchangedCount}`)
    } else {
        console.log(`✅ No updates needed. All matching variants are in sync. (Checked ${unchangedCount} variants)`)
    }
}
