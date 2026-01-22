
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import * as fs from "fs"
import * as path from "path"

export default async function verifyDataMatch({ container }: ExecArgs) {
    const reportPath = path.join(process.cwd(), "src", "scripts", "verification-report.txt")
    let report = ""

    try {
        const remoteLink = container.resolve("remoteLink")
        const query = container.resolve("query")
        const productModule = container.resolve(Modules.PRODUCT)

        // The product we know has metadata
        const productId = "prod_100w-indoor-meanwell-power-supply-24vdc"

        report += `⚖️ DATA INTEGRITY CHECK for ${productId}\n`
        report += "----------------------------------------\n"

        // 1. Get Source Truth (Metadata)
        const product = await productModule.retrieveProduct(productId, { select: ["metadata"] })
        const sourceAttrs = (product.metadata?.wc_attributes as any[]) || []

        report += `📦 WooCommerce Source: ${sourceAttrs.length} attributes defined in metadata.\n`

        if (sourceAttrs.length === 0) {
            report += "⚠️ No source attributes to compare.\n"
            fs.writeFileSync(reportPath, report)
            return
        }

        // 2. Get Migrated Truth (Links) -> The reliable way
        const links = await remoteLink.list({
            [Modules.PRODUCT]: { product_id: productId }
        })

        const ids = links.map((l: any) => l.attribute_value_id)
        if (ids.length === 0) {
            report += "❌ No links found in DB (Migration failed).\n"
            fs.writeFileSync(reportPath, report)
            return
        }

        // 3. Hydrate Values
        const { data: medusaAttrs } = await query.graph({
            entity: "attribute_value",
            fields: ["id", "value", "attribute_key.label"],
            filters: { id: ids }
        })

        report += `🔗 Medusa Database:  ${medusaAttrs.length} attributes linked.\n`
        report += "----------------------------------------\n"

        // 4. Compare
        let matches = 0
        report += "📝 Detailed Comparison:\n"

        sourceAttrs.forEach(src => {
            const srcLabel = src.name.replace("pa_", "").replace(/-/g, " ").replace(/\b\w/g, (l: string) => l.toUpperCase())
            const srcValues = Array.isArray(src.options) ? src.options : [src.options]

            const found = medusaAttrs.find(m =>
                m.attribute_key?.label === srcLabel &&
                srcValues.some((v: string) => String(v).trim() === m.value)
            )

            if (found) {
                report += `   ✅ [MATCH] ${srcLabel}: "${found.value}"\n`
                matches++
            } else {
                report += `   ❌ [MISSING] ${srcLabel}: Expected one of [${srcValues.join(", ")}]\n`
            }
        })

        report += "----------------------------------------\n"
        report += `📊 Final Score: ${matches}/${sourceAttrs.length} matched.\n`

    } catch (e: any) {
        report += `\n❌ CRITICAL FAILURE: ${e.message}\n`
        if (e.stack) report += e.stack
    } finally {
        fs.writeFileSync(reportPath, report)
        console.log("Report generated.")
    }
}
