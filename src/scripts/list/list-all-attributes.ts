import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * List all Product Attributes in database
 */

export default async function listAllAttributes({ container }: { container: MedusaContainer }) {
    console.log("🔍 Listing All Product Attributes...\n")

    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    const { data: attributes } = await query.graph({
        entity: "attribute_key",
        fields: [
            "id",
            "label",
            "handle",
            "values.*",
        ],
    })

    console.log(`📚 Total Attributes: ${attributes.length}\n`)

    for (const attr of attributes) {
        console.log(`📋 ${attr.label}`)
        console.log(`   ID: ${attr.id}`)
        console.log(`   Handle: ${attr.handle}`)
        console.log(`   Values: ${attr.values?.length || 0}`)

        if (attr.values && attr.values.length > 0) {
            console.log(`   Sample Values:`)
            for (const val of attr.values.slice(0, 10)) {
                if (val) {
                    console.log(`      - ${val.value}`)
                }
            }
            if (attr.values.length > 10) {
                console.log(`      ... and ${attr.values.length - 10} more`)
            }
        }
        console.log("")
    }
}
