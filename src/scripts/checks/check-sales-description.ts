import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/utils"

export default async function ({ container }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    let skip = 0
    const take = 500
    let all: any[] = []

    while (true) {
        const { data } = await query.graph({
            entity: "product",
            fields: ["id", "title", "status", "metadata", "variants.*"],
            pagination: { skip, take }
        })
        if (!data.length) break
        all = all.concat(data)
        skip += take
    }

    const missing = all.filter((p: any) => !p.metadata?.sales_description)
    const filled = all.filter((p: any) => !!p.metadata?.sales_description)

    console.log(`\n${"=".repeat(60)}`)
    console.log(`📊 SALES DESCRIPTION COVERAGE REPORT`)
    console.log(`${"=".repeat(60)}`)
    console.log(`Total Products:  ${all.length}`)
    console.log(`✅ Filled:        ${filled.length} (${Math.round(filled.length / all.length * 100)}%)`)
    console.log(`❌ Missing:       ${missing.length} (${Math.round(missing.length / all.length * 100)}%)`)
    console.log(`${"=".repeat(60)}`)

    if (missing.length > 0) {
        console.log(`\nFirst 20 products missing sales_description:\n`)
        missing.slice(0, 20).forEach((p: any) => {
            const sku = p.variants?.[0]?.sku || "no-sku"
            console.log(`  [${p.status}] ${sku} — ${p.title}`)
        })
        if (missing.length > 20) {
            console.log(`  ... and ${missing.length - 20} more`)
        }
    }
}
