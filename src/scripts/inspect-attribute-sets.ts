import { ExecArgs } from "@medusajs/framework/types"
import { PRODUCT_ATTRIBUTES_MODULE } from "../modules/product-attributes"

export default async function ({ container }: ExecArgs) {
    const productAttributesService = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

    console.log("🔍 Checking Attribute Sets in Database...\n")

    try {
        // List all attribute sets
        const sets = await productAttributesService.listAttributeSets()

        console.log(`📊 Found ${sets.length} Attribute Set(s) in database:\n`)

        if (sets.length === 0) {
            console.log("   ⚠️  No attribute sets found yet")
            console.log("   💡 You can create one through the Admin UI\n")
        } else {
            sets.forEach((set: any, index: number) => {
                console.log(`${index + 1}. ${set.title}`)
                console.log(`   ID: ${set.id}`)
                console.log(`   Handle: ${set.handle}`)
                console.log(`   Created: ${new Date(set.created_at).toLocaleString()}`)
                console.log("")
            })
        }

        // Check attributes with sets
        const allAttributes = await productAttributesService.listAttributeKeys()
        const withSets = allAttributes.filter((attr: any) => attr.attribute_set_id)
        const withoutSets = allAttributes.filter((attr: any) => !attr.attribute_set_id)

        console.log(`\n📋 Attribute Assignment Status:`)
        console.log(`   Total attributes: ${allAttributes.length}`)
        console.log(`   Assigned to sets: ${withSets.length}`)
        console.log(`   Unassigned: ${withoutSets.length}`)

        if (withSets.length > 0) {
            console.log(`\n✅ Sample assigned attributes:`)
            withSets.slice(0, 5).forEach((attr: any) => {
                const set = sets.find((s: any) => s.id === attr.attribute_set_id)
                console.log(`   - "${attr.label}" → Set: "${set?.title || 'Unknown'}"`)
            })
        }

    } catch (error) {
        console.error("❌ Error:", (error as Error).message)
    }
}
