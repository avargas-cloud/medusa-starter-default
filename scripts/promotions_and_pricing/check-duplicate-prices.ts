import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/utils"

export default async function ({ container }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    console.log("🔍 Checking for variants with duplicate default retail prices...\n")

    // Fetch all variants with their prices
    const { data: variants } = await query.graph({
        entity: "variant",
        fields: ["id", "sku", "price_set.id", "price_set.prices.*"]
    })

    const withDuplicates: { sku: string; count: number; amounts: number[] }[] = []

    for (const v of variants) {
        if (!v.price_set?.prices) continue
        const retailPrices = (v.price_set.prices as any[]).filter((p: any) => !p.price_list_id)
        if (retailPrices.length > 1) {
            withDuplicates.push({
                sku: v.sku || v.id,
                count: retailPrices.length,
                amounts: retailPrices.map((p: any) => p.amount)
            })
        }
    }

    if (withDuplicates.length === 0) {
        console.log("✅ All clean — no variants with duplicate default retail prices!")
    } else {
        console.log(`⚠️  Found ${withDuplicates.length} variants with duplicate retail prices:\n`)
        withDuplicates.forEach(v => {
            console.log(`  • ${v.sku}: ${v.count} prices — $${v.amounts.map(a => a.toFixed(2)).join(', $')}`)
        })
    }
    console.log(`\nTotal variants checked: ${variants.length}`)
}
