
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import ProductAttributesService from "../modules/product-attributes/service"

export default async function debugLabels({ container }: ExecArgs) {
    const service: ProductAttributesService = container.resolve("productAttributes")
    const keys = await service.listAttributeKeys({}, { take: 10 })

    console.log("🔍 Checking Attribute Keys:")
    keys.forEach(k => {
        console.log(`- ID: ${k.id} | Handle: "${k.handle}" | Label: "${k.label}" | Title (legacy): "${(k as any).title}"`)
    })
}
