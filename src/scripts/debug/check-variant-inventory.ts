import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/utils"

export default async function myScript({ container }: ExecArgs) {
    const productModule = container.resolve(Modules.PRODUCT) as any
    const remoteQuery = container.resolve("remoteQuery") as any

    const variants = await productModule.listProductVariants({ sku: "ESPFC4R4N50W0830" })
    if (!variants.length) {
        console.log("Variant not found by SKU")
        return
    }

    const variant = variants[0]
    console.log("Variant details:", JSON.stringify(variant, null, 2))

    // Let's use remoteQuery to see links
    const qResp = await remoteQuery({
        variant: {
            fields: ["id", "sku", "manage_inventory"],
            __args: { filters: { sku: "ESPFC4R4N50W0830" } },
            inventory_items: { fields: ["inventory_item_id"] }
        }
    })

    console.log("RemoteQuery Links:", JSON.stringify(qResp, null, 2))
}
