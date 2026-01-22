import { ExecArgs } from "@medusajs/framework/types"
import { PRODUCT_ATTRIBUTES_MODULE } from "../modules/product-attributes"

export default async function ({ container }: ExecArgs) {
    const productAttributesService = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

    console.log("🧹 Cleaning up: Moving to Virtual 'Unsorted'...\n")

    try {
        // 1. Find the "Unsorted Attribute Set" we created earlier
        const sets = await productAttributesService.listAttributeSets({
            handle: "unsorted-attribute-set",
        })

        if (sets.length === 0) {
            console.log("✅ No 'Unsorted' set found in database (already clean!)\n")
            return
        }

        const unsortedSet = sets[0]
        console.log(`📌 Found 'Unsorted Attribute Set':`)
        console.log(`   ID: ${unsortedSet.id}`)
        console.log(`   Handle: ${unsortedSet.handle}\n`)

        // 2. Get all attributes in this set
        const attributes = await productAttributesService.listAttributeKeys({
            attribute_set_id: unsortedSet.id,
        })

        console.log(`📊 Found ${attributes.length} attributes in this set`)

        // 3. Set all their set_id to null (virtual Unsorted)
        if (attributes.length > 0) {
            console.log("🔄 Moving attributes to virtual Unsorted (set_id: null)...")

            const updates = attributes.map((attr: any) => ({
                id: attr.id,
                attribute_set_id: null,
            }))

            await productAttributesService.updateAttributeKeys(updates)
            console.log(`✅ Moved ${attributes.length} attributes to null\n`)
        }

        // 4. Delete the "Unsorted" set record
        console.log("🗑️  Deleting the 'Unsorted' set record...")
        await productAttributesService.deleteAttributeSets([unsortedSet.id])
        console.log("✅ Deleted successfully!\n")

        // 5. Verify cleanup
        console.log("📋 Verification:")
        const nullAttributes = await productAttributesService.listAttributeKeys()
        const unassigned = nullAttributes.filter((attr: any) => !attr.attribute_set_id)

        console.log(`   Total attributes: ${nullAttributes.length}`)
        console.log(`   With set_id = null: ${unassigned.length}`)
        console.log(`   Assigned to sets: ${nullAttributes.length - unassigned.length}`)

        console.log("\n🎉 Cleanup complete! Ready for virtual 'Unsorted' implementation.")

    } catch (error) {
        console.error("\n❌ Error:", (error as Error).message)
        console.error((error as Error).stack)
    }
}
