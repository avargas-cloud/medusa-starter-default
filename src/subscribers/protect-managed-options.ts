import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules, ProductEvents } from "@medusajs/framework/utils"

/**
 * IMPORTANT: This subscriber executes AFTER the option is deleted.
 * It CANNOT block the deletion - it only logs/reacts to it.
 * 
 * To actually PREVENT deletion, you must override the DELETE API route.
 */
export default async function protectManagedOptionsHandler({
    event: { data },
    container,
}: SubscriberArgs<{ id: string }>) {
    console.log("🛡️ [PROTECTION POST-DELETE] Option was deleted:", data.id)
    console.log("   Note: This fires AFTER deletion. Cannot block the operation.")

    const productService = container.resolve(Modules.PRODUCT)
    const query = container.resolve("query")

    try {
        // Find which product this option belonged to (may not exist anymore)
        const { data: products } = await query.graph({
            entity: "product",
            fields: ["id", "title", "metadata", "options.id", "options.title"],
            filters: {
                options: {
                    id: data.id
                }
            }
        })

        if (!products || products.length === 0) {
            console.log("   ✅ Option not found in any product (already deleted)")
            return
        }

        const product = products[0]
        const option = product.options?.find((o: any) => o.id === data.id)

        if (!option) {
            console.log("   ✅ Option not found")
            return
        }

        console.log(`   📦 Product: ${product.title}`)
        console.log(`   🔧 Option: ${option.title}`)

        // Check if this was a managed option
        const variantAttributes = (product.metadata?.variant_attributes as string[]) || []

        if (variantAttributes.length === 0) {
            console.log("   ✅ No managed attributes")
            return
        }

        // Fetch attribute keys to match option title
        const { data: attributeKeys } = await query.graph({
            entity: "attribute_key",
            fields: ["id", "label"],
            filters: {
                id: variantAttributes
            }
        })

        // Check if ANY managed attribute key matches this option's title
        const wasManaged = attributeKeys.some((key: any) => key.label === option.title)

        if (wasManaged) {
            console.error(`   ⚠️ WARNING: Managed option "${option.title}" was manually deleted!`)
            console.error(`   This may cause data inconsistency. Please investigate.`)
        } else {
            console.log(`   ✅ Option "${option.title}" was not managed`)
        }
    } catch (error: any) {
        console.error("   ⚠️ Error in post-delete handler:", error.message)
    }
}

export const config: SubscriberConfig = {
    // CORRECTED: Uses ProductEvents constant which provides kebab-case format
    // "product-option.deleted" not "product_option.deleted"
    event: ProductEvents.PRODUCT_OPTION_DELETED,
}
