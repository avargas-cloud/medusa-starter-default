
import { ExecArgs } from "@medusajs/framework/types"
import { PRODUCT_ATTRIBUTES_MODULE } from "../modules/product-attributes"
import ProductAttributesService from "../modules/product-attributes/service"

export default async function debugAttributeHandles({ container }: ExecArgs) {
    console.log("🔍 INSPECTING ATTRIBUTE HANDLES...")
    const service: ProductAttributesService = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

    // Fetch first 50 attributes
    const attributes = await service.listAttributeKeys({}, { take: 50 })

    console.log(`Found ${attributes.length} attributes. Sample:`)
    console.log("------------------------------------------------")
    attributes.forEach(a => {
        console.log(`- ID: ${a.id} | Handle: "${a.handle}" | SetID: ${a.attribute_set_id || 'NULL'}`)
    })
    console.log("------------------------------------------------")
}
