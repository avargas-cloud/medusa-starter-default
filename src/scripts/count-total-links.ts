
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { PRODUCT_ATTRIBUTES_MODULE } from "../modules/product-attributes"

export default async function countTotalLinks({ container }: ExecArgs) {
    const remoteLink = container.resolve("remoteLink")

    console.log("📊 Counting total Product-Attribute links...")

    // List ALL links for this module pair
    // Note: list() might be paginated, so we request a large number.
    // Ideally we would use a count() method but remoteLink usually provides list().

    const links = await remoteLink.list({
        [Modules.PRODUCT]: { product_id: [] }, // Filter causing scan? Or just list all?
        // To list ALL, we might need to rely on the fact that an empty filter implies all?
        // Or we key by the service name.
    }, { take: 99999 })

    // Filter strictly for our specific link if list returns more? 
    // remoteLink.list returns items matching the query. If we pass empty object, does it return all?
    // Let's try iterating products if not.

    console.log(`✅ Total Links Found: ${links.length}`)
}
