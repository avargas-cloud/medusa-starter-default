import { ExecArgs } from "@medusajs/framework/types"
import { PRODUCT_ATTRIBUTES_MODULE } from "../modules/product-attributes"

export default async function ({ container }: ExecArgs) {
    const productAttributesService = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

    console.log("🚀 Creating 'Unsorted Attribute Set' and assigning all attributes...\n")

    try {
        // 1. Check if it already exists
        const existing = await productAttributesService.listAttributeSets({
            handle: "unsorted-attribute-set",
        })

        let unsortedSet

        if (existing.length > 0) {
            console.log("⚠️  'Unsorted Attribute Set' already exists!")
            unsortedSet = existing[0]
            console.log(`   ID: ${unsortedSet.id}`)
            console.log(`   Title: ${unsortedSet.title}\n`)
        } else {
            // 2. Create the "Unsorted" set
            console.log("📝 Creating 'Unsorted Attribute Set'...")
            const [newSet] = await productAttributesService.createAttributeSets([
                {
                    title: "Unsorted Attribute Set",
                    handle: "unsorted-attribute-set",
                },
            ])
            unsortedSet = newSet
            console.log(`✅ Created set: ${unsortedSet.title}`)
            console.log(`   ID: ${unsortedSet.id}`)
            console.log(`   Handle: ${unsortedSet.handle}\n`)
        }

        // 3. Get all attributes
        const allAttributes = await productAttributesService.listAttributeKeys()
        console.log(`📊 Found ${allAttributes.length} total attributes`)

        // 4. Find unassigned attributes
        const unassignedAttributes = allAttributes.filter(
            (attr: any) => !attr.attribute_set_id
        )

        if (unassignedAttributes.length === 0) {
            console.log("   ✅ All attributes are already assigned to sets\n")
            return
        }

        console.log(`   📌 ${unassignedAttributes.length} attributes are unassigned`)
        console.log(`   🔄 Assigning them to "Unsorted"...\n`)

        // 5. Assign all unassigned attributes to "Unsorted"
        const updates = unassignedAttributes.map((attr: any) => ({
            id: attr.id,
            attribute_set_id: unsortedSet.id,
        }))

        await productAttributesService.updateAttributeKeys(updates)

        console.log(`✅ Successfully assigned ${unassignedAttributes.length} attributes!\n`)

        // 6. Show summary
        console.log("📋 Summary:")
        console.log(`   Set: "${unsortedSet.title}"`)
        console.log(`   Total attributes in set: ${unassignedAttributes.length}`)

        // Show first 5 as examples
        console.log(`\n   First 5 attributes assigned:`)
        unassignedAttributes.slice(0, 5).forEach((attr: any, i: number) => {
            console.log(`   ${i + 1}. ${attr.label} (${attr.handle})`)
        })

        if (unassignedAttributes.length > 5) {
            console.log(`   ... and ${unassignedAttributes.length - 5} more`)
        }

        console.log("\n🎉 Initialization complete! Refresh your Admin UI to see the changes.")

    } catch (error) {
        console.error("\n❌ Error:", (error as Error).message)
        console.error((error as Error).stack)
    }
}
