
import { ExecArgs } from "@medusajs/framework/types"
import { PRODUCT_ATTRIBUTES_MODULE } from "../modules/product-attributes"
import ProductAttributesService from "../modules/product-attributes/service"

export default async function tryUpdateOne({ container }: ExecArgs) {
    console.log("🧪 TESTING ATTRIBUTE UPDATE...")
    const service: ProductAttributesService = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

    // 1. Find 'height' (known attribute)
    const [height] = await service.listAttributeKeys({ handle: "height" })
    if (!height) {
        console.error("❌ Attribute 'height' not found")
        return
    }
    console.log(`Found 'height' (SetID: ${height.attribute_set_id})`)

    // 2. Find 'Physical Characteristics' set
    let [set] = await service.listAttributeSets({ title: "Physical Characteristics" })
    if (!set) {
        console.log("⚠️ Set not found. Creating it...")
        set = await service.createAttributeSets({ title: "Physical Characteristics" })
    }
    console.log(`Target Set: '${set.title}' (ID: ${set.id})`)

    // 3. Try Update Method 2: attribute_set property
    console.log("Trying update with 'attribute_set' property...")
    try {
        await service.updateAttributeKeys([
            {
                id: height.id,
                attribute_set: set.id // Passing ID string to relation property
            }
        ])

        // Verify
        const [updated1] = await service.listAttributeKeys({ id: height.id }, { relations: ['attribute_set'] })

        // Log deep result
        console.log("Updated Attribute:", JSON.stringify(updated1, null, 2))

        const resultSetId = updated1.attribute_set?.id || updated1.attribute_set_id
        console.log(`Result: SetID = ${resultSetId}`)
    } catch (e) {
        console.error("Method 2 failed.")
        console.error((e as Error).message)
    }
}
