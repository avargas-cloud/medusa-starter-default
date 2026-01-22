import { ExecArgs } from "@medusajs/framework/types"
import { createAttributeKeyWorkflow } from "../workflows/product-attributes/create-attribute-key"

export default async function testAttributesWorkflow({ container }: ExecArgs) {
    console.log("---------------------------------------------------")
    console.log("🧪 TESTING ATTRIBUTES WORKFLOW")
    console.log("---------------------------------------------------")

    const { result } = await createAttributeKeyWorkflow(container).run({
        input: {
            handle: "test-material",
            label: "Test Material",
            options: ["Test-Wood", "Test-Metal"]
        }
    })

    console.log("✅ Workflow Executed Successfully!")
    console.log("📄 Created Attribute Key:")
    console.log(`   ID: ${result.id}`)
    console.log(`   Handle: ${result.handle}`)
    console.log(`   Label: ${result.label}`)
    console.log(`   Options: ${result.options}`)
    console.log("---------------------------------------------------")
}
